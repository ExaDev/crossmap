//! The `npm crossmap` task builds the npm package `crossmap` from the wasm binding, run as
//! `sh scripts/rust.sh xtask npm crossmap`: it compiles `crossmap-wasm` to wasm, runs `wasm-bindgen --target web` over
//! it, and writes what makes the one build usable in every runtime (the `#init` modules that differ only in how the
//! `.wasm` is loaded, the API, the error classes, the entry point and the command's Node shim) into
//! `packages/crossmap/dist`, and the JSON Schemas into `packages/crossmap/schemas`. Both are build output and never
//! committed. The layout follows trilean's `xtask npm` for `trilean-regex`.
//!
//! Every file of `dist` is written here, so the set of files is known, and the package's manifest is checked against
//! it: a `./dist/` path it names that was not written, or a written entry point that it leaves out, fails the build,
//! and so does a name the JavaScript imports from the generated module that the module does not export.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The package's name, and its directory under `packages`.
const PACKAGE: &str = "crossmap";
/// The crate whose wasm module the package ships.
const BINDING: &str = "crossmap-wasm";
/// The stem of the files `wasm-bindgen` writes (`<glue>.js`, `<glue>_bg.wasm`).
const GLUE: &str = "crossmap";

/// The package's JavaScript and declarations, kept beside the binding crate and copied into `dist` as they are.
const STATIC_FILES: [(&str, &str); 8] = [
    (
        "index.js",
        include_str!("../../bindings/crossmap-wasm/js/index.js"),
    ),
    (
        "index.d.ts",
        include_str!("../../bindings/crossmap-wasm/js/index.d.ts"),
    ),
    (
        "api.js",
        include_str!("../../bindings/crossmap-wasm/js/api.js"),
    ),
    (
        "api.d.ts",
        include_str!("../../bindings/crossmap-wasm/js/api.d.ts"),
    ),
    (
        "errors.js",
        include_str!("../../bindings/crossmap-wasm/js/errors.js"),
    ),
    (
        "errors.d.ts",
        include_str!("../../bindings/crossmap-wasm/js/errors.d.ts"),
    ),
    (
        "cli.js",
        include_str!("../../bindings/crossmap-wasm/js/cli.js"),
    ),
    (
        "read-source.js",
        include_str!("../../bindings/crossmap-wasm/js/read-source.js"),
    ),
];

/// The files of `dist` the manifest's `exports`, `imports` and `bin` point at.
const ENTRY_POINTS: [&str; 6] = [
    "index.js",
    "index.d.ts",
    "init.node.js",
    "init.workerd.js",
    "init.browser.js",
    "cli.js",
];

/// Runs the task on the arguments after `npm`.
pub fn run(arguments: &[String]) -> Result<(), String> {
    match arguments {
        [name] if name == PACKAGE => build_npm_package(),
        _ => Err(format!("usage: cargo xtask npm {PACKAGE}")),
    }
}

/// The repository's `rust` directory, which this crate sits in.
fn rust_directory() -> Result<PathBuf, String> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "the xtask crate has no parent directory".to_owned())
}

fn command_output(command: &mut Command) -> Result<String, String> {
    let output = command
        .output()
        .map_err(|error| format!("could not run {command:?}: {error}"))?;
    if !output.status.success() {
        return Err(format!("{command:?} failed with {}", output.status));
    }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

fn run_checked(command: &mut Command) -> Result<(), String> {
    let status = command
        .status()
        .map_err(|error| format!("could not run {command:?}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{command:?} failed with {status}"))
    }
}

/// The version `Cargo.lock` pins for a crate, which the `wasm-bindgen` command line tool must equal: the tool and the
/// library it generates glue for are released together and refuse to work across versions.
fn locked_version(lock: &str, crate_name: &str) -> Option<String> {
    let mut lines = lock.lines();
    while let Some(line) = lines.next() {
        if line == format!("name = \"{crate_name}\"") {
            let version = lines.next()?.strip_prefix("version = \"")?;
            return Some(version.strip_suffix('"')?.to_owned());
        }
    }
    None
}

fn target_directory(rust: &Path) -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR").map_or_else(|| rust.join("target"), PathBuf::from)
}

fn write(path: &Path, contents: &[u8]) -> Result<(), String> {
    fs::write(path, contents).map_err(|error| format!("{}: {error}", path.display()))
}

fn read_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))
}

fn fresh_directory(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path).map_err(|error| format!("{}: {error}", path.display()))?;
    }
    fs::create_dir_all(path).map_err(|error| format!("{}: {error}", path.display()))
}

fn build_npm_package() -> Result<(), String> {
    let rust = rust_directory()?;
    let root = rust.parent().ok_or("the rust directory has no parent")?;
    let package_directory = root.join("packages").join(PACKAGE);
    let dist = package_directory.join("dist");

    let lock = read_text(&rust.join("Cargo.lock"))?;
    let wanted =
        locked_version(&lock, "wasm-bindgen").ok_or("Cargo.lock does not pin wasm-bindgen")?;
    let found = command_output(Command::new("wasm-bindgen").arg("--version")).map_err(|error| {
        format!("{error}; install it with `sh scripts/rust.sh install-wasm-bindgen`")
    })?;
    if found.trim() != format!("wasm-bindgen {wanted}") {
        return Err(format!(
            "the wasm-bindgen command is `{}`, and Cargo.lock pins {wanted}; install it with `sh scripts/rust.sh install-wasm-bindgen`",
            found.trim()
        ));
    }

    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    run_checked(
        Command::new(cargo)
            .current_dir(&rust)
            .args(["build", "--locked", "--package", BINDING])
            .args(["--target", "wasm32-unknown-unknown", "--release"]),
    )?;

    fresh_directory(&dist)?;
    let module = target_directory(&rust)
        .join("wasm32-unknown-unknown/release")
        .join(format!("{}.wasm", BINDING.replace('-', "_")));
    run_checked(
        Command::new("wasm-bindgen")
            // The generated module does not locate the `.wasm` file itself: each `#init` module says where the module
            // is, and a bundler that follows `new URL(..., import.meta.url)` in the generated glue as well as in
            // `init.browser.js` fails in module concatenation (webpack, production).
            .args(["--target", "web", "--omit-default-module-path"])
            .args(["--out-name", GLUE, "--out-dir"])
            .arg(&dist)
            .arg(module),
    )?;
    // The package's declarations are `index.d.ts` and what it imports. The generated module's are of no use to a
    // consumer, who never imports it, and they name the DOM library's types.
    for name in [format!("{GLUE}.d.ts"), format!("{GLUE}_bg.wasm.d.ts")] {
        let path = dist.join(name);
        if path.exists() {
            fs::remove_file(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        }
    }

    let glue = read_text(&dist.join(format!("{GLUE}.js")))?;
    let exported = exported_names(&glue);
    for (name, contents) in STATIC_FILES {
        for imported in names_imported_from(contents, &format!("./{GLUE}.js")) {
            if !exported.contains(&imported) {
                return Err(format!(
                    "{name} imports {imported} from ./{GLUE}.js, which the binding does not export"
                ));
            }
        }
        write(&dist.join(name), contents.as_bytes())?;
    }
    let wasm = fs::read(dist.join(format!("{GLUE}_bg.wasm")))
        .map_err(|error| format!("{GLUE}_bg.wasm: {error}"))?;
    write(
        &dist.join(format!("{GLUE}_inline.js")),
        inline_module(&wasm).as_bytes(),
    )?;
    write(&dist.join("init.node.js"), init_node().as_bytes())?;
    write(&dist.join("init.workerd.js"), init_workerd().as_bytes())?;
    write(&dist.join("init.browser.js"), init_browser().as_bytes())?;

    let schemas = copy_schemas(&root.join("schemas"), &package_directory.join("schemas"))?;
    check_package_manifest(&package_directory.join("package.json"))?;
    println!(
        "built packages/{PACKAGE}/dist ({}) and packages/{PACKAGE}/schemas ({})",
        ENTRY_POINTS.join(", "),
        schemas.join(", ")
    );
    Ok(())
}

/// Copies every `*.schema.json` of the repository's `schemas` directory into the package's, which the package exports
/// as `./schemas/*.schema.json`. The directory is build output of the schema generator, so a build without one fails
/// rather than publishing an export that matches nothing.
fn copy_schemas(from: &Path, to: &Path) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(from).map_err(|error| {
        format!(
            "{}: {error}; generate the JSON Schema first, which writes it there",
            from.display()
        )
    })?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".schema.json") {
            names.push(name);
        }
    }
    if names.is_empty() {
        return Err(format!(
            "{} holds no *.schema.json; generate the JSON Schema first",
            from.display()
        ));
    }
    names.sort();
    fresh_directory(to)?;
    for name in &names {
        fs::copy(from.join(name), to.join(name))
            .map_err(|error| format!("{}: {error}", from.join(name).display()))?;
    }
    Ok(names)
}

/// The `#init` module for Node, Bun and Deno. The module's bytes are in the package as a generated base64 string (see
/// [`inline_module`]), decoded once with `atob`, which Node, Bun and Deno all have, and compiled synchronously, so
/// importing the package reads no file and waits for nothing.
fn init_node() -> String {
    format!(
        "import {{ initSync }} from \"./{GLUE}.js\";\nimport {{ base64 }} from \"./{GLUE}_inline.js\";\n\ninitSync({{ module: Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)) }});\n"
    )
}

/// The `#init` module for Cloudflare Workers, which imports a `.wasm` file as an already compiled module.
fn init_workerd() -> String {
    format!(
        "import {{ initSync }} from \"./{GLUE}.js\";\nimport wasm from \"./{GLUE}_bg.wasm\";\n\ninitSync({{ module: wasm }});\n"
    )
}

/// The `#init` module for browsers and bundlers, which fetch the module and wait for it with top-level await.
fn init_browser() -> String {
    format!(
        "import init from \"./{GLUE}.js\";\n\nawait init({{ module_or_path: new URL(\"./{GLUE}_bg.wasm\", import.meta.url) }});\n"
    )
}

/// The module's bytes as the base64 text of an ES module, which only `init.node.js` imports.
fn inline_module(wasm: &[u8]) -> String {
    format!("export const base64 = \"{}\";\n", base64(wasm))
}

/// Standard base64 with padding, which `atob` reads.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let group = chunk.iter().enumerate().fold(0u32, |group, (at, byte)| {
            group | u32::from(*byte) << (16 - 8 * at)
        });
        for at in 0..4 {
            if at <= chunk.len() {
                text.push(char::from(ALPHABET[(group >> (18 - 6 * at) & 63) as usize]));
            } else {
                text.push('=');
            }
        }
    }
    text
}

/// The names the generated module exports, one `export function|class <name>` to a line, as `wasm-bindgen` writes.
fn exported_names(glue: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for line in glue.lines() {
        let Some(rest) = line.strip_prefix("export ") else {
            continue;
        };
        for keyword in ["function ", "class "] {
            if let Some(after) = rest.strip_prefix(keyword) {
                let name: String = after
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
                    .collect();
                if !name.is_empty() {
                    names.insert(name);
                }
            }
        }
    }
    names
}

/// The names an ES module imports from `specifier` through `import { a, b as c } from "<specifier>";` lines.
fn names_imported_from(module: &str, specifier: &str) -> Vec<String> {
    let suffix = format!("}} from \"{specifier}\";");
    module
        .lines()
        .filter_map(|line| {
            line.strip_prefix("import {")
                .and_then(|rest| rest.strip_suffix(&suffix))
        })
        .flat_map(|list| list.split(','))
        .filter_map(|item| item.split_whitespace().next().map(str::to_owned))
        .collect()
}

/// The `./dist/...` paths a package manifest names, in `exports`, `imports`, `bin` and everywhere else it can.
fn dist_paths(manifest: &str) -> BTreeSet<String> {
    let mut paths = BTreeSet::new();
    let mut rest = manifest;
    while let Some(start) = rest.find("\"./dist/") {
        let after = &rest[start + 1..];
        let Some(end) = after.find('"') else { break };
        paths.insert(after[..end].to_owned());
        rest = &after[end + 1..];
    }
    paths
}

/// Checks that the manifest names exactly the entry points that were written, and has no `sideEffects` field: the
/// entry point has effects (it starts the module and registers the error classes), and a bundler told otherwise drops
/// them.
fn check_package_manifest(path: &Path) -> Result<(), String> {
    let manifest = read_text(path)?;
    check_manifest_text(&manifest).map_err(|problem| format!("{}: {problem}", path.display()))
}

fn check_manifest_text(manifest: &str) -> Result<(), String> {
    if manifest.contains("\"sideEffects\"") {
        return Err(
            "has a sideEffects field; the entry point has effects, and a bundler that is told otherwise drops them"
                .to_owned(),
        );
    }
    let named = dist_paths(manifest);
    let wanted: BTreeSet<String> = ENTRY_POINTS
        .iter()
        .map(|file| format!("./dist/{file}"))
        .collect();
    if named == wanted {
        Ok(())
    } else {
        Err(format!(
            "names {named:?} under dist, and the build wrote the entry points {wanted:?}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_locked_version_is_the_line_after_the_crate_name() {
        let lock = "[[package]]\nname = \"wasm-bindgen\"\nversion = \"0.2.5\"\n\n[[package]]\nname = \"wasm-bindgen-macro\"\nversion = \"9.9.9\"\n";
        assert_eq!(
            locked_version(lock, "wasm-bindgen").as_deref(),
            Some("0.2.5")
        );
        assert_eq!(locked_version(lock, "absent"), None);
    }

    #[test]
    fn base64_is_the_standard_padded_encoding() {
        for (bytes, text) in [
            (&b""[..], ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foobar", "Zm9vYmFy"),
            (&[0xFB, 0xFF, 0x00], "+/8A"),
        ] {
            assert_eq!(base64(bytes), text);
        }
    }

    #[test]
    fn every_name_the_javascript_imports_from_the_glue_is_found() {
        assert_eq!(
            names_imported_from(
                "import { Codec, ruleSides as bindingRuleSides } from \"./crossmap.js\";\nimport { x } from \"./other.js\";\n",
                "./crossmap.js"
            ),
            ["Codec", "ruleSides"]
        );
        let imported: Vec<String> = STATIC_FILES
            .iter()
            .flat_map(|(_, contents)| names_imported_from(contents, "./crossmap.js"))
            .collect();
        for name in [
            "Codec",
            "registerErrorClasses",
            "cliPlan",
            "cliComplete",
            "cliIsUrl",
        ] {
            assert!(imported.iter().any(|found| found == name), "{name}");
        }
    }

    #[test]
    fn the_glue_exports_are_its_functions_and_classes() {
        let glue = "export function parse(a) {}\nexport class Codec {}\nexport default __wbg_init;\nfunction hidden() {}\n";
        assert_eq!(
            exported_names(glue).into_iter().collect::<Vec<_>>(),
            ["Codec", "parse"]
        );
    }

    #[test]
    fn a_manifest_that_names_a_path_nothing_wrote_or_leaves_one_out_is_refused() {
        let all = r#"{ "a": "./dist/index.js", "b": "./dist/index.d.ts", "c": "./dist/init.node.js", "d": "./dist/init.workerd.js", "e": "./dist/init.browser.js", "f": "./dist/cli.js" }"#;
        assert!(check_manifest_text(all).is_ok());
        assert!(check_manifest_text(&all.replace(", \"f\": \"./dist/cli.js\"", "")).is_err());
        assert!(check_manifest_text(&all.replace("cli.js", "other.js")).is_err());
        assert!(check_manifest_text(&all.replace("{ ", "{ \"sideEffects\": false, ")).is_err());
    }

    #[test]
    fn the_shipped_manifest_names_exactly_the_entry_points() -> Result<(), String> {
        let manifest = rust_directory()?.join("../packages/crossmap/package.json");
        check_package_manifest(&manifest)
    }

    #[test]
    fn each_init_module_loads_the_module_its_runtime_way() {
        let node = init_node();
        assert!(node.contains("Uint8Array.from(atob(base64)"));
        assert!(!node.contains("node:") && !node.contains("import.meta"));
        assert!(init_workerd().contains("import wasm from \"./crossmap_bg.wasm\""));
        assert!(init_browser().contains("await init("));
    }
}

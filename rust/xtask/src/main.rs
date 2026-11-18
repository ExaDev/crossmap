//! The repository's tasks, run from the `rust` directory as `cargo xtask <task>`.
//!
//! `schema` writes `schemas/crossmap.schema.json` from [`crossmap::schema::json_schema_text`], and `schema --check`
//! writes nothing and fails when the committed file is not what the crate generates. The tests hold the committed file
//! to the generated text, and the generated text to the schema the TypeScript generator wrote before the port.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "usage: cargo xtask schema [--check]";

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match run(&arguments) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: &[String]) -> Result<(), String> {
    let check = match arguments {
        [task] if task == "schema" => false,
        [task, flag] if task == "schema" && flag == "--check" => true,
        _ => return Err(USAGE.to_owned()),
    };
    let path = schema_path();
    let generated = crossmap::schema::json_schema_text();
    if check {
        let committed = fs::read_to_string(&path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        if committed == generated {
            Ok(())
        } else {
            Err(format!(
                "{} is not what the crate generates; run `cargo xtask schema`",
                path.display()
            ))
        }
    } else {
        let directory = repository().join("schemas");
        fs::create_dir_all(&directory)
            .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
        fs::write(&path, generated)
            .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
        println!("wrote {}", path.display());
        Ok(())
    }
}

/// The repository's root, the parent of the `rust` directory this crate sits in.
fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The published schema's place in the repository, where the npm package's `./schemas/*.schema.json` export reads it.
fn schema_path() -> PathBuf {
    repository().join("schemas").join("crossmap.schema.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossmap::Value;
    use crossmap::schema::{PACKAGE_VERSION, TRILEAN_VERSION, json_schema_text};

    /// The crossmap version the pre-port schema was published with, which its `$id` names.
    const PRE_PORT_VERSION: &str = "0.11.1";

    fn read(path: &Path) -> String {
        fs::read_to_string(path)
            .unwrap_or_else(|error| format!("cannot read {}: {error}", path.display()))
    }

    #[test]
    fn the_committed_schema_is_what_the_crate_generates() {
        assert!(
            read(&schema_path()) == json_schema_text(),
            "schemas/crossmap.schema.json is stale; run `cargo xtask schema`"
        );
    }

    #[test]
    fn the_generated_schema_is_byte_for_byte_the_pre_port_one() {
        let pre_port =
            read(&repository().join("rust/tests/fixtures/pre-port-crossmap.schema.json")).replace(
                &format!("/crossmap@{PRE_PORT_VERSION}/"),
                &format!("/crossmap@{PACKAGE_VERSION}/"),
            );
        assert!(
            json_schema_text() == pre_port,
            "the generated schema differs from the one the TypeScript generator wrote"
        );
    }

    #[test]
    fn the_typescript_package_pins_the_same_trilean() {
        let manifest: Value =
            serde_json::from_str(&read(&repository().join("package.json"))).unwrap_or(Value::Null);
        let pinned = manifest
            .get("dependencies")
            .and_then(|dependencies| dependencies.get("trilean"))
            .and_then(Value::as_str);
        assert_eq!(pinned, Some(TRILEAN_VERSION));
    }

    #[test]
    fn the_check_refuses_arguments_it_does_not_take() {
        assert_eq!(run(&["schemas".to_owned()]), Err(USAGE.to_owned()));
        assert_eq!(
            run(&["schema".to_owned(), "--write".to_owned()]),
            Err(USAGE.to_owned())
        );
    }
}

//! `schema` writes `schemas/crossmap.schema.json` from [`crossmap::schema::json_schema_text`], and `schema --check`
//! writes nothing and fails when the committed file is not what the crate generates. The tests hold the committed file
//! to the generated text, and the generated text to the schema the TypeScript generator wrote before the port.

use std::fs;
use std::path::{Path, PathBuf};

/// The task's usage, which every argument list it does not take is refused with.
pub const USAGE: &str = "usage: cargo xtask schema [--check]";

/// Runs the task on the arguments after `schema`.
pub fn run(arguments: &[String]) -> Result<(), String> {
    let check = match arguments {
        [] => false,
        [flag] if flag == "--check" => true,
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
    fn the_trilean_pin_is_the_one_the_pre_port_schema_names() {
        let pre_port: Value = serde_json::from_str(&read(
            &repository().join("rust/tests/fixtures/pre-port-crossmap.schema.json"),
        ))
        .unwrap_or(Value::Null);
        let reference = pre_port
            .get("$defs")
            .and_then(|definitions| definitions.get("When"))
            .and_then(|when| when.get("$ref"))
            .and_then(Value::as_str);
        assert_eq!(
            reference,
            Some(
                format!(
                    "https://cdn.jsdelivr.net/npm/trilean@{TRILEAN_VERSION}/schemas/trilean.schema.json#/$defs/PredicateNode"
                )
                .as_str()
            ),
            "TRILEAN_VERSION is not the trilean release the pre-port schema's `when` reference names"
        );
    }

    #[test]
    fn the_check_refuses_arguments_it_does_not_take() {
        assert_eq!(run(&["--write".to_owned()]), Err(USAGE.to_owned()));
        assert_eq!(
            run(&["--check".to_owned(), "--check".to_owned()]),
            Err(USAGE.to_owned())
        );
    }
}

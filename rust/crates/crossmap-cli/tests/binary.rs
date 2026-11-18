//! The built `crossmap` executable: its exit statuses and standard streams, which the conformance runner exercises
//! in process through `run` and this exercises through the binary.

use std::io::Write as _;
use std::process::{Command, Output, Stdio};

type Outcome = Result<(), Box<dyn std::error::Error>>;

fn crossmap(args: &[&str], stdin: &str) -> std::io::Result<Output> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_crossmap"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut input) = child.stdin.take() {
        input.write_all(stdin.as_bytes())?;
    }
    child.wait_with_output()
}

const CROSSWALK: &str =
    r#"{"source":"n","target":"s","rules":[{"op":"scale","from":"g","to":"kg","factor":0.001}]}"#;

#[test]
fn encodes_a_document_from_standard_input() -> Outcome {
    let directory = std::env::temp_dir().join(format!("crossmap-binary-{}", std::process::id()));
    std::fs::create_dir_all(&directory)?;
    let crosswalk = directory.join("cw.json");
    std::fs::write(&crosswalk, CROSSWALK)?;
    let path = crosswalk.to_string_lossy().into_owned();
    let output = crossmap(&["encode", &path, "-"], r#"{"g":1250000}"#)?;
    let refused = crossmap(&["encode", &path, "-"], r#"{"h":1}"#)?;
    let _ = std::fs::remove_dir_all(&directory);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "{\n  \"kg\": 1250\n}\n"
    );
    assert!(output.stderr.is_empty());
    assert_eq!(refused.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&refused.stderr).starts_with("rule 0 (g): "));
    Ok(())
}

#[test]
fn exits_two_for_bad_usage_and_unreadable_arguments() -> Outcome {
    let usage = crossmap(&["frobnicate"], "")?;
    assert_eq!(usage.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&usage.stderr).contains("Usage: crossmap"));
    let missing = crossmap(&["validate", "no-such-crosswalk.json"], "")?;
    assert_eq!(missing.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&missing.stderr)
            .starts_with("cannot read no-such-crosswalk.json: ")
    );
    Ok(())
}

#[test]
fn prints_its_version() -> Outcome {
    let output = crossmap(&["--version"], "")?;
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{}\n", env!("CARGO_PKG_VERSION"))
    );
    Ok(())
}

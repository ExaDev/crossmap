//! Prints the crosswalk format's JSON Schema, exactly as the repository's `schemas/crossmap.schema.json` holds it.
//!
//! Shipped in the crate's package so the schema a published version generates can be read from that package alone:
//! `cargo run --example json-schema`.

use std::io::Write as _;
use std::process::ExitCode;

fn main() -> ExitCode {
    match std::io::stdout()
        .lock()
        .write_all(crossmap::schema::json_schema_text().as_bytes())
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("json-schema: {error}");
            ExitCode::FAILURE
        }
    }
}

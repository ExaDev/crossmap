//! The repository's tasks, run from the `rust` directory as `cargo xtask <task>` (or `sh scripts/rust.sh xtask <task>`
//! from anywhere, which also pins the lock file and the toolchain).
//!
//! - `schema [--check]` writes `schemas/crossmap.schema.json` from the core crate, or checks the committed copy is
//!   current (see [`schema`]).
//! - `npm crossmap` builds the npm package `crossmap` from the wasm binding (see [`npm`]).

mod npm;
mod schema;

use std::process::ExitCode;

const USAGE: &str = "usage: cargo xtask schema [--check] | npm crossmap";

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let result = match arguments.split_first() {
        Some((task, rest)) if task == "schema" => schema::run(rest),
        Some((task, rest)) if task == "npm" => npm::run(rest),
        _ => Err(USAGE.to_owned()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask: {error}");
            ExitCode::FAILURE
        }
    }
}

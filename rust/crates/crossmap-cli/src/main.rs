//! The `crossmap` executable.

#![forbid(unsafe_code)]

use std::process::ExitCode;

use crossmap_cli::{StandardStreams, run};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let status = run(&args, &mut StandardStreams);
    ExitCode::from(u8::try_from(status).unwrap_or(1))
}

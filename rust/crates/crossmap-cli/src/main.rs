//! The `crossmap` executable.

#![forbid(unsafe_code)]

use std::io::Write as _;
use std::process::ExitCode;

use crossmap_cli::{CliIo, ReadLimits, VERSION, read_source, run};

/// Standard streams and the real readers.
struct Terminal;

impl CliIo for Terminal {
    fn read_text(&self, source: &str) -> Result<String, String> {
        read_source(source, ReadLimits::default())
    }

    fn write_stdout(&mut self, text: &str) {
        // A reader that closes early (`| head -c 0`) makes the write fail with a broken pipe. The result was computed
        // either way, so that failure is dropped and the exit status the command settled on stands.
        let _ = std::io::stdout().lock().write_all(text.as_bytes());
    }

    fn write_stderr(&mut self, text: &str) {
        let _ = std::io::stderr().lock().write_all(text.as_bytes());
    }

    fn version(&self) -> &str {
        VERSION
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let status = run(&args, &mut Terminal);
    ExitCode::from(u8::try_from(status).unwrap_or(1))
}

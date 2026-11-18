//! The `crossmap` command, with everything it touches outside its arguments injected so it runs the same under test
//! as from a terminal.
//!
//! The command is two pure steps around the reading of its arguments: [`plan`] reads the command line and either
//! names the sources to read or settles the outcome (help, version, bad usage), and [`complete`] takes the texts read
//! (or why each could not be) and produces the outcome. [`run`] joins them with a [`CliIo`]. A host that reads in its
//! own way (the npm package's Node shim, which reads through Node's file system and `fetch`) calls the two steps and
//! does the reading between them, and so prints exactly what this command prints. The native reader, [`read_source`],
//! is behind the `read` feature, so the steps compile without it to `wasm32-unknown-unknown`.

#![forbid(unsafe_code)]

mod argument;
#[cfg(feature = "read")]
pub mod read_source;

#[cfg(feature = "read")]
use std::io::Write as _;

use crossmap::{
    CrossmapError, Value, assert_round_trip, decode, encode, parse_crosswalk, stringify_pretty,
    validate_crosswalk,
};

pub use argument::{STDIN, SUPPORTED_SCHEMES, is_url, scheme_of};
#[cfg(feature = "read")]
pub use read_source::{ReadLimits, read_source};

/// The version the command reports.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The command did what was asked.
pub const EXIT_OK: i32 = 0;
/// The inputs were readable but the library rejected them; the reason is on standard error.
pub const EXIT_REJECTED: i32 = 1;
/// The command could not run: bad usage, or an argument that is unreadable or not JSON.
pub const EXIT_USAGE: i32 = 2;

/// Everything the command touches outside its arguments.
pub trait CliIo: Sync {
    /// The text an argument names: a file, standard input for `-`, or a URL.
    ///
    /// # Errors
    ///
    /// Why the source cannot be read; the command names the argument.
    fn read_text(&self, source: &str) -> Result<String, String>;
    /// Writes to standard output.
    fn write_stdout(&mut self, text: &str);
    /// Writes to standard error.
    fn write_stderr(&mut self, text: &str);
    /// The version to report.
    fn version(&self) -> &str;
}

/// The process's own standard streams and the real readers: what the `crossmap` executable runs with, and what any other
/// host of the command (the Python package's console script) runs with.
#[cfg(feature = "read")]
pub struct StandardStreams;

#[cfg(feature = "read")]
impl CliIo for StandardStreams {
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

/// The usage text.
pub const USAGE: &str = "Usage: crossmap encode     <crosswalk.json> <document.json>
       crossmap decode     <crosswalk.json> <document.json>
       crossmap validate   <crosswalk.json>
       crossmap round-trip <crosswalk.json> <samples.json>

Applies a crossmap crosswalk to JSON documents.

  encode      prints the document translated from the crosswalk's source shape
              to its target shape
  decode      prints the document translated back, from target shape to source
  validate    checks the crosswalk's schema and structure, printing nothing
              when it is sound
  round-trip  checks that decoding the encoding of every sample reproduces it
              on the paths the crosswalk preserves; <samples.json> is a JSON
              array of source-shape documents. Prints nothing on success

  <crosswalk.json>  the crosswalk: a path, a URL, or - to read it from standard
                    input
  <document.json>   the document: a path, a URL, or - to read it from standard
                    input
  -h, --help        show this text
  -v, --version     show the version

A URL is an http:, https:, data: or file: address; any other scheme is
unsupported. Only one argument may be -. Output is JSON on standard output.

Exit status: 0 on success, 1 when the library rejected the crosswalk or the
document (the reason is on standard error), 2 for bad usage or an argument that
cannot be read (a missing file, a failed fetch, an unsupported scheme) or is
not JSON.
";

#[derive(Clone, Copy, Debug)]
enum Command {
    Encode,
    Decode,
    Validate,
    RoundTrip,
}

impl Command {
    fn named(name: &str) -> Option<Command> {
        match name {
            "encode" => Some(Command::Encode),
            "decode" => Some(Command::Decode),
            "validate" => Some(Command::Validate),
            "round-trip" => Some(Command::RoundTrip),
            _ => None,
        }
    }

    /// The arguments the command takes after its name: the crosswalk, then a document where it has one.
    fn operand_count(self) -> usize {
        match self {
            Command::Validate => 1,
            Command::Encode | Command::Decode | Command::RoundTrip => 2,
        }
    }
}

struct CommandLine {
    help: bool,
    version: bool,
    positionals: Vec<String>,
}

/// Reads the options and positionals as Node's `parseArgs` reads them with `help` (`-h`) and `version` (`-v`).
fn parse_command_line(args: &[String]) -> Result<CommandLine, String> {
    let mut line = CommandLine {
        help: false,
        version: false,
        positionals: Vec::new(),
    };
    let unknown = |option: &str| {
        format!(
            "Unknown option '{option}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{option}\"'"
        )
    };
    let mut arguments = args.iter();
    while let Some(argument) = arguments.next() {
        if argument == "--" {
            line.positionals.extend(arguments.by_ref().cloned());
            break;
        }
        if let Some(long) = argument.strip_prefix("--") {
            let (name, value) = long
                .split_once('=')
                .map_or((long, None), |(name, value)| (name, Some(value)));
            let flag = match name {
                "help" => &mut line.help,
                "version" => &mut line.version,
                _ => return Err(unknown(argument)),
            };
            if value.is_some() {
                return Err(format!("Option '--{name}' does not take an argument"));
            }
            *flag = true;
            continue;
        }
        if argument.len() > 1 && argument.starts_with('-') {
            for short in argument.chars().skip(1) {
                match short {
                    'h' => line.help = true,
                    'v' => line.version = true,
                    other => return Err(unknown(&format!("-{other}"))),
                }
            }
            continue;
        }
        line.positionals.push(argument.clone());
    }
    Ok(line)
}

/// What the command settled on: its exit status and everything it writes to each stream.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// The exit status: [`EXIT_OK`], [`EXIT_REJECTED`] or [`EXIT_USAGE`].
    pub status: i32,
    /// Everything written to standard output.
    pub stdout: String,
    /// Everything written to standard error.
    pub stderr: String,
}

impl Outcome {
    fn failure(status: i32, lines: &[&str]) -> Outcome {
        Outcome {
            status,
            stdout: String::new(),
            stderr: format!("{}\n", lines.join("\n").trim_end()),
        }
    }

    fn printed(stdout: String) -> Outcome {
        Outcome {
            status: EXIT_OK,
            stdout,
            stderr: String::new(),
        }
    }
}

/// A command line that names a command and its sources, ready for them to be read.
#[derive(Clone, Debug)]
pub struct Invocation {
    command: Command,
    operands: Vec<String>,
}

impl Invocation {
    /// The sources to read, in argument order: the crosswalk, then the document where the command has one. Each is
    /// [`STDIN`], a URL (see [`is_url`]) or a path; at most one is [`STDIN`].
    pub fn operands(&self) -> &[String] {
        &self.operands
    }
}

/// Reads the command line. `Ok` names the sources to read before [`complete`]; `Err` is the whole outcome when there
/// is nothing to read: the version or the usage text asked for, or bad usage. `version` is what `--version` prints.
///
/// # Errors
///
/// The outcome, when the command ends without reading anything.
pub fn plan(args: &[String], version: &str) -> Result<Invocation, Outcome> {
    let usage = || Outcome::failure(EXIT_USAGE, &["expected a command and its files", "", USAGE]);
    let line = match parse_command_line(args) {
        Ok(line) => line,
        Err(message) => return Err(Outcome::failure(EXIT_USAGE, &[&message, "", USAGE])),
    };
    if line.version {
        return Err(Outcome::printed(format!("{version}\n")));
    }
    if line.help {
        return Err(Outcome::printed(USAGE.to_owned()));
    }
    let Some((name, operands)) = line.positionals.split_first() else {
        return Err(usage());
    };
    let Some(command) =
        Command::named(name).filter(|command| command.operand_count() == operands.len())
    else {
        return Err(usage());
    };
    if operands.iter().filter(|operand| *operand == STDIN).count() > 1 {
        return Err(Outcome::failure(
            EXIT_USAGE,
            &["only one argument can be read from standard input"],
        ));
    }
    Ok(Invocation {
        command,
        operands: operands.to_vec(),
    })
}

/// Finishes the command from what reading its sources gave: `reads` holds, for each of
/// [`Invocation::operands`] in order, the text read or the reason it could not be (which the message names the
/// argument in front of). The first failure in argument order is the one reported.
pub fn complete(invocation: &Invocation, reads: Vec<Result<String, String>>) -> Outcome {
    if reads.len() != invocation.operands.len() {
        return Outcome::failure(EXIT_USAGE, &["expected a command and its files", "", USAGE]);
    }
    let mut documents = Vec::with_capacity(reads.len());
    for (source, read) in invocation.operands.iter().zip(reads) {
        match parse_json(source, read) {
            Ok(value) => documents.push(value),
            Err(message) => return Outcome::failure(EXIT_USAGE, &[&message]),
        }
    }
    let (crosswalk_document, document) = match documents.as_slice() {
        [crosswalk] => (crosswalk, None),
        [crosswalk, document] => (crosswalk, Some(document)),
        _ => {
            return Outcome::failure(EXIT_USAGE, &["expected a command and its files", "", USAGE]);
        }
    };
    match execute(invocation.command, crosswalk_document, document) {
        Ok(outcome) => outcome,
        Err(error) => Outcome::failure(EXIT_REJECTED, &[&error.to_string()]),
    }
}

/// One source's text as JSON, or the message saying why it cannot be.
fn parse_json(source: &str, read: Result<String, String>) -> Result<Value, String> {
    let name = if source == STDIN {
        "standard input"
    } else {
        source
    };
    let text = read.map_err(|error| format!("cannot read {name}: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("{name} is not valid JSON: {error}"))
}

/// Runs the command and returns its exit status.
pub fn run(args: &[String], io: &mut dyn CliIo) -> i32 {
    let outcome = match plan(args, io.version()) {
        Ok(invocation) => {
            // Read together so two remote arguments are fetched concurrently; `complete` reports the first failure in
            // argument order.
            let reader: &dyn CliIo = io;
            let reads: Vec<Result<String, String>> = std::thread::scope(|scope| {
                let handles: Vec<_> = invocation
                    .operands()
                    .iter()
                    .map(|operand| scope.spawn(move || reader.read_text(operand)))
                    .collect();
                handles
                    .into_iter()
                    .map(|handle| {
                        handle
                            .join()
                            .unwrap_or_else(|_| Err("the read failed".to_owned()))
                    })
                    .collect()
            });
            complete(&invocation, reads)
        }
        Err(outcome) => outcome,
    };
    if !outcome.stdout.is_empty() {
        io.write_stdout(&outcome.stdout);
    }
    if !outcome.stderr.is_empty() {
        io.write_stderr(&outcome.stderr);
    }
    outcome.status
}

fn execute(
    command: Command,
    crosswalk_document: &Value,
    document: Option<&Value>,
) -> Result<Outcome, CrossmapError> {
    let crosswalk = parse_crosswalk(crosswalk_document)?;
    let null = Value::Null;
    let document = document.unwrap_or(&null);
    match command {
        Command::Encode => Ok(print(&encode(&crosswalk, document)?)),
        Command::Decode => Ok(print(&decode(&crosswalk, document)?)),
        Command::Validate => {
            let issues = validate_crosswalk(&crosswalk);
            if issues.is_empty() {
                Ok(Outcome::default())
            } else {
                Err(CrossmapError::Structure { issues })
            }
        }
        Command::RoundTrip => {
            let Value::Array(samples) = document else {
                return Ok(Outcome::failure(
                    EXIT_USAGE,
                    &["the samples file must hold a JSON array of documents"],
                ));
            };
            assert_round_trip(&crosswalk, samples)?;
            Ok(Outcome::default())
        }
    }
}

fn print(value: &Value) -> Outcome {
    Outcome::printed(format!("{}\n", stringify_pretty(value)))
}

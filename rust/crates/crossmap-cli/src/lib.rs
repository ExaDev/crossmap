//! The `crossmap` command, with everything it touches outside its arguments injected so it runs the same under test
//! as from a terminal.

#![forbid(unsafe_code)]

pub mod read_source;

use std::io::Write as _;

use crossmap::{
    CrossmapError, Value, assert_round_trip, decode, encode, parse_crosswalk, stringify_pretty,
    validate_crosswalk,
};

pub use read_source::{ReadLimits, STDIN, is_url, read_source};

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
pub struct StandardStreams;

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

#[derive(Clone, Copy)]
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

fn fail(io: &mut dyn CliIo, status: i32, lines: &[&str]) -> i32 {
    io.write_stderr(&format!("{}\n", lines.join("\n").trim_end()));
    status
}

/// Reads one argument as JSON, or the message saying why it cannot be.
fn read_json(io: &dyn CliIo, source: &str) -> Result<Value, String> {
    let name = if source == STDIN {
        "standard input"
    } else {
        source
    };
    let text = io
        .read_text(source)
        .map_err(|error| format!("cannot read {name}: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("{name} is not valid JSON: {error}"))
}

/// Runs the command and returns its exit status.
pub fn run(args: &[String], io: &mut dyn CliIo) -> i32 {
    let line = match parse_command_line(args) {
        Ok(line) => line,
        Err(message) => return fail(io, EXIT_USAGE, &[&message, "", USAGE]),
    };
    if line.version {
        let version = format!("{}\n", io.version());
        io.write_stdout(&version);
        return EXIT_OK;
    }
    if line.help {
        io.write_stdout(USAGE);
        return EXIT_OK;
    }
    let Some((name, operands)) = line.positionals.split_first() else {
        return fail(
            io,
            EXIT_USAGE,
            &["expected a command and its files", "", USAGE],
        );
    };
    let Some(command) =
        Command::named(name).filter(|command| command.operand_count() == operands.len())
    else {
        return fail(
            io,
            EXIT_USAGE,
            &["expected a command and its files", "", USAGE],
        );
    };
    if operands.iter().filter(|operand| *operand == STDIN).count() > 1 {
        return fail(
            io,
            EXIT_USAGE,
            &["only one argument can be read from standard input"],
        );
    }
    // Read together so two remote arguments are fetched concurrently; the first failure in argument order is reported.
    let reader: &dyn CliIo = io;
    let read: Vec<Result<Value, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = operands
            .iter()
            .map(|operand| scope.spawn(move || read_json(reader, operand)))
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
    let mut documents = Vec::with_capacity(read.len());
    for file in read {
        match file {
            Ok(value) => documents.push(value),
            Err(message) => return fail(io, EXIT_USAGE, &[&message]),
        }
    }
    let (crosswalk_document, document) = match documents.as_slice() {
        [crosswalk] => (crosswalk, None),
        [crosswalk, document] => (crosswalk, Some(document)),
        _ => {
            return fail(
                io,
                EXIT_USAGE,
                &["expected a command and its files", "", USAGE],
            );
        }
    };
    match execute(command, io, crosswalk_document, document) {
        Ok(status) => status,
        Err(error) => fail(io, EXIT_REJECTED, &[&error.to_string()]),
    }
}

fn execute(
    command: Command,
    io: &mut dyn CliIo,
    crosswalk_document: &Value,
    document: Option<&Value>,
) -> Result<i32, CrossmapError> {
    let crosswalk = parse_crosswalk(crosswalk_document)?;
    let null = Value::Null;
    let document = document.unwrap_or(&null);
    match command {
        Command::Encode => print(io, &encode(&crosswalk, document)?),
        Command::Decode => print(io, &decode(&crosswalk, document)?),
        Command::Validate => {
            let issues = validate_crosswalk(&crosswalk);
            if issues.is_empty() {
                Ok(EXIT_OK)
            } else {
                Err(CrossmapError::Structure { issues })
            }
        }
        Command::RoundTrip => {
            let Value::Array(samples) = document else {
                return Ok(fail(
                    io,
                    EXIT_USAGE,
                    &["the samples file must hold a JSON array of documents"],
                ));
            };
            assert_round_trip(&crosswalk, samples)?;
            Ok(EXIT_OK)
        }
    }
}

fn print(io: &mut dyn CliIo, value: &Value) -> Result<i32, CrossmapError> {
    io.write_stdout(&format!("{}\n", stringify_pretty(value)));
    Ok(EXIT_OK)
}

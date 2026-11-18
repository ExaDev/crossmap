//! Runs the conformance corpus in `conformance/` against the Rust crates: `cargo test -p crossmap-conformance`.
//!
//! The corpus is checked first (which files are corpus files, that each is canonical, that ids are unique, that it is
//! what the manifest says), then every case not marked `skip: "rust"` is executed. The run fails on any corpus problem,
//! any mismatch, and on an empty corpus, and prints the id of every failing case with each difference.

use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use crossmap::{
    CrossmapError, CrosswalkIssue, PathStep, SyntaxIssue, TrailStep, Value, assert_round_trip,
    decode, encode, format_path, parse_crosswalk, parse_path, read_path, rule_sides, stringify,
    validate_crosswalk,
};
use crossmap_cli::{CliIo, ReadLimits, is_url, read_source};

/// The implementation this runner executes, which decides the skip list it honours.
const IMPLEMENTATION: &str = "rust";

/// The files the corpus root may hold besides the package directory.
const ROOT_FILES: [&str; 5] = [
    "README.md",
    "PROPERTIES.md",
    "case.schema.json",
    "manifest.json",
    "manifest.schema.json",
];

/// Directories skipped at any depth: they hold runners and generators, never cases.
const SKIPPED_DIRECTORIES: [&str; 4] = ["runner", "generate", "fixtures", "schema"];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance")
}

fn get<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    value.get(key)
}

fn text<'v>(value: &'v Value, key: &str) -> Option<&'v str> {
    value.get(key).and_then(Value::as_str)
}

fn integer(value: &Value, key: &str) -> Option<i64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .map(|number| number as i64)
}

// ---------------------------------------------------------------------------------------------------------------------
// The corpus format.

fn is_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn utf16_order(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// The canonical text of a value: keys in ascending UTF-16 order, two-space indent, one element per line.
fn canonical(value: &Value, indent: &str) -> String {
    let next = format!("{indent}  ");
    match value {
        Value::Array(items) if !items.is_empty() => {
            let lines: Vec<String> = items
                .iter()
                .map(|item| format!("{next}{}", canonical(item, &next)))
                .collect();
            format!("[\n{}\n{indent}]", lines.join(",\n"))
        }
        Value::Object(pairs) if !pairs.is_empty() => {
            let mut sorted: Vec<&(String, Value)> = pairs.iter().collect();
            sorted.sort_by(|left, right| utf16_order(&left.0, &right.0));
            let lines: Vec<String> = sorted
                .iter()
                .map(|(key, member)| {
                    format!(
                        "{next}{}: {}",
                        stringify(&Value::String(key.clone())),
                        canonical(member, &next)
                    )
                })
                .collect();
            format!("{{\n{}\n{indent}}}", lines.join(",\n"))
        }
        other => stringify(other),
    }
}

fn read_canonical(path: &Path, label: &str, problems: &mut Vec<String>) -> Option<Value> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            problems.push(format!("{label}: cannot be read: {error}"));
            return None;
        }
    };
    let Ok(text) = String::from_utf8(bytes) else {
        problems.push(format!("{label}: is not valid UTF-8"));
        return None;
    };
    if text.starts_with('\u{feff}') {
        problems.push(format!("{label}: begins with a byte order mark"));
        return None;
    }
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            problems.push(format!("{label}: is not JSON: {error}"));
            return None;
        }
    };
    if format!("{}\n", canonical(&value, "")) != text {
        problems.push(format!(
            "{label}: is not in canonical form (sorted keys, two-space indent, one trailing line feed)"
        ));
    }
    Some(value)
}

fn discover(root: &Path, directory: &str, problems: &mut Vec<String>, found: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(root.join(directory)) else {
        problems.push(format!("{directory}: cannot be listed"));
        return;
    };
    let mut entries: Vec<(String, bool)> = entries
        .filter_map(Result::ok)
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                entry.file_type().is_ok_and(|kind| kind.is_dir()),
            )
        })
        .collect();
    entries.sort_by(|left, right| utf16_order(&left.0, &right.0));
    for (name, is_directory) in entries {
        let relative = if directory.is_empty() {
            name.clone()
        } else {
            format!("{directory}/{name}")
        };
        if name.starts_with('.') {
            continue;
        }
        if is_directory {
            if SKIPPED_DIRECTORIES.contains(&name.as_str()) {
                continue;
            }
            if directory.is_empty() && name != "crossmap" {
                problems.push(format!(
                    "{relative}: a directory at the root that is not the package directory"
                ));
                continue;
            }
            discover(root, &relative, problems, found);
            continue;
        }
        if directory.is_empty() {
            if !ROOT_FILES.contains(&name.as_str()) {
                problems.push(format!(
                    "{relative}: a file at the root that is not one of the root files"
                ));
            }
            continue;
        }
        let stem = name.strip_suffix(".json");
        let area = directory.split('/').nth(1).unwrap_or("");
        if !stem.is_some_and(is_name) || !is_name(area) || relative.split('/').count() != 3 {
            problems.push(format!(
                "{relative}: is not a corpus file at <package>/<area>/<name>.json"
            ));
            continue;
        }
        found.push(relative);
    }
}

struct CorpusFile {
    path: String,
    cases: Vec<Value>,
}

fn load(root: &Path, problems: &mut Vec<String>) -> Vec<CorpusFile> {
    let manifest = read_canonical(&root.join("manifest.json"), "manifest.json", problems);
    let mut paths = Vec::new();
    discover(root, "", problems, &mut paths);
    let mut files = Vec::new();
    let mut ids: BTreeMap<String, String> = BTreeMap::new();
    for path in paths {
        let Some(value) = read_canonical(&root.join(&path), &path, problems) else {
            continue;
        };
        let Some(Value::Array(cases)) = get(&value, "cases") else {
            problems.push(format!("{path}: has no cases array"));
            continue;
        };
        if cases.is_empty() {
            problems.push(format!("{path}: holds no cases"));
        }
        for entry in cases {
            let (Some(id), Some(_), Some(_)) =
                (text(entry, "id"), text(entry, "from"), text(entry, "kind"))
            else {
                problems.push(format!("{path}: a case lacks its id, from or kind"));
                continue;
            };
            if !is_name(id) {
                problems.push(format!("{path}: the id {id} is not a corpus name"));
            }
            if let Some(earlier) = ids.insert(id.to_owned(), path.clone()) {
                problems.push(format!("{path}: the id {id} is also used in {earlier}"));
            }
        }
        files.push(CorpusFile {
            path,
            cases: cases.clone(),
        });
    }
    let entries = manifest
        .as_ref()
        .and_then(|manifest| get(manifest, "files"))
        .and_then(Value::as_object)
        .unwrap_or(&[]);
    if manifest.is_some() && entries.is_empty() {
        problems.push("manifest.json: lists no files".to_owned());
    }
    for file in &files {
        let Some((_, entry)) = entries.iter().find(|(path, _)| *path == file.path) else {
            problems.push(format!("{}: is not in the manifest", file.path));
            continue;
        };
        if integer(entry, "cases") != i64::try_from(file.cases.len()).ok() {
            problems.push(format!(
                "{}: the manifest's case count differs from the file's {}",
                file.path,
                file.cases.len()
            ));
        }
        for implementation in ["ts", "rust"] {
            let mut marked: Vec<&str> = file
                .cases
                .iter()
                .filter(|entry| text(entry, "skip") == Some(implementation))
                .filter_map(|entry| text(entry, "id"))
                .collect();
            marked.sort_by(|left, right| utf16_order(left, right));
            let listed: Vec<&str> = get(entry, "skip")
                .and_then(|skip| get(skip, implementation))
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if marked != listed {
                problems.push(format!(
                    "{}: the cases marked skip {implementation} differ from the manifest's sorted list",
                    file.path
                ));
            }
        }
    }
    for (path, _) in entries {
        if !files.iter().any(|file| file.path == *path) {
            problems.push(format!("{path}: is in the manifest and not on disk"));
        }
    }
    if files.iter().map(|file| file.cases.len()).sum::<usize>() == 0 {
        problems.push("the corpus holds no cases".to_owned());
    }
    files
}

// ---------------------------------------------------------------------------------------------------------------------
// Comparison.

fn same(got: &Value, expected: &Value) -> Vec<String> {
    if got.json_equal(expected) {
        Vec::new()
    } else {
        vec![format!(
            "got {}, expected {}",
            stringify(got),
            stringify(expected)
        )]
    }
}

fn compare_error(error: &CrossmapError, expected: &Value) -> Vec<String> {
    let class = text(expected, "class").unwrap_or("");
    if error.class_name() != class {
        return vec![format!(
            "expected a {class}, got {}: {error}",
            error.class_name()
        )];
    }
    let mut problems = Vec::new();
    let located = match error {
        CrossmapError::RuleApplication {
            rule_index, path, ..
        } => Some((*rule_index, path.as_str(), integer(expected, "ruleIndex"))),
        CrossmapError::RoundTripMismatch {
            sample_index, path, ..
        } => Some((
            i64::try_from(*sample_index).unwrap_or(i64::MAX),
            path.as_str(),
            integer(expected, "sampleIndex"),
        )),
        _ => None,
    };
    if let Some((index, path, expected_index)) = located {
        if let Some(expected_index) = expected_index
            && expected_index != index
        {
            problems.push(format!("index {index}, expected {expected_index}"));
        }
        if let Some(expected_path) = text(expected, "path")
            && expected_path != path
        {
            problems.push(format!("path {path}, expected {expected_path}"));
        }
    }
    let message = error.to_string();
    if let Some(wanted) = text(expected, "message")
        && wanted != message
    {
        problems.push(format!("message {message:?}, expected {wanted:?}"));
    }
    for part in get(expected, "messageContains")
        .and_then(Value::as_array)
        .unwrap_or(&[])
        .iter()
        .filter_map(Value::as_str)
    {
        if !message.contains(part) {
            problems.push(format!("message {message:?} lacks {part:?}"));
        }
    }
    if let (Some(minimum), CrossmapError::Syntax { issues }) =
        (integer(expected, "minIssues"), error)
        && i64::try_from(issues.len()).unwrap_or(i64::MAX) < minimum
    {
        problems.push(format!(
            "{} issues, expected at least {minimum}",
            issues.len()
        ));
    }
    if let (Some(wanted), CrossmapError::Structure { issues }) = (get(expected, "issues"), error) {
        problems.extend(same(&issues_value(issues), wanted));
    }
    problems
}

fn issues_value(issues: &[CrosswalkIssue]) -> Value {
    Value::Array(
        issues
            .iter()
            .map(|issue| {
                Value::Object(vec![
                    ("message".to_owned(), Value::String(issue.message.clone())),
                    (
                        "ruleIndex".to_owned(),
                        Value::Number(issue.rule_index as f64),
                    ),
                ])
            })
            .collect(),
    )
}

/// Compares an outcome with an expectation that is either `{ error }` or a success shape.
fn outcome(
    expect: &Value,
    result: Result<Value, CrossmapError>,
    success: &dyn Fn(&Value, &Value) -> Vec<String>,
) -> Vec<String> {
    match (get(expect, "error"), result) {
        (Some(wanted), Err(error)) => compare_error(&error, wanted),
        (None, Err(error)) => vec![format!(
            "threw {}: {error}, expected a result",
            error.class_name()
        )],
        (Some(wanted), Ok(value)) => vec![format!(
            "returned {}, expected a {}",
            stringify(&value),
            text(wanted, "class").unwrap_or("")
        )],
        (None, Ok(value)) => success(&value, expect),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The kinds.

fn step_value(step: &PathStep) -> Value {
    let kind = |name: &str| ("kind".to_owned(), Value::String(name.to_owned()));
    match step {
        PathStep::Key(key) => Value::Object(vec![
            kind("key"),
            ("key".to_owned(), Value::String(key.clone())),
        ]),
        PathStep::Index(index) => Value::Object(vec![
            kind("index"),
            ("index".to_owned(), Value::Number(*index as f64)),
        ]),
        PathStep::Wildcard => Value::Object(vec![kind("wildcard")]),
    }
}

fn trail_value(trail: &[TrailStep]) -> Value {
    Value::Array(
        trail
            .iter()
            .map(|step| step_value(&PathStep::from(step)))
            .collect(),
    )
}

fn steps_value(steps: &[PathStep]) -> Value {
    Value::Array(steps.iter().map(step_value).collect())
}

fn strings(values: &[String]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|value| Value::String(value.clone()))
            .collect(),
    )
}

fn required<'v>(entry: &'v Value, key: &str) -> Result<&'v Value, String> {
    get(entry, key).ok_or_else(|| format!("the case has no {key}"))
}

fn crosswalk_then<T>(
    entry: &Value,
    then: impl FnOnce(&crossmap::Crosswalk) -> Result<T, CrossmapError>,
) -> Result<T, CrossmapError> {
    let document = get(entry, "crosswalk").cloned().unwrap_or(Value::Null);
    then(&parse_crosswalk(&document)?)
}

fn execute(entry: &Value) -> Result<Vec<String>, String> {
    let kind = text(entry, "kind").unwrap_or("");
    let expect = required(entry, "expect")?;
    Ok(match kind {
        "path-parse" => {
            let path = text(entry, "path").unwrap_or("");
            outcome(
                expect,
                parse_path(path).map(|steps| steps_value(&steps)),
                &|value, expect| {
                    get(expect, "steps").map_or_else(Vec::new, |steps| same(value, steps))
                },
            )
        }
        "path-format" => {
            let path = text(entry, "path").unwrap_or("");
            let steps = parse_path(path).map_err(|error| error.to_string())?;
            let printed = format_path(&steps);
            let mut problems = same(
                &Value::String(printed.clone()),
                required(expect, "canonical")?,
            );
            if parse_path(&printed).ok() != Some(steps) {
                problems.push("the canonical spelling parses to a different path".to_owned());
            }
            problems
        }
        "path-read" => {
            let path = text(entry, "path").unwrap_or("");
            let steps = parse_path(path).map_err(|error| error.to_string())?;
            let document = required(entry, "document")?;
            match read_path(document, &steps) {
                None => same(&Value::Bool(false), required(expect, "found")?),
                Some(reading) => {
                    let matches = Value::Array(
                        reading
                            .matches
                            .iter()
                            .map(|found| {
                                Value::Object(vec![
                                    ("trail".to_owned(), trail_value(&found.trail)),
                                    ("value".to_owned(), found.value.clone()),
                                ])
                            })
                            .collect(),
                    );
                    let empties = Value::Array(
                        reading
                            .empties
                            .iter()
                            .map(|empty| {
                                Value::Object(vec![
                                    ("trail".to_owned(), trail_value(&empty.trail)),
                                    ("wildcard".to_owned(), Value::Number(empty.wildcard as f64)),
                                ])
                            })
                            .collect(),
                    );
                    let mut problems = same(&Value::Bool(true), required(expect, "found")?);
                    problems.extend(same(&matches, required(expect, "matches")?));
                    problems.extend(same(&empties, required(expect, "empties")?));
                    problems
                }
            }
        }
        "parse" => outcome(
            expect,
            crosswalk_then(entry, |crosswalk| Ok(crosswalk.to_value())),
            &|value, expect| {
                get(expect, "crosswalk").map_or_else(Vec::new, |wanted| same(value, wanted))
            },
        ),
        "validate" => {
            let issues = crosswalk_then(entry, |crosswalk| Ok(validate_crosswalk(crosswalk)))
                .map_err(|error| format!("the crosswalk does not parse: {error}"))?;
            same(
                &Value::Object(vec![("issues".to_owned(), issues_value(&issues))]),
                expect,
            )
        }
        "rule-sides" => {
            let document = Value::Object(vec![
                ("source".to_owned(), Value::String("n".to_owned())),
                ("target".to_owned(), Value::String("s".to_owned())),
                (
                    "rules".to_owned(),
                    Value::Array(vec![required(entry, "rule")?.clone()]),
                ),
            ]);
            let crosswalk = parse_crosswalk(&document).map_err(|error| error.to_string())?;
            let rule = crosswalk.rules().first().ok_or("the rule did not parse")?;
            let sides = rule_sides(rule);
            same(
                &Value::Object(vec![
                    ("from".to_owned(), strings(&sides.from)),
                    ("to".to_owned(), strings(&sides.to)),
                ]),
                expect,
            )
        }
        "error-message" => error_message(entry, expect)?,
        "run" => {
            let document = required(entry, "document")?;
            let direction = text(entry, "direction").unwrap_or("");
            let result = crosswalk_then(entry, |crosswalk| {
                if direction == "encode" {
                    encode(crosswalk, document)
                } else {
                    decode(crosswalk, document)
                }
            });
            outcome(expect, result, &|value, expect| {
                let mut problems =
                    get(expect, "output").map_or_else(Vec::new, |output| same(value, output));
                if let Some(wanted) = text(expect, "outputText")
                    && stringify(value) != wanted
                {
                    problems.push(format!(
                        "serialised as {}, expected {wanted}",
                        stringify(value)
                    ));
                }
                problems
            })
        }
        "round-trip" => {
            let samples = required(entry, "samples")?
                .as_array()
                .ok_or("samples is not an array")?;
            let result = crosswalk_then(entry, |crosswalk| assert_round_trip(crosswalk, samples))
                .map(|()| Value::Bool(true));
            outcome(expect, result, &|value, expect| {
                get(expect, "ok").map_or_else(Vec::new, |ok| same(value, ok))
            })
        }
        "is-url" => same(
            &Value::Bool(is_url(text(entry, "argument").unwrap_or(""))),
            expect,
        ),
        "cli" => cli_case(entry, expect)?,
        "schema-canonical"
        | "schema-when-ref"
        | "schema-pointer"
        | "schema-rule-requires-to"
        | "schema-validates" => {
            vec!["the JSON Schema is not generated by the Rust crates yet".to_owned()]
        }
        other => vec![format!("unknown kind {other}")],
    })
}

fn error_message(entry: &Value, expect: &Value) -> Result<Vec<String>, String> {
    let error = required(entry, "error")?;
    let message = |issue: &Value| text(issue, "message").unwrap_or("").to_owned();
    let issues = get(error, "issues")
        .and_then(Value::as_array)
        .unwrap_or(&[]);
    let built = match text(error, "class").unwrap_or("") {
        "CrosswalkSyntaxError" => CrossmapError::Syntax {
            issues: issues
                .iter()
                .map(|issue| SyntaxIssue {
                    message: message(issue),
                })
                .collect(),
        },
        "CrosswalkStructureError" => CrossmapError::Structure {
            issues: issues
                .iter()
                .map(|issue| CrosswalkIssue {
                    rule_index: integer(issue, "ruleIndex").unwrap_or(0),
                    message: message(issue),
                })
                .collect(),
        },
        "RuleApplicationError" => CrossmapError::RuleApplication {
            rule_index: integer(error, "ruleIndex").unwrap_or(0),
            path: text(error, "path").unwrap_or("").to_owned(),
            detail: message(error),
        },
        "RoundTripMismatchError" => CrossmapError::RoundTripMismatch {
            sample_index: usize::try_from(integer(error, "sampleIndex").unwrap_or(0)).unwrap_or(0),
            path: text(error, "path").unwrap_or("").to_owned(),
            detail: message(error),
        },
        other => return Ok(vec![format!("unknown error class {other}")]),
    };
    Ok(same(
        &Value::String(built.to_string()),
        required(expect, "message")?,
    ))
}

// ---------------------------------------------------------------------------------------------------------------------
// Command-line cases.

fn substitute(text: &str, replacements: &[(&str, &str)]) -> String {
    replacements
        .iter()
        .fold(text.to_owned(), |current, (name, value)| {
            current.replace(&format!("{{{name}}}"), value)
        })
}

struct CaseIo {
    stdin: String,
    stdout: String,
    stderr: String,
}

impl CliIo for CaseIo {
    fn read_text(&self, source: &str) -> Result<String, String> {
        if source == crossmap_cli::STDIN {
            Ok(self.stdin.clone())
        } else {
            read_source(source, ReadLimits::default())
        }
    }

    fn write_stdout(&mut self, text: &str) {
        self.stdout.push_str(text);
    }

    fn write_stderr(&mut self, text: &str) {
        self.stderr.push_str(text);
    }

    fn version(&self) -> &str {
        crossmap_cli::VERSION
    }
}

/// A local HTTP server answering each request path with the case's response, until it is stopped.
struct Server {
    origin: String,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    fn start(responses: &Value) -> Result<Server, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
        let origin = format!(
            "http://127.0.0.1:{}",
            listener
                .local_addr()
                .map_err(|error| error.to_string())?
                .port()
        );
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let responses = responses.clone();
        let stopping = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        respond(stream, &responses);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Server {
            origin,
            stop,
            handle: Some(handle),
        })
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        302 => "Found",
        404 => "Not Found",
        410 => "Gone",
        _ => "",
    }
}

fn respond(stream: std::net::TcpStream, responses: &Value) {
    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    loop {
        let mut header = String::new();
        match reader.read_line(&mut header) {
            Ok(0) | Err(_) => break,
            Ok(_) if header == "\r\n" || header == "\n" => break,
            Ok(_) => {}
        }
    }
    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    let found = responses.get(path);
    let status = found
        .and_then(|response| integer(response, "status"))
        .unwrap_or(404);
    let body = found
        .and_then(|response| text(response, "body"))
        .unwrap_or("missing");
    let status = u16::try_from(status).unwrap_or(500);
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n",
        reason(status),
        body.len()
    );
    if let Some(Value::Object(headers)) = found.and_then(|response| response.get("headers")) {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
        }
    }
    head.push_str("\r\n");
    let mut writer = &stream;
    let _ = writer.write_all(head.as_bytes());
    let _ = writer.write_all(body.as_bytes());
    let _ = writer.flush();
    let mut rest = Vec::new();
    let _ = reader.read_to_end(&mut rest);
}

static CASE_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

fn cli_case(entry: &Value, expect: &Value) -> Result<Vec<String>, String> {
    let dir = std::env::temp_dir().join(format!(
        "crossmap-conformance-{}-{}",
        std::process::id(),
        CASE_DIRECTORY.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let result = run_cli_case(entry, expect, &dir);
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn run_cli_case(entry: &Value, expect: &Value, dir: &Path) -> Result<Vec<String>, String> {
    let server = match get(entry, "server") {
        Some(responses) => Some(Server::start(responses)?),
        None => None,
    };
    let dir_text = dir.to_string_lossy().into_owned();
    let origin = server
        .as_ref()
        .map_or_else(String::new, |server| server.origin.clone());
    let replacements = [
        ("dir", dir_text.as_str()),
        ("origin", origin.as_str()),
        ("version", crossmap_cli::VERSION),
    ];
    if let Some(Value::Object(files)) = get(entry, "files") {
        for (name, content) in files {
            let path = dir.join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::write(&path, content.as_str().unwrap_or(""))
                .map_err(|error| error.to_string())?;
        }
    }
    let args: Vec<String> = get(entry, "args")
        .and_then(Value::as_array)
        .unwrap_or(&[])
        .iter()
        .filter_map(Value::as_str)
        .map(|argument| substitute(argument, &replacements))
        .collect();
    let mut io = CaseIo {
        stdin: text(entry, "stdin").unwrap_or("").to_owned(),
        stdout: String::new(),
        stderr: String::new(),
    };
    let status = crossmap_cli::run(&args, &mut io);
    drop(server);
    let mut problems = Vec::new();
    if Some(i64::from(status)) != integer(expect, "status") {
        problems.push(format!(
            "exit status {status}, expected {:?}",
            integer(expect, "status")
        ));
    }
    let stream = |name: &str, got: &str, wanted: &Value, problems: &mut Vec<String>| match wanted {
        Value::String(exact) => {
            let exact = substitute(exact, &replacements);
            if got != exact {
                problems.push(format!("{name} was {got:?}, expected {exact:?}"));
            }
        }
        other => {
            for part in get(other, "contains")
                .and_then(Value::as_array)
                .unwrap_or(&[])
                .iter()
                .filter_map(Value::as_str)
            {
                let part = substitute(part, &replacements);
                if !got.contains(&part) {
                    problems.push(format!("{name} {got:?} lacks {part:?}"));
                }
            }
        }
    };
    if let Some(wanted) = get(expect, "stdout") {
        stream("stdout", &io.stdout, wanted, &mut problems);
    }
    if let Some(wanted) = get(expect, "stdoutJson") {
        match serde_json::from_str::<Value>(&io.stdout) {
            Ok(printed) => problems.extend(same(&printed, wanted)),
            Err(_) => problems.push(format!("stdout is not JSON: {:?}", io.stdout)),
        }
    }
    if let Some(wanted) = get(expect, "stderr") {
        if let Some(equals) = get(wanted, "equals") {
            stream("stderr", &io.stderr, equals, &mut problems);
        }
        if let Some(prefix) = text(wanted, "startsWith") {
            let prefix = substitute(prefix, &replacements);
            if !io.stderr.starts_with(&prefix) {
                problems.push(format!(
                    "stderr {:?} does not start with {prefix:?}",
                    io.stderr
                ));
            }
        }
        if let Some(contains) = get(wanted, "contains") {
            let wrapped = Value::Object(vec![("contains".to_owned(), contains.clone())]);
            stream("stderr", &io.stderr, &wrapped, &mut problems);
        }
    }
    Ok(problems)
}

// ---------------------------------------------------------------------------------------------------------------------

fn main() -> ExitCode {
    let root = root();
    let mut problems = Vec::new();
    let files = load(&root, &mut problems);
    let filter = std::env::var("CROSSMAP_CONFORMANCE_FILTER").ok();
    let mut executed = 0;
    let mut skipped = 0;
    let mut passed = 0;
    let mut total = 0;
    let mut failures: Vec<String> = Vec::new();
    let mut per_area: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for file in &files {
        let area = file.path.split('/').nth(1).unwrap_or("").to_owned();
        for entry in &file.cases {
            total += 1;
            let id = text(entry, "id").unwrap_or("");
            if text(entry, "skip") == Some(IMPLEMENTATION) {
                skipped += 1;
                continue;
            }
            if filter.as_deref().is_some_and(|filter| !id.contains(filter)) {
                continue;
            }
            executed += 1;
            let found = execute(entry).unwrap_or_else(|problem| {
                vec![format!("the runner failed on this case: {problem}")]
            });
            let counts = per_area.entry(area.clone()).or_default();
            counts.1 += 1;
            if found.is_empty() {
                passed += 1;
                counts.0 += 1;
            } else {
                failures.push(format!("{id} ({}): {}", file.path, found.join("; ")));
            }
        }
    }
    let mut out = std::io::stdout().lock();
    for (area, (area_passed, area_run)) in &per_area {
        let _ = writeln!(out, "{area}: {area_passed}/{area_run}");
    }
    for problem in &problems {
        let _ = writeln!(out, "corpus problem: {problem}");
    }
    for failure in &failures {
        let _ = writeln!(out, "FAIL {failure}");
    }
    let _ = writeln!(
        out,
        "conformance (rust): {passed} passed of {total} cases; {executed} executed, {skipped} skipped, {} failed, {} corpus problems",
        failures.len(),
        problems.len()
    );
    if problems.is_empty()
        && failures.is_empty()
        && executed > 0
        && filter.is_none()
        && executed + skipped == total
    {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

//! The wasm binding of crossmap, which the npm package `crossmap` is built from.
//!
//! The package's API is JavaScript (`api.js`, written by the package build) over what this exports: a [`Codec`] per
//! crosswalk object, holding the parsed crosswalk and its prepared form, and the free functions that need no
//! crosswalk. Documents cross as JavaScript values (see [`convert`]). The error classes are JavaScript too, handed to
//! [`register_error_classes`] by the package's entry point, and every [`CrossmapError`] is thrown as an instance of
//! its class with the fields the TypeScript implementation's had. A `when` gate is evaluated here, by the core crate.
//!
//! The binding does no input or output. The command's steps ([`cli_plan`], [`cli_complete`]) are the native
//! command's own, from `crossmap-cli` without its reader; the package's Node shim reads the files, standard input
//! and URLs between them.
//!
//! Exports named `conformance*` exist for the package's conformance suite, which runs the corpus's path cases
//! through the packed package. The entry point does not re-export them and they are not part of the API.

mod convert;

use std::cell::RefCell;

use crossmap::{
    CrossmapError, Crosswalk, PathStep, TrailStep, Value, assert_round_trip, compile_crosswalk,
    format_path, parse_crosswalk, parse_path, read_path, rule_sides, validate_crosswalk,
};
use js_sys::{Array, Function, Object, Reflect};
use wasm_bindgen::prelude::*;

/// The error classes the package's entry point registers.
struct ErrorClasses {
    syntax: Function,
    structure: Function,
    rule_application: Function,
    round_trip_mismatch: Function,
}

thread_local! {
    static CLASSES: RefCell<Option<ErrorClasses>> = const { RefCell::new(None) };
}

/// Hands the binding the classes it throws and installs the panic hook. The package's entry point calls it once,
/// with `CrosswalkSyntaxError`, `CrosswalkStructureError`, `RuleApplicationError` and `RoundTripMismatchError` in that
/// order, before anything else in the package can run.
///
/// A panic would otherwise reach JavaScript as a bare `RuntimeError: unreachable`. The hook throws an `Error` carrying
/// the panic's message and location instead, from inside the panic, so the instance is spent afterwards: a caller
/// that sees `crossmap: internal error` should report it rather than retry.
#[wasm_bindgen(js_name = registerErrorClasses)]
pub fn register_error_classes(
    syntax: Function,
    structure: Function,
    rule_application: Function,
    round_trip_mismatch: Function,
) {
    CLASSES.with(|classes| {
        *classes.borrow_mut() = Some(ErrorClasses {
            syntax,
            structure,
            rule_application,
            round_trip_mismatch,
        });
    });
    std::panic::set_hook(Box::new(|info| {
        wasm_bindgen::throw_val(
            js_sys::Error::new(&format!("crossmap: internal error: {info}")).into(),
        )
    }));
}

fn set(object: &Object, key: &str, value: &JsValue) {
    Reflect::set(object, &JsValue::from_str(key), value).unwrap_throw();
}

fn record(fields: &[(&str, JsValue)]) -> JsValue {
    let object = Object::new();
    for (key, value) in fields {
        set(&object, key, value);
    }
    object.into()
}

fn number(value: impl Into<f64>) -> JsValue {
    JsValue::from_f64(value.into())
}

/// An index as a JavaScript number. An index or count addresses memory in a 32-bit module, far below 2^53, where a
/// double stops being exact, so the conversion is exact.
fn index_number(value: usize) -> JsValue {
    JsValue::from_f64(value as f64)
}

/// A rule index as a JavaScript number: an index as [`index_number`], or a small negative number for a failure no rule
/// owns, so the conversion is exact.
fn signed_number(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}

fn issues_to_js(issues: &[crossmap::CrosswalkIssue]) -> JsValue {
    issues
        .iter()
        .map(|issue| {
            record(&[
                ("ruleIndex", signed_number(issue.rule_index)),
                ("message", JsValue::from_str(&issue.message)),
            ])
        })
        .collect::<Array>()
        .into()
}

/// The error as an instance of its JavaScript class, constructed with the arguments the TypeScript implementation's
/// constructor took, so its message is built by the same code whoever constructs it. A `when` that cannot be
/// evaluated is a plain `Error`, as it was in TypeScript.
fn error_to_js(error: &CrossmapError) -> JsValue {
    let construct = |class: fn(&ErrorClasses) -> &Function, arguments: Vec<JsValue>| {
        CLASSES.with(|classes| match classes.borrow().as_ref() {
            Some(registered) => {
                Reflect::construct(class(registered), &arguments.into_iter().collect::<Array>())
                    .unwrap_throw()
            }
            None => js_sys::Error::new(
                "crossmap: import the package entry point, which registers the error classes",
            )
            .into(),
        })
    };
    match error {
        CrossmapError::Syntax { issues } => construct(
            |classes| &classes.syntax,
            vec![
                issues
                    .iter()
                    .map(|issue| record(&[("message", JsValue::from_str(&issue.message))]))
                    .collect::<Array>()
                    .into(),
            ],
        ),
        CrossmapError::Structure { issues } => {
            construct(|classes| &classes.structure, vec![issues_to_js(issues)])
        }
        CrossmapError::RuleApplication {
            rule_index,
            path,
            detail,
        } => construct(
            |classes| &classes.rule_application,
            vec![
                signed_number(*rule_index),
                JsValue::from_str(path),
                JsValue::from_str(detail),
            ],
        ),
        CrossmapError::RoundTripMismatch {
            sample_index,
            path,
            detail,
        } => construct(
            |classes| &classes.round_trip_mismatch,
            vec![
                index_number(*sample_index),
                JsValue::from_str(path),
                JsValue::from_str(detail),
            ],
        ),
        CrossmapError::WhenEvaluation { message } => js_sys::Error::new(message).into(),
    }
}

fn thrown<T>(result: Result<T, CrossmapError>) -> Result<T, JsValue> {
    result.map_err(|error| error_to_js(&error))
}

fn parse(document: &JsValue) -> Result<Crosswalk, JsValue> {
    thrown(parse_crosswalk(&convert::from_js(
        document,
        "the crosswalk",
    )?))
}

/// One crosswalk, parsed from a JavaScript value, with the form the executor prepares the first time it runs. The
/// package keeps one per crosswalk object.
#[wasm_bindgen]
pub struct Codec {
    crosswalk: Crosswalk,
}

#[wasm_bindgen]
impl Codec {
    /// Parses the crosswalk.
    ///
    /// # Errors
    ///
    /// `CrosswalkSyntaxError` when it is not a crosswalk; a `TypeError` when it is not a JSON value.
    #[wasm_bindgen(constructor)]
    pub fn new(crosswalk: &JsValue) -> Result<Codec, JsValue> {
        Ok(Codec {
            crosswalk: parse(crosswalk)?,
        })
    }

    /// The parsed crosswalk: defaults filled in, kept paths as moves, every `to` present.
    pub fn parsed(&self) -> JsValue {
        convert::to_js(&self.crosswalk.to_value())
    }

    /// The structural issues of the crosswalk, as `{ ruleIndex, message }` records.
    pub fn validate(&self) -> JsValue {
        issues_to_js(&validate_crosswalk(&self.crosswalk))
    }

    /// Validates and prepares the crosswalk, which happens once whatever is called afterwards.
    ///
    /// # Errors
    ///
    /// `CrosswalkStructureError` when the crosswalk fails structural validation.
    pub fn compile(&self) -> Result<(), JsValue> {
        thrown(compile_crosswalk(&self.crosswalk).map(|_| ()))
    }

    /// Encodes a native document into the shared shape.
    ///
    /// # Errors
    ///
    /// As the core crate's `encode`, each thrown as its class; a `TypeError` when the document is not a JSON value.
    pub fn encode(&self, document: &JsValue) -> Result<JsValue, JsValue> {
        let document = convert::from_js(document, "the document")?;
        let compiled = thrown(compile_crosswalk(&self.crosswalk))?;
        Ok(convert::to_js(&thrown(compiled.encode(&document))?))
    }

    /// Decodes a shared document back into the native shape.
    ///
    /// # Errors
    ///
    /// As [`Codec::encode`].
    pub fn decode(&self, document: &JsValue) -> Result<JsValue, JsValue> {
        let document = convert::from_js(document, "the document")?;
        let compiled = thrown(compile_crosswalk(&self.crosswalk))?;
        Ok(convert::to_js(&thrown(compiled.decode(&document))?))
    }

    /// Checks that decoding the encoding of every sample reproduces it on the paths the crosswalk preserves.
    ///
    /// # Errors
    ///
    /// `RoundTripMismatchError` on the first difference, or what encoding or decoding a sample throws; a `TypeError`
    /// when `samples` is not an array of JSON values.
    #[wasm_bindgen(js_name = assertRoundTrip)]
    pub fn assert_round_trip(&self, samples: &JsValue) -> Result<(), JsValue> {
        if !Array::is_array(samples) {
            return Err(js_sys::TypeError::new("the samples are not an array").into());
        }
        let samples: &Array = samples.unchecked_ref();
        let mut read = Vec::with_capacity(samples.length() as usize);
        for (index, sample) in samples.iter().enumerate() {
            read.push(convert::from_js(&sample, &format!("sample {index}"))?);
        }
        thrown(assert_round_trip(&self.crosswalk, &read))
    }
}

/// The paths a two-way rule reads and writes, as `{ from, to }` lists of path strings.
///
/// # Errors
///
/// `CrosswalkSyntaxError` when it is not a two-way rule.
#[wasm_bindgen(js_name = ruleSides)]
pub fn rule_sides_js(rule: &JsValue) -> Result<JsValue, JsValue> {
    let rule = convert::from_js(rule, "the rule")?;
    let crosswalk = thrown(parse_crosswalk(&Value::Object(vec![
        ("source".to_owned(), Value::String(String::new())),
        ("target".to_owned(), Value::String(String::new())),
        ("rules".to_owned(), Value::Array(vec![rule])),
    ])))?;
    let Some(rule) = crosswalk.rules().first() else {
        return Err(js_sys::Error::new("crossmap: the rule did not parse").into());
    };
    let sides = rule_sides(rule);
    let strings = |paths: &[String]| -> JsValue {
        paths
            .iter()
            .map(|path| JsValue::from_str(path))
            .collect::<Array>()
            .into()
    };
    Ok(record(&[
        ("from", strings(&sides.from)),
        ("to", strings(&sides.to)),
    ]))
}

fn outcome_to_js(outcome: &crossmap_cli::Outcome) -> JsValue {
    record(&[
        ("status", number(outcome.status)),
        ("stdout", JsValue::from_str(&outcome.stdout)),
        ("stderr", JsValue::from_str(&outcome.stderr)),
    ])
}

/// The command's first step: `{ operands }`, the sources to read in argument order, or `{ status, stdout, stderr }`
/// when the command ends without reading anything. `version` is what `--version` prints.
#[wasm_bindgen(js_name = cliPlan)]
pub fn cli_plan(args: Vec<String>, version: &str) -> JsValue {
    match crossmap_cli::plan(&args, version) {
        Ok(invocation) => record(&[(
            "operands",
            invocation
                .operands()
                .iter()
                .map(|operand| JsValue::from_str(operand))
                .collect::<Array>()
                .into(),
        )]),
        Err(outcome) => outcome_to_js(&outcome),
    }
}

/// The command's second step: `{ status, stdout, stderr }` from the same arguments and, for each operand
/// [`cli_plan`] named, `{ text }` or `{ error }` with why it could not be read.
///
/// # Errors
///
/// A `TypeError` when a read is neither.
#[wasm_bindgen(js_name = cliComplete)]
pub fn cli_complete(args: Vec<String>, version: &str, reads: &Array) -> Result<JsValue, JsValue> {
    let invocation = match crossmap_cli::plan(&args, version) {
        Ok(invocation) => invocation,
        Err(outcome) => return Ok(outcome_to_js(&outcome)),
    };
    let mut texts = Vec::with_capacity(reads.length() as usize);
    for read in reads.iter() {
        let field = |key: &str| Reflect::get(&read, &JsValue::from_str(key)).ok();
        match (
            field("text").and_then(|text| text.as_string()),
            field("error").and_then(|error| error.as_string()),
        ) {
            (Some(text), None) => texts.push(Ok(text)),
            (None, Some(error)) => texts.push(Err(error)),
            _ => {
                return Err(js_sys::TypeError::new(
                    "a read is { text } or { error }, each a string",
                )
                .into());
            }
        }
    }
    Ok(outcome_to_js(&crossmap_cli::complete(&invocation, texts)))
}

/// Whether the command reads an argument as a URL.
#[wasm_bindgen(js_name = cliIsUrl)]
pub fn cli_is_url(argument: &str) -> bool {
    crossmap_cli::is_url(argument)
}

fn step_to_js(step: &PathStep) -> JsValue {
    match step {
        PathStep::Key(key) => record(&[
            ("kind", JsValue::from_str("key")),
            ("key", JsValue::from_str(key)),
        ]),
        PathStep::Index(index) => record(&[
            ("kind", JsValue::from_str("index")),
            ("index", index_number(*index)),
        ]),
        PathStep::Wildcard => record(&[("kind", JsValue::from_str("wildcard"))]),
    }
}

fn trail_to_js(trail: &[TrailStep]) -> JsValue {
    trail
        .iter()
        .map(|step| step_to_js(&PathStep::from(step)))
        .collect::<Array>()
        .into()
}

/// The steps a path parses to, for the corpus's `path-parse` cases.
///
/// # Errors
///
/// `CrosswalkSyntaxError` when the path does not parse.
#[wasm_bindgen(js_name = conformancePathParse)]
pub fn conformance_path_parse(path: &str) -> Result<JsValue, JsValue> {
    Ok(thrown(parse_path(path))?
        .iter()
        .map(step_to_js)
        .collect::<Array>()
        .into())
}

/// The canonical spelling of a path, for the corpus's `path-format` cases.
///
/// # Errors
///
/// `CrosswalkSyntaxError` when the path does not parse.
#[wasm_bindgen(js_name = conformancePathFormat)]
pub fn conformance_path_format(path: &str) -> Result<String, JsValue> {
    Ok(format_path(&thrown(parse_path(path))?))
}

/// What a path reads in a document, `{ found: false }` or `{ found: true, matches, empties }`, for the corpus's
/// `path-read` cases.
///
/// # Errors
///
/// `CrosswalkSyntaxError` when the path does not parse; a `TypeError` when the document is not a JSON value.
#[wasm_bindgen(js_name = conformancePathRead)]
pub fn conformance_path_read(document: &JsValue, path: &str) -> Result<JsValue, JsValue> {
    let steps = thrown(parse_path(path))?;
    let document = convert::from_js(document, "the document")?;
    Ok(match read_path(&document, &steps) {
        None => record(&[("found", JsValue::FALSE)]),
        Some(reading) => record(&[
            ("found", JsValue::TRUE),
            (
                "matches",
                reading
                    .matches
                    .iter()
                    .map(|found| {
                        record(&[
                            ("trail", trail_to_js(&found.trail)),
                            ("value", convert::to_js(found.value)),
                        ])
                    })
                    .collect::<Array>()
                    .into(),
            ),
            (
                "empties",
                reading
                    .empties
                    .iter()
                    .map(|empty| {
                        record(&[
                            ("trail", trail_to_js(&empty.trail)),
                            ("wildcard", index_number(empty.wildcard)),
                        ])
                    })
                    .collect::<Array>()
                    .into(),
            ),
        ]),
    })
}

//! The Python binding of crossmap: the `crosswalk_codec._native` extension module, which the pure Python package
//! `crosswalk_codec` re-exports.
//!
//! Documents cross the boundary as native Python values (`dict`, `list`, `str`, `int`, `float`, `bool`, `None`),
//! converted once in each direction straight between the Python objects and the codec's [`Value`], never through JSON
//! text. The codec runs with the interpreter detached, so other Python threads run while a document is translated.
//!
//! Errors are raised as the exception classes `crosswalk_codec._errors` defines, constructed from the fields of the
//! [`CrossmapError`] they report, so a Python caller reads the same rule index, path and sample index the Rust error
//! carries, and the message is the one the Rust error displays.

#![forbid(unsafe_code)]

mod convert;

use crossmap::{
    CrossmapError, Crosswalk, CrosswalkIssue, PathStep, SyntaxIssue, TrailStep, Value,
    assert_round_trip, compile_crosswalk, decode, encode, format_path, parse_crosswalk, parse_path,
    read_path, rule_sides, validate_crosswalk,
};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

use convert::{from_value, to_value};

/// The module the exception and issue classes live in.
const ERRORS_MODULE: &str = "crosswalk_codec._errors";

/// The Python exception for a codec error: an instance of the matching `crosswalk_codec._errors` class, or a
/// `ValueError` for a `when` predicate that cannot be evaluated at all, which the TypeScript implementation also reports
/// outside its error classes.
fn raise(py: Python<'_>, error: CrossmapError) -> PyErr {
    match build_exception(py, error) {
        Ok(exception) => exception,
        Err(failure) => failure,
    }
}

fn build_exception(py: Python<'_>, error: CrossmapError) -> PyResult<PyErr> {
    let errors = py.import(ERRORS_MODULE)?;
    let instance = match error {
        CrossmapError::Syntax { issues } => {
            let class = errors.getattr("SyntaxIssue")?;
            let issues: Vec<Bound<'_, PyAny>> = issues
                .into_iter()
                .map(|issue| class.call1((issue.message,)))
                .collect::<PyResult<_>>()?;
            errors
                .getattr("CrosswalkSyntaxError")?
                .call1((PyList::new(py, issues)?,))?
        }
        CrossmapError::Structure { issues } => errors
            .getattr("CrosswalkStructureError")?
            .call1((issue_list(py, issues)?,))?,
        CrossmapError::RuleApplication {
            rule_index,
            path,
            detail,
        } => errors
            .getattr("RuleApplicationError")?
            .call1((rule_index, path, detail))?,
        CrossmapError::RoundTripMismatch {
            sample_index,
            path,
            detail,
        } => errors
            .getattr("RoundTripMismatchError")?
            .call1((sample_index, path, detail))?,
        CrossmapError::WhenEvaluation { message } => return Ok(PyValueError::new_err(message)),
    };
    Ok(PyErr::from_value(instance))
}

fn issue_list(py: Python<'_>, issues: Vec<CrosswalkIssue>) -> PyResult<Bound<'_, PyList>> {
    let class = py.import(ERRORS_MODULE)?.getattr("CrosswalkIssue")?;
    let issues: Vec<Bound<'_, PyAny>> = issues
        .into_iter()
        .map(|issue| class.call1((issue.rule_index, issue.message)))
        .collect::<PyResult<_>>()?;
    PyList::new(py, issues)
}

/// A parsed crosswalk: defaults filled in, kept paths turned into moves, every `to` present. It is immutable, and the
/// codec validates and prepares it once, the first time it is used, however many documents it then translates.
#[pyclass(frozen, eq, name = "Crosswalk", module = "crosswalk_codec")]
#[derive(PartialEq)]
struct PyCrosswalk {
    inner: Crosswalk,
}

#[pymethods]
impl PyCrosswalk {
    /// The label naming the native shape.
    #[getter]
    fn source(&self) -> &str {
        self.inner.source()
    }

    /// The label naming the shared shape.
    #[getter]
    fn target(&self) -> &str {
        self.inner.target()
    }

    /// The `$schema` the document named, if it named one.
    #[getter]
    fn schema(&self) -> Option<&str> {
        self.inner.schema()
    }

    /// The parsed crosswalk as a JSON document, the form `parse_crosswalk` accepts.
    fn to_dict<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        from_value(py, self.inner.to_value())
    }

    fn __repr__(&self) -> String {
        format!(
            "Crosswalk(source={:?}, target={:?}, rules={}, one_way={})",
            self.inner.source(),
            self.inner.target(),
            self.inner.rules().len(),
            self.inner.one_way().len()
        )
    }
}

/// A crosswalk validated and prepared up front, translating documents in either direction.
#[pyclass(frozen, name = "CompiledCrosswalk", module = "crosswalk_codec")]
struct PyCompiled {
    crosswalk: Py<PyCrosswalk>,
}

#[pymethods]
impl PyCompiled {
    /// The crosswalk this was compiled from.
    #[getter]
    fn crosswalk(&self, py: Python<'_>) -> Py<PyCrosswalk> {
        self.crosswalk.clone_ref(py)
    }

    /// The document translated from the native shape to the shared shape.
    fn encode<'py>(
        &self,
        py: Python<'py>,
        document: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyAny>> {
        run_codec(py, &self.crosswalk.get().inner, document, Way::Encode)
    }

    /// The document translated back, from the shared shape to the native shape.
    fn decode<'py>(
        &self,
        py: Python<'py>,
        document: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyAny>> {
        run_codec(py, &self.crosswalk.get().inner, document, Way::Decode)
    }
}

#[derive(Clone, Copy)]
enum Way {
    Encode,
    Decode,
}

fn run_codec<'py>(
    py: Python<'py>,
    crosswalk: &Crosswalk,
    document: &Bound<'py, PyAny>,
    way: Way,
) -> PyResult<Bound<'py, PyAny>> {
    let value = to_value(document, "document")?;
    let result = py.detach(|| match way {
        Way::Encode => encode(crosswalk, &value),
        Way::Decode => decode(crosswalk, &value),
    });
    from_value(py, result.map_err(|error| raise(py, error))?)
}

/// Parses a JSON document as a crosswalk.
#[pyfunction(name = "parse_crosswalk")]
fn py_parse_crosswalk(py: Python<'_>, document: &Bound<'_, PyAny>) -> PyResult<PyCrosswalk> {
    let value = to_value(document, "document")?;
    py.detach(|| parse_crosswalk(&value))
        .map(|inner| PyCrosswalk { inner })
        .map_err(|error| raise(py, error))
}

/// Every structural defect of the crosswalk's rule list, empty when it can execute.
#[pyfunction(name = "validate_crosswalk")]
fn py_validate_crosswalk<'py>(
    py: Python<'py>,
    crosswalk: &Bound<'py, PyCrosswalk>,
) -> PyResult<Bound<'py, PyList>> {
    let inner = &crosswalk.get().inner;
    issue_list(py, py.detach(|| validate_crosswalk(inner)))
}

/// Validates and prepares the crosswalk now, raising `CrosswalkStructureError` here rather than on the first document.
#[pyfunction(name = "compile_crosswalk")]
fn py_compile_crosswalk(py: Python<'_>, crosswalk: Bound<'_, PyCrosswalk>) -> PyResult<PyCompiled> {
    let inner = &crosswalk.get().inner;
    py.detach(|| compile_crosswalk(inner).map(|_| ()))
        .map_err(|error| raise(py, error))?;
    Ok(PyCompiled {
        crosswalk: crosswalk.unbind(),
    })
}

/// The document translated from the native shape to the shared shape.
#[pyfunction(name = "encode")]
fn py_encode<'py>(
    py: Python<'py>,
    crosswalk: &Bound<'py, PyCrosswalk>,
    document: &Bound<'py, PyAny>,
) -> PyResult<Bound<'py, PyAny>> {
    run_codec(py, &crosswalk.get().inner, document, Way::Encode)
}

/// The document translated back, from the shared shape to the native shape.
#[pyfunction(name = "decode")]
fn py_decode<'py>(
    py: Python<'py>,
    crosswalk: &Bound<'py, PyCrosswalk>,
    document: &Bound<'py, PyAny>,
) -> PyResult<Bound<'py, PyAny>> {
    run_codec(py, &crosswalk.get().inner, document, Way::Decode)
}

/// Encodes and decodes every sample and raises `RoundTripMismatchError` at the first path where the result differs
/// from the sample, leaving out the paths one-way rules touch.
#[pyfunction(name = "assert_round_trip")]
fn py_assert_round_trip(
    py: Python<'_>,
    crosswalk: &Bound<'_, PyCrosswalk>,
    samples: &Bound<'_, PyAny>,
) -> PyResult<()> {
    let samples: Vec<Value> = samples
        .try_iter()?
        .enumerate()
        .map(|(index, sample)| to_value(&sample?, &format!("samples[{index}]")))
        .collect::<PyResult<_>>()?;
    let inner = &crosswalk.get().inner;
    py.detach(|| assert_round_trip(inner, &samples))
        .map_err(|error| raise(py, error))
}

/// The `from` and `to` paths of a two-way rule, as two lists. The rule is a JSON rule document, such as an element of
/// a parsed crosswalk's `rules`; it is parsed as a crosswalk's only rule, so a syntax error names it as `rules.0`.
#[pyfunction(name = "rule_sides")]
fn py_rule_sides(py: Python<'_>, rule: &Bound<'_, PyAny>) -> PyResult<(Vec<String>, Vec<String>)> {
    let rule = to_value(rule, "rule")?;
    let document = Value::Object(vec![
        ("source".to_owned(), Value::String(String::new())),
        ("target".to_owned(), Value::String(String::new())),
        ("rules".to_owned(), Value::Array(vec![rule])),
    ]);
    let crosswalk = parse_crosswalk(&document).map_err(|error| raise(py, error))?;
    let sides = crosswalk
        .rules()
        .first()
        .map(rule_sides)
        .ok_or_else(|| PyValueError::new_err("the rule did not parse"))?;
    Ok((sides.from, sides.to))
}

/// The message a `CrosswalkSyntaxError` with these issue messages displays.
#[pyfunction]
fn format_syntax_error(messages: Vec<String>) -> String {
    CrossmapError::Syntax {
        issues: messages
            .into_iter()
            .map(|message| SyntaxIssue { message })
            .collect(),
    }
    .to_string()
}

/// The message a `CrosswalkStructureError` with these `(rule index, message)` issues displays.
#[pyfunction]
fn format_structure_error(issues: Vec<(i64, String)>) -> String {
    CrossmapError::Structure {
        issues: issues
            .into_iter()
            .map(|(rule_index, message)| CrosswalkIssue {
                rule_index,
                message,
            })
            .collect(),
    }
    .to_string()
}

/// The message a `RuleApplicationError` displays.
#[pyfunction]
fn format_rule_application_error(rule_index: i64, path: String, detail: String) -> String {
    CrossmapError::RuleApplication {
        rule_index,
        path,
        detail,
    }
    .to_string()
}

/// The message a `RoundTripMismatchError` displays.
#[pyfunction]
fn format_round_trip_mismatch(sample_index: usize, path: String, detail: String) -> String {
    CrossmapError::RoundTripMismatch {
        sample_index,
        path,
        detail,
    }
    .to_string()
}

fn step_dict<'py>(py: Python<'py>, step: &PathStep) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    match step {
        PathStep::Key(key) => {
            dict.set_item("kind", "key")?;
            dict.set_item("key", key)?;
        }
        PathStep::Index(index) => {
            dict.set_item("kind", "index")?;
            dict.set_item("index", index)?;
        }
        PathStep::Wildcard => dict.set_item("kind", "wildcard")?,
    }
    Ok(dict)
}

fn trail_list<'py>(py: Python<'py>, trail: &[TrailStep]) -> PyResult<Bound<'py, PyList>> {
    let steps: Vec<Bound<'py, PyDict>> = trail
        .iter()
        .map(|step| step_dict(py, &PathStep::from(step)))
        .collect::<PyResult<_>>()?;
    PyList::new(py, steps)
}

/// The steps of a path, as `{"kind": "key" | "index" | "wildcard", ...}` records. Not public API: the conformance
/// runner reads the path grammar through it.
#[pyfunction(name = "parse_path")]
fn py_parse_path<'py>(py: Python<'py>, path: &str) -> PyResult<Bound<'py, PyList>> {
    let steps = parse_path(path).map_err(|error| raise(py, error))?;
    let steps: Vec<Bound<'py, PyDict>> = steps
        .iter()
        .map(|step| step_dict(py, step))
        .collect::<PyResult<_>>()?;
    PyList::new(py, steps)
}

/// The canonical spelling of a path. Not public API, as for `parse_path`.
#[pyfunction(name = "format_path")]
fn py_format_path(py: Python<'_>, path: &str) -> PyResult<String> {
    parse_path(path)
        .map(|steps| format_path(&steps))
        .map_err(|error| raise(py, error))
}

/// What a path addresses in a document: `None` when it is absent, else its matches (trail and value) and the empty
/// arrays its wildcards met (trail and wildcard ordinal). Not public API, as for `parse_path`.
#[pyfunction(name = "read_path")]
fn py_read_path<'py>(
    py: Python<'py>,
    document: &Bound<'py, PyAny>,
    path: &str,
) -> PyResult<Option<Bound<'py, PyDict>>> {
    let steps = parse_path(path).map_err(|error| raise(py, error))?;
    let document = to_value(document, "document")?;
    let Some(reading) = read_path(&document, &steps) else {
        return Ok(None);
    };
    let matches = PyList::empty(py);
    for found in reading.matches {
        let entry = PyDict::new(py);
        entry.set_item("trail", trail_list(py, &found.trail)?)?;
        entry.set_item("value", from_value(py, found.value.clone())?)?;
        matches.append(entry)?;
    }
    let empties = PyList::empty(py);
    for empty in reading.empties {
        let entry = PyDict::new(py);
        entry.set_item("trail", trail_list(py, &empty.trail)?)?;
        entry.set_item("wildcard", empty.wildcard)?;
        empties.append(entry)?;
    }
    let reading = PyDict::new(py);
    reading.set_item("matches", matches)?;
    reading.set_item("empties", empties)?;
    Ok(Some(reading))
}

/// Whether the command reads an argument as a URL. Not public API: the conformance runner reads the command's argument
/// classification through it.
#[pyfunction]
fn is_url(argument: &str) -> bool {
    crossmap_cli::is_url(argument)
}

/// Runs the `crossmap` command with these arguments on the process's standard streams and returns its exit status.
#[pyfunction]
fn run_command(py: Python<'_>, args: Vec<String>) -> i32 {
    py.detach(|| crossmap_cli::run(&args, &mut crossmap_cli::StandardStreams))
}

/// The crosswalk format's JSON Schema as text, byte for byte the `schemas/crossmap.schema.json` the npm package ships.
#[pyfunction]
fn json_schema_text() -> String {
    crossmap::schema::json_schema_text()
}

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<PyCrosswalk>()?;
    module.add_class::<PyCompiled>()?;
    module.add_function(wrap_pyfunction!(py_parse_crosswalk, module)?)?;
    module.add_function(wrap_pyfunction!(py_validate_crosswalk, module)?)?;
    module.add_function(wrap_pyfunction!(py_compile_crosswalk, module)?)?;
    module.add_function(wrap_pyfunction!(py_encode, module)?)?;
    module.add_function(wrap_pyfunction!(py_decode, module)?)?;
    module.add_function(wrap_pyfunction!(py_assert_round_trip, module)?)?;
    module.add_function(wrap_pyfunction!(py_rule_sides, module)?)?;
    module.add_function(wrap_pyfunction!(format_syntax_error, module)?)?;
    module.add_function(wrap_pyfunction!(format_structure_error, module)?)?;
    module.add_function(wrap_pyfunction!(format_rule_application_error, module)?)?;
    module.add_function(wrap_pyfunction!(format_round_trip_mismatch, module)?)?;
    module.add_function(wrap_pyfunction!(py_parse_path, module)?)?;
    module.add_function(wrap_pyfunction!(py_format_path, module)?)?;
    module.add_function(wrap_pyfunction!(py_read_path, module)?)?;
    module.add_function(wrap_pyfunction!(is_url, module)?)?;
    module.add_function(wrap_pyfunction!(run_command, module)?)?;
    module.add_function(wrap_pyfunction!(json_schema_text, module)?)?;
    module.add("VERSION", crossmap_cli::VERSION)?;
    Ok(())
}

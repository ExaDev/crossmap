//! Conversion between Python objects and the codec's JSON [`Value`], in one pass each way with no JSON text between.
//!
//! A JSON number is an IEEE double, as `JSON.parse` reads it, so the conversion is defined by doubles:
//!
//! - An `int` becomes the double of the same value, and is refused when no double has that value (an integer beyond
//!   2^53 that is not a multiple of the spacing of doubles there), rather than being rounded as `JSON.parse` would round
//!   its digits. A `float` becomes itself, and NaN and the infinities, which JSON cannot write, are refused.
//! - A double comes back as an `int` when it is a safe integer (`Number.isSafeInteger`: integral, magnitude at most
//!   2^53 - 1) and as a `float` otherwise, except that negative zero stays the `float` `-0.0` so its sign survives. So
//!   `1`, `1.0` and `1e0` all come back as `1`, as `json.loads` reads the text `JSON.stringify` writes for each.
//!
//! Only `dict` with `str` keys, `list`, `str`, `int`, `float`, `bool` and `None` (and their subclasses) are JSON: a
//! `tuple`, `set`, `bytes` or any other object is refused, since nothing would turn it back into what it was. A string
//! holding a lone surrogate is refused, since it has no UTF-8 form.

use crossmap::Value;
use pyo3::exceptions::{PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict, PyFloat, PyInt, PyList, PyString};

/// The most arrays and records a document may nest, the root included: the most `serde_json`, and so the `crossmap`
/// command, reads from JSON text, so a document the command can read converts and one it refuses does not. It also
/// bounds the conversion's recursion, so a container that contains itself is refused rather than exhausting the stack.
const MAX_DEPTH: usize = 127;

/// The largest safe integer, `Number.MAX_SAFE_INTEGER`: 2^53 - 1, the largest integer whose successor is also a double.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// One step from the document's root to the value that could not be converted.
enum Step {
    Key(String),
    Index(usize),
}

/// Which Python exception a refusal raises.
enum Kind {
    /// The object's type has no JSON value.
    Type,
    /// The object's type is JSON's but this value is not.
    Value,
}

/// Why a value is not JSON, and where it is, collected as the conversion unwinds so a successful conversion builds no
/// location at all.
struct NotJson {
    kind: Kind,
    message: String,
    trail: Vec<Step>,
}

impl NotJson {
    fn type_error(message: String) -> Self {
        Self {
            kind: Kind::Type,
            message,
            trail: Vec::new(),
        }
    }

    fn value_error(message: String) -> Self {
        Self {
            kind: Kind::Value,
            message,
            trail: Vec::new(),
        }
    }

    fn at(mut self, step: Step) -> Self {
        self.trail.push(step);
        self
    }

    /// The Python exception, naming the argument and the location in it, root first.
    fn into_err(self, argument: &str) -> PyErr {
        let mut location = argument.to_owned();
        for step in self.trail.iter().rev() {
            match step {
                Step::Key(key) => location.push_str(&format!("[{key:?}]")),
                Step::Index(index) => location.push_str(&format!("[{index}]")),
            }
        }
        let text = format!("{location} is not JSON: {}", self.message);
        match self.kind {
            Kind::Type => PyTypeError::new_err(text),
            Kind::Value => PyValueError::new_err(text),
        }
    }
}

/// The JSON value a Python object denotes.
///
/// # Errors
///
/// `TypeError` for an object of a type JSON has no value for, or a record key that is not a string; `ValueError` for
/// a number JSON cannot hold, a string with a lone surrogate, or nesting deeper than [`MAX_DEPTH`]. The message names
/// `argument` and the location in it.
pub(crate) fn to_value(object: &Bound<'_, PyAny>, argument: &str) -> PyResult<Value> {
    convert(object, 0).map_err(|failure| failure.into_err(argument))
}

fn convert(object: &Bound<'_, PyAny>, depth: usize) -> Result<Value, NotJson> {
    if object.is_none() {
        return Ok(Value::Null);
    }
    if let Ok(flag) = object.cast::<PyBool>() {
        return Ok(Value::Bool(flag.is_true()));
    }
    if let Ok(integer) = object.cast::<PyInt>() {
        return integer_value(integer).map(Value::Number);
    }
    if let Ok(float) = object.cast::<PyFloat>() {
        let number = float.value();
        return if number.is_finite() {
            Ok(Value::Number(number))
        } else {
            Err(NotJson::value_error(format!(
                "{number} has no JSON form, which holds finite numbers only"
            )))
        };
    }
    if let Ok(string) = object.cast::<PyString>() {
        return string
            .to_str()
            .map(|text| Value::String(text.to_owned()))
            .map_err(|_| {
                NotJson::value_error(
                    "the string holds a lone surrogate, which has no UTF-8 form".to_owned(),
                )
            });
    }
    if let Ok(list) = object.cast::<PyList>() {
        let depth = deeper(depth)?;
        let mut items = Vec::with_capacity(list.len());
        for (index, item) in list.iter().enumerate() {
            items.push(convert(&item, depth).map_err(|failure| failure.at(Step::Index(index)))?);
        }
        return Ok(Value::Array(items));
    }
    if let Ok(dict) = object.cast::<PyDict>() {
        let depth = deeper(depth)?;
        let mut pairs = Vec::with_capacity(dict.len());
        for (key, member) in dict.iter() {
            let Ok(key) = key.cast::<PyString>() else {
                return Err(NotJson::type_error(format!(
                    "a record key must be a str, not {}",
                    type_name(&key)
                )));
            };
            let Ok(key) = key.to_str() else {
                return Err(NotJson::value_error(
                    "a record key holds a lone surrogate, which has no UTF-8 form".to_owned(),
                ));
            };
            let member =
                convert(&member, depth).map_err(|failure| failure.at(Step::Key(key.to_owned())))?;
            pairs.push((key.to_owned(), member));
        }
        return Ok(Value::Object(pairs));
    }
    Err(NotJson::type_error(format!(
        "{} is not one of dict, list, str, int, float, bool and None",
        type_name(object)
    )))
}

fn deeper(depth: usize) -> Result<usize, NotJson> {
    if depth >= MAX_DEPTH {
        Err(NotJson::value_error(format!(
            "it nests more than {MAX_DEPTH} arrays and records deep, or contains itself"
        )))
    } else {
        Ok(depth + 1)
    }
}

/// The double with the integer's value, when there is one.
fn integer_value(integer: &Bound<'_, PyInt>) -> Result<f64, NotJson> {
    // Every integer of magnitude up to 2^53 is a double; most integers in documents take this path.
    if let Ok(small) = integer.extract::<i64>()
        && small.unsigned_abs() <= 1 << 53
    {
        #[expect(
            clippy::cast_precision_loss,
            reason = "the magnitude is at most 2^53, so the conversion is exact"
        )]
        return Ok(small as f64);
    }
    let not_a_double = || {
        NotJson::value_error(format!(
            "the int {integer} is not exactly a double, which is all a JSON number holds"
        ))
    };
    // `float(n)` rounds to the nearest double, or overflows; Python compares an int with a float exactly, so equality
    // says the rounding lost nothing.
    let nearest: f64 = integer.extract().map_err(|_| not_a_double())?;
    if PyAnyMethods::eq(integer.as_any(), nearest).map_err(|_| not_a_double())? {
        Ok(nearest)
    } else {
        Err(not_a_double())
    }
}

/// The name of the object's type, for a refusal. A type's `__name__` is always a string, so the fallback to its `repr`
/// is reached only by a metaclass that overrides `__name__` with something else.
fn type_name(object: &Bound<'_, PyAny>) -> String {
    let kind = object.get_type();
    kind.name()
        .map_or_else(|_| kind.to_string(), |name| name.to_string())
}

/// The Python object a JSON value denotes, consuming the value so its strings and containers are not copied twice.
pub(crate) fn from_value(py: Python<'_>, value: Value) -> PyResult<Bound<'_, PyAny>> {
    Ok(match value {
        Value::Null => py.None().into_bound(py),
        Value::Bool(flag) => PyBool::new(py, flag).to_owned().into_any(),
        Value::Number(number) => number_object(py, number)?,
        Value::String(text) => PyString::new(py, &text).into_any(),
        Value::Array(items) => {
            let list = PyList::empty(py);
            for item in items {
                list.append(from_value(py, item)?)?;
            }
            list.into_any()
        }
        Value::Object(pairs) => {
            let dict = PyDict::new(py);
            for (key, member) in pairs {
                dict.set_item(key, from_value(py, member)?)?;
            }
            dict.into_any()
        }
    })
}

fn number_object(py: Python<'_>, number: f64) -> PyResult<Bound<'_, PyAny>> {
    let negative_zero = number == 0.0 && number.is_sign_negative();
    if number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER && !negative_zero {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "the number is integral with magnitude below 2^53, so the conversion is exact"
        )]
        let integer = number as i64;
        Ok(integer.into_pyobject(py)?.into_any())
    } else {
        Ok(PyFloat::new(py, number).into_any())
    }
}

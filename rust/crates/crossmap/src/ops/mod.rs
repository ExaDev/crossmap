//! The operations of the rules. Each returns the message of its failure, which the executor turns into a
//! [`crate::CrossmapError::RuleApplication`] naming the rule and its paths.

pub(crate) mod aggregate;
pub(crate) mod format;
pub(crate) mod template;

use json_shape::Value;

use crate::js;

/// `scale`: multiplies by `factor` while encoding and divides by it while decoding. Decoding divides rather than
/// multiplying by the reciprocal, which is itself rounded, so the division is the accurate route.
pub(crate) fn scale(factor: f64, encode: bool, value: &Value) -> Result<Value, String> {
    let Value::Number(number) = value else {
        return Err(format!(
            "scale applies to finite numbers, found: {}",
            js::stringify(value)
        ));
    };
    let scaled = if encode {
        number * factor
    } else {
        number / factor
    };
    if !scaled.is_finite() {
        return Err(format!(
            "scaling by the rule's factor overflows to a non-finite value: {} against factor {}",
            js::to_display_string(value),
            json_shape::number_to_string(factor)
        ));
    }
    Ok(Value::Number(scaled))
}

/// `enum`: the value through one of the rule's maps. A value the map does not hold is an error, never passed through.
pub(crate) fn enumerate(
    map: &[(String, String)],
    map_name: &str,
    value: &Value,
) -> Result<Value, String> {
    let Value::String(text) = value else {
        return Err(format!(
            "enum applies to strings, found: {}",
            js::stringify(value)
        ));
    };
    map.iter()
        .find(|(key, _)| key == text)
        .map(|(_, mapped)| Value::String(mapped.clone()))
        .ok_or_else(|| format!("value {} has no entry in {map_name}", js::quote(text)))
}

/// The encode half of `split`: the string cut at every occurrence of the separator.
pub(crate) fn split_encode(separator: &str, value: &Value) -> Result<Value, String> {
    let Value::String(text) = value else {
        return Err(format!(
            "split applies to strings, found: {}",
            js::stringify(value)
        ));
    };
    Ok(Value::Array(
        text.split(separator)
            .map(|part| Value::String(part.to_owned()))
            .collect(),
    ))
}

/// The decode half of `split`: the parts joined with the separator. A part containing the separator would make the
/// join ambiguous, so it is an error.
pub(crate) fn split_decode(separator: &str, value: &Value) -> Result<Value, String> {
    let Value::Array(items) = value else {
        return Err(format!(
            "split decode applies to arrays of strings, found: {}",
            js::stringify(value)
        ));
    };
    let mut parts = Vec::with_capacity(items.len());
    for item in items {
        let Value::String(part) = item else {
            return Err(format!(
                "split decode applies to arrays of strings, found: {}",
                js::stringify(value)
            ));
        };
        if part.contains(separator) {
            return Err(format!(
                "a split part contains the separator, so the join is ambiguous: {}",
                js::quote(part)
            ));
        }
        parts.push(part.as_str());
    }
    Ok(Value::String(parts.join(separator)))
}

/// The decode half of `copy`: the copies must all be equal, and that one value goes back to `from`.
pub(crate) fn copy_decode(values: &[&Value]) -> Result<Value, String> {
    let Some((first, others)) = values.split_first() else {
        return Err("a copy read no values".to_owned());
    };
    for (position, other) in others.iter().enumerate() {
        if !same_json(first, other) {
            return Err(format!(
                "the copies disagree: to path {} holds {} where the first holds {}",
                position + 1,
                js::stringify(other),
                js::stringify(first)
            ));
        }
    }
    Ok((*first).clone())
}

/// Deep equality over JSON values: leaves with `Object.is`, arrays by length then element, records by key set then
/// value.
fn same_json(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same_json(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, member)| {
                    right
                        .iter()
                        .find(|(name, _)| name == key)
                        .is_some_and(|(_, other)| same_json(member, other))
                })
        }
        (Value::Number(left), Value::Number(right)) => js::same_number(*left, *right),
        (left, right) => left == right,
    }
}

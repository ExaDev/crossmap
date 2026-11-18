//! The JavaScript behaviours the format is defined by, where they differ from a plain reading of JSON: the order a
//! JavaScript object lists its keys in, and the text `JSON.stringify` writes.
//!
//! A JavaScript object lists every key that is an array index (the canonical decimal spelling of an integer from 0 to
//! 2^32 - 2) first, in ascending numeric order, and every other key after them in insertion order. Documents read with
//! `JSON.parse` and outputs built by assignment both follow that order, so it is the order `JSON.stringify` writes and
//! the order every iteration over a record's keys sees. [`Value`] keeps plain insertion order, and this module applies
//! the JavaScript order wherever it is observable.

use json_shape::{Value, number_to_string};

/// The largest array index: an index is below 2^32 - 1.
const MAX_ARRAY_INDEX: u64 = 4_294_967_294;

/// The array index a key spells, when it is the canonical decimal spelling of one.
fn array_index(key: &str) -> Option<u64> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    let index: u64 = key.parse().ok()?;
    (index <= MAX_ARRAY_INDEX).then_some(index)
}

/// The positions of `pairs` in the order a JavaScript object lists its keys.
pub(crate) fn key_order<T>(pairs: &[(String, T)]) -> Vec<usize> {
    let mut indexed: Vec<(u64, usize)> = Vec::new();
    let mut named: Vec<usize> = Vec::new();
    for (position, (key, _)) in pairs.iter().enumerate() {
        match array_index(key) {
            Some(index) => indexed.push((index, position)),
            None => named.push(position),
        }
    }
    indexed.sort_unstable();
    indexed
        .into_iter()
        .map(|(_, position)| position)
        .chain(named)
        .collect()
}

/// The pairs of a record in the order a JavaScript object lists its keys.
pub(crate) fn ordered_pairs<T>(pairs: &[(String, T)]) -> Vec<&(String, T)> {
    key_order(pairs)
        .into_iter()
        .filter_map(|position| pairs.get(position))
        .collect()
}

/// The value with every record's keys in JavaScript order, which is the value a JavaScript program holding it sees.
pub fn js_ordered(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(js_ordered).collect()),
        Value::Object(pairs) => Value::Object(
            ordered_pairs(pairs)
                .into_iter()
                .map(|(key, member)| (key.clone(), js_ordered(member)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A string as `JSON.stringify` writes it: quoted, with `"`, `\` and the control characters escaped.
pub(crate) fn quote(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for character in text.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\u{8}' => quoted.push_str("\\b"),
            '\u{c}' => quoted.push_str("\\f"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            control if u32::from(control) < 0x20 => {
                quoted.push_str(&format!("\\u{:04x}", u32::from(control)));
            }
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    quoted
}

/// The text `JSON.stringify(value)` writes: compact, keys in JavaScript order, numbers as JavaScript writes them.
pub fn stringify(value: &Value) -> String {
    let mut text = String::new();
    write_value(&mut text, value, None, "");
    text
}

/// The text `JSON.stringify(value, undefined, 2)` writes: two spaces per level of nesting, one member per line.
pub fn stringify_pretty(value: &Value) -> String {
    let mut text = String::new();
    write_value(&mut text, value, Some("  "), "");
    text
}

fn write_value(text: &mut String, value: &Value, indent: Option<&str>, current: &str) {
    match value {
        Value::Null => text.push_str("null"),
        Value::Bool(flag) => text.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => text.push_str(&number_to_string(*number)),
        Value::String(string) => text.push_str(&quote(string)),
        Value::Array(items) => {
            if items.is_empty() {
                text.push_str("[]");
                return;
            }
            let inner = indent.map(|step| format!("{current}{step}"));
            text.push('[');
            for (position, item) in items.iter().enumerate() {
                if position > 0 {
                    text.push(',');
                }
                if let Some(inner) = &inner {
                    text.push('\n');
                    text.push_str(inner);
                }
                write_value(text, item, indent, inner.as_deref().unwrap_or(current));
            }
            if indent.is_some() {
                text.push('\n');
                text.push_str(current);
            }
            text.push(']');
        }
        Value::Object(pairs) => {
            if pairs.is_empty() {
                text.push_str("{}");
                return;
            }
            let inner = indent.map(|step| format!("{current}{step}"));
            text.push('{');
            for (position, (key, member)) in ordered_pairs(pairs).into_iter().enumerate() {
                if position > 0 {
                    text.push(',');
                }
                if let Some(inner) = &inner {
                    text.push('\n');
                    text.push_str(inner);
                }
                text.push_str(&quote(key));
                text.push(':');
                if indent.is_some() {
                    text.push(' ');
                }
                write_value(text, member, indent, inner.as_deref().unwrap_or(current));
            }
            if indent.is_some() {
                text.push('\n');
                text.push_str(current);
            }
            text.push('}');
        }
    }
}

/// The text `String(value)` gives for a JSON scalar, and for a record or array the text a mismatch message shows.
pub(crate) fn to_display_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_to_string(*number),
        Value::String(string) => string.clone(),
        Value::Array(_) | Value::Object(_) => stringify(value),
    }
}

/// Orders two strings by their UTF-16 code units, as JavaScript's `<` and `Array.prototype.sort` do.
pub(crate) fn compare_code_units(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// The length of a string in UTF-16 code units, which is what a JavaScript string position counts.
pub(crate) fn code_unit_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Whether `value` is the same value as `other` under `Object.is` for JSON leaves: numbers by value, except that `0`
/// and `-0` differ.
pub(crate) fn same_number(left: f64, right: f64) -> bool {
    left == right && left.is_sign_negative() == right.is_sign_negative()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_keys_come_first_in_numeric_order() {
        let value = Value::Object(vec![
            ("b".to_owned(), Value::Null),
            ("10".to_owned(), Value::Null),
            ("2".to_owned(), Value::Null),
            ("01".to_owned(), Value::Null),
        ]);
        assert_eq!(
            stringify(&value),
            r#"{"2":null,"10":null,"b":null,"01":null}"#
        );
    }

    #[test]
    fn pretty_matches_json_stringify_with_two_spaces() {
        let value = Value::Object(vec![
            (
                "a".to_owned(),
                Value::Array(vec![Value::Number(1.0), Value::Array(vec![])]),
            ),
            ("b".to_owned(), Value::Object(vec![])),
        ]);
        assert_eq!(
            stringify_pretty(&value),
            "{\n  \"a\": [\n    1,\n    []\n  ],\n  \"b\": {}\n}"
        );
    }
}

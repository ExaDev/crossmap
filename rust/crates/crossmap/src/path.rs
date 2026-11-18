//! The path grammar, and reading the locations a path addresses in a document.
//!
//! A path starts with a key and continues with any sequence of `.key`, a quoted key `["..."]`, a fixed index `[n]` or
//! a wildcard `[]`. A bare key is `[A-Za-z0-9_-]+`; a quoted key is any text with `"` and `\` written `\"` and `\\`,
//! the only two escapes, so every key has one quoted spelling. No key may be exactly `__proto__`, bare or quoted,
//! because the TypeScript implementation's output check drops that key without a word. An index is `0` or a decimal
//! of up to nine digits without a leading zero, every one of which is a valid JavaScript array index.

use json_shape::Value;

use crate::error::CrossmapError;

/// One step of a parsed path: a record key, a fixed array index, or a wildcard over every element of an array.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum PathStep {
    /// A record key.
    Key(String),
    /// One element of an array.
    Index(usize),
    /// Every element of an array.
    Wildcard,
}

/// One step of a concrete location: a record key or an array index. A trail is a path with every wildcard bound to an
/// index, so a record key spelled `0` is never mistaken for the first element of an array.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum TrailStep {
    /// A record key.
    Key(String),
    /// An array index.
    Index(usize),
}

/// The most digits an index may have: every number of up to nine digits is a valid JavaScript array index.
pub(crate) const MAX_INDEX_DIGITS: usize = 9;

/// The key no path may name.
pub(crate) const PROTO: &str = "__proto__";

fn is_bare_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

/// Whether a key prints bare: it is made of bare characters and is not `__proto__`.
fn is_bare_key(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(is_bare_char) && key != PROTO
}

/// Parses a path string into its steps, or `None` when it is not in the grammar.
fn parse_steps(path: &str) -> Option<Vec<PathStep>> {
    let bytes = path.as_bytes();
    let mut steps = Vec::new();
    let mut position = 0;
    while position < bytes.len() || steps.is_empty() {
        let first = steps.is_empty();
        let byte = *bytes.get(position)?;
        if byte == b'[' {
            match bytes.get(position + 1) {
                Some(b'"') => {
                    let (key, end) = read_quoted(path, position + 2)?;
                    steps.push(PathStep::Key(key));
                    position = end;
                }
                Some(b']') if !first => {
                    steps.push(PathStep::Wildcard);
                    position += 2;
                }
                Some(digit) if digit.is_ascii_digit() && !first => {
                    let start = position + 1;
                    let mut end = start;
                    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                        end += 1;
                    }
                    let digits = &path[start..end];
                    if bytes.get(end) != Some(&b']')
                        || digits.len() > MAX_INDEX_DIGITS
                        || (digits.len() > 1 && digits.starts_with('0'))
                    {
                        return None;
                    }
                    steps.push(PathStep::Index(digits.parse().ok()?));
                    position = end + 1;
                }
                _ => return None,
            }
            continue;
        }
        let start = if first {
            position
        } else if byte == b'.' {
            position + 1
        } else {
            return None;
        };
        let mut end = start;
        while bytes.get(end).copied().is_some_and(is_bare_char) {
            end += 1;
        }
        let key = &path[start..end];
        if key.is_empty() || key == PROTO {
            return None;
        }
        steps.push(PathStep::Key(key.to_owned()));
        position = end;
    }
    Some(steps)
}

/// Reads a quoted key's body from just after its opening `["`, undoing the two escapes, and returns the key with the
/// position just after its closing `"]`.
fn read_quoted(path: &str, start: usize) -> Option<(String, usize)> {
    let mut key = String::new();
    let mut characters = path[start..].char_indices();
    loop {
        let (offset, character) = characters.next()?;
        match character {
            '"' => {
                let close = start + offset + 1;
                if path.as_bytes().get(close) != Some(&b']') || key == PROTO {
                    return None;
                }
                return Some((key, close + 1));
            }
            '\\' => match characters.next()? {
                (_, escaped @ ('"' | '\\')) => key.push(escaped),
                _ => return None,
            },
            other => key.push(other),
        }
    }
}

/// Whether a string is a well-formed path.
pub fn is_path(path: &str) -> bool {
    parse_steps(path).is_some()
}

/// Parses a path string into its steps.
///
/// # Errors
///
/// [`CrossmapError::Syntax`] when the string is not a well-formed path: it is empty, has an empty segment, a leading
/// or trailing dot, starts with `[]` or an index, has an unterminated quoted key, an index with a leading zero or more
/// than nine digits, a key that is exactly `__proto__`, or a character outside the bare key class outside quotes.
pub fn parse_path(path: &str) -> Result<Vec<PathStep>, CrossmapError> {
    parse_steps(path).ok_or_else(|| CrossmapError::syntax(format!("malformed path: {path}")))
}

/// A step as a path step, for printing a trail.
impl From<&TrailStep> for PathStep {
    fn from(step: &TrailStep) -> Self {
        match step {
            TrailStep::Key(key) => PathStep::Key(key.clone()),
            TrailStep::Index(index) => PathStep::Index(*index),
        }
    }
}

/// Prints steps in the path grammar, the inverse of [`parse_path`]: a key the bare class covers prints bare, any
/// other quoted. A key of exactly `__proto__` prints quoted, for messages, though the grammar refuses it.
pub fn format_path(steps: &[PathStep]) -> String {
    let mut text = String::new();
    for (position, step) in steps.iter().enumerate() {
        match step {
            PathStep::Wildcard => text.push_str("[]"),
            PathStep::Index(index) => {
                text.push('[');
                text.push_str(&index.to_string());
                text.push(']');
            }
            PathStep::Key(key) if is_bare_key(key) => {
                if position > 0 {
                    text.push('.');
                }
                text.push_str(key);
            }
            PathStep::Key(key) => {
                text.push_str("[\"");
                text.push_str(&key.replace('\\', "\\\\").replace('"', "\\\""));
                text.push_str("\"]");
            }
        }
    }
    text
}

/// Prints a trail in the path grammar.
pub fn format_trail(trail: &[TrailStep]) -> String {
    let steps: Vec<PathStep> = trail.iter().map(PathStep::from).collect();
    format_path(&steps)
}

/// The canonical spelling of a path, so two spellings of one path compare equal; `None` when it is malformed.
pub(crate) fn canonical_path(path: &str) -> Option<String> {
    parse_steps(path).map(|steps| format_path(&steps))
}

/// The number of wildcard steps of a path.
pub fn wildcard_count(steps: &[PathStep]) -> usize {
    steps
        .iter()
        .filter(|step| matches!(step, PathStep::Wildcard))
        .count()
}

/// One location a path addresses: the trail reaching it and the value there.
#[derive(Clone, Debug, PartialEq)]
pub struct PathMatch<'a> {
    /// The concrete location.
    pub trail: Vec<TrailStep>,
    /// The value found there.
    pub value: &'a Value,
}

/// An existing empty array a wildcard step met: structure the matches cannot show, since it yields none. `wildcard` is
/// the ordinal (from zero) of the wildcard step that met it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmptySite {
    /// The location of the empty array.
    pub trail: Vec<TrailStep>,
    /// Which wildcard of the path met it.
    pub wildcard: usize,
}

/// Everything a path addresses in a document: the matches in index order, and every empty array a wildcard met.
#[derive(Clone, Debug, PartialEq)]
pub struct Reading<'a> {
    /// The matches, in index order.
    pub matches: Vec<PathMatch<'a>>,
    /// The empty arrays the wildcards met.
    pub empties: Vec<EmptySite>,
}

/// What a walk calls for each location it reaches: the trail (valid until the next call) and the value there.
pub(crate) type Visit<'v, 'a> =
    dyn FnMut(&[TrailStep], &'a Value) -> Result<(), CrossmapError> + 'v;

/// A per-element admission test: once the first `arity` wildcards are bound, an element is kept only when `admit`
/// returns true for its indexes at those wildcards, and nothing below a refused element is read.
pub(crate) struct ElementGate<'g> {
    pub(crate) arity: usize,
    pub(crate) admit: &'g dyn Fn(&[usize]) -> Result<bool, CrossmapError>,
}

/// Reads every location a path addresses in a document.
///
/// # Errors
///
/// Only what the gate's admission test returns.
///
/// Returns `Ok(None)` when any step of the path is absent: a missing key, a key step meeting a non-record, an index
/// step meeting a non-array or an index past the end, or a wildcard meeting a non-array.
pub(crate) fn walk<'a>(
    root: &'a Value,
    steps: &[PathStep],
    gate: Option<&ElementGate<'_>>,
    visit: &mut Visit<'_, 'a>,
) -> Result<Option<Vec<EmptySite>>, CrossmapError> {
    let mut walker = Walker {
        steps,
        gate,
        visit,
        trail: Vec::new(),
        indexes: Vec::new(),
        empties: Vec::new(),
    };
    Ok(walker.walk(0, root)?.then_some(walker.empties))
}

struct Walker<'s, 'g, 'v, 'a> {
    steps: &'s [PathStep],
    gate: Option<&'g ElementGate<'g>>,
    visit: &'v mut Visit<'v, 'a>,
    trail: Vec<TrailStep>,
    indexes: Vec<usize>,
    empties: Vec<EmptySite>,
}

impl<'a> Walker<'_, '_, '_, 'a> {
    fn walk(&mut self, position: usize, value: &'a Value) -> Result<bool, CrossmapError> {
        let Some(step) = self.steps.get(position) else {
            (self.visit)(&self.trail, value)?;
            return Ok(true);
        };
        match step {
            PathStep::Key(key) => {
                let Some(child) = own_member(value, key) else {
                    return Ok(false);
                };
                self.trail.push(TrailStep::Key(key.clone()));
                let found = self.walk(position + 1, child)?;
                self.trail.pop();
                Ok(found)
            }
            PathStep::Index(index) => {
                let Some(child) = value.as_array().and_then(|items| items.get(*index)) else {
                    return Ok(false);
                };
                self.trail.push(TrailStep::Index(*index));
                let found = self.walk(position + 1, child)?;
                self.trail.pop();
                Ok(found)
            }
            PathStep::Wildcard => {
                let Some(items) = value.as_array() else {
                    return Ok(false);
                };
                let ordinal = self.indexes.len();
                if items.is_empty() {
                    self.empties.push(EmptySite {
                        trail: self.trail.clone(),
                        wildcard: ordinal,
                    });
                }
                let gated = self.gate.filter(|gate| gate.arity == ordinal + 1);
                for (index, item) in items.iter().enumerate() {
                    self.trail.push(TrailStep::Index(index));
                    self.indexes.push(index);
                    let admitted = match gated {
                        Some(gate) => (gate.admit)(&self.indexes)?,
                        None => true,
                    };
                    let found = !admitted || self.walk(position + 1, item)?;
                    self.indexes.pop();
                    self.trail.pop();
                    if !found {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
        }
    }
}

/// Reads every location a path addresses, collecting the matches.
///
/// # Errors
///
/// Only what the gate's admission test returns.
pub(crate) fn read_gated<'a>(
    root: &'a Value,
    steps: &[PathStep],
    gate: Option<&ElementGate<'_>>,
) -> Result<Option<Reading<'a>>, CrossmapError> {
    let mut matches = Vec::new();
    let empties = walk(root, steps, gate, &mut |trail, value| {
        matches.push(PathMatch {
            trail: trail.to_vec(),
            value,
        });
        Ok(())
    })?;
    Ok(empties.map(|empties| Reading { matches, empties }))
}

/// Reads every location a path addresses in a document, or `None` when the path is absent from it.
pub fn read_path<'a>(root: &'a Value, steps: &[PathStep]) -> Option<Reading<'a>> {
    read_gated(root, steps, None).ok().flatten()
}

/// The member of a record under `key`, when the value is a record that has it.
pub(crate) fn own_member<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value
        .as_object()?
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, member)| member)
}

/// The indexes a trail took at the wildcard steps of the path it was read through, in order.
pub(crate) fn wildcard_indexes(steps: &[PathStep], trail: &[TrailStep]) -> Vec<usize> {
    trail
        .iter()
        .zip(steps)
        .filter_map(|(taken, step)| match (step, taken) {
            (PathStep::Wildcard, TrailStep::Index(index)) => Some(*index),
            _ => None,
        })
        .collect()
}

/// Binds a path to an index tuple: the n-th wildcard takes the n-th index. With `limit`, the trail stops just before
/// that wildcard, at the array it would iterate. A wildcard with no index left ends the trail there too; structural
/// validation rules that out for every caller.
pub(crate) fn bind(steps: &[PathStep], indexes: &[usize], limit: Option<usize>) -> Vec<TrailStep> {
    let mut trail = Vec::with_capacity(steps.len());
    let mut ordinal = 0;
    for step in steps {
        match step {
            PathStep::Key(key) => trail.push(TrailStep::Key(key.clone())),
            PathStep::Index(index) => trail.push(TrailStep::Index(*index)),
            PathStep::Wildcard => {
                if Some(ordinal) == limit {
                    break;
                }
                let Some(index) = indexes.get(ordinal) else {
                    break;
                };
                trail.push(TrailStep::Index(*index));
                ordinal += 1;
            }
        }
    }
    trail
}

/// Reads one concrete location, or `None` when a step is absent.
pub(crate) fn read_trail<'a>(root: &'a Value, trail: &[TrailStep]) -> Option<&'a Value> {
    let mut value = root;
    for step in trail {
        value = match step {
            TrailStep::Key(key) => own_member(value, key)?,
            TrailStep::Index(index) => value.as_array()?.get(*index)?,
        };
    }
    Some(value)
}

/// The prefixes of a path through each of its wildcards, printed canonically, outermost first: the arrays its
/// wildcards iterate.
pub(crate) fn wildcard_arrays(steps: &[PathStep]) -> Vec<String> {
    steps
        .iter()
        .enumerate()
        .filter(|(_, step)| matches!(step, PathStep::Wildcard))
        .map(|(position, _)| format_path(&steps[..=position]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_keys_round_trip_through_their_canonical_spelling() {
        let steps = parse_steps(r#"meta["a.b"]["x\"y\\z"][0][]"#);
        assert_eq!(
            steps,
            Some(vec![
                PathStep::Key("meta".to_owned()),
                PathStep::Key("a.b".to_owned()),
                PathStep::Key("x\"y\\z".to_owned()),
                PathStep::Index(0),
                PathStep::Wildcard,
            ])
        );
        let printed = steps.map(|steps| format_path(&steps));
        assert_eq!(printed.as_deref(), Some(r#"meta["a.b"]["x\"y\\z"][0][]"#));
    }

    #[test]
    fn refuses_what_the_grammar_refuses() {
        for path in [
            "",
            ".a",
            "a.",
            "a..b",
            "[]",
            "[0]",
            "a[01]",
            "a[1234567890]",
            "__proto__",
            "a.__proto__",
            r#"["__proto__"]"#,
            r#"a["x"#,
            r#"a["x\n"]"#,
            "a b",
            "a[x]",
        ] {
            assert!(parse_steps(path).is_none(), "{path}");
        }
        assert!(parse_steps("__proto__x").is_some());
        assert!(parse_steps(r#"["0"]"#).is_some());
    }
}

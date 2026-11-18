//! `template`: several fields rendered into one text, and split back out of it.
//!
//! `{name}` is a placeholder, `{{` and `}}` are a literal `{` and `}`, and every other character is literal. A template
//! is sound when every field is used exactly once and a literal separates every two placeholders; encode then refuses a
//! value that contains the literal following its placeholder, so decode always recovers the fields encode rendered.

use json_shape::Value;

use crate::js;
use crate::path::PROTO;

/// One piece of a parsed template.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Piece {
    /// Literal text.
    Literal(String),
    /// A placeholder naming one of the rule's fields.
    Placeholder(String),
}

/// Whether a name is a placeholder name: `[A-Za-z0-9_]+` other than `__proto__`.
pub(crate) fn is_placeholder_name(name: &str) -> bool {
    !name.is_empty()
        && name != PROTO
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Parses a template. Adjacent literal characters are merged, so no two literal pieces are adjacent.
///
/// # Errors
///
/// The message for a `{` that opens neither `{{` nor a placeholder closed by `}`, or a `}` that is not part of `}}`.
/// Positions count UTF-16 code units, as a JavaScript string does.
pub(crate) fn parse(template: &str) -> Result<Vec<Piece>, String> {
    let mut pieces = Vec::new();
    let mut literal = String::new();
    let mut rest = template;
    let mut position = 0;
    while let Some(character) = rest.chars().next() {
        if rest.starts_with("{{") || rest.starts_with("}}") {
            literal.push(character);
            rest = &rest[2..];
            position += 2;
            continue;
        }
        if character == '}' {
            return Err(format!(
                "a lone }} at position {position}: write }}}} for a literal brace"
            ));
        }
        if character != '{' {
            literal.push(character);
            rest = &rest[character.len_utf8()..];
            position += character.len_utf16();
            continue;
        }
        let name = rest[1..].find('}').map(|close| &rest[1..=close]);
        let Some(name) = name.filter(|name| is_placeholder_name(name)) else {
            return Err(format!(
                "a {{ at position {position} opens no placeholder: write {{name}} with a name of [A-Za-z0-9_]+ other than __proto__, or {{{{ for a literal brace"
            ));
        };
        if !literal.is_empty() {
            pieces.push(Piece::Literal(std::mem::take(&mut literal)));
        }
        pieces.push(Piece::Placeholder(name.to_owned()));
        rest = &rest[name.len() + 2..];
        position += js::code_unit_length(name) + 2;
    }
    if !literal.is_empty() {
        pieces.push(Piece::Literal(literal));
    }
    Ok(pieces)
}

/// The structural problems that stop a template from having a unique inverse, given the rule's field names; empty
/// when it is sound.
pub(crate) fn problems(pieces: &[Piece], fields: &[&str]) -> Vec<String> {
    let mut problems = Vec::new();
    let names: Vec<&str> = pieces
        .iter()
        .filter_map(|piece| match piece {
            Piece::Placeholder(name) => Some(name.as_str()),
            Piece::Literal(_) => None,
        })
        .collect();
    if names.is_empty() {
        problems.push("a template needs at least one placeholder".to_owned());
    }
    let mut seen: Vec<&str> = Vec::new();
    for name in &names {
        if seen.contains(name) {
            problems.push(format!(
                "placeholder {{{name}}} appears twice: decode could not tell which occurrence holds the value"
            ));
        }
        seen.push(name);
        if !fields.contains(name) {
            problems.push(format!("placeholder {{{name}}} names no from field"));
        }
    }
    for field in fields {
        if !seen.contains(field) {
            problems.push(format!(
                "from field {field} appears in no placeholder, so encode would lose it"
            ));
        }
    }
    for pair in pieces.windows(2) {
        if let [Piece::Placeholder(left), Piece::Placeholder(right)] = pair {
            problems.push(format!(
                "placeholders {{{left}}} and {{{right}}} are adjacent: with no literal between them, decode cannot tell where one ends"
            ));
        }
    }
    problems
}

/// Splits a rendered text back into its fields: the text must start with the leading literal and end with the
/// trailing one, and each placeholder takes the text up to the first occurrence of the literal after it.
///
/// # Errors
///
/// The message when the text does not have the template's shape.
pub(crate) fn split<'t>(pieces: &[Piece], text: &'t str) -> Result<Vec<(String, &'t str)>, String> {
    let leading = match pieces.first() {
        Some(Piece::Literal(literal)) => literal.as_str(),
        _ => "",
    };
    let trailing = match pieces.last() {
        Some(Piece::Literal(literal)) if pieces.len() > 1 => literal.as_str(),
        _ => "",
    };
    if !text.starts_with(leading)
        || !text.ends_with(trailing)
        || text.len() < leading.len() + trailing.len()
    {
        return Err(format!(
            "text does not have the template's leading {} and trailing {}: {}",
            js::quote(leading),
            js::quote(trailing),
            js::quote(text)
        ));
    }
    let mut rest = &text[leading.len()..text.len() - trailing.len()];
    let start = usize::from(!leading.is_empty());
    let end = pieces.len() - usize::from(!trailing.is_empty());
    let middle = pieces.get(start..end).unwrap_or(&[]);
    let mut parts = Vec::new();
    for (position, piece) in middle.iter().enumerate() {
        let Piece::Placeholder(name) = piece else {
            continue;
        };
        match middle.get(position + 1) {
            None => {
                parts.push((name.clone(), rest));
            }
            Some(Piece::Literal(boundary)) => {
                let Some(at) = rest.find(boundary.as_str()) else {
                    return Err(format!(
                        "text lacks the template's {} after {{{name}}}: {}",
                        js::quote(boundary),
                        js::quote(text)
                    ));
                };
                parts.push((name.clone(), &rest[..at]));
                rest = &rest[at + boundary.len()..];
            }
            Some(Piece::Placeholder(_)) => {
                return Err(
                    "adjacent placeholders reached the split: the parse rejects them".to_owned(),
                );
            }
        }
    }
    Ok(parts)
}

/// Renders the fields into the template. The rendering is split back at once and compared with the fields, so a value
/// containing the literal that follows its placeholder is refused here rather than decoding to different values.
///
/// # Errors
///
/// The message when a value is not a string, or the rendering does not split back into the same values.
pub(crate) fn render(pieces: &[Piece], fields: &[(&str, &Value)]) -> Result<String, String> {
    let field = |name: &str| {
        fields
            .iter()
            .find(|(field, _)| *field == name)
            .map(|(_, value)| *value)
    };
    let mut text = String::new();
    for piece in pieces {
        match piece {
            Piece::Literal(literal) => text.push_str(literal),
            Piece::Placeholder(name) => match field(name) {
                Some(Value::String(value)) => text.push_str(value),
                other => {
                    return Err(format!(
                        "template field {name} must be a string, found: {}",
                        other.map_or_else(|| "undefined".to_owned(), js::stringify)
                    ));
                }
            },
        }
    }
    let back = split(pieces, &text)?;
    for piece in pieces {
        let Piece::Placeholder(name) = piece else {
            continue;
        };
        let value = field(name).and_then(Value::as_str);
        let split_value = back
            .iter()
            .find(|(part, _)| part == name)
            .map(|(_, part)| *part);
        if split_value != value {
            return Err(format!(
                "template field {name} holds {}, which contains text the template uses as a boundary, so the rendering would not split back into the same fields",
                value.map_or_else(|| "undefined".to_owned(), js::quote)
            ));
        }
    }
    Ok(text)
}

//! `format`: a textual form and the machine value it spells, each converted as JavaScript converts it, so the
//! canonical text of every kind is the text the TypeScript implementation renders.

use json_shape::{Value, number_to_string};

use crate::crosswalk::FormatKind;
use crate::js;
use crate::path::PROTO;

/// The length of a UTC day in milliseconds; ECMAScript time has no leap seconds.
const MILLISECONDS_PER_DAY: i64 = 86_400_000;
const MILLISECONDS_PER_HOUR: i64 = 3_600_000;
const MILLISECONDS_PER_MINUTE: i64 = 60_000;
const MILLISECONDS_PER_SECOND: i64 = 1_000;

/// The largest magnitude of an ECMAScript time value: 10^8 days either side of the epoch.
const MAX_TIME: f64 = 8.64e15;

/// The encode half: parses the native text into the shared machine value.
pub(crate) fn encode(kind: FormatKind, value: &Value) -> Result<Value, String> {
    let Value::String(text) = value else {
        return Err(format!(
            "format ({}) applies to strings, found: {}",
            kind.name(),
            js::stringify(value)
        ));
    };
    match kind {
        FormatKind::IsoDateTime => parse_iso_date_time(text).map(Value::Number),
        FormatKind::IsoDate => parse_iso_date(text).map(Value::Number),
        FormatKind::NumberText => parse_number_text(text).map(Value::Number),
        FormatKind::BooleanText => match text.as_str() {
            "true" => Ok(Value::Bool(true)),
            "false" => Ok(Value::Bool(false)),
            _ => Err(format!(
                "value is not \"true\" or \"false\": {}",
                js::quote(text)
            )),
        },
        FormatKind::JsonText => parse_json_text(text),
    }
}

/// The decode half: renders the shared machine value as the canonical text.
pub(crate) fn decode(kind: FormatKind, value: &Value) -> Result<Value, String> {
    let text = match kind {
        FormatKind::IsoDateTime => iso_string(finite_number(kind, value)?)?,
        FormatKind::IsoDate => render_iso_date(finite_number(kind, value)?)?,
        FormatKind::NumberText => number_to_string(finite_number(kind, value)?),
        FormatKind::BooleanText => match value {
            Value::Bool(flag) => flag.to_string(),
            other => {
                return Err(format!(
                    "format (booleanText) decode applies to booleans, found: {}",
                    js::stringify(other)
                ));
            }
        },
        FormatKind::JsonText => js::stringify(value),
    };
    Ok(Value::String(text))
}

fn finite_number(kind: FormatKind, value: &Value) -> Result<f64, String> {
    match value {
        Value::Number(number) => Ok(*number),
        other => Err(format!(
            "format ({}) decode applies to finite numbers, found: {}",
            kind.name(),
            js::stringify(other)
        )),
    }
}

/// The fields of an ISO-8601 text in the shapes the format accepts: a calendar date, optionally a time with hours and
/// minutes, optional seconds and one to three fraction digits, and optionally `Z` or a numeric offset.
struct IsoFields {
    year: i64,
    month: i64,
    day: i64,
    time: Option<(i64, i64, i64, i64)>,
    offset_minutes: Option<i64>,
    /// Whether the offset's hours and minutes are in range (at most 23 and 59).
    offset_in_range: bool,
}

fn digits(text: &[u8], start: usize, count: usize) -> Option<i64> {
    let slice = text.get(start..start + count)?;
    if !slice.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(
        slice
            .iter()
            .fold(0, |total, digit| total * 10 + i64::from(digit - b'0')),
    )
}

fn iso_fields(text: &str) -> Option<IsoFields> {
    let bytes = text.as_bytes();
    let year = digits(bytes, 0, 4)?;
    if bytes.get(4) != Some(&b'-') {
        return None;
    }
    let month = digits(bytes, 5, 2)?;
    if bytes.get(7) != Some(&b'-') {
        return None;
    }
    let day = digits(bytes, 8, 2)?;
    let mut fields = IsoFields {
        year,
        month,
        day,
        time: None,
        offset_minutes: None,
        offset_in_range: true,
    };
    let mut position = 10;
    if position == bytes.len() {
        return Some(fields);
    }
    if bytes.get(position) != Some(&b'T') {
        return None;
    }
    let hours = digits(bytes, position + 1, 2)?;
    if bytes.get(position + 3) != Some(&b':') {
        return None;
    }
    let minutes = digits(bytes, position + 4, 2)?;
    position += 6;
    let mut seconds = 0;
    let mut milliseconds = 0;
    if bytes.get(position) == Some(&b':') {
        seconds = digits(bytes, position + 1, 2)?;
        position += 3;
        if bytes.get(position) == Some(&b'.') {
            let start = position + 1;
            let mut end = start;
            while end < bytes.len() && end < start + 3 && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end == start {
                return None;
            }
            let fraction = digits(bytes, start, end - start)?;
            milliseconds = fraction * 10_i64.pow(u32::try_from(3 - (end - start)).ok()?);
            position = end;
        }
    }
    fields.time = Some((hours, minutes, seconds, milliseconds));
    match bytes.get(position) {
        None => {}
        Some(b'Z') => {
            fields.offset_minutes = Some(0);
            position += 1;
        }
        Some(sign @ (b'+' | b'-')) => {
            let offset_hours = digits(bytes, position + 1, 2)?;
            if bytes.get(position + 3) != Some(&b':') {
                return None;
            }
            let offset_minutes = digits(bytes, position + 4, 2)?;
            fields.offset_in_range = offset_hours <= 23 && offset_minutes <= 59;
            let magnitude = offset_hours * 60 + offset_minutes;
            fields.offset_minutes = Some(if *sign == b'-' { -magnitude } else { magnitude });
            position += 6;
        }
        Some(_) => return None,
    }
    (position == bytes.len()).then_some(fields)
}

/// Days from 1970-01-01 to a proleptic Gregorian date, with an out-of-range day counted on into the next month.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The proleptic Gregorian date of a day count from 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The epoch milliseconds `new Date(text)` gives for text in the accepted shapes, or `None` for an invalid date. A time
/// with no zone is read as UTC.
fn date_value(fields: &IsoFields) -> Option<i64> {
    if !fields.offset_in_range
        || !(1..=12).contains(&fields.month)
        || !(1..=31).contains(&fields.day)
    {
        return None;
    }
    let (hours, minutes, seconds, milliseconds) = fields.time.unwrap_or((0, 0, 0, 0));
    let midnight_next = hours == 24 && minutes == 0 && seconds == 0 && milliseconds == 0;
    if (hours > 23 && !midnight_next) || minutes > 59 || seconds > 59 {
        return None;
    }
    let time = days_from_civil(fields.year, fields.month, fields.day) * MILLISECONDS_PER_DAY
        + hours * MILLISECONDS_PER_HOUR
        + minutes * MILLISECONDS_PER_MINUTE
        + seconds * MILLISECONDS_PER_SECOND
        + milliseconds
        - fields.offset_minutes.unwrap_or(0) * MILLISECONDS_PER_MINUTE;
    (time.unsigned_abs() <= 8_640_000_000_000_000).then_some(time)
}

fn parse_iso_date_time(text: &str) -> Result<f64, String> {
    let Some(fields) = iso_fields(text) else {
        return Err(format!(
            "value is not an ISO-8601 date or timestamp: {}",
            js::quote(text)
        ));
    };
    let Some(time) = date_value(&fields) else {
        return Err(format!(
            "value is a well-formed but nonexistent instant: {}",
            js::quote(text)
        ));
    };
    // The written calendar date is checked against the parsed one in the text's own zone (an offset can cross
    // midnight), because a nonexistent date such as 30 February rolls forward to another date rather than failing.
    let in_written_zone = time + fields.offset_minutes.unwrap_or(0) * MILLISECONDS_PER_MINUTE;
    let (year, month, day) = civil_from_days(in_written_zone.div_euclid(MILLISECONDS_PER_DAY));
    if (year, month, day) != (fields.year, fields.month, fields.day) {
        return Err(format!(
            "value is a well-formed but nonexistent instant (the date rolls forward): {}",
            js::quote(text)
        ));
    }
    Ok(time as f64)
}

fn parse_iso_date(text: &str) -> Result<f64, String> {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && digits(bytes, 0, 4).is_some()
        && bytes[4] == b'-'
        && digits(bytes, 5, 2).is_some()
        && bytes[7] == b'-'
        && digits(bytes, 8, 2).is_some();
    if !shaped {
        return Err(format!(
            "value is not an ISO-8601 calendar date (YYYY-MM-DD): {}",
            js::quote(text)
        ));
    }
    parse_iso_date_time(text)
}

/// `new Date(time).toISOString()`.
fn iso_string(time: f64) -> Result<String, String> {
    if time.abs() > MAX_TIME {
        return Err("Invalid time value".to_owned());
    }
    // TimeClip truncates towards zero; the magnitude is at most 8.64e15, which an i64 holds exactly.
    let clipped = time.trunc() as i64;
    let days = clipped.div_euclid(MILLISECONDS_PER_DAY);
    let within = clipped.rem_euclid(MILLISECONDS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Ok(format!(
        "{year_text}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        within / MILLISECONDS_PER_HOUR,
        within % MILLISECONDS_PER_HOUR / MILLISECONDS_PER_MINUTE,
        within % MILLISECONDS_PER_MINUTE / MILLISECONDS_PER_SECOND,
        within % MILLISECONDS_PER_SECOND
    ))
}

fn render_iso_date(time: f64) -> Result<String, String> {
    let days = time / MILLISECONDS_PER_DAY as f64;
    if days.fract() != 0.0 {
        return Err(format!(
            "value is not a UTC midnight, so it names no calendar date: {}",
            number_to_string(time)
        ));
    }
    let text = iso_string(time)?;
    let date = text.get(..10).unwrap_or("");
    let bytes = date.as_bytes();
    let four_digit_year = bytes.len() == 10 && bytes[..4].iter().all(u8::is_ascii_digit);
    if !four_digit_year {
        return Err(format!(
            "value is outside the four-digit years an ISO calendar date can spell: {}",
            number_to_string(time)
        ));
    }
    Ok(date.to_owned())
}

/// Whether a character is JavaScript white space or a line terminator, which `String.prototype.trim` and `Number`
/// both strip.
fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `Number(text)` for a non-empty trimmed text: a decimal literal with an optional sign, `Infinity`, or a `0x`, `0o`
/// or `0b` integer. `None` is `NaN`.
fn js_number(text: &str) -> Option<f64> {
    let radix = match text.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let body = &text[2..];
        if body.is_empty() || !body.chars().all(|digit| digit.is_digit(radix)) {
            return None;
        }
        return Some(body.chars().fold(0.0, |total, digit| {
            total * f64::from(radix) + f64::from(digit.to_digit(radix).unwrap_or(0))
        }));
    }
    let (sign, unsigned) = match text.as_bytes().first() {
        Some(b'-') => (-1.0, &text[1..]),
        Some(b'+') => (1.0, &text[1..]),
        _ => (1.0, text),
    };
    if unsigned == "Infinity" {
        return Some(sign * f64::INFINITY);
    }
    let bytes = unsigned.as_bytes();
    let mut position = 0;
    let integer_start = position;
    while bytes.get(position).is_some_and(u8::is_ascii_digit) {
        position += 1;
    }
    let mut digits_seen = position > integer_start;
    if bytes.get(position) == Some(&b'.') {
        position += 1;
        let fraction_start = position;
        while bytes.get(position).is_some_and(u8::is_ascii_digit) {
            position += 1;
        }
        digits_seen |= position > fraction_start;
    }
    if !digits_seen {
        return None;
    }
    if matches!(bytes.get(position), Some(b'e' | b'E')) {
        position += 1;
        if matches!(bytes.get(position), Some(b'+' | b'-')) {
            position += 1;
        }
        let exponent_start = position;
        while bytes.get(position).is_some_and(u8::is_ascii_digit) {
            position += 1;
        }
        if position == exponent_start {
            return None;
        }
    }
    if position != bytes.len() {
        return None;
    }
    unsigned
        .parse::<f64>()
        .ok()
        .map(|magnitude| sign * magnitude)
}

fn parse_number_text(text: &str) -> Result<f64, String> {
    let trimmed = text.trim_matches(is_js_space);
    match js_number(trimmed) {
        Some(number) if !trimmed.is_empty() && number.is_finite() => Ok(number),
        _ => Err(format!(
            "value is not a decimal number in text form: {}",
            js::quote(text)
        )),
    }
}

fn holds_proto_key(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(holds_proto_key),
        Value::Object(pairs) => pairs
            .iter()
            .any(|(key, member)| key == PROTO || holds_proto_key(member)),
        _ => false,
    }
}

fn parse_json_text(text: &str) -> Result<Value, String> {
    let parsed: Value =
        serde_json::from_str(text).map_err(|error| format!("value is not JSON text: {error}"))?;
    if holds_proto_key(&parsed) {
        return Err(format!(
            "JSON text holds a __proto__ key, which the output cannot carry: {}",
            js::quote(text)
        ));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_strings_match_to_iso_string() {
        assert_eq!(
            iso_string(1_792_318_500_000.0).as_deref(),
            Ok("2026-10-18T10:15:00.000Z")
        );
        assert_eq!(iso_string(-1.0).as_deref(), Ok("1969-12-31T23:59:59.999Z"));
        assert_eq!(iso_string(1.9).as_deref(), Ok("1970-01-01T00:00:00.001Z"));
        assert_eq!(
            iso_string(-62_198_755_200_000.0).as_deref(),
            Ok("-000001-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_string(253_402_300_800_000.0).as_deref(),
            Ok("+010000-01-01T00:00:00.000Z")
        );
        assert!(iso_string(8.64e15 + 1.0).is_err());
    }

    #[test]
    fn number_text_follows_number() {
        for (text, expected) in [
            (" 12 ", Some(12.0)),
            ("0x1f", Some(31.0)),
            (".5", Some(0.5)),
            ("5.", Some(5.0)),
            ("-1e3", Some(-1000.0)),
            ("1e", None),
            ("-0x1", None),
            ("Infinity", None),
            ("inf", None),
            ("1_0", None),
        ] {
            assert_eq!(parse_number_text(text).ok(), expected, "{text}");
        }
    }

    #[test]
    fn rolled_dates_are_refused() {
        assert!(parse_iso_date_time("2026-02-30").is_err());
        assert!(parse_iso_date_time("2024-02-29T23:59:59.999Z").is_ok());
        assert!(parse_iso_date_time("2026-10-18T24:00Z").is_err());
        assert_eq!(
            parse_iso_date_time("2026-10-18T10:15:00+01:00"),
            Ok(1_792_314_900_000.0)
        );
    }
}

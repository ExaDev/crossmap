//! `aggregate`: one value per group of the elements a wildcard path reaches, written in one direction.

use json_shape::Value;

use crate::crosswalk::AggregateFunction;
use crate::js;
use crate::path::{PathStep, TrailStep, bind, read_path, wildcard_count, wildcard_indexes};

/// The writes of an aggregate rule against the governing input document: the matches of `from` grouped by their
/// indexes at the first `k` wildcards, `k` being the wildcard count of `to`, and one value per group at `to` bound to
/// those indexes. The groups are enumerated from the arrays themselves, so a group with no elements still gets its
/// result.
///
/// # Errors
///
/// The message when `from` is absent from the document, a value does not fit the function, or `min` or `max` meets a
/// group with no values.
pub(crate) fn writes(
    function: AggregateFunction,
    from: &[PathStep],
    to: &[PathStep],
    document: &Value,
) -> Result<Vec<(Vec<TrailStep>, Value)>, String> {
    let depth = wildcard_count(to);
    let (Some(reading), Some(groups)) = (
        read_path(document, from),
        read_path(document, prefix_through_wildcard(from, depth)),
    ) else {
        return Err("the path is absent from the document".to_owned());
    };
    let mut grouped: Vec<(Vec<usize>, Vec<&Value>)> = groups
        .matches
        .iter()
        .map(|group| (wildcard_indexes(from, &group.trail), Vec::new()))
        .collect();
    for found in &reading.matches {
        let mut indexes = wildcard_indexes(from, &found.trail);
        indexes.truncate(depth);
        let Some((_, bucket)) = grouped.iter_mut().find(|(group, _)| *group == indexes) else {
            return Err(format!(
                "a match of {} belongs to no group",
                crate::path::format_path(from)
            ));
        };
        bucket.push(found.value);
    }
    grouped
        .into_iter()
        .map(|(indexes, values)| {
            Ok((
                bind(to, &indexes, None),
                Value::Number(combine(function, &values)?),
            ))
        })
        .collect()
}

/// The prefix of a path through its n-th wildcard, the array whose elements form the groups; the whole document for
/// n of zero.
fn prefix_through_wildcard(steps: &[PathStep], wildcards: usize) -> &[PathStep] {
    if wildcards == 0 {
        return &[];
    }
    let mut seen = 0;
    for (position, step) in steps.iter().enumerate() {
        if matches!(step, PathStep::Wildcard) {
            seen += 1;
            if seen == wildcards {
                return &steps[..=position];
            }
        }
    }
    steps
}

/// Combines one group's values: the count, or the sum, minimum or maximum of finite numbers.
fn combine(function: AggregateFunction, values: &[&Value]) -> Result<f64, String> {
    if function == AggregateFunction::Count {
        return Ok(values.len() as f64);
    }
    let mut numbers = Vec::with_capacity(values.len());
    for value in values {
        match value {
            Value::Number(number) => numbers.push(*number),
            other => {
                return Err(format!(
                    "{} applies to finite numbers, found: {}",
                    function.name(),
                    js::stringify(other)
                ));
            }
        }
    }
    if function == AggregateFunction::Sum {
        let total: f64 = numbers.iter().fold(0.0, |sum, value| sum + value);
        if !total.is_finite() {
            return Err("the sum overflows to a non-finite value".to_owned());
        }
        return Ok(total);
    }
    let Some((first, rest)) = numbers.split_first() else {
        return Err(format!(
            "{} of no values has no answer: gate the rule with when, or use count",
            function.name()
        ));
    };
    Ok(rest.iter().fold(*first, |best, value| {
        if function == AggregateFunction::Min {
            js_min(best, *value)
        } else {
            js_max(best, *value)
        }
    }))
}

/// `Math.min` of two finite numbers, which orders `-0` below `0`.
fn js_min(left: f64, right: f64) -> f64 {
    if left == right && left == 0.0 {
        if left.is_sign_negative() { left } else { right }
    } else if right < left {
        right
    } else {
        left
    }
}

/// `Math.max` of two finite numbers, which orders `0` above `-0`.
fn js_max(left: f64, right: f64) -> f64 {
    if left == right && left == 0.0 {
        if left.is_sign_negative() { right } else { left }
    } else if right > left {
        right
    } else {
        left
    }
}

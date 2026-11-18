//! The structural checks of a parsed crosswalk: the properties of the rule list as a whole that make it executable
//! and decode a true inverse of encode.
//!
//! Per two-way rule, every path has as many wildcards as the first `from` (key and index steps around them may
//! differ, which is how a rule nests or flattens), and a rule's several `from` paths iterate the same arrays; across
//! rules, every target array a wildcard iterates, at every depth, is fed by exactly one source array; every `to` path
//! and every `from` path is unique in canonical spelling; no array is addressed both by a fixed index and by a wildcard
//! on one side; `when` references are well-formed paths whose wildcards bind to the element the rule visits; and a
//! `default` writes one wildcard-free place.

use crate::crosswalk::{Crosswalk, Direction, OneWayRule, RuleSides, rule_sides};
use crate::error::CrosswalkIssue;
use crate::js;
use crate::path::{
    PathStep, canonical_path, format_path, is_path, parse_path, wildcard_arrays, wildcard_count,
};
use crate::when::visit_references;

/// The index of an issue that lies between rules rather than in one.
const BETWEEN_RULES: i64 = -1;

fn steps(path: &str) -> Vec<PathStep> {
    parse_path(path).unwrap_or_default()
}

fn index(position: usize) -> i64 {
    i64::try_from(position).unwrap_or(i64::MAX)
}

/// Validates a parsed crosswalk against the structural rules of the format.
///
/// Returns every issue found, empty when the crosswalk is sound. Issue indexes number the two-way rules first, then
/// the one-way rules.
pub fn validate_crosswalk(crosswalk: &Crosswalk) -> Vec<CrosswalkIssue> {
    let rule_count = crosswalk.rules().len();
    let mut issues = Vec::new();
    for (position, rule) in crosswalk.rules().iter().enumerate() {
        let sides = rule_sides(rule);
        let first = first_from(&sides);
        check_wildcard_alignment(&sides, &first, index(position), &mut issues);
        check_shared_arrays(&sides, &first, index(position), &mut issues);
        check_when_paths(
            rule.when().map(|when| when.json()),
            index(position),
            Some(&first),
            &mut issues,
        );
    }
    for (position, rule) in crosswalk.one_way().iter().enumerate() {
        let at = index(rule_count + position);
        check_when_paths(rule.when().map(|when| when.json()), at, None, &mut issues);
        match rule {
            OneWayRule::Default { to, .. } => {
                if wildcard_count(&steps(to)) > 0 {
                    issues.push(CrosswalkIssue {
                        rule_index: at,
                        message: format!("a default rule's to path must be wildcard-free: {to}"),
                    });
                }
            }
            OneWayRule::Aggregate { from, to, .. } => {
                if wildcard_count(&steps(from)) <= wildcard_count(&steps(to)) {
                    issues.push(CrosswalkIssue {
                        rule_index: at,
                        message: format!(
                            "an aggregate's from ({from}) needs more wildcards than its to ({to}): it combines the elements of the wildcards to drops"
                        ),
                    });
                }
            }
            OneWayRule::Drop { .. } => {}
        }
    }
    check_path_uniqueness(crosswalk, &mut issues);
    check_wildcard_roots(crosswalk, &mut issues);
    check_index_wildcard_mix(crosswalk, &mut issues);
    issues
}

/// A rule's first `from` path, parsed: the read side every gate and pairing is measured against.
fn first_from(sides: &RuleSides) -> Vec<PathStep> {
    sides
        .from
        .first()
        .map(|path| steps(path))
        .unwrap_or_default()
}

fn check_wildcard_alignment(
    sides: &RuleSides,
    first: &[PathStep],
    rule: i64,
    issues: &mut Vec<CrosswalkIssue>,
) {
    let expected = wildcard_count(first);
    let sided = sides
        .from
        .iter()
        .map(|path| ("from", path))
        .chain(sides.to.iter().map(|path| ("to", path)));
    for (side, path) in sided {
        let wildcards = wildcard_count(&steps(path));
        if wildcards != expected {
            issues.push(CrosswalkIssue {
                rule_index: rule,
                message: format!(
                    "{side} path {path} has {wildcards} wildcards where the first from has {expected}: mapping is index-aligned, one wildcard to one"
                ),
            });
        }
    }
}

fn check_shared_arrays(
    sides: &RuleSides,
    first: &[PathStep],
    rule: i64,
    issues: &mut Vec<CrosswalkIssue>,
) {
    let arrays = wildcard_arrays(first).join(" ");
    for path in &sides.from {
        if wildcard_arrays(&steps(path)).join(" ") != arrays {
            issues.push(CrosswalkIssue {
                rule_index: rule,
                message: format!(
                    "from path {path} iterates different arrays from the rule's other from paths: the fields of one element must come from one element"
                ),
            });
        }
    }
}

fn check_when_paths(
    when: Option<&json_shape::Value>,
    rule: i64,
    from: Option<&[PathStep]>,
    issues: &mut Vec<CrosswalkIssue>,
) {
    let Some(when) = when else {
        return;
    };
    visit_references(when, &mut |reference| {
        let Some(path) = reference.as_str().filter(|path| is_path(path)) else {
            issues.push(CrosswalkIssue {
                rule_index: rule,
                message: format!(
                    "when references a path that is malformed: {}",
                    js::stringify(reference)
                ),
            });
            return;
        };
        if let Some(problem) = element_reference_problem(&steps(path), from) {
            issues.push(CrosswalkIssue {
                rule_index: rule,
                message: format!("when reference {path} {problem}"),
            });
        }
    });
}

/// Why a reference's wildcards cannot bind to the element its rule visits, or `None` when they can.
fn element_reference_problem(reference: &[PathStep], from: Option<&[PathStep]>) -> Option<String> {
    let wildcards = wildcard_count(reference);
    if wildcards == 0 {
        return None;
    }
    let Some(from) = from else {
        return Some(
            "contains a wildcard, but a one-way rule visits no element to bind it to".to_owned(),
        );
    };
    let from_wildcards = wildcard_count(from);
    if wildcards > from_wildcards {
        return Some(format!(
            "contains {wildcards} wildcards where its rule's from has {from_wildcards}"
        ));
    }
    let last = reference
        .iter()
        .rposition(|step| matches!(step, PathStep::Wildcard))
        .map_or(0, |position| position + 1);
    let reference_array = format_path(&reference[..last]);
    let from_array = wildcard_arrays(from).get(wildcards - 1).cloned();
    if from_array.as_deref() != Some(reference_array.as_str()) {
        return Some(format!(
            "contains a wildcard into {reference_array}, which is not the array its rule's from iterates at that depth ({})",
            from_array.unwrap_or_else(|| "undefined".to_owned())
        ));
    }
    None
}

/// Records a path in an insertion-ordered map, marking a repeat.
fn note_path(paths: &mut Vec<(String, bool)>, path: &str) {
    let canonical = canonical_path(path).unwrap_or_else(|| path.to_owned());
    match paths.iter_mut().find(|(seen, _)| *seen == canonical) {
        Some((_, repeated)) => *repeated = true,
        None => paths.push((canonical, false)),
    }
}

fn check_path_uniqueness(crosswalk: &Crosswalk, issues: &mut Vec<CrosswalkIssue>) {
    let mut to_paths = Vec::new();
    let mut from_paths = Vec::new();
    for rule in crosswalk.rules() {
        let sides = rule_sides(rule);
        for path in &sides.to {
            note_path(&mut to_paths, path);
        }
        for path in &sides.from {
            note_path(&mut from_paths, path);
        }
    }
    for rule in crosswalk.one_way() {
        match rule {
            OneWayRule::Drop { from, .. } => note_path(&mut from_paths, from),
            // A decode-direction write lands in the source-shape document, where the two-way rules' from paths live.
            OneWayRule::Default { to, direction, .. }
            | OneWayRule::Aggregate { to, direction, .. } => {
                let paths = if *direction == Direction::Encode {
                    &mut to_paths
                } else {
                    &mut from_paths
                };
                note_path(paths, to);
            }
        }
    }
    for (path, repeated) in to_paths {
        if repeated {
            issues.push(CrosswalkIssue {
                rule_index: BETWEEN_RULES,
                message: format!("two rules write the same to path: {path}"),
            });
        }
    }
    for (path, repeated) in from_paths {
        if repeated {
            issues.push(CrosswalkIssue {
                rule_index: BETWEEN_RULES,
                message: format!("two rules use the same from path: {path}"),
            });
        }
    }
}

fn check_wildcard_roots(crosswalk: &Crosswalk, issues: &mut Vec<CrosswalkIssue>) {
    let mut feeders: Vec<(String, String)> = Vec::new();
    for (position, rule) in crosswalk.rules().iter().enumerate() {
        let sides = rule_sides(rule);
        let from_arrays = wildcard_arrays(&first_from(&sides));
        for path in &sides.to {
            for (depth, to_array) in wildcard_arrays(&steps(path)).into_iter().enumerate() {
                let Some(from_array) = from_arrays.get(depth) else {
                    continue;
                };
                match feeders.iter().find(|(array, _)| *array == to_array) {
                    Some((_, existing)) if existing != from_array => {
                        issues.push(CrosswalkIssue {
                            rule_index: index(position),
                            message: format!(
                                "two source arrays ({existing}, {from_array}) feed the one target array {to_array}: the merge is not index-invertible"
                            ),
                        });
                    }
                    Some(_) => {}
                    None => feeders.push((to_array, from_array.clone())),
                }
            }
        }
    }
    let rule_count = crosswalk.rules().len();
    for (position, rule) in crosswalk.one_way().iter().enumerate() {
        let OneWayRule::Aggregate {
            from,
            to,
            direction,
            ..
        } = rule
        else {
            continue;
        };
        let to_arrays = wildcard_arrays(&steps(to));
        let mut from_arrays = wildcard_arrays(&steps(from));
        from_arrays.truncate(to_arrays.len());
        let (target_arrays, source_arrays) = if *direction == Direction::Encode {
            (to_arrays, from_arrays)
        } else {
            (from_arrays, to_arrays)
        };
        for (depth, target_array) in target_arrays.iter().enumerate() {
            let source_array = source_arrays.get(depth);
            let existing = feeders
                .iter()
                .find(|(array, _)| array == target_array)
                .map(|(_, feeder)| feeder);
            if let (Some(source_array), Some(existing)) = (source_array, existing)
                && existing != source_array
            {
                issues.push(CrosswalkIssue {
                    rule_index: index(rule_count + position),
                    message: format!(
                        "an aggregate groups {source_array} into {target_array}, which {existing} feeds: the results would land in the wrong elements"
                    ),
                });
            }
        }
    }
}

fn check_index_wildcard_mix(crosswalk: &Crosswalk, issues: &mut Vec<CrosswalkIssue>) {
    let one_way_writes = |wanted: Direction| -> Vec<String> {
        crosswalk
            .one_way()
            .iter()
            .filter_map(|rule| match rule {
                OneWayRule::Default { to, direction, .. }
                | OneWayRule::Aggregate { to, direction, .. }
                    if *direction == wanted =>
                {
                    Some(to.clone())
                }
                _ => None,
            })
            .collect()
    };
    let mut from_side: Vec<String> = crosswalk
        .rules()
        .iter()
        .flat_map(|rule| rule_sides(rule).from)
        .collect();
    from_side.extend(one_way_writes(Direction::Decode));
    let mut to_side: Vec<String> = crosswalk
        .rules()
        .iter()
        .flat_map(|rule| rule_sides(rule).to)
        .collect();
    to_side.extend(one_way_writes(Direction::Encode));
    for array in mixed_arrays(&from_side)
        .into_iter()
        .chain(mixed_arrays(&to_side))
    {
        issues.push(CrosswalkIssue {
            rule_index: BETWEEN_RULES,
            message: format!(
                "the array {array} is addressed both by a fixed index and by a wildcard"
            ),
        });
    }
}

/// The locations of every array some path addresses by index and another by wildcard, in the order first indexed.
fn mixed_arrays(paths: &[String]) -> Vec<String> {
    let mut indexed: Vec<String> = Vec::new();
    let mut iterated: Vec<String> = Vec::new();
    for path in paths {
        let locus = steps(path);
        for (position, step) in locus.iter().enumerate() {
            let set = match step {
                PathStep::Key(_) => continue,
                PathStep::Index(_) => &mut indexed,
                PathStep::Wildcard => &mut iterated,
            };
            let array = format_path(&locus[..position]);
            if !set.contains(&array) {
                set.push(array);
            }
        }
    }
    indexed
        .into_iter()
        .filter(|array| iterated.contains(array))
        .collect()
}

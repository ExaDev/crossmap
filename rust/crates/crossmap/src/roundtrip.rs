//! Checking that decode inverts encode over sample documents.

use json_shape::Value;

use crate::crosswalk::{Crosswalk, Direction, OneWayRule};
use crate::error::CrossmapError;
use crate::executor::compile_crosswalk;
use crate::js;
use crate::path::{PathStep, TrailStep, format_trail, parse_path};

/// Checks that `decode(encode(sample))` equals every sample on the paths the crosswalk promises to preserve. The paths
/// one-way rules touch are left out (a dropped path cannot survive; a decode-direction default or aggregate inserts a
/// path the sample never had), then each round trip is compared with its sample, leaves with `Object.is`.
///
/// # Errors
///
/// [`CrossmapError::Structure`] when the crosswalk fails structural validation, any error encode or decode reports,
/// and [`CrossmapError::RoundTripMismatch`] naming the sample and path of the first difference.
pub fn assert_round_trip(crosswalk: &Crosswalk, samples: &[Value]) -> Result<(), CrossmapError> {
    let codec = compile_crosswalk(crosswalk)?;
    let mut excluded = Vec::new();
    for rule in crosswalk.one_way() {
        let path = match rule {
            OneWayRule::Drop { from, .. } => from,
            OneWayRule::Default { to, direction, .. }
            | OneWayRule::Aggregate { to, direction, .. } => {
                if *direction != Direction::Decode {
                    continue;
                }
                to
            }
        };
        excluded.push(parse_path(path)?);
    }
    for (sample_index, sample) in samples.iter().enumerate() {
        let round_tripped = codec.decode(&codec.encode(sample)?)?;
        let left = excluded
            .iter()
            .fold(Tree::from(sample), |tree, steps| prune(tree, steps));
        let right = excluded
            .iter()
            .fold(Tree::from(&round_tripped), |tree, steps| prune(tree, steps));
        let mut trail = Vec::new();
        compare(&left, &right, &mut trail, sample_index)?;
    }
    Ok(())
}

/// A document under comparison, in which a pruned array element keeps its slot so later indexes do not shift.
#[derive(Clone, Debug)]
enum Tree {
    Leaf(Value),
    Array(Vec<Tree>),
    Record(Vec<(String, Tree)>),
    Pruned,
}

impl From<&Value> for Tree {
    fn from(value: &Value) -> Self {
        match value {
            Value::Array(items) => Tree::Array(items.iter().map(Tree::from).collect()),
            Value::Object(pairs) => Tree::Record(
                js::ordered_pairs(pairs)
                    .into_iter()
                    .map(|(key, member)| (key.clone(), Tree::from(member)))
                    .collect(),
            ),
            other => Tree::Leaf(other.clone()),
        }
    }
}

/// The tree with one path's locations removed: a wildcard rebuilds every element, a key removes the member where the
/// path ends there, and an index replaces the element with the pruned marker where the path ends there. Absence along
/// the way is fine.
fn prune(tree: Tree, steps: &[PathStep]) -> Tree {
    let Some((first, rest)) = steps.split_first() else {
        return tree;
    };
    match (first, tree) {
        (PathStep::Wildcard, Tree::Array(items)) => {
            Tree::Array(items.into_iter().map(|item| prune(item, rest)).collect())
        }
        (PathStep::Index(index), Tree::Array(items)) if *index < items.len() => Tree::Array(
            items
                .into_iter()
                .enumerate()
                .map(|(position, item)| {
                    if position != *index {
                        item
                    } else if rest.is_empty() {
                        Tree::Pruned
                    } else {
                        prune(item, rest)
                    }
                })
                .collect(),
        ),
        (PathStep::Key(key), Tree::Record(pairs)) => Tree::Record(
            pairs
                .into_iter()
                .filter_map(|(name, member)| {
                    if name != *key {
                        Some((name, member))
                    } else if rest.is_empty() {
                        None
                    } else {
                        Some((name, prune(member, rest)))
                    }
                })
                .collect(),
        ),
        (_, tree) => tree,
    }
}

fn kind_of(tree: &Tree) -> &'static str {
    match tree {
        Tree::Array(_) => "array",
        Tree::Record(_) => "record",
        Tree::Pruned => "symbol",
        Tree::Leaf(Value::Number(_)) => "number",
        Tree::Leaf(Value::String(_)) => "string",
        Tree::Leaf(Value::Bool(_)) => "boolean",
        Tree::Leaf(_) => "object",
    }
}

fn describe(tree: &Tree) -> String {
    match tree {
        Tree::Pruned => "(a pruned element)".to_owned(),
        Tree::Leaf(value) => js::to_display_string(value),
        Tree::Array(_) | Tree::Record(_) => kind_of(tree).to_owned(),
    }
}

fn same_leaf(left: &Tree, right: &Tree) -> bool {
    match (left, right) {
        (Tree::Pruned, Tree::Pruned) => true,
        (Tree::Leaf(Value::Number(left)), Tree::Leaf(Value::Number(right))) => {
            js::same_number(*left, *right)
        }
        (Tree::Leaf(left), Tree::Leaf(right)) => left == right,
        _ => false,
    }
}

fn compare(
    left: &Tree,
    right: &Tree,
    trail: &mut Vec<TrailStep>,
    sample_index: usize,
) -> Result<(), CrossmapError> {
    let mismatch = |trail: &[TrailStep], detail: String| CrossmapError::RoundTripMismatch {
        sample_index,
        path: format_trail(trail),
        detail,
    };
    match (left, right) {
        (Tree::Array(left), Tree::Array(right)) => {
            if left.len() != right.len() {
                return Err(mismatch(
                    trail,
                    format!(
                        "arrays differ in length: {} against {}",
                        left.len(),
                        right.len()
                    ),
                ));
            }
            for (index, (left, right)) in left.iter().zip(right).enumerate() {
                trail.push(TrailStep::Index(index));
                compare(left, right, trail, sample_index)?;
                trail.pop();
            }
            Ok(())
        }
        (Tree::Record(left), Tree::Record(right)) => {
            let (left_keys, right_keys) = (sorted_keys(left), sorted_keys(right));
            if left_keys.join(",") != right_keys.join(",") {
                return Err(mismatch(
                    trail,
                    format!(
                        "records differ in keys: {} against {}",
                        left_keys.join(","),
                        right_keys.join(",")
                    ),
                ));
            }
            // Two key lists can join to the same text without being the same keys (a key holding a comma), so a member may be missing on one side; it compares as the pruned marker, which equals only itself.
            let missing = Tree::Pruned;
            for key in left_keys {
                trail.push(TrailStep::Key(key.to_owned()));
                compare(
                    member_or(left, key, &missing),
                    member_or(right, key, &missing),
                    trail,
                    sample_index,
                )?;
                trail.pop();
            }
            Ok(())
        }
        (left, right) => {
            let container = |tree: &Tree| matches!(tree, Tree::Array(_) | Tree::Record(_));
            if container(left) || container(right) {
                return Err(mismatch(
                    trail,
                    format!(
                        "values differ in kind: {} against {}",
                        kind_of(left),
                        kind_of(right)
                    ),
                ));
            }
            if !same_leaf(left, right) {
                return Err(mismatch(
                    trail,
                    format!(
                        "values differ: {} against {}",
                        describe(left),
                        describe(right)
                    ),
                ));
            }
            Ok(())
        }
    }
}

/// A record's keys in UTF-16 code unit order, as `Object.keys(record).sort()` gives them.
fn sorted_keys(pairs: &[(String, Tree)]) -> Vec<&str> {
    let mut keys: Vec<&str> = pairs.iter().map(|(key, _)| key.as_str()).collect();
    keys.sort_by(|left, right| js::compare_code_units(left, right));
    keys
}

fn member_or<'t>(pairs: &'t [(String, Tree)], key: &str, missing: &'t Tree) -> &'t Tree {
    pairs
        .iter()
        .find(|(name, _)| name == key)
        .map_or(missing, |(_, member)| member)
}

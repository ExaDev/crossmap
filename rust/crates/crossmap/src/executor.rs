//! Running a crosswalk: encode, decode, and the prepared form both run from.
//!
//! Every read path is read from the input as given and every write path is written into a fresh output, so the input
//! is never changed and rule order carries no meaning (the path uniqueness [`crate::validate_crosswalk`] enforces is
//! what makes that safe). Two-way rules write first, then the one-way rules due in the direction, and an output array
//! left with an element no rule wrote is refused.

use json_shape::Value;

use crate::crosswalk::{Crosswalk, Direction, OneWayRule, TwoWayRule, rule_sides};
use crate::error::CrossmapError;
use crate::ops::{self, aggregate, format, template};
use crate::output::Node;
use crate::path::{
    ElementGate, EmptySite, PathStep, bind, format_trail, parse_path, read_trail, walk,
    wildcard_indexes,
};
use crate::validate::validate_crosswalk;
use crate::when::{Gate, WhenElement};

/// The rule index of a failure no single rule owns: a gap in an output array is the absence of a write.
const NO_SINGLE_RULE: i64 = -1;

/// One read path of a rule in one direction.
#[derive(Clone, Debug)]
struct ReadSide {
    path: String,
    steps: Vec<PathStep>,
}

/// One two-way rule prepared for one direction.
#[derive(Clone, Debug)]
struct RulePlan {
    index: usize,
    /// The read path the rule walks, which every other read path pairs with element by element.
    governing: ReadSide,
    other_reads: Vec<ReadSide>,
    writes: Vec<Vec<PathStep>>,
    /// Every read path, as an operation's failure names them.
    read_path: String,
    /// Every write path, as a write's failure names them.
    write_path: String,
    /// The governing path through each of its wildcards: the arrays a per-element gate's references are rebased onto.
    arrays: Vec<Vec<PathStep>>,
    /// A template's parsed pieces.
    pieces: Vec<template::Piece>,
}

/// A crosswalk prepared for one direction.
#[derive(Clone, Debug)]
struct Plan {
    direction: Direction,
    rules: Vec<RulePlan>,
}

/// A crosswalk validated and prepared once, for both directions.
#[derive(Clone, Debug)]
pub(crate) struct Prepared {
    encode: Plan,
    decode: Plan,
}

/// A crosswalk prepared for running any number of times: [`Compiled::encode`] and [`Compiled::decode`] have exactly
/// the semantics of [`encode`] and [`decode`] on the crosswalk.
#[derive(Clone, Copy, Debug)]
pub struct Compiled<'c> {
    crosswalk: &'c Crosswalk,
    prepared: &'c Prepared,
}

impl Compiled<'_> {
    /// Encodes a native document into the shared shape, as [`encode`] does.
    ///
    /// # Errors
    ///
    /// As [`encode`], apart from the structural check, which compiling has already passed.
    pub fn encode(&self, document: &Value) -> Result<Value, CrossmapError> {
        run(self.crosswalk, &self.prepared.encode, document)
    }

    /// Decodes a shared document back into the native shape, as [`decode`] does.
    ///
    /// # Errors
    ///
    /// As [`decode`], apart from the structural check, which compiling has already passed.
    pub fn decode(&self, document: &Value) -> Result<Value, CrossmapError> {
        run(self.crosswalk, &self.prepared.decode, document)
    }
}

/// Validates and prepares a crosswalk for encoding and decoding any number of documents. The prepared form is kept
/// with the crosswalk, so compiling it again (as [`encode`] and [`decode`] do on every call) costs nothing.
///
/// # Errors
///
/// [`CrossmapError::Structure`] when the crosswalk fails structural validation.
pub fn compile_crosswalk(crosswalk: &Crosswalk) -> Result<Compiled<'_>, CrossmapError> {
    let prepared = crosswalk.prepared.get_or_init(|| prepare(crosswalk));
    match prepared {
        Ok(prepared) => Ok(Compiled {
            crosswalk,
            prepared,
        }),
        Err(error) => Err(error.clone()),
    }
}

/// Encodes a native document into the shared shape. A rule's `when` is evaluated against `document`.
///
/// # Errors
///
/// [`CrossmapError::Structure`] when the crosswalk fails structural validation; [`CrossmapError::RuleApplication`]
/// when a read path is absent, a value does not fit an operation, two rules claim one output location, or an output
/// array is left with an element no rule wrote; [`CrossmapError::WhenEvaluation`] when a gate cannot be evaluated.
pub fn encode(crosswalk: &Crosswalk, document: &Value) -> Result<Value, CrossmapError> {
    compile_crosswalk(crosswalk)?.encode(document)
}

/// Decodes a shared document back into the native shape: every two-way rule's paths swapped and each operation's
/// inverse applied. A rule's `when` is evaluated against `document`, the shared document.
///
/// # Errors
///
/// As [`encode`].
pub fn decode(crosswalk: &Crosswalk, document: &Value) -> Result<Value, CrossmapError> {
    compile_crosswalk(crosswalk)?.decode(document)
}

fn prepare(crosswalk: &Crosswalk) -> Result<Prepared, CrossmapError> {
    let issues = validate_crosswalk(crosswalk);
    if !issues.is_empty() {
        return Err(CrossmapError::Structure { issues });
    }
    Ok(Prepared {
        encode: plan(crosswalk, Direction::Encode)?,
        decode: plan(crosswalk, Direction::Decode)?,
    })
}

fn read_side(path: &str) -> Result<ReadSide, CrossmapError> {
    Ok(ReadSide {
        path: path.to_owned(),
        steps: parse_path(path)?,
    })
}

fn plan(crosswalk: &Crosswalk, direction: Direction) -> Result<Plan, CrossmapError> {
    let mut rules = Vec::with_capacity(crosswalk.rules().len());
    for (index, rule) in crosswalk.rules().iter().enumerate() {
        let sides = rule_sides(rule);
        let (reads, writes) = match direction {
            Direction::Encode => (sides.from, sides.to),
            Direction::Decode => (sides.to, sides.from),
        };
        let mut read_sides = reads
            .iter()
            .map(|path| read_side(path))
            .collect::<Result<Vec<_>, _>>()?;
        if read_sides.is_empty() {
            return Err(CrossmapError::syntax("a rule with no read path"));
        }
        let governing = read_sides.remove(0);
        let arrays = governing
            .steps
            .iter()
            .enumerate()
            .filter(|(_, step)| matches!(step, PathStep::Wildcard))
            .map(|(position, _)| governing.steps[..=position].to_vec())
            .collect();
        let pieces = match rule {
            TwoWayRule::Template { template, .. } => {
                template::parse(template).map_err(CrossmapError::syntax)?
            }
            _ => Vec::new(),
        };
        rules.push(RulePlan {
            index,
            governing,
            other_reads: read_sides,
            writes: writes
                .iter()
                .map(|path| parse_path(path))
                .collect::<Result<_, _>>()?,
            read_path: reads.join(", "),
            write_path: writes.join(", "),
            arrays,
            pieces,
        });
    }
    Ok(Plan { direction, rules })
}

fn run(crosswalk: &Crosswalk, plan: &Plan, document: &Value) -> Result<Value, CrossmapError> {
    let mut target = Node::root();
    for (rule, rule_plan) in crosswalk.rules().iter().zip(&plan.rules) {
        apply_two_way(rule, rule_plan, plan.direction, document, &mut target)?;
    }
    let rule_count = crosswalk.rules().len();
    for (position, rule) in crosswalk.one_way().iter().enumerate() {
        if let Some(when) = rule.when()
            && !when.admits(document, None)?
        {
            continue;
        }
        apply_one_way(rule, plan.direction, document, &mut target).map_err(|detail| {
            let path = match rule {
                OneWayRule::Default { to, .. } => to,
                OneWayRule::Drop { from, .. } | OneWayRule::Aggregate { from, .. } => from,
            };
            CrossmapError::rule(rule_count + position, path.clone(), detail)
        })?;
    }
    target
        .finish()
        .map_err(|hole| CrossmapError::RuleApplication {
            rule_index: NO_SINGLE_RULE,
            path: format_trail(&hole),
            detail: "no rule wrote this array element, so the array would have a gap".to_owned(),
        })
}

fn apply_one_way(
    rule: &OneWayRule,
    direction: Direction,
    document: &Value,
    target: &mut Node,
) -> Result<(), String> {
    match rule {
        OneWayRule::Drop { .. } => Ok(()),
        OneWayRule::Aggregate {
            function,
            from,
            to,
            direction: applies,
            ..
        } => {
            if *applies != direction {
                return Ok(());
            }
            let from = parse_path(from).map_err(|error| error.to_string())?;
            let to = parse_path(to).map_err(|error| error.to_string())?;
            for (trail, value) in aggregate::writes(*function, &from, &to, document)? {
                target.write(&trail, value)?;
            }
            Ok(())
        }
        OneWayRule::Default {
            to,
            value,
            direction: applies,
            ..
        } => {
            if *applies != direction {
                return Ok(());
            }
            // Validation refuses a wildcard in a default's `to`, so binding with no indexes gives its one trail.
            let trail = bind(
                &parse_path(to).map_err(|error| error.to_string())?,
                &[],
                None,
            );
            if target.has(&trail) {
                return Ok(());
            }
            target.write(&trail, value.clone())
        }
    }
}

/// How a rule's gate applies: decided once for the whole rule when its references have no wildcards, otherwise per
/// element at the depth its references reach.
enum RuleGate<'g> {
    Skip,
    All,
    PerElement(&'g dyn Gate, usize),
}

fn apply_two_way(
    rule: &TwoWayRule,
    plan: &RulePlan,
    direction: Direction,
    document: &Value,
    target: &mut Node,
) -> Result<(), CrossmapError> {
    let gate = match rule.when() {
        None => RuleGate::All,
        Some(when) if when.arity() == 0 => {
            if when.admits(document, None)? {
                RuleGate::All
            } else {
                RuleGate::Skip
            }
        }
        Some(when) => RuleGate::PerElement(when, when.arity()),
    };
    let admit = |indexes: &[usize]| -> Result<bool, CrossmapError> {
        match gate {
            RuleGate::PerElement(gate, _) => gate.admits(
                document,
                Some(&WhenElement {
                    indexes,
                    arrays: &plan.arrays,
                }),
            ),
            RuleGate::Skip | RuleGate::All => Ok(true),
        }
    };
    let element_gate = match gate {
        RuleGate::Skip => return Ok(()),
        RuleGate::All => None,
        RuleGate::PerElement(_, arity) => Some(ElementGate {
            arity,
            admit: &admit,
        }),
    };
    let element_gate = element_gate.as_ref();
    let index = plan.index;
    let absent = |read: &ReadSide| {
        CrossmapError::rule(
            index,
            read.path.clone(),
            "the path is absent from the document",
        )
    };
    let unpaired = |read: &ReadSide| {
        CrossmapError::rule(
            index,
            read.path.clone(),
            format!(
                "addresses different elements from {}, so the paths cannot be paired element by element",
                plan.governing.path
            ),
        )
    };
    let count = |steps: &[PathStep]| -> Result<Option<(Vec<EmptySite>, usize)>, CrossmapError> {
        let mut matches = 0;
        let empties = walk(document, steps, element_gate, &mut |_, _| {
            matches += 1;
            Ok(())
        })?;
        Ok(empties.map(|empties| (empties, matches)))
    };
    let Some((governing_empties, governing_count)) = count(&plan.governing.steps)? else {
        return Err(absent(&plan.governing));
    };
    let mut empties: Vec<(&[PathStep], EmptySite)> = governing_empties
        .into_iter()
        .map(|empty| (plan.governing.steps.as_slice(), empty))
        .collect();
    for read in &plan.other_reads {
        let Some((read_empties, read_count)) = count(&read.steps)? else {
            return Err(absent(read));
        };
        if read_count != governing_count {
            return Err(unpaired(read));
        }
        empties.extend(
            read_empties
                .into_iter()
                .map(|empty| (read.steps.as_slice(), empty)),
        );
    }
    walk(
        document,
        &plan.governing.steps,
        element_gate,
        &mut |trail, value| {
            let indexes = wildcard_indexes(&plan.governing.steps, trail);
            let mut values = Vec::with_capacity(1 + plan.other_reads.len());
            values.push(value);
            for read in &plan.other_reads {
                let Some(found) = read_trail(document, &bind(&read.steps, &indexes, None)) else {
                    return Err(unpaired(read));
                };
                values.push(found);
            }
            let results = transform(rule, plan, direction, &values)
                .map_err(|detail| CrossmapError::rule(index, plan.read_path.clone(), detail))?;
            for (steps, result) in plan.writes.iter().zip(results) {
                target
                    .write(&bind(steps, &indexes, None), result)
                    .map_err(|detail| {
                        CrossmapError::rule(index, plan.write_path.clone(), detail)
                    })?;
            }
            Ok(())
        },
    )?;
    // An existing empty source array yields no matches, so without this its counterpart would never come into being.
    for (steps, empty) in empties {
        let indexes = wildcard_indexes(steps, &empty.trail);
        for write in &plan.writes {
            target
                .ensure_array(&bind(write, &indexes, Some(empty.wildcard)))
                .map_err(|detail| CrossmapError::rule(index, plan.write_path.clone(), detail))?;
        }
    }
    Ok(())
}

/// A rule's operation in one direction over one element's values: one value per read path in, one per write path out.
fn transform(
    rule: &TwoWayRule,
    plan: &RulePlan,
    direction: Direction,
    values: &[&Value],
) -> Result<Vec<Value>, String> {
    let encode = direction == Direction::Encode;
    let first = values
        .first()
        .copied()
        .ok_or_else(|| "a rule read no values".to_owned())?;
    Ok(match rule {
        TwoWayRule::Move(_) => vec![first.clone()],
        TwoWayRule::Scale { factor, .. } => vec![ops::scale(*factor, encode, first)?],
        TwoWayRule::Enum { map, map_back, .. } => vec![if encode {
            ops::enumerate(map, "map", first)?
        } else {
            ops::enumerate(map_back, "mapBack", first)?
        }],
        TwoWayRule::Format { kind, .. } => vec![if encode {
            format::encode(*kind, first)?
        } else {
            format::decode(*kind, first)?
        }],
        TwoWayRule::Split { separator, .. } => vec![if encode {
            ops::split_encode(separator, first)?
        } else {
            ops::split_decode(separator, first)?
        }],
        TwoWayRule::Template { from, .. } => {
            if encode {
                let fields: Vec<(&str, &Value)> = from
                    .iter()
                    .zip(values)
                    .map(|((name, _), value)| (name.as_str(), *value))
                    .collect();
                vec![Value::String(template::render(&plan.pieces, &fields)?)]
            } else {
                let Value::String(text) = first else {
                    return Err(format!(
                        "template decode applies to strings, found: {}",
                        crate::js::stringify(first)
                    ));
                };
                let parts = template::split(&plan.pieces, text)?;
                from.iter()
                    .map(|(name, _)| {
                        parts
                            .iter()
                            .find(|(part, _)| part == name)
                            .map(|(_, text)| Value::String((*text).to_owned()))
                            .ok_or_else(|| format!("the template has no placeholder {name}"))
                    })
                    .collect::<Result<_, _>>()?
            }
        }
        TwoWayRule::Copy { to, .. } => {
            if encode {
                to.iter().map(|_| first.clone()).collect()
            } else {
                vec![ops::copy_decode(values)?]
            }
        }
    })
}

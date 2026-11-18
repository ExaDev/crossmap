//! Property tests, after `conformance/PROPERTIES.md`: the statements a JSON fixture cannot be.
//!
//! The differential property (the optimised executor against a reference executor) has no obligation here, because
//! this port has one executor and the recorded outcomes in `conformance/crossmap/generated/differential.json` are its
//! oracle; the conformance runner holds it to them.

use crossmap::{
    CrossmapError, Direction, PathStep, Value, assert_round_trip, decode, encode, format_path,
    parse_crosswalk, parse_path, rule_sides,
};
use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;

use proptest::prelude::*;
use proptest::test_runner::{RngAlgorithm, TestRng, TestRunner};

fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn object(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(
        pairs
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

/// The leaves of PROPERTIES.md: several fit an operation (enum keys, number text, ISO dates, separated text).
fn leaf() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(text("open")),
        Just(text("closed")),
        Just(text("x")),
        Just(text("1")),
        Just(text("2.5")),
        Just(text("2026-10-18")),
        Just(text("2026-10-18T09:30:00.000Z")),
        Just(text("true")),
        Just(text("{\"k\":1}")),
        Just(text("p,q")),
        Just(text("p-q")),
        Just(Value::Number(0.0)),
        Just(Value::Number(1.0)),
        Just(Value::Number(2.5)),
        Just(Value::Number(-3.0)),
        Just(Value::Bool(true)),
        Just(Value::Bool(false)),
        Just(Value::Null),
    ]
}

/// Records with keys `a`, `b`, `c`, `xs` and `ys`, each optional: `a`, `b` and `c` hold a leaf or a record, `xs` and
/// `ys` a leaf or an array of up to three records or leaves, to a depth of three.
fn document() -> impl Strategy<Value = Value> {
    let record = leaf().prop_recursive(3, 48, 5, |inner| {
        let field = prop_oneof![leaf(), inner.clone()];
        let list = prop_oneof![
            leaf(),
            prop::collection::vec(inner.clone(), 0..=3).prop_map(Value::Array),
            prop::collection::vec(leaf(), 0..=3).prop_map(Value::Array),
        ];
        (
            prop::option::of(field.clone()),
            prop::option::of(field.clone()),
            prop::option::of(field),
            prop::option::of(list.clone()),
            prop::option::of(list),
        )
            .prop_map(|(a, b, c, xs, ys)| {
                let pairs = [("a", a), ("b", b), ("c", c), ("xs", xs), ("ys", ys)];
                object(
                    pairs
                        .into_iter()
                        .filter_map(|(key, value)| value.map(|value| (key, value)))
                        .collect(),
                )
            })
    });
    record.prop_map(|value| match value {
        Value::Object(_) => value,
        leaf => object(vec![("a", leaf)]),
    })
}

/// The kept paths of PROPERTIES.md: keyed arity-1 paths (weight 3), key paths (2), and arity-0, arity-1 and arity-2
/// paths (1 each), over the keys and arrays the documents use.
fn kept_path() -> impl Strategy<Value = String> {
    let key = prop_oneof![Just("a"), Just("b"), Just("c")];
    let array = prop_oneof![Just("xs"), Just("ys")];
    prop_oneof![
        3 => (array.clone(), key.clone()).prop_map(|(array, key)| format!("{array}[].{key}")),
        2 => key.clone().prop_map(str::to_owned),
        1 => (key.clone(), key.clone()).prop_map(|(outer, inner)| format!("{outer}.{inner}")),
        1 => (array.clone(), key.clone()).prop_map(|(array, key)| format!("a.{array}[].{key}")),
        1 => (array.clone(), array, key).prop_map(|(outer, inner, key)| format!("{outer}[].{inner}[].{key}")),
    ]
}

/// A two-way rule over the same paths, as a JSON document.
fn rule() -> impl Strategy<Value = Value> {
    (kept_path(), kept_path(), 0..3_u8).prop_map(|(from, to, op)| match op {
        0 => object(vec![
            ("op", text("move")),
            ("from", text(&from)),
            ("to", text(&to)),
        ]),
        1 => object(vec![
            ("op", text("scale")),
            ("from", text(&from)),
            ("to", text(&to)),
            ("factor", Value::Number(2.0)),
        ]),
        _ => object(vec![
            ("op", text("split")),
            ("from", text(&from)),
            ("to", text(&to)),
            ("separator", text(",")),
        ]),
    })
}

fn outcome(result: Result<Value, CrossmapError>) -> Result<String, CrossmapError> {
    result.map(|value| crossmap::stringify(&value))
}

/// The kind of an outcome, so a run can show that the generators reach every kind it must.
fn kind(result: &Result<String, CrossmapError>) -> &'static str {
    match result {
        Ok(_) => "output",
        Err(CrossmapError::Structure { .. }) => "structure",
        Err(CrossmapError::RuleApplication { detail, .. }) if detail.contains("absent") => "absent",
        Err(CrossmapError::RuleApplication { detail, .. })
            if detail.contains("location")
                || detail.contains("container")
                || detail.contains("fit") =>
        {
            "conflict"
        }
        Err(_) => "other",
    }
}

/// The seed PROPERTIES.md draws its fixtures at, so a run is the same run every time and a coverage assertion cannot
/// pass or fail by chance.
const SEED: u64 = 20_261_118;

fn runner() -> TestRunner {
    let mut seed = [0_u8; 32];
    seed[..8].copy_from_slice(&SEED.to_le_bytes());
    TestRunner::new_with_rng(
        ProptestConfig::with_cases(1500),
        TestRng::from_seed(RngAlgorithm::ChaCha, &seed),
    )
}

/// A document in which every path of a list is present, as far as the paths agree on a shape: each key a record,
/// each wildcard or fixed index an array, each end a leaf; where two paths disagree the first placed wins. Array
/// lengths (0 to 3) and leaves are taken in turn from `draws`.
fn fitted(paths: &[String], draws: &[usize]) -> Value {
    let leaves = [
        text("open"),
        text("x"),
        text("1"),
        text("p,q"),
        Value::Number(1.0),
        Value::Number(2.5),
        Value::Bool(true),
        Value::Null,
    ];
    let mut next = 0_usize;
    let mut draw = |bound: usize| {
        let value = draws.get(next % draws.len().max(1)).copied().unwrap_or(0) % bound;
        next += 1;
        value
    };
    let mut root = Value::Object(Vec::new());
    for path in paths {
        if let Ok(steps) = parse_path(path) {
            place(&mut root, &steps, &leaves, &mut draw);
        }
    }
    root
}

fn place(
    node: &mut Value,
    steps: &[PathStep],
    leaves: &[Value],
    draw: &mut dyn FnMut(usize) -> usize,
) {
    let Some((step, rest)) = steps.split_first() else {
        return;
    };
    let fresh =
        |rest: &[PathStep], leaves: &[Value], draw: &mut dyn FnMut(usize) -> usize| match rest
            .first()
        {
            None => leaves[draw(leaves.len())].clone(),
            Some(PathStep::Key(_)) => Value::Object(Vec::new()),
            Some(PathStep::Index(index)) => Value::Array(vec![Value::Null; index + 1 + draw(3)]),
            Some(PathStep::Wildcard) => Value::Array(vec![Value::Null; draw(4)]),
        };
    match (step, node) {
        (PathStep::Key(key), Value::Object(pairs)) => {
            let position = match pairs.iter().position(|(name, _)| name == key) {
                Some(position) => position,
                None => {
                    pairs.push((key.clone(), fresh(rest, leaves, draw)));
                    pairs.len() - 1
                }
            };
            place(&mut pairs[position].1, rest, leaves, draw);
        }
        (PathStep::Index(index), Value::Array(items)) => {
            if let Some(item) = items.get_mut(*index) {
                if *item == Value::Null {
                    *item = fresh(rest, leaves, draw);
                }
                place(item, rest, leaves, draw);
            }
        }
        (PathStep::Wildcard, Value::Array(items)) => {
            for item in items.iter_mut() {
                if *item == Value::Null {
                    *item = fresh(rest, leaves, draw);
                }
                place(item, rest, leaves, draw);
            }
        }
        _ => {}
    }
}

/// A crosswalk written with `keep` gives the same outcome as the same crosswalk with each kept path written as an
/// identity move appended after the other rules, in each direction; and the outcomes `output`, `absent`, `structure`
/// and `conflict` all occur, so the generators cannot silently stop reaching one.
#[test]
fn keep_equals_explicit_identity_moves() {
    let seen: RefCell<BTreeSet<&'static str>> = RefCell::new(BTreeSet::new());
    let strategy = (
        prop::collection::vec(rule(), 0..=3),
        prop::collection::vec(kept_path(), 1..=5),
        document(),
        document(),
        prop::collection::vec(0_usize..64, 1..32),
    );
    let result = runner().run(&strategy, |(rules, kept, native, shared, draws)| {
        let with_keep = object(vec![
            ("source", text("n")),
            ("target", text("s")),
            ("rules", Value::Array(rules.clone())),
            (
                "keep",
                Value::Array(kept.iter().map(|path| text(path)).collect()),
            ),
        ]);
        let mut explicit_rules = rules;
        explicit_rules.extend(
            kept.iter()
                .map(|path| object(vec![("op", text("move")), ("from", text(path))])),
        );
        let explicit = object(vec![
            ("source", text("n")),
            ("target", text("s")),
            ("rules", Value::Array(explicit_rules)),
        ]);
        let with_keep = parse_crosswalk(&with_keep);
        let explicit = parse_crosswalk(&explicit);
        prop_assert_eq!(&with_keep, &explicit);
        if let (Ok(with_keep), Ok(explicit)) = (with_keep, explicit) {
            let sides: Vec<_> = with_keep.rules().iter().map(rule_sides).collect();
            let from: Vec<String> = sides.iter().flat_map(|side| side.from.clone()).collect();
            let to: Vec<String> = sides.iter().flat_map(|side| side.to.clone()).collect();
            let fitted_native = fitted(&from, &draws);
            let fitted_shared = fitted(&to, &draws);
            for (direction, document) in [
                (Direction::Encode, &native),
                (Direction::Encode, &fitted_native),
                (Direction::Decode, &shared),
                (Direction::Decode, &fitted_shared),
            ] {
                let run = |crosswalk| match direction {
                    Direction::Encode => outcome(encode(crosswalk, document)),
                    Direction::Decode => outcome(decode(crosswalk, document)),
                };
                let (left, right) = (run(&with_keep), run(&explicit));
                seen.borrow_mut().insert(kind(&left));
                prop_assert_eq!(left, right);
            }
        }
        Ok(())
    });
    assert!(result.is_ok(), "{result:?}");
    let seen = seen.into_inner();
    for wanted in ["output", "absent", "structure", "conflict"] {
        assert!(
            seen.contains(wanted),
            "no run gave the outcome {wanted}: {seen:?}"
        );
    }
}

/// Decode inverts encode: wherever encode of a document succeeds over a crosswalk that keeps every field of it, the
/// round trip reproduces the document. Most runs must reach the round trip, so the property is not vacuous.
#[test]
fn decode_inverts_encode_over_kept_paths() {
    let reached = Cell::new(0_u32);
    let result = runner().run(&document(), |native| {
        let mut paths = Vec::new();
        collect_leaf_paths(&native, &mut Vec::new(), &mut paths);
        let crosswalk = object(vec![
            ("source", text("n")),
            ("target", text("s")),
            (
                "keep",
                Value::Array(paths.iter().map(|path| text(path)).collect()),
            ),
        ]);
        let Ok(crosswalk) = parse_crosswalk(&crosswalk) else {
            return Err(TestCaseError::fail(
                "a crosswalk of the document's own paths did not parse",
            ));
        };
        if encode(&crosswalk, &native).is_ok() {
            reached.set(reached.get() + 1);
            prop_assert_eq!(
                assert_round_trip(&crosswalk, std::slice::from_ref(&native)),
                Ok(())
            );
        }
        Ok(())
    });
    assert!(result.is_ok(), "{result:?}");
    assert!(
        reached.get() >= 750,
        "only {} of 1500 runs reached the round trip",
        reached.get()
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1500))]

    /// A path prints in one canonical spelling that parses back to the same steps.
    #[test]
    fn paths_print_and_parse_back(
        first in "[A-Za-z0-9_.\\[\\]\"\\\\ :-]{1,8}",
        rest in prop::collection::vec(
            prop_oneof![
                "[A-Za-z0-9_.\\[\\]\"\\\\ :-]{1,8}".prop_map(PathStep::Key),
                (0_usize..1000).prop_map(PathStep::Index),
                Just(PathStep::Wildcard),
            ],
            0..6,
        ),
    ) {
        let mut steps = vec![PathStep::Key(first)];
        steps.extend(rest);
        prop_assume!(steps.iter().all(|step| step != &PathStep::Key("__proto__".to_owned())));
        let printed = format_path(&steps);
        prop_assert_eq!(parse_path(&printed), Ok(steps));
    }
}

/// The path of every leaf, empty record and empty array of a document, wildcards standing for its arrays' elements, so
/// a crosswalk keeping them all maps the whole document. A document whose elements disagree in shape gives paths some
/// element lacks, or paths that overlap, and encode refuses it.
fn collect_leaf_paths(value: &Value, prefix: &mut Vec<PathStep>, paths: &mut Vec<String>) {
    let mut note = |prefix: &[PathStep]| {
        let path = format_path(prefix);
        if !prefix.is_empty() && !paths.contains(&path) {
            paths.push(path);
        }
    };
    match value {
        Value::Object(pairs) if pairs.is_empty() => note(prefix),
        Value::Array(items) if items.is_empty() => note(prefix),
        Value::Object(pairs) => {
            for (key, member) in pairs {
                prefix.push(PathStep::Key(key.clone()));
                collect_leaf_paths(member, prefix, paths);
                prefix.pop();
            }
        }
        Value::Array(items) => {
            prefix.push(PathStep::Wildcard);
            for item in items {
                collect_leaf_paths(item, prefix, paths);
            }
            prefix.pop();
        }
        _ => note(prefix),
    }
}

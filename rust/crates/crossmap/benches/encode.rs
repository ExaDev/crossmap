//! Measures encode and decode against a hand-written copy of the same fields over the same documents, on the same
//! machine in the same run, and prints the ratio of crossmap's median run to the baseline's rather than a time. Each
//! scenario first checks that the baseline gives crossmap's output, so the ratio compares the same work.
//!
//! Run with `sh scripts/rust.sh bench`, which builds it optimised (`cargo bench`).

use std::hint::black_box;
use std::process::ExitCode;
use std::time::Instant;

use crossmap::{CrossmapError, Crosswalk, Value, decode, encode, parse_crosswalk};

/// A document small enough that the per-call cost of a run shows beside its per-node cost.
const SMALL_SIZE: usize = 1_000;

/// A document between the two.
const MEDIUM_SIZE: usize = 30_000;

/// A document large enough that the per-node cost dominates.
const LARGE_SIZE: usize = 300_000;

/// Node counts the ratios are measured at.
const SIZES: [usize; 3] = [SMALL_SIZE, MEDIUM_SIZE, LARGE_SIZE];

/// Identity field moves the mixed crosswalk carries besides its non-identity rules, the shape of a catalogue entry that
/// maps one field per rule.
const IDENTITY_FIELDS: usize = 6;

/// Timed rounds per measurement: each round runs the baseline and crossmap once, interleaved so load on a shared host
/// falls on both, and the median of the rounds is kept.
const ROUNDS: usize = 7;

/// Untimed runs of each side before timing, so caches and the allocator are warm for both.
const WARMUPS: usize = 2;

/// Nodes in the document the baseline is checked against crossmap on.
const CHECKED_NODES: usize = 100;

/// The factor the scale rule multiplies by.
const SCALE_FACTOR: f64 = 1000.0;

/// The kinds the enum rule maps, cycled through the nodes, each with the shared type it maps to.
const KINDS: [(&str, &str); 3] = [("paper", "PAPER"), ("book", "BOOK"), ("thesis", "THESIS")];

type Baseline = fn(&Value) -> Value;
type Document = fn(usize) -> Value;

/// One crosswalk in one direction, with the documents it reads and its hand-written equivalent.
struct Scenario {
    name: String,
    crosswalk: Crosswalk,
    direction: Direction,
    document: Document,
    baseline: Baseline,
}

#[derive(Clone, Copy)]
enum Direction {
    Encode,
    Decode,
}

fn identity_fields() -> Vec<String> {
    (0..IDENTITY_FIELDS)
        .map(|position| format!("f{position}"))
        .collect()
}

fn parse(text: &str) -> Result<Crosswalk, String> {
    let document: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    parse_crosswalk(&document).map_err(|error| error.to_string())
}

fn identity_moves() -> String {
    identity_fields()
        .iter()
        .map(|name| format!(r#"{{"op":"move","from":"nodes[].{name}","to":"nodes[].{name}"}}"#))
        .collect::<Vec<_>>()
        .join(",")
}

fn crosswalks() -> Result<[Crosswalk; 4], String> {
    let enum_map: Vec<String> = KINDS
        .iter()
        .map(|(native, shared)| format!(r#""{native}":"{shared}""#))
        .collect();
    let enum_map_back: Vec<String> = KINDS
        .iter()
        .map(|(native, shared)| format!(r#""{shared}":"{native}""#))
        .collect();
    Ok([
        // The three identity moves the problem was first measured with.
        parse(
            r#"{"source":"native","target":"shared","rules":[{"op":"move","from":"meta","to":"meta"},{"op":"move","from":"nodes[].id","to":"nodes[].id"},{"op":"move","from":"nodes[].text","to":"nodes[].text"}]}"#,
        )?,
        // The same crosswalk written as a `keep` list, which parses to the same rules and so should cost the same.
        parse(
            r#"{"source":"native","target":"shared","keep":["meta","nodes[].id","nodes[].text"]}"#,
        )?,
        // Identity moves for every field, plus one rule each of format, scale and enum.
        parse(&format!(
            r#"{{"source":"native","target":"shared","rules":[{{"op":"move","from":"meta","to":"meta"}},{},{{"op":"format","from":"nodes[].sizeText","to":"nodes[].size","kind":"numberText"}},{{"op":"scale","from":"nodes[].weight","to":"nodes[].weightMilli","factor":{SCALE_FACTOR}}},{{"op":"enum","from":"nodes[].kind","to":"nodes[].type","map":{{{}}},"mapBack":{{{}}}}}]}}"#,
            identity_moves(),
            enum_map.join(","),
            enum_map_back.join(","),
        ))?,
        // Identity moves for every field and one more gated per element.
        parse(&format!(
            r#"{{"source":"native","target":"shared","rules":[{{"op":"move","from":"meta","to":"meta"}},{},{{"op":"move","from":"nodes[].weight","to":"nodes[].weight","when":{{"kind":"compare","op":"gte","left":{{"kind":"reference","key":"nodes[].weight"}},"right":{{"kind":"numberLiteral","value":0}}}}}}]}}"#,
            identity_moves(),
        ))?,
    ])
}

fn meta() -> Value {
    Value::Object(vec![
        ("name".to_owned(), Value::String("bench".to_owned())),
        ("version".to_owned(), Value::Number(1.0)),
    ])
}

fn with_nodes(nodes: Vec<Value>) -> Value {
    Value::Object(vec![
        ("meta".to_owned(), meta()),
        ("nodes".to_owned(), Value::Array(nodes)),
    ])
}

fn identity_document(count: usize) -> Value {
    with_nodes(
        (0..count)
            .map(|index| {
                Value::Object(vec![
                    ("id".to_owned(), Value::String(format!("n{index}"))),
                    ("text".to_owned(), Value::String(format!("node {index}"))),
                ])
            })
            .collect(),
    )
}

fn mixed_document(count: usize) -> Value {
    let fields = identity_fields();
    with_nodes(
        (0..count)
            .map(|index| {
                let mut node: Vec<(String, Value)> = fields
                    .iter()
                    .map(|name| (name.clone(), Value::String(format!("{name}-{index}"))))
                    .collect();
                node.push(("sizeText".to_owned(), Value::String(index.to_string())));
                #[expect(
                    clippy::cast_precision_loss,
                    reason = "node indices stay far below 2^53"
                )]
                node.push(("weight".to_owned(), Value::Number(index as f64)));
                node.push((
                    "kind".to_owned(),
                    Value::String(KINDS[index % KINDS.len()].0.to_owned()),
                ));
                Value::Object(node)
            })
            .collect(),
    )
}

fn shared_mixed_document(count: usize) -> Value {
    mixed_encode_baseline(&mixed_document(count))
}

fn nodes(document: &Value) -> &[Value] {
    document
        .get("nodes")
        .and_then(Value::as_array)
        .unwrap_or_default()
}

fn field(node: &Value, name: &str) -> Value {
    node.get(name).cloned().unwrap_or(Value::Null)
}

fn number(node: &Value, name: &str) -> f64 {
    node.get(name).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

fn text<'a>(node: &'a Value, name: &str) -> &'a str {
    node.get(name).and_then(Value::as_str).unwrap_or_default()
}

/// Rebuilds a document's `meta` and maps each node with `node`, as a caller would write a one-off translation.
fn map_nodes(document: &Value, node: impl Fn(&Value) -> Vec<(String, Value)>) -> Value {
    Value::Object(vec![
        ("meta".to_owned(), field(document, "meta")),
        (
            "nodes".to_owned(),
            Value::Array(
                nodes(document)
                    .iter()
                    .map(|each| Value::Object(node(each)))
                    .collect(),
            ),
        ),
    ])
}

fn copy_identity_fields(node: &Value) -> Vec<(String, Value)> {
    (0..IDENTITY_FIELDS)
        .map(|position| {
            let name = format!("f{position}");
            let value = field(node, &name);
            (name, value)
        })
        .collect()
}

/// The hand-written encode, and decode, of the identity crosswalk: the fields it names, copied.
fn identity_baseline(document: &Value) -> Value {
    map_nodes(document, |node| {
        vec![
            ("id".to_owned(), field(node, "id")),
            ("text".to_owned(), field(node, "text")),
        ]
    })
}

/// The hand-written encode of the mixed crosswalk.
fn mixed_encode_baseline(document: &Value) -> Value {
    map_nodes(document, |node| {
        let mut out = copy_identity_fields(node);
        out.push((
            "size".to_owned(),
            Value::Number(text(node, "sizeText").parse().unwrap_or(f64::NAN)),
        ));
        out.push((
            "weightMilli".to_owned(),
            Value::Number(number(node, "weight") * SCALE_FACTOR),
        ));
        let kind = text(node, "kind");
        let shared = KINDS
            .iter()
            .find(|(native, _)| *native == kind)
            .map_or(Value::Null, |(_, shared)| {
                Value::String((*shared).to_owned())
            });
        out.push(("type".to_owned(), shared));
        out
    })
}

/// The hand-written decode of the mixed crosswalk.
fn mixed_decode_baseline(document: &Value) -> Value {
    map_nodes(document, |node| {
        let mut out = copy_identity_fields(node);
        out.push((
            "sizeText".to_owned(),
            Value::String(crossmap::stringify(&field(node, "size"))),
        ));
        out.push((
            "weight".to_owned(),
            Value::Number(number(node, "weightMilli") / SCALE_FACTOR),
        ));
        let shared = text(node, "type");
        let native = KINDS
            .iter()
            .find(|(_, each)| *each == shared)
            .map_or(Value::Null, |(native, _)| {
                Value::String((*native).to_owned())
            });
        out.push(("kind".to_owned(), native));
        out
    })
}

/// The hand-written encode of the gated crosswalk.
fn gated_baseline(document: &Value) -> Value {
    map_nodes(document, |node| {
        let mut out = copy_identity_fields(node);
        if number(node, "weight") >= 0.0 {
            out.push(("weight".to_owned(), field(node, "weight")));
        }
        out
    })
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values.get(values.len() / 2).copied().unwrap_or(f64::NAN)
}

/// How long one run took, in seconds; only ever compared with another reading from the same run.
fn timed(run: &mut dyn FnMut()) -> f64 {
    let start = Instant::now();
    run();
    start.elapsed().as_secs_f64()
}

/// The median ratio of crossmap's run to the baseline's, with the two interleaved round by round.
fn ratio(baseline: &mut dyn FnMut(), crossmap: &mut dyn FnMut()) -> f64 {
    for _ in 0..WARMUPS {
        baseline();
        crossmap();
    }
    let mut baseline_runs = Vec::with_capacity(ROUNDS);
    let mut crossmap_runs = Vec::with_capacity(ROUNDS);
    for _ in 0..ROUNDS {
        baseline_runs.push(timed(baseline));
        crossmap_runs.push(timed(crossmap));
    }
    median(crossmap_runs) / median(baseline_runs)
}

fn run(scenario: &Scenario, document: &Value) -> Result<Value, CrossmapError> {
    match scenario.direction {
        Direction::Encode => encode(&scenario.crosswalk, document),
        Direction::Decode => decode(&scenario.crosswalk, document),
    }
}

/// Measures one scenario against its hand-written baseline and prints the ratios.
///
/// # Errors
///
/// When crossmap fails, or the baseline and crossmap disagree on a small document, since the ratio would then compare
/// different work.
fn measure(scenario: &Scenario) -> Result<(), String> {
    let small = (scenario.document)(CHECKED_NODES);
    let output = run(scenario, &small).map_err(|error| format!("{}: {error}", scenario.name))?;
    if !output.json_equal(&(scenario.baseline)(&small)) {
        return Err(format!(
            "{}: the baseline and crossmap disagree, so the ratio would compare different work",
            scenario.name
        ));
    }
    let mut ratios = Vec::with_capacity(SIZES.len());
    for size in SIZES {
        let document = (scenario.document)(size);
        let mut failure = None;
        let measured = ratio(
            &mut || {
                black_box((scenario.baseline)(black_box(&document)));
            },
            &mut || {
                if let Err(error) = black_box(run(scenario, black_box(&document))) {
                    failure = Some(error);
                }
            },
        );
        if let Some(error) = failure {
            return Err(format!("{}: {error}", scenario.name));
        }
        ratios.push(format!("{size} nodes {measured:.1}x"));
    }
    println!(
        "{}\n  ratio to baseline: {}",
        scenario.name,
        ratios.join(", ")
    );
    Ok(())
}

fn main() -> ExitCode {
    let scenarios = match crosswalks() {
        Ok([identity, kept, mixed, gated]) => {
            let mixed_name = format!("{} moves + format, scale, enum", IDENTITY_FIELDS + 1);
            let scenario =
                |name: String, crosswalk: &Crosswalk, direction, document, baseline| Scenario {
                    name,
                    crosswalk: crosswalk.clone(),
                    direction,
                    document,
                    baseline,
                };
            vec![
                scenario(
                    "3 identity moves, encode".to_owned(),
                    &identity,
                    Direction::Encode,
                    identity_document,
                    identity_baseline,
                ),
                scenario(
                    "3 identity moves, decode".to_owned(),
                    &identity,
                    Direction::Decode,
                    identity_document,
                    identity_baseline,
                ),
                scenario(
                    "3 kept paths, encode".to_owned(),
                    &kept,
                    Direction::Encode,
                    identity_document,
                    identity_baseline,
                ),
                scenario(
                    "3 kept paths, decode".to_owned(),
                    &kept,
                    Direction::Decode,
                    identity_document,
                    identity_baseline,
                ),
                scenario(
                    format!("{mixed_name}, encode"),
                    &mixed,
                    Direction::Encode,
                    mixed_document,
                    mixed_encode_baseline,
                ),
                scenario(
                    format!("{mixed_name}, decode"),
                    &mixed,
                    Direction::Decode,
                    shared_mixed_document,
                    mixed_decode_baseline,
                ),
                scenario(
                    format!(
                        "{} moves + 1 gated per element, encode",
                        IDENTITY_FIELDS + 1
                    ),
                    &gated,
                    Direction::Encode,
                    mixed_document,
                    gated_baseline,
                ),
            ]
        }
        Err(error) => {
            eprintln!("bench: {error}");
            return ExitCode::FAILURE;
        }
    };
    for scenario in &scenarios {
        if let Err(error) = measure(scenario) {
            eprintln!("bench: {error}");
            return ExitCode::FAILURE;
        }
    }
    ExitCode::SUCCESS
}

//! The JSON Schema of the crosswalk format, the document the packages publish as `schemas/crossmap.schema.json`.
//!
//! It describes a crosswalk as a document may be written, so what [`crate::parse_crosswalk`] fills in (the rule lists,
//! a single-path rule's `to`) is optional in it. It is written by hand here rather than derived from the parsed types,
//! because those are the parsed form (no `keep`, a `to` on every rule), and because the document has to stay the one
//! the TypeScript generator wrote from its Zod schemas, which it is byte for byte once canonicalised. What each rule
//! may carry comes from the parser's own tables, the names of formats, functions and directions from their types, and
//! the path pattern from the constants of the path grammar, so the schema and the parser cannot list different
//! fields; the tests check that the parser requires exactly the fields the schema requires.
//!
//! The `when` field is a reference to trilean's published predicate schema, pinned to [`TRILEAN_VERSION`], rather than
//! a copy of it, so the predicate grammar has one source of truth.

use json_shape::Value;

use crate::crosswalk::{
    AggregateFunction, Direction, Field, FormatKind, ONE_WAY_SHAPES, RuleShape, TWO_WAY_SHAPES,
};
use crate::js::canonical_json;
use crate::path::{MAX_INDEX_DIGITS, PROTO};

/// The version of the trilean npm package whose published schema the `when` reference names.
///
/// It is the trilean release the format's predicate grammar is pinned to, which is the version the TypeScript package
/// depends on exactly; the Rust crates read predicates with trilean's Rust evaluator, which is not published with a
/// version of its own. A test of the workspace's tooling checks that the two pins agree while the TypeScript package
/// exists.
pub const TRILEAN_VERSION: &str = "1.9.0";

/// The version of the crate, which names the published schema in its `$id`.
pub const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The dialect the document is written in.
const DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";

/// The name under `$defs` of the definition of a crosswalk, which the document's root refers to.
const CROSSWALK: &str = "Crosswalk";

/// The name under `$defs` of the reference to trilean's predicate schema.
const WHEN: &str = "When";

/// The name under `$defs` of the definition of trilean's expression tree, as Zod wrote it among the definitions shared
/// by the crosswalk and trilean's predicate tree. Nothing in the crosswalk refers to it since `When` became an external
/// reference; it is kept so the published document does not change.
const EXPRESSION: &str = "schema0";

/// The name under `$defs` of the definition of any JSON value, which a `default` rule's `value` and trilean's
/// expression tree share. The name is the one Zod numbered it with.
const JSON_VALUE: &str = "schema1";

/// The characters of a bare key, which the path grammar's `is_bare_char` accepts.
const BARE_CLASS: &str = "[A-Za-z0-9_-]";

/// The address of the schema this crate's format is published as.
pub fn schema_id() -> String {
    format!("https://cdn.jsdelivr.net/npm/crossmap@{PACKAGE_VERSION}/schemas/crossmap.schema.json")
}

/// The address of the trilean schema the `when` reference resolves in: the one published with [`TRILEAN_VERSION`].
pub fn trilean_schema_id() -> String {
    format!("https://cdn.jsdelivr.net/npm/trilean@{TRILEAN_VERSION}/schemas/trilean.schema.json")
}

/// The pattern a path string matches: the path grammar of [`crate::is_path`], as an ECMAScript pattern with the `u` flag.
pub fn path_pattern() -> String {
    let segment = format!("(?!{PROTO}(?!{BARE_CLASS})){BARE_CLASS}+");
    let quoted = format!(r#"\["(?!{PROTO}"\])(?:[^"\\]|\\["\\])*"\]"#);
    let index = format!(r"\[(?:0|[1-9][0-9]{{0,{}}})\]", MAX_INDEX_DIGITS - 1);
    let wildcard = r"\[\]";
    format!("^(?:{segment}|{quoted})(?:\\.{segment}|{quoted}|{index}|{wildcard})*$")
}

/// The pattern a template's placeholder name matches, as the template grammar's `is_placeholder_name` accepts it.
fn placeholder_pattern() -> String {
    format!("^(?!{PROTO}$)[A-Za-z0-9_]+$")
}

/// The JSON Schema document of the crosswalk format.
pub fn json_schema() -> Value {
    object(vec![
        ("$schema", text(DIALECT)),
        ("$id", text(&schema_id())),
        (
            "$defs",
            object(vec![
                (CROSSWALK, crosswalk()),
                (
                    WHEN,
                    object(vec![(
                        "$ref",
                        text(&format!("{}#/$defs/PredicateNode", trilean_schema_id())),
                    )]),
                ),
                (EXPRESSION, expression()),
                (JSON_VALUE, json_value()),
            ]),
        ),
        ("$ref", text(&format!("#/$defs/{CROSSWALK}"))),
    ])
}

/// The document as it is published: [`json_schema`] in its RFC 8785 canonical form, with no trailing newline, so the
/// file's bytes are exactly the canonical form of its own content.
pub fn json_schema_text() -> String {
    canonical_json(&json_schema())
}

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

fn texts<'t>(values: impl IntoIterator<Item = &'t str>) -> Value {
    Value::Array(values.into_iter().map(text).collect())
}

fn typed(name: &str) -> Value {
    object(vec![("type", text(name))])
}

fn reference(name: &str) -> Value {
    object(vec![("$ref", text(&format!("#/$defs/{name}")))])
}

/// A string that is exactly `value`.
fn constant(value: &str) -> Value {
    object(vec![("type", text("string")), ("const", text(value))])
}

/// A string that is one of `values`.
fn one_of_names<'t>(values: impl IntoIterator<Item = &'t str>) -> Value {
    object(vec![("type", text("string")), ("enum", texts(values))])
}

/// A record of any keys matching `names`, each holding a `values`.
fn record(names: Value, values: Value) -> Value {
    object(vec![
        ("type", text("object")),
        ("propertyNames", names),
        ("additionalProperties", values),
    ])
}

fn path() -> Value {
    object(vec![
        ("type", text("string")),
        ("pattern", text(&path_pattern())),
    ])
}

fn array(items: Value) -> Value {
    object(vec![("type", text("array")), ("items", items)])
}

/// An object with `properties`, requiring `required`, and refusing any other key when `closed`.
fn properties(properties: Vec<(&str, Value)>, required: &[&str], closed: bool) -> Value {
    let mut pairs = vec![
        ("type", text("object")),
        ("properties", object(properties)),
        ("required", texts(required.iter().copied())),
    ];
    if closed {
        pairs.push(("additionalProperties", Value::Bool(false)));
    }
    object(pairs)
}

fn directions(allowed: &[Direction]) -> Value {
    match allowed {
        [only] => constant(only.name()),
        several => one_of_names(several.iter().map(|direction| direction.name())),
    }
}

/// The schema of one field of the rule `shape` describes.
fn field(shape: &RuleShape, field: Field) -> Value {
    match field {
        Field::Op => constant(shape.op),
        Field::From if shape.op == "template" => record(
            object(vec![
                ("type", text("string")),
                ("pattern", text(&placeholder_pattern())),
            ]),
            path(),
        ),
        Field::To if shape.op == "copy" => object(vec![
            ("type", text("array")),
            ("items", path()),
            ("minItems", Value::Number(2.0)),
        ]),
        Field::From | Field::To => path(),
        Field::When => reference(WHEN),
        Field::Factor => typed("number"),
        Field::Map | Field::MapBack => record(typed("string"), typed("string")),
        Field::Kind => one_of_names(FormatKind::ALL.iter().map(|kind| kind.name())),
        Field::Separator => object(vec![
            ("type", text("string")),
            ("minLength", Value::Number(1.0)),
        ]),
        Field::Template => typed("string"),
        Field::Direction => directions(shape.directions),
        Field::Value => reference(JSON_VALUE),
        Field::Fn => one_of_names(
            AggregateFunction::ALL
                .iter()
                .map(|function| function.name()),
        ),
    }
}

/// The schema of a rule of `shape`: every field it may carry, requiring those it may not leave out, refusing others.
fn rule(shape: &RuleShape) -> Value {
    let required: Vec<&str> = shape
        .fields
        .iter()
        .filter(|candidate| !shape.optional.contains(candidate))
        .map(|candidate| candidate.name())
        .collect();
    properties(
        shape
            .fields
            .iter()
            .map(|&candidate| (candidate.name(), field(shape, candidate)))
            .collect(),
        &required,
        true,
    )
}

fn rules(shapes: &[RuleShape]) -> Value {
    object(vec![(
        "oneOf",
        Value::Array(shapes.iter().map(rule).collect()),
    )])
}

/// An array of `items` that a document may leave out, standing for the empty array.
fn defaulted_array(items: Value) -> Value {
    object(vec![
        ("type", text("array")),
        ("items", items),
        ("default", Value::Array(Vec::new())),
    ])
}

/// The definition of a crosswalk document. Its properties are [`crate::crosswalk::CROSSWALK_FIELDS`], which a test
/// checks. `rules` carries no `default`, though a document may leave it out as it may `keep` and `oneWay`: the
/// TypeScript schema gave all three the same default and Zod wrote it for the last two only.
fn crosswalk() -> Value {
    properties(
        vec![
            ("$schema", typed("string")),
            ("source", typed("string")),
            ("target", typed("string")),
            ("rules", array(rules(&TWO_WAY_SHAPES))),
            ("keep", defaulted_array(path())),
            ("oneWay", defaulted_array(rules(&ONE_WAY_SHAPES))),
        ],
        &["source", "target"],
        true,
    )
}

/// Any JSON value.
fn json_value() -> Value {
    object(vec![(
        "anyOf",
        Value::Array(vec![
            typed("string"),
            typed("number"),
            typed("boolean"),
            typed("null"),
            array(reference(JSON_VALUE)),
            record(typed("string"), reference(JSON_VALUE)),
        ]),
    )])
}

/// An open node of trilean 1.9.0's expression tree whose `kind` is `kind`.
fn node(kind: &str, fields: Vec<(&str, Value)>, required: &[&str]) -> Value {
    let mut all = vec![("kind", constant(kind))];
    all.extend(fields);
    let mut names = vec!["kind"];
    names.extend_from_slice(required);
    properties(all, &names, false)
}

fn unit_map() -> Value {
    record(typed("string"), typed("number"))
}

fn expression_ref() -> Value {
    reference(EXPRESSION)
}

/// One form of a complex literal, which refuses keys it does not name, as trilean 1.9.0's strict object did.
fn complex(fields: Vec<(&str, Value)>, required: &[&str]) -> Value {
    let mut all = vec![("kind", constant("complexLiteral"))];
    all.extend(fields);
    all.push(("unit", unit_map()));
    let mut names = vec!["kind"];
    names.extend_from_slice(required);
    properties(all, &names, true)
}

/// Trilean 1.9.0's expression tree, read as Zod's input side wrote it: the definition shared by the crosswalk and the
/// predicate tree before `When` became an external reference. It is fixed with the published document, not derived
/// from the trilean crate, whose trees are a later release's.
fn expression() -> Value {
    let combiner = object(vec![(
        "oneOf",
        Value::Array(vec![
            properties(
                vec![("mode", constant("max")), ("item", expression_ref())],
                &["mode", "item"],
                false,
            ),
            properties(
                vec![("mode", constant("min")), ("item", expression_ref())],
                &["mode", "item"],
                false,
            ),
            properties(
                vec![
                    ("mode", constant("reduce")),
                    ("initial", expression_ref()),
                    ("combine", expression_ref()),
                ],
                &["mode", "initial", "combine"],
                false,
            ),
        ]),
    )]);
    let nodes = vec![
        node(
            "numberLiteral",
            vec![("value", typed("number")), ("unit", unit_map())],
            &["value"],
        ),
        node("textLiteral", vec![("value", typed("string"))], &["value"]),
        node(
            "booleanLiteral",
            vec![("value", typed("boolean"))],
            &["value"],
        ),
        node(
            "instantLiteral",
            vec![("value", typed("string"))],
            &["value"],
        ),
        node(
            "durationLiteral",
            vec![
                ("value", typed("number")),
                ("unit", one_of_names(["ms", "s", "min", "h", "d"])),
            ],
            &["value", "unit"],
        ),
        node(
            "reference",
            vec![("key", reference(JSON_VALUE)), ("unit", unit_map())],
            &["key"],
        ),
        node(
            "arithmetic",
            vec![
                (
                    "op",
                    one_of_names(["add", "subtract", "multiply", "divide", "power", "modulo"]),
                ),
                ("left", expression_ref()),
                ("right", expression_ref()),
            ],
            &["op", "left", "right"],
        ),
        node("negate", vec![("operand", expression_ref())], &["operand"]),
        node(
            "call",
            vec![("fn", typed("string")), ("args", array(expression_ref()))],
            &["fn", "args"],
        ),
        node(
            "lookup",
            vec![
                ("table", reference(JSON_VALUE)),
                ("keys", array(expression_ref())),
            ],
            &["table", "keys"],
        ),
        node(
            "conditional",
            vec![
                (
                    "cases",
                    array(properties(
                        vec![("when", reference(WHEN)), ("then", expression_ref())],
                        &["when", "then"],
                        false,
                    )),
                ),
                ("fallback", expression_ref()),
                ("hitPolicy", one_of_names(["first", "unique"])),
            ],
            &["cases", "fallback"],
        ),
        node(
            "fold",
            vec![
                ("collection", reference(JSON_VALUE)),
                ("combiner", combiner),
                ("filter", reference(WHEN)),
            ],
            &["collection", "combiner"],
        ),
        node("accumulator", Vec::new(), &[]),
        node(
            "delegate",
            vec![
                ("system", typed("string")),
                ("payload", reference(JSON_VALUE)),
            ],
            &["system", "payload"],
        ),
        node(
            "treeReference",
            vec![("key", reference(JSON_VALUE))],
            &["key"],
        ),
    ];
    let complex_literal = object(vec![(
        "anyOf",
        Value::Array(vec![
            complex(
                vec![("re", typed("number")), ("im", typed("number"))],
                &["re", "im"],
            ),
            complex(
                vec![("magnitude", typed("number")), ("phase", typed("number"))],
                &["magnitude", "phase"],
            ),
        ]),
    )]);
    object(vec![(
        "anyOf",
        Value::Array(vec![
            object(vec![("oneOf", Value::Array(nodes))]),
            complex_literal,
        ]),
    )])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crosswalk::CROSSWALK_FIELDS;
    use crate::parse_crosswalk;

    fn parse(text: &str) -> Value {
        serde_json::from_str(text).unwrap_or(Value::Null)
    }

    fn at<'v>(value: &'v Value, pointer: &[&str]) -> Option<&'v Value> {
        pointer.iter().try_fold(value, |node, key| match node {
            Value::Array(items) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
            other => other.get(key),
        })
    }

    fn keys(value: Option<&Value>) -> Vec<String> {
        value
            .and_then(Value::as_object)
            .map(|pairs| pairs.iter().map(|(key, _)| key.clone()).collect())
            .unwrap_or_default()
    }

    /// A value the parser accepts for `field` of a rule of `shape`, together with the others of [`sample`].
    fn sample_field(shape: &RuleShape, field: Field) -> Value {
        match field {
            Field::Op => text(shape.op),
            Field::From if shape.op == "template" => parse(r#"{ "x": "a" }"#),
            Field::From if shape.op == "aggregate" => text("a[]"),
            Field::To if shape.op == "copy" => parse(r#"["b", "c"]"#),
            Field::From => text("a"),
            Field::To => text("b"),
            Field::When => parse(
                r#"{ "kind": "compare", "op": "eq", "left": { "kind": "reference", "key": "g" }, "right": { "kind": "booleanLiteral", "value": true } }"#,
            ),
            Field::Factor => Value::Number(2.0),
            Field::Map => parse(r#"{ "x": "y" }"#),
            Field::MapBack => parse(r#"{ "y": "x" }"#),
            Field::Kind => text("isoDate"),
            Field::Separator => text(";"),
            Field::Template => text("<{x}>"),
            Field::Direction => text("encode"),
            Field::Value => Value::Number(1.0),
            Field::Fn => text("count"),
        }
    }

    /// A rule of `shape` carrying every field it may, except `without`.
    fn sample(shape: &RuleShape, without: Option<Field>) -> Value {
        Value::Object(
            shape
                .fields
                .iter()
                .filter(|&&field| Some(field) != without)
                .map(|&field| (field.name().to_owned(), sample_field(shape, field)))
                .collect(),
        )
    }

    fn crosswalk_with(list: &str, rule: Value) -> Value {
        Value::Object(vec![
            ("source".to_owned(), text("s")),
            ("target".to_owned(), text("t")),
            (list.to_owned(), Value::Array(vec![rule])),
        ])
    }

    fn schema_branches(list: &str) -> Vec<Value> {
        let document = json_schema();
        at(
            &document,
            &["$defs", CROSSWALK, "properties", list, "items", "oneOf"],
        )
        .and_then(Value::as_array)
        .map(<[Value]>::to_vec)
        .unwrap_or_default()
    }

    #[test]
    fn the_parser_requires_exactly_the_fields_the_schema_requires() {
        for (list, shapes) in [
            ("rules", &TWO_WAY_SHAPES[..]),
            ("oneWay", &ONE_WAY_SHAPES[..]),
        ] {
            let branches = schema_branches(list);
            assert_eq!(branches.len(), shapes.len(), "{list}");
            for (shape, branch) in shapes.iter().zip(&branches) {
                assert_eq!(
                    at(branch, &["properties", "op", "const"]).and_then(Value::as_str),
                    Some(shape.op)
                );
                let mut listed = keys(branch.get("properties"));
                listed.sort();
                let mut fields = shape.field_names();
                fields.sort_unstable();
                assert_eq!(listed, fields, "{}", shape.op);
                let required: Vec<String> = branch
                    .get("required")
                    .and_then(Value::as_array)
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|name| name.as_str().map(str::to_owned))
                    .collect();
                let full = crosswalk_with(list, sample(shape, None));
                assert!(
                    parse_crosswalk(&full).is_ok(),
                    "{} with every field",
                    shape.op
                );
                for &field in shape.fields {
                    let parsed = parse_crosswalk(&crosswalk_with(list, sample(shape, Some(field))));
                    assert_eq!(
                        parsed.is_ok(),
                        !required.iter().any(|name| name == field.name()),
                        "{} without {}",
                        shape.op,
                        field.name()
                    );
                }
                let Value::Object(mut extra) = sample(shape, None) else {
                    return;
                };
                extra.push(("extra".to_owned(), Value::Bool(true)));
                assert!(
                    parse_crosswalk(&crosswalk_with(list, Value::Object(extra))).is_err(),
                    "{} with a field the schema refuses",
                    shape.op
                );
            }
        }
    }

    #[test]
    fn the_crosswalk_definition_lists_the_fields_the_parser_reads() {
        let document = json_schema();
        let mut listed = keys(at(&document, &["$defs", CROSSWALK, "properties"]));
        listed.sort();
        let mut fields: Vec<&str> = CROSSWALK_FIELDS.to_vec();
        fields.sort_unstable();
        assert_eq!(listed, fields);
        let minimal = parse(r#"{ "source": "s", "target": "t" }"#);
        assert!(parse_crosswalk(&minimal).is_ok());
        for name in ["source", "target"] {
            let Value::Object(pairs) = minimal.clone() else {
                return;
            };
            let without = Value::Object(pairs.into_iter().filter(|(key, _)| key != name).collect());
            assert!(parse_crosswalk(&without).is_err(), "without {name}");
        }
    }

    #[test]
    fn the_parser_reads_every_name_the_schema_lists() {
        for kind in FormatKind::ALL {
            let rule = parse(&format!(
                r#"{{ "op": "format", "from": "a", "kind": "{}" }}"#,
                kind.name()
            ));
            assert!(
                parse_crosswalk(&crosswalk_with("rules", rule)).is_ok(),
                "{}",
                kind.name()
            );
        }
        for function in AggregateFunction::ALL {
            for direction in [Direction::Encode, Direction::Decode] {
                let rule = parse(&format!(
                    r#"{{ "op": "aggregate", "fn": "{}", "from": "a[]", "to": "b", "direction": "{}" }}"#,
                    function.name(),
                    direction.name()
                ));
                assert!(
                    parse_crosswalk(&crosswalk_with("oneWay", rule)).is_ok(),
                    "{}",
                    function.name()
                );
            }
        }
        let decode_drop = parse(r#"{ "op": "drop", "from": "a", "direction": "decode" }"#);
        assert!(parse_crosswalk(&crosswalk_with("oneWay", decode_drop)).is_err());
    }

    #[test]
    fn the_document_is_its_own_canonical_form() {
        let written = json_schema_text();
        assert_eq!(canonical_json(&parse(&written)), written);
        assert!(!written.ends_with('\n'));
    }

    #[test]
    fn the_when_reference_names_the_pinned_trilean_schema() {
        assert_eq!(
            at(&json_schema(), &["$defs", WHEN, "$ref"]).and_then(Value::as_str),
            Some(format!("https://cdn.jsdelivr.net/npm/trilean@{TRILEAN_VERSION}/schemas/trilean.schema.json#/$defs/PredicateNode").as_str())
        );
    }
}

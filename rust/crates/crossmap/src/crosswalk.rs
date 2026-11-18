//! The crosswalk document: its types, and parsing a JSON value into one with every issue reported.
//!
//! Parsing checks each rule on its own (the syntax of every path, the fields each operation takes, that an `enum`'s
//! two maps are one bijection, that a template has a unique inverse); the properties of the rule list as a whole are
//! [`crate::validate_crosswalk`]'s. A `keep` path is read as the identity `move` from that path to itself, appended
//! after `rules` in the order listed, and a single-path rule that leaves out `to` has its `from` filled in, so a parsed
//! crosswalk holds only rules and every rule carries a `to`.

use std::sync::OnceLock;

use json_shape::{PathSegment, Value};

use crate::error::{CrossmapError, SyntaxIssue};
use crate::executor::Prepared;
use crate::js;
use crate::ops::template;
use crate::path::{PROTO, is_path};
use crate::when::When;

/// The direction a crosswalk runs in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Direction {
    /// From the native shape to the shared shape.
    Encode,
    /// From the shared shape back to the native shape.
    Decode,
}

impl Direction {
    /// The direction's name in the format: `encode` or `decode`.
    pub fn name(self) -> &'static str {
        match self {
            Direction::Encode => "encode",
            Direction::Decode => "decode",
        }
    }
}

/// The textual forms `format` converts, each a bijection between its canonical text and a machine value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FormatKind {
    /// An ISO-8601 date or timestamp and epoch milliseconds.
    IsoDateTime,
    /// A calendar date (`YYYY-MM-DD`) and the epoch milliseconds of its UTC midnight.
    IsoDate,
    /// A decimal number in text and the number.
    NumberText,
    /// `"true"` or `"false"` and the boolean.
    BooleanText,
    /// JSON text and the value it denotes.
    JsonText,
}

impl FormatKind {
    const ALL: [FormatKind; 5] = [
        FormatKind::IsoDateTime,
        FormatKind::IsoDate,
        FormatKind::NumberText,
        FormatKind::BooleanText,
        FormatKind::JsonText,
    ];

    /// The kind's name in the format.
    pub fn name(self) -> &'static str {
        match self {
            FormatKind::IsoDateTime => "isoDateTime",
            FormatKind::IsoDate => "isoDate",
            FormatKind::NumberText => "numberText",
            FormatKind::BooleanText => "booleanText",
            FormatKind::JsonText => "jsonText",
        }
    }
}

/// What an `aggregate` computes over the elements it reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AggregateFunction {
    /// How many elements there are.
    Count,
    /// The sum of their numbers.
    Sum,
    /// The smallest of their numbers.
    Min,
    /// The largest of their numbers.
    Max,
}

impl AggregateFunction {
    const ALL: [AggregateFunction; 4] = [
        AggregateFunction::Count,
        AggregateFunction::Sum,
        AggregateFunction::Min,
        AggregateFunction::Max,
    ];

    /// The function's name in the format.
    pub fn name(self) -> &'static str {
        match self {
            AggregateFunction::Count => "count",
            AggregateFunction::Sum => "sum",
            AggregateFunction::Min => "min",
            AggregateFunction::Max => "max",
        }
    }
}

/// The paths and gate of a rule with one path on each side.
#[derive(Clone, Debug, PartialEq)]
pub struct SinglePath {
    /// The native-side path.
    pub from: String,
    /// The shared-side path.
    pub to: String,
    /// The rule's gate.
    pub when: Option<When>,
}

/// A two-way rule: both directions derive from it.
#[derive(Clone, Debug, PartialEq)]
pub enum TwoWayRule {
    /// Carries any JSON value across unchanged.
    Move(SinglePath),
    /// Multiplies by `factor` while encoding and divides by it while decoding.
    Scale {
        /// The paths and gate.
        path: SinglePath,
        /// A finite, non-zero factor.
        factor: f64,
    },
    /// Maps text through `map` while encoding and through its inverse `map_back` while decoding.
    Enum {
        /// The paths and gate.
        path: SinglePath,
        /// The encode mapping, injective.
        map: Vec<(String, String)>,
        /// Exactly the inverse of `map`.
        map_back: Vec<(String, String)>,
    },
    /// Parses a textual form while encoding and renders its canonical text while decoding.
    Format {
        /// The paths and gate.
        path: SinglePath,
        /// The textual form.
        kind: FormatKind,
    },
    /// Cuts text at every separator while encoding and joins the parts while decoding.
    Split {
        /// The paths and gate.
        path: SinglePath,
        /// A non-empty separator.
        separator: String,
    },
    /// Renders several fields into one text while encoding and splits them back out while decoding.
    Template {
        /// Each placeholder name with the path of its field, in the order a JavaScript object lists the names.
        from: Vec<(String, String)>,
        /// The path of the rendered text.
        to: String,
        /// The template text.
        template: String,
        /// The rule's gate.
        when: Option<When>,
    },
    /// Writes one value to several places while encoding, and requires the copies to agree while decoding.
    Copy {
        /// The path of the value.
        from: String,
        /// Two or more paths of the copies.
        to: Vec<String>,
        /// The rule's gate.
        when: Option<When>,
    },
}

impl TwoWayRule {
    /// The operation's name in the format.
    pub fn op(&self) -> &'static str {
        match self {
            TwoWayRule::Move(_) => "move",
            TwoWayRule::Scale { .. } => "scale",
            TwoWayRule::Enum { .. } => "enum",
            TwoWayRule::Format { .. } => "format",
            TwoWayRule::Split { .. } => "split",
            TwoWayRule::Template { .. } => "template",
            TwoWayRule::Copy { .. } => "copy",
        }
    }

    /// The rule's gate.
    pub fn when(&self) -> Option<&When> {
        match self {
            TwoWayRule::Move(path)
            | TwoWayRule::Scale { path, .. }
            | TwoWayRule::Enum { path, .. }
            | TwoWayRule::Format { path, .. }
            | TwoWayRule::Split { path, .. } => path.when.as_ref(),
            TwoWayRule::Template { when, .. } | TwoWayRule::Copy { when, .. } => when.as_ref(),
        }
    }
}

/// The paths a two-way rule reads and writes, in the order its operation takes and produces values: encode reads
/// `from` and writes `to`, decode the reverse. Each list is non-empty.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleSides {
    /// The native-side paths.
    pub from: Vec<String>,
    /// The shared-side paths.
    pub to: Vec<String>,
}

/// The sides of a two-way rule: a template reads its fields in its `from` record's order, a copy writes several
/// targets, and every other rule has one path on each side.
pub fn rule_sides(rule: &TwoWayRule) -> RuleSides {
    match rule {
        TwoWayRule::Template { from, to, .. } => RuleSides {
            from: from.iter().map(|(_, path)| path.clone()).collect(),
            to: vec![to.clone()],
        },
        TwoWayRule::Copy { from, to, .. } => RuleSides {
            from: vec![from.clone()],
            to: to.clone(),
        },
        TwoWayRule::Move(path)
        | TwoWayRule::Scale { path, .. }
        | TwoWayRule::Enum { path, .. }
        | TwoWayRule::Format { path, .. }
        | TwoWayRule::Split { path, .. } => RuleSides {
            from: vec![path.from.clone()],
            to: vec![path.to.clone()],
        },
    }
}

/// A one-way rule: explicitly lossy, applying in one direction.
#[derive(Clone, Debug, PartialEq)]
pub enum OneWayRule {
    /// Declares that `from` is deliberately not carried across while encoding.
    Drop {
        /// The native-side path left behind.
        from: String,
        /// The rule's gate.
        when: Option<When>,
    },
    /// Inserts `value` at `to` while running in `direction`, when `to` is still absent from the output.
    Default {
        /// The wildcard-free path of the value.
        to: String,
        /// The value.
        value: Value,
        /// The direction it applies in.
        direction: Direction,
        /// The rule's gate.
        when: Option<When>,
    },
    /// Writes the count, sum, minimum or maximum of the elements `from` reaches, grouped at the wildcards `to` keeps.
    Aggregate {
        /// The function.
        function: AggregateFunction,
        /// The path of the elements.
        from: String,
        /// The path of the results, with fewer wildcards than `from`.
        to: String,
        /// The direction it applies in.
        direction: Direction,
        /// The rule's gate.
        when: Option<When>,
    },
}

impl OneWayRule {
    /// The rule's gate.
    pub fn when(&self) -> Option<&When> {
        match self {
            OneWayRule::Drop { when, .. }
            | OneWayRule::Default { when, .. }
            | OneWayRule::Aggregate { when, .. } => when.as_ref(),
        }
    }
}

/// A parsed crosswalk. It is built only by [`parse_crosswalk`] and cannot be changed afterwards, so the prepared form
/// the executor builds the first time it is used stays the crosswalk's own.
#[derive(Clone, Debug)]
pub struct Crosswalk {
    schema: Option<String>,
    source: String,
    target: String,
    rules: Vec<TwoWayRule>,
    one_way: Vec<OneWayRule>,
    pub(crate) prepared: OnceLock<Result<Prepared, CrossmapError>>,
}

impl PartialEq for Crosswalk {
    fn eq(&self, other: &Self) -> bool {
        self.schema == other.schema
            && self.source == other.source
            && self.target == other.target
            && self.rules == other.rules
            && self.one_way == other.one_way
    }
}

impl Crosswalk {
    /// The address of the JSON Schema the document declares itself written against. It has no part in encoding,
    /// decoding or validation.
    pub fn schema(&self) -> Option<&str> {
        self.schema.as_deref()
    }

    /// The label of the native shape.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// The label of the shared shape.
    pub fn target(&self) -> &str {
        &self.target
    }

    /// The two-way rules, kept paths included as the moves they stand for.
    pub fn rules(&self) -> &[TwoWayRule] {
        &self.rules
    }

    /// The one-way rules.
    pub fn one_way(&self) -> &[OneWayRule] {
        &self.one_way
    }

    /// The parsed crosswalk as a JSON document: defaults filled in, kept paths as moves, every `to` present.
    pub fn to_value(&self) -> Value {
        let mut pairs = Vec::new();
        if let Some(schema) = &self.schema {
            pairs.push(("$schema".to_owned(), text(schema)));
        }
        pairs.push(("source".to_owned(), text(&self.source)));
        pairs.push(("target".to_owned(), text(&self.target)));
        pairs.push((
            "rules".to_owned(),
            Value::Array(self.rules.iter().map(two_way_value).collect()),
        ));
        pairs.push((
            "oneWay".to_owned(),
            Value::Array(self.one_way.iter().map(one_way_value).collect()),
        ));
        Value::Object(pairs)
    }
}

impl serde::Serialize for Crosswalk {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(serializer)
    }
}

impl<'de> serde::Deserialize<'de> for Crosswalk {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        parse_crosswalk(&value).map_err(serde::de::Error::custom)
    }
}

fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn record(pairs: &[(String, String)]) -> Value {
    Value::Object(
        pairs
            .iter()
            .map(|(key, value)| (key.clone(), text(value)))
            .collect(),
    )
}

fn with_when(mut pairs: Vec<(String, Value)>, when: Option<&When>) -> Value {
    if let Some(when) = when {
        pairs.push(("when".to_owned(), when.json().clone()));
    }
    Value::Object(pairs)
}

fn single(op: &str, path: &SinglePath, extra: Vec<(String, Value)>) -> Value {
    let mut pairs = vec![
        ("op".to_owned(), text(op)),
        ("from".to_owned(), text(&path.from)),
        ("to".to_owned(), text(&path.to)),
    ];
    pairs.extend(extra);
    with_when(pairs, path.when.as_ref())
}

fn two_way_value(rule: &TwoWayRule) -> Value {
    match rule {
        TwoWayRule::Move(path) => single("move", path, Vec::new()),
        TwoWayRule::Scale { path, factor } => single(
            "scale",
            path,
            vec![("factor".to_owned(), Value::Number(*factor))],
        ),
        TwoWayRule::Enum {
            path,
            map,
            map_back,
        } => single(
            "enum",
            path,
            vec![
                ("map".to_owned(), record(map)),
                ("mapBack".to_owned(), record(map_back)),
            ],
        ),
        TwoWayRule::Format { path, kind } => {
            single("format", path, vec![("kind".to_owned(), text(kind.name()))])
        }
        TwoWayRule::Split { path, separator } => single(
            "split",
            path,
            vec![("separator".to_owned(), text(separator))],
        ),
        TwoWayRule::Template {
            from,
            to,
            template,
            when,
        } => with_when(
            vec![
                ("op".to_owned(), text("template")),
                ("from".to_owned(), record(from)),
                ("to".to_owned(), text(to)),
                ("template".to_owned(), text(template)),
            ],
            when.as_ref(),
        ),
        TwoWayRule::Copy { from, to, when } => with_when(
            vec![
                ("op".to_owned(), text("copy")),
                ("from".to_owned(), text(from)),
                (
                    "to".to_owned(),
                    Value::Array(to.iter().map(|path| text(path)).collect()),
                ),
            ],
            when.as_ref(),
        ),
    }
}

fn one_way_value(rule: &OneWayRule) -> Value {
    match rule {
        OneWayRule::Drop { from, when } => with_when(
            vec![
                ("op".to_owned(), text("drop")),
                ("from".to_owned(), text(from)),
                ("direction".to_owned(), text("encode")),
            ],
            when.as_ref(),
        ),
        OneWayRule::Default {
            to,
            value,
            direction,
            when,
        } => with_when(
            vec![
                ("op".to_owned(), text("default")),
                ("to".to_owned(), text(to)),
                ("value".to_owned(), value.clone()),
                ("direction".to_owned(), text(direction.name())),
            ],
            when.as_ref(),
        ),
        OneWayRule::Aggregate {
            function,
            from,
            to,
            direction,
            when,
        } => with_when(
            vec![
                ("op".to_owned(), text("aggregate")),
                ("fn".to_owned(), text(function.name())),
                ("from".to_owned(), text(from)),
                ("to".to_owned(), text(to)),
                ("direction".to_owned(), text(direction.name())),
            ],
            when.as_ref(),
        ),
    }
}

/// The message of a path field that is not a well-formed path.
const PATH_MESSAGE: &str = "not a well-formed path (a key, then any of '.key', '[\"quoted key\"]', '[n]' or '[]'; bare keys are [A-Za-z0-9_-]+, and no key may be __proto__)";

/// Collects the issues of one parse, each prefixed with the dotted path of its field.
struct Reader {
    issues: Vec<SyntaxIssue>,
}

/// A location in the document being parsed.
#[derive(Clone)]
struct At(Vec<String>);

impl At {
    fn key(&self, key: &str) -> At {
        let mut path = self.0.clone();
        path.push(key.to_owned());
        At(path)
    }

    fn index(&self, index: usize) -> At {
        self.key(&index.to_string())
    }

    fn text(&self) -> String {
        if self.0.is_empty() {
            "(root)".to_owned()
        } else {
            self.0.join(".")
        }
    }
}

fn kind_name(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

impl Reader {
    fn issue(&mut self, at: &At, message: impl AsRef<str>) {
        self.issues.push(SyntaxIssue {
            message: format!("{}: {}", at.text(), message.as_ref()),
        });
    }

    fn expected(&mut self, at: &At, expected: &str, found: Option<&Value>) {
        self.issue(
            at,
            format!(
                "Invalid input: expected {expected}, received {}",
                kind_name(found)
            ),
        );
    }

    /// The members of a record, or `None` with an issue when the value is not one.
    fn object<'v>(&mut self, at: &At, value: &'v Value) -> Option<&'v [(String, Value)]> {
        match value {
            Value::Object(pairs) => Some(pairs),
            other => {
                self.expected(at, "object", Some(other));
                None
            }
        }
    }

    /// Reports every key of a record that is not among `known`.
    fn strict(&mut self, at: &At, pairs: &[(String, Value)], known: &[&str]) {
        let unknown: Vec<String> = js::ordered_pairs(pairs)
            .into_iter()
            .filter(|(key, _)| !known.contains(&key.as_str()))
            .map(|(key, _)| js::quote(key))
            .collect();
        match unknown.len() {
            0 => {}
            1 => self.issue(at, format!("Unrecognized key: {}", unknown.join(", "))),
            _ => self.issue(at, format!("Unrecognized keys: {}", unknown.join(", "))),
        }
    }

    fn string(&mut self, at: &At, value: Option<&Value>) -> Option<String> {
        match value {
            Some(Value::String(text)) => Some(text.clone()),
            other => {
                self.expected(at, "string", other);
                None
            }
        }
    }

    fn path(&mut self, at: &At, value: Option<&Value>) -> Option<String> {
        let path = self.string(at, value)?;
        if is_path(&path) {
            Some(path)
        } else {
            self.issue(at, PATH_MESSAGE);
            None
        }
    }

    /// An optional path field: `Some(None)` when absent, `None` when present and invalid.
    fn optional_path(&mut self, at: &At, value: Option<&Value>) -> Option<Option<String>> {
        match value {
            None => Some(None),
            present => self.path(at, present).map(Some),
        }
    }

    fn when(&mut self, at: &At, value: Option<&Value>) -> Option<Option<When>> {
        let Some(value) = value else {
            return Some(None);
        };
        match When::read(value) {
            Ok(when) => Some(Some(when)),
            Err(issues) => {
                for issue in issues {
                    let mut place = at.clone();
                    for segment in &issue.path {
                        place = match segment {
                            PathSegment::Key(key) => place.key(key),
                            PathSegment::Index(index) => place.index(*index),
                        };
                    }
                    self.issue(&place, &issue.message);
                }
                None
            }
        }
    }

    fn string_record(&mut self, at: &At, value: Option<&Value>) -> Option<Vec<(String, String)>> {
        let pairs = match value {
            Some(Value::Object(pairs)) => pairs,
            other => {
                self.expected(at, "record", other);
                return None;
            }
        };
        let mut read = Vec::new();
        let mut sound = true;
        for (key, member) in js::ordered_pairs(pairs) {
            match self.string(&at.key(key), Some(member)) {
                Some(text) => read.push((key.clone(), text)),
                None => sound = false,
            }
        }
        sound.then_some(read)
    }

    fn direction(
        &mut self,
        at: &At,
        value: Option<&Value>,
        allowed: &[Direction],
    ) -> Option<Direction> {
        let found = allowed
            .iter()
            .copied()
            .find(|direction| value == Some(&Value::String(direction.name().to_owned())));
        if found.is_none() {
            let names: Vec<String> = allowed
                .iter()
                .map(|direction| js::quote(direction.name()))
                .collect();
            if names.len() == 1 {
                self.issue(at, format!("Invalid input: expected {}", names.join("")));
            } else {
                self.issue(
                    at,
                    format!("Invalid option: expected one of {}", names.join("|")),
                );
            }
        }
        found
    }

    fn two_way(&mut self, at: &At, value: &Value) -> Option<TwoWayRule> {
        let pairs = self.object(at, value)?;
        let get = |key: &str| member(pairs, key);
        let op = get("op").and_then(Value::as_str);
        let known: &[&str] = match op {
            Some("move") => &["op", "from", "to", "when"],
            Some("scale") => &["op", "from", "to", "factor", "when"],
            Some("enum") => &["op", "from", "to", "map", "mapBack", "when"],
            Some("format") => &["op", "from", "to", "kind", "when"],
            Some("split") => &["op", "from", "to", "separator", "when"],
            Some("template") => &["op", "from", "to", "template", "when"],
            Some("copy") => &["op", "from", "to", "when"],
            _ => {
                self.issue(
                    &at.key("op"),
                    "Invalid input: expected one of \"move\"|\"scale\"|\"enum\"|\"format\"|\"split\"|\"template\"|\"copy\"",
                );
                return None;
            }
        };
        let before = self.issues.len();
        let rule = match op {
            Some("template") => self.template(at, pairs),
            Some("copy") => self.copy(at, pairs),
            Some(single_op) => self.single(at, single_op, pairs),
            None => None,
        };
        self.strict(at, pairs, known);
        rule.filter(|_| self.issues.len() == before)
    }

    fn single(&mut self, at: &At, op: &str, pairs: &[(String, Value)]) -> Option<TwoWayRule> {
        let get = |key: &str| member(pairs, key);
        let from = self.path(&at.key("from"), get("from"));
        let to = self.optional_path(&at.key("to"), get("to"));
        let when = self.when(&at.key("when"), get("when"));
        let rule = match op {
            "move" => Some(Rest::Move),
            "scale" => self
                .factor(&at.key("factor"), get("factor"))
                .map(Rest::Scale),
            "enum" => {
                let map = self.string_record(&at.key("map"), get("map"));
                let map_back = self.string_record(&at.key("mapBack"), get("mapBack"));
                match (map, map_back) {
                    (Some(map), Some(map_back)) => Some(Rest::Enum(map, map_back)),
                    _ => None,
                }
            }
            "format" => self
                .format_kind(&at.key("kind"), get("kind"))
                .map(Rest::Format),
            "split" => self
                .separator(&at.key("separator"), get("separator"))
                .map(Rest::Split),
            _ => None,
        };
        let (from, to, when, rest) = (from?, to?, when?, rule?);
        let path = SinglePath {
            to: to.unwrap_or_else(|| from.clone()),
            from,
            when,
        };
        Some(match rest {
            Rest::Move => TwoWayRule::Move(path),
            Rest::Scale(factor) => TwoWayRule::Scale { path, factor },
            Rest::Enum(map, map_back) => {
                if !self.bijection(at, &map, &map_back) {
                    return None;
                }
                TwoWayRule::Enum {
                    path,
                    map,
                    map_back,
                }
            }
            Rest::Format(kind) => TwoWayRule::Format { path, kind },
            Rest::Split(separator) => TwoWayRule::Split { path, separator },
        })
    }

    fn factor(&mut self, at: &At, value: Option<&Value>) -> Option<f64> {
        match value {
            Some(Value::Number(factor)) if factor.is_finite() && *factor != 0.0 => Some(*factor),
            Some(Value::Number(_)) => {
                self.issue(
                    at,
                    "factor must be a finite non-zero number: decode divides by it",
                );
                None
            }
            other => {
                self.expected(at, "number", other);
                None
            }
        }
    }

    fn format_kind(&mut self, at: &At, value: Option<&Value>) -> Option<FormatKind> {
        let found = FormatKind::ALL
            .into_iter()
            .find(|kind| value.and_then(Value::as_str) == Some(kind.name()));
        if found.is_none() {
            let names: Vec<String> = FormatKind::ALL
                .iter()
                .map(|kind| js::quote(kind.name()))
                .collect();
            self.issue(
                at,
                format!("Invalid option: expected one of {}", names.join("|")),
            );
        }
        found
    }

    fn separator(&mut self, at: &At, value: Option<&Value>) -> Option<String> {
        let separator = self.string(at, value)?;
        if separator.is_empty() {
            self.issue(
                at,
                "separator must be non-empty: an empty separator makes decode's join ambiguous",
            );
            return None;
        }
        Some(separator)
    }

    /// Checks that `map_back` is exactly the inverse of an injective `map`.
    fn bijection(
        &mut self,
        at: &At,
        map: &[(String, String)],
        map_back: &[(String, String)],
    ) -> bool {
        let before = self.issues.len();
        let mut image: Vec<&str> = map.iter().map(|(_, to)| to.as_str()).collect();
        image.sort_unstable();
        image.dedup();
        if image.len() != map.len() {
            self.issue(
                &at.key("map"),
                "map must be injective: two keys mapping to one value have no inverse",
            );
        }
        if map_back.len() != image.len() {
            self.issue(
                &at.key("mapBack"),
                "mapBack must hold exactly the image of map: an entry map never produces, or a produced value it lacks, has no inverse",
            );
        }
        for (from, to) in map {
            let back = map_back
                .iter()
                .find(|(key, _)| key == to)
                .map(|(_, value)| value);
            if back != Some(from) {
                self.issue(
                    &at.key("mapBack"),
                    format!("mapBack must invert map: map sends {from} to {to} but mapBack does not send {to} back to {from}"),
                );
            }
        }
        self.issues.len() == before
    }

    fn template(&mut self, at: &At, pairs: &[(String, Value)]) -> Option<TwoWayRule> {
        let get = |key: &str| member(pairs, key);
        let from_at = at.key("from");
        let from = match get("from") {
            Some(Value::Object(pairs)) => {
                let mut read = Vec::new();
                let mut sound = true;
                for (name, path) in js::ordered_pairs(pairs) {
                    if !template::is_placeholder_name(name) {
                        self.issue(
                            &from_at.key(name),
                            "a template field name is [A-Za-z0-9_]+ other than __proto__",
                        );
                        sound = false;
                    }
                    match self.path(&from_at.key(name), Some(path)) {
                        Some(path) => read.push((name.clone(), path)),
                        None => sound = false,
                    }
                }
                sound.then_some(read)
            }
            other => {
                self.expected(&from_at, "record", other);
                None
            }
        };
        let to = self.path(&at.key("to"), get("to"));
        let text = self.string(&at.key("template"), get("template"));
        let when = self.when(&at.key("when"), get("when"));
        let (from, to, text, when) = (from?, to?, text?, when?);
        let names: Vec<&str> = from.iter().map(|(name, _)| name.as_str()).collect();
        let problems = match template::parse(&text) {
            Ok(pieces) => template::problems(&pieces, &names),
            Err(message) => vec![message],
        };
        if !problems.is_empty() {
            for problem in problems {
                self.issue(&at.key("template"), problem);
            }
            return None;
        }
        Some(TwoWayRule::Template {
            from,
            to,
            template: text,
            when,
        })
    }

    fn copy(&mut self, at: &At, pairs: &[(String, Value)]) -> Option<TwoWayRule> {
        let get = |key: &str| member(pairs, key);
        let from = self.path(&at.key("from"), get("from"));
        let to_at = at.key("to");
        let to = match get("to") {
            Some(Value::Array(items)) => {
                let mut read = Vec::new();
                let mut sound = true;
                for (index, item) in items.iter().enumerate() {
                    match self.path(&to_at.index(index), Some(item)) {
                        Some(path) => read.push(path),
                        None => sound = false,
                    }
                }
                if items.len() < 2 {
                    self.issue(&to_at, "a copy writes at least two paths: one is a move");
                    sound = false;
                }
                sound.then_some(read)
            }
            other => {
                self.expected(&to_at, "array", other);
                None
            }
        };
        let when = self.when(&at.key("when"), get("when"));
        Some(TwoWayRule::Copy {
            from: from?,
            to: to?,
            when: when?,
        })
    }

    fn one_way(&mut self, at: &At, value: &Value) -> Option<OneWayRule> {
        let pairs = self.object(at, value)?;
        let get = |key: &str| member(pairs, key);
        let before = self.issues.len();
        let (rule, known): (Option<OneWayRule>, &[&str]) = match get("op").and_then(Value::as_str) {
            Some("drop") => {
                let from = self.path(&at.key("from"), get("from"));
                let direction =
                    self.direction(&at.key("direction"), get("direction"), &[Direction::Encode]);
                let when = self.when(&at.key("when"), get("when"));
                let rule = match (from, direction, when) {
                    (Some(from), Some(_), Some(when)) => Some(OneWayRule::Drop { from, when }),
                    _ => None,
                };
                (rule, &["op", "from", "direction", "when"])
            }
            Some("default") => {
                let to = self.path(&at.key("to"), get("to"));
                let value = match get("value") {
                    Some(value) => Some(without_prototype_keys(value)),
                    None => {
                        self.issue(
                            &at.key("value"),
                            "Invalid input: expected JSON value, received undefined",
                        );
                        None
                    }
                };
                let direction = self.direction(
                    &at.key("direction"),
                    get("direction"),
                    &[Direction::Encode, Direction::Decode],
                );
                let when = self.when(&at.key("when"), get("when"));
                let rule = match (to, value, direction, when) {
                    (Some(to), Some(value), Some(direction), Some(when)) => {
                        Some(OneWayRule::Default {
                            to,
                            value,
                            direction,
                            when,
                        })
                    }
                    _ => None,
                };
                (rule, &["op", "to", "value", "direction", "when"])
            }
            Some("aggregate") => {
                let function = AggregateFunction::ALL
                    .into_iter()
                    .find(|function| get("fn").and_then(Value::as_str) == Some(function.name()));
                if function.is_none() {
                    self.issue(
                        &at.key("fn"),
                        "Invalid option: expected one of \"count\"|\"sum\"|\"min\"|\"max\"",
                    );
                }
                let from = self.path(&at.key("from"), get("from"));
                let to = self.path(&at.key("to"), get("to"));
                let direction = self.direction(
                    &at.key("direction"),
                    get("direction"),
                    &[Direction::Encode, Direction::Decode],
                );
                let when = self.when(&at.key("when"), get("when"));
                let rule = match (function, from, to, direction, when) {
                    (Some(function), Some(from), Some(to), Some(direction), Some(when)) => {
                        Some(OneWayRule::Aggregate {
                            function,
                            from,
                            to,
                            direction,
                            when,
                        })
                    }
                    _ => None,
                };
                (rule, &["op", "fn", "from", "to", "direction", "when"])
            }
            _ => {
                self.issue(
                    &at.key("op"),
                    "Invalid input: expected one of \"drop\"|\"default\"|\"aggregate\"",
                );
                return None;
            }
        };
        self.strict(at, pairs, known);
        rule.filter(|_| self.issues.len() == before)
    }
}

/// The member of a record under `key`.
fn member<'v>(pairs: &'v [(String, Value)], key: &str) -> Option<&'v Value> {
    pairs
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, member)| member)
}

/// The two-way rule's fields beyond its paths and gate, read before the rule is assembled.
enum Rest {
    Move,
    Scale(f64),
    Enum(Vec<(String, String)>, Vec<(String, String)>),
    Format(FormatKind),
    Split(String),
}

/// A JSON value with every `__proto__` key removed, as trilean's JSON value schema reads a value.
fn without_prototype_keys(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(without_prototype_keys).collect()),
        Value::Object(pairs) => Value::Object(
            pairs
                .iter()
                .filter(|(key, _)| key != PROTO)
                .map(|(key, member)| (key.clone(), without_prototype_keys(member)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Parses a JSON value as a crosswalk document.
///
/// # Errors
///
/// [`CrossmapError::Syntax`] carrying every issue found, not just the first.
pub fn parse_crosswalk(document: &Value) -> Result<Crosswalk, CrossmapError> {
    let mut reader = Reader { issues: Vec::new() };
    let root = At(Vec::new());
    let Some(pairs) = reader.object(&root, document) else {
        return Err(CrossmapError::Syntax {
            issues: reader.issues,
        });
    };
    let get = |key: &str| member(pairs, key);
    let schema = match get("$schema") {
        None => None,
        present => reader.string(&root.key("$schema"), present),
    };
    let source = reader.string(&root.key("source"), get("source"));
    let target = reader.string(&root.key("target"), get("target"));
    let mut rules = Vec::new();
    match get("rules") {
        None => {}
        Some(Value::Array(items)) => {
            for (index, item) in items.iter().enumerate() {
                if let Some(rule) = reader.two_way(&root.key("rules").index(index), item) {
                    rules.push(rule);
                }
            }
        }
        Some(other) => reader.expected(&root.key("rules"), "array", Some(other)),
    }
    match get("keep") {
        None => {}
        Some(Value::Array(items)) => {
            for (index, item) in items.iter().enumerate() {
                if let Some(path) = reader.path(&root.key("keep").index(index), Some(item)) {
                    rules.push(TwoWayRule::Move(SinglePath {
                        from: path.clone(),
                        to: path,
                        when: None,
                    }));
                }
            }
        }
        Some(other) => reader.expected(&root.key("keep"), "array", Some(other)),
    }
    let mut one_way = Vec::new();
    match get("oneWay") {
        None => {}
        Some(Value::Array(items)) => {
            for (index, item) in items.iter().enumerate() {
                if let Some(rule) = reader.one_way(&root.key("oneWay").index(index), item) {
                    one_way.push(rule);
                }
            }
        }
        Some(other) => reader.expected(&root.key("oneWay"), "array", Some(other)),
    }
    reader.strict(
        &root,
        pairs,
        &["$schema", "source", "target", "rules", "keep", "oneWay"],
    );
    match (source, target) {
        (Some(source), Some(target)) if reader.issues.is_empty() => Ok(Crosswalk {
            schema,
            source,
            target,
            rules,
            one_way,
            prepared: OnceLock::new(),
        }),
        _ => Err(CrossmapError::Syntax {
            issues: reader.issues,
        }),
    }
}

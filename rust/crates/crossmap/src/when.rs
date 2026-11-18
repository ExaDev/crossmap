//! Gating a rule with `when`: a trilean predicate tree whose reference keys are paths into the governing document
//! (the source while encoding, the target while decoding).
//!
//! The executor sees a gate only through [`Gate`]: whether it lets its rule apply to a document, or to one element of
//! it, and how many of the visited element's indexes it needs. [`When`] is the gate a crosswalk carries, evaluated by
//! trilean's three-valued evaluator: a definite `true` applies the rule, and a definite `false` or an indeterminate
//! result (the data needed to decide is absent) skips it.

use json_shape::{Issue, Value};
use trilean::evaluate::{Evaluation, Evaluator, Resolution, SyncResolvers};
use trilean::schemas::{read, read_predicate};
use trilean::{ComputedValue, JsonValue, PredicateNode};

use crate::error::CrossmapError;
use crate::js;
use crate::path::{PathStep, bind, parse_path, read_path, read_trail, wildcard_count};

/// The element a wildcard rule is visiting, for a gate whose references carry wildcards: the current match's index
/// at each wildcard the gate covers, and the governing side's path through each of the rule's wildcards. A reference
/// such as `rows[].kind` is written against the rule's `from` side, so its part through its last wildcard is replaced
/// by the governing side's array at the same depth, and it reads the visited element in whichever document governs.
pub struct WhenElement<'e> {
    /// The current match's indexes, outermost first.
    pub indexes: &'e [usize],
    /// The governing side's path through each of its wildcards, outermost first.
    pub arrays: &'e [Vec<PathStep>],
}

/// What the executor asks of a rule's gate.
pub trait Gate {
    /// The most wildcards any of the gate's references carries: zero for a gate on the whole rule, otherwise how many
    /// of the visited element's indexes it needs.
    fn arity(&self) -> usize;

    /// Whether the gate lets its rule apply to `document`, or to the visited `element` of it.
    ///
    /// # Errors
    ///
    /// [`CrossmapError::WhenEvaluation`] when the gate cannot be evaluated at all: a collection it ranges over is
    /// absent or not an array of records, or it uses a `lookup`.
    fn admits(
        &self,
        document: &Value,
        element: Option<&WhenElement<'_>>,
    ) -> Result<bool, CrossmapError>;
}

/// A rule's `when`: the predicate tree as trilean reads it, with the JSON it was read from.
#[derive(Clone, Debug)]
pub struct When {
    node: PredicateNode,
    json: Value,
    arity: usize,
}

impl PartialEq for When {
    fn eq(&self, other: &Self) -> bool {
        self.json == other.json
    }
}

const PREDICATE_SCHEMA: &str = "PredicateNodeSchema";

impl When {
    /// Reads a predicate tree, as trilean's predicate schema reads it.
    ///
    /// # Errors
    ///
    /// Every issue, with its path within the tree.
    pub(crate) fn read(value: &Value) -> Result<When, Vec<Issue>> {
        let json = match read(PREDICATE_SCHEMA, value) {
            Some(Ok(json)) => json,
            Some(Err(issues)) => return Err(issues),
            None => {
                return Err(vec![Issue {
                    path: Vec::new(),
                    message: format!("trilean exports no schema named {PREDICATE_SCHEMA}"),
                }]);
            }
        };
        let node = read_predicate(&json)?;
        let mut arity = 0;
        visit_references(&json, &mut |reference| {
            if let Some(steps) = reference.as_str().and_then(|text| parse_path(text).ok()) {
                arity = arity.max(wildcard_count(&steps));
            }
        });
        Ok(When { node, json, arity })
    }

    /// The tree as JSON, as trilean's schema reads it.
    pub fn json(&self) -> &Value {
        &self.json
    }

    /// The tree.
    pub fn node(&self) -> &PredicateNode {
        &self.node
    }
}

impl Gate for When {
    fn arity(&self) -> usize {
        self.arity
    }

    fn admits(
        &self,
        document: &Value,
        element: Option<&WhenElement<'_>>,
    ) -> Result<bool, CrossmapError> {
        let resolvers = Resolvers { document, element };
        match Evaluator::new().evaluate_predicate(&self.node, &Context::Root, &resolvers) {
            Ok(Evaluation::Definite(value)) => Ok(value),
            Ok(Evaluation::Indeterminate(_)) => Ok(false),
            Err(error) => Err(CrossmapError::WhenEvaluation {
                message: error.to_string(),
            }),
        }
    }
}

/// Visits every string a predicate tree uses as a reference key or collection name: an object's `key` or
/// `collection` member that is text. Field references inside a quantifier's item are plain field names, which the path
/// grammar also accepts.
pub(crate) fn visit_references(node: &Value, visit: &mut dyn FnMut(&Value)) {
    match node {
        Value::Array(items) => {
            for item in items {
                visit_references(item, visit);
            }
        }
        Value::Object(pairs) => {
            for name in ["key", "collection"] {
                if let Some(reference) = pairs
                    .iter()
                    .find(|(key, member)| key == name && member.as_str().is_some())
                    .map(|(_, member)| member)
                {
                    visit(reference);
                }
            }
            for (_, member) in js::ordered_pairs(pairs) {
                if matches!(member, Value::Array(_) | Value::Object(_)) {
                    visit_references(member, visit);
                }
            }
        }
        _ => {}
    }
}

/// Where a reference is resolved: the governing document, or one item of a collection a quantifier ranges over.
#[derive(Clone, Copy)]
enum Context<'a> {
    Root,
    Item(&'a [(String, Value)]),
}

struct Resolvers<'a, 'e> {
    document: &'a Value,
    element: Option<&'e WhenElement<'e>>,
}

/// A scalar leaf as trilean's computed value; a record, an array or `null` is not found.
fn scalar(value: Option<&Value>) -> Resolution {
    match value {
        Some(Value::Number(number)) => Resolution::Found(ComputedValue::Number {
            value: *number,
            unit: None,
        }),
        Some(Value::String(text)) => Resolution::Found(ComputedValue::Text {
            value: text.clone(),
        }),
        Some(Value::Bool(flag)) => Resolution::Found(ComputedValue::Boolean { value: *flag }),
        _ => Resolution::Absent {
            not_yet_known: false,
        },
    }
}

impl<'a> Resolvers<'a, '_> {
    /// The one value a reference path names: a wildcard-free path as written (exactly one match, else nothing), and
    /// a wildcard path rebased onto the visited element's array and bound to its indexes.
    fn locate(&self, path: &str) -> Result<Option<&'a Value>, String> {
        let Ok(steps) = parse_path(path) else {
            return Ok(None);
        };
        let wildcards = wildcard_count(&steps);
        if wildcards == 0 {
            return Ok(read_path(self.document, &steps).and_then(|reading| {
                match reading.matches.as_slice() {
                    [only] => Some(only.value),
                    _ => None,
                }
            }));
        }
        let Some(element) = self
            .element
            .filter(|element| wildcards <= element.indexes.len())
        else {
            return Err(format!(
                "a when reference with wildcards has no visited element to bind to: {path}"
            ));
        };
        let Some(array) = element.arrays.get(wildcards - 1) else {
            return Err(format!(
                "a when reference with wildcards has no visited element to bind to: {path}"
            ));
        };
        let last = steps
            .iter()
            .rposition(|step| matches!(step, PathStep::Wildcard))
            .unwrap_or(0);
        let mut rebased = array.clone();
        rebased.extend(steps.iter().skip(last + 1).cloned());
        Ok(read_trail(
            self.document,
            &bind(&rebased, element.indexes, None),
        ))
    }
}

impl<'a> SyncResolvers<Context<'a>> for Resolvers<'a, '_> {
    type Error = String;

    fn resolve_value(&self, key: &JsonValue, context: &Context<'a>) -> Result<Resolution, String> {
        let Some(key) = key.0.as_str() else {
            return Ok(Resolution::Absent {
                not_yet_known: false,
            });
        };
        match context {
            Context::Item(pairs) => Ok(scalar(
                pairs
                    .iter()
                    .find(|(name, _)| name == key)
                    .map(|(_, member)| member),
            )),
            Context::Root => Ok(scalar(self.locate(key)?)),
        }
    }

    fn resolve_lookup(
        &self,
        table: &JsonValue,
        _: &[ComputedValue],
        _: &Context<'a>,
    ) -> Result<Resolution, String> {
        Err(format!(
            "lookup tables are not supported in a crosswalk when predicate (table: {})",
            js::stringify(&table.0)
        ))
    }

    fn resolve_collection(
        &self,
        collection: &JsonValue,
        _: &Context<'a>,
    ) -> Result<Vec<Context<'a>>, String> {
        let Some(path) = collection.0.as_str() else {
            return Err(format!(
                "a when collection reference must be a path string, found: {}",
                js::stringify(&collection.0)
            ));
        };
        let Some(found) = self.locate(path)? else {
            return Err(format!(
                "a when collection reference resolved to nothing in the governing document: {path}"
            ));
        };
        let Some(items) = found.as_array() else {
            return Err(format!(
                "a when collection reference resolved to a non-array value: {path}"
            ));
        };
        items
            .iter()
            .map(|item| match item {
                Value::Object(pairs) => Ok(Context::Item(pairs)),
                _ => Err(format!(
                    "a when collection resolved to a non-record element under {path}"
                )),
            })
            .collect()
    }
}

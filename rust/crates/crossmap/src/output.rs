//! The output document under construction.
//!
//! Records and arrays the writes create to reach a deeper location are structure, which later writes may run through;
//! a value a rule writes is a leaf, even when it is a record or an array carried across whole, so a later trail through
//! it is a conflict, never a merge into the value. An array may have holes while rules are still writing, and the
//! finished document is refused if any remain.

use json_shape::Value;

use crate::js;
use crate::path::{TrailStep, format_trail, own_member};

/// One node of the output under construction.
#[derive(Clone, Debug)]
pub(crate) enum Node {
    /// A record created as structure, its members in the order they were first written.
    Record(Vec<(String, Option<Node>)>),
    /// An array created as structure; `None` is an element no write has reached yet.
    Array(Vec<Option<Node>>),
    /// A value a rule wrote.
    Leaf(Value),
}

/// What a node or a value reached through a trail is.
enum Found<'a> {
    Node(&'a Node),
    Value(&'a Value),
}

impl Node {
    /// An empty output document.
    pub(crate) fn root() -> Self {
        Node::Record(Vec::new())
    }

    fn child(&self, step: &TrailStep) -> Option<Found<'_>> {
        match (self, step) {
            (Node::Record(pairs), TrailStep::Key(key)) => pairs
                .iter()
                .find(|(name, _)| name == key)
                .and_then(|(_, node)| node.as_ref())
                .map(Found::Node),
            (Node::Array(items), TrailStep::Index(index)) => {
                items.get(*index).and_then(Option::as_ref).map(Found::Node)
            }
            (Node::Leaf(value), step) => value_child(value, step).map(Found::Value),
            _ => None,
        }
    }

    /// Whether a concrete location holds anything, reading through written values as well as structure.
    pub(crate) fn has(&self, trail: &[TrailStep]) -> bool {
        self.found(trail).is_some()
    }

    fn found(&self, trail: &[TrailStep]) -> Option<Found<'_>> {
        let mut current = Found::Node(self);
        for step in trail {
            current = match current {
                Found::Node(node) => node.child(step)?,
                Found::Value(value) => Found::Value(value_child(value, step)?),
            };
        }
        Some(current)
    }

    /// Writes a value a rule produced at a location, creating the records and arrays the trail needs.
    ///
    /// # Errors
    ///
    /// The message of the conflict, when the trail is empty, a step's kind does not fit the container it meets, an
    /// intermediate location already holds a written value, or the final location already holds anything.
    pub(crate) fn write(&mut self, trail: &[TrailStep], value: Value) -> Result<(), String> {
        self.place(trail, Node::Leaf(value))
    }

    /// Makes sure an array exists at a location as structure: an existing array is left as it is and a missing one is
    /// created empty, so later writes may still fill it.
    ///
    /// # Errors
    ///
    /// The message of the conflict, when the location holds something other than an array or reaching it conflicts
    /// as [`Node::write`] describes.
    pub(crate) fn ensure_array(&mut self, trail: &[TrailStep]) -> Result<(), String> {
        match self.found(trail) {
            Some(Found::Node(Node::Array(_)) | Found::Value(Value::Array(_))) => Ok(()),
            Some(Found::Node(Node::Leaf(Value::Array(_)))) => Ok(()),
            Some(_) => Err(format!(
                "the location of an empty source array already holds a non-array value: {}",
                format_trail(trail)
            )),
            None => self.place(trail, Node::Array(Vec::new())),
        }
    }

    fn place(&mut self, trail: &[TrailStep], value: Node) -> Result<(), String> {
        let Some((last, intermediate)) = trail.split_last() else {
            return Err("a trail must address at least one step".to_owned());
        };
        let mut node = self;
        for (depth, step) in intermediate.iter().enumerate() {
            let next_is_index = matches!(trail.get(depth + 1), Some(TrailStep::Index(_)));
            let slot = slot(node, step, trail, depth)?;
            match slot {
                Some(Node::Record(_) | Node::Array(_)) => {}
                Some(Node::Leaf(_)) => {
                    return Err(format!(
                        "intermediate path step {} holds a value where the trail needs a container",
                        format_trail(&trail[..=depth])
                    ));
                }
                None => {
                    *slot = Some(if next_is_index {
                        Node::Array(Vec::new())
                    } else {
                        Node::Record(Vec::new())
                    });
                }
            }
            node = match slot {
                Some(child) => child,
                None => return Err("a container was not created".to_owned()),
            };
        }
        let slot = slot(node, last, trail, trail.len() - 1)?;
        if slot.is_some() {
            return Err(format!(
                "two destinations write the one location {}",
                format_trail(trail)
            ));
        }
        *slot = Some(value);
        Ok(())
    }

    /// The finished document, with every record's keys in JavaScript order.
    ///
    /// # Errors
    ///
    /// The trail of the first array element no write reached, in depth-first order.
    pub(crate) fn finish(self) -> Result<Value, Vec<TrailStep>> {
        let mut trail = Vec::new();
        if hole_below(&self, &mut trail) {
            return Err(trail);
        }
        Ok(into_value(self))
    }
}

/// A slot one step down from a structure node, keyed record members created empty on demand; `None` inside is a
/// location nothing has written.
fn slot<'n>(
    node: &'n mut Node,
    step: &TrailStep,
    trail: &[TrailStep],
    depth: usize,
) -> Result<&'n mut Option<Node>, String> {
    match (node, step) {
        (Node::Array(items), TrailStep::Index(index)) => {
            if items.len() <= *index {
                items.resize_with(index + 1, || None);
            }
            items
                .get_mut(*index)
                .ok_or_else(|| "an array slot was not created".to_owned())
        }
        (Node::Record(pairs), TrailStep::Key(key)) => Ok(record_slot(pairs, key)),
        (Node::Array(_), TrailStep::Key(_)) => Err(format!(
            "path step {} is a record key where the document has an array",
            format_trail(&trail[..=depth])
        )),
        (Node::Record(_), TrailStep::Index(_)) => Err(format!(
            "path step {} is an array index where the document has a record",
            format_trail(&trail[..=depth])
        )),
        (Node::Leaf(_), _) => Err(format!(
            "path step {} does not fit the container it meets",
            format_trail(&trail[..=depth])
        )),
    }
}

/// The slot of a record member, added empty when the record lacks the key. An added slot is always filled at once or
/// the whole run fails, so a record never keeps an empty slot in a finished document.
fn record_slot<'n>(pairs: &'n mut Vec<(String, Option<Node>)>, key: &str) -> &'n mut Option<Node> {
    let position = match pairs.iter().position(|(name, _)| name == key) {
        Some(position) => position,
        None => {
            pairs.push((key.to_owned(), None));
            pairs.len() - 1
        }
    };
    &mut pairs[position].1
}

fn value_child<'a>(value: &'a Value, step: &TrailStep) -> Option<&'a Value> {
    match step {
        TrailStep::Key(key) => own_member(value, key),
        TrailStep::Index(index) => value.as_array()?.get(*index),
    }
}

fn hole_below(node: &Node, trail: &mut Vec<TrailStep>) -> bool {
    match node {
        Node::Array(items) => {
            if let Some(index) = items.iter().position(Option::is_none) {
                trail.push(TrailStep::Index(index));
                return true;
            }
            for (index, item) in items.iter().enumerate() {
                if let Some(child) = item {
                    trail.push(TrailStep::Index(index));
                    if hole_below(child, trail) {
                        return true;
                    }
                    trail.pop();
                }
            }
            false
        }
        Node::Record(pairs) => {
            for (key, child) in js::ordered_pairs(pairs) {
                let Some(child) = child else {
                    continue;
                };
                trail.push(TrailStep::Key(key.clone()));
                if hole_below(child, trail) {
                    return true;
                }
                trail.pop();
            }
            false
        }
        Node::Leaf(_) => false,
    }
}

fn into_value(node: Node) -> Value {
    match node {
        Node::Record(pairs) => {
            let order = js::key_order(&pairs);
            let mut slots: Vec<Option<(String, Option<Node>)>> =
                pairs.into_iter().map(Some).collect();
            Value::Object(
                order
                    .into_iter()
                    .filter_map(|position| slots.get_mut(position).and_then(Option::take))
                    .filter_map(|(key, child)| child.map(|child| (key, into_value(child))))
                    .collect(),
            )
        }
        Node::Array(items) => Value::Array(items.into_iter().flatten().map(into_value).collect()),
        Node::Leaf(value) => js::js_ordered(&value),
    }
}

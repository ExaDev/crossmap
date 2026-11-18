//! A bidirectional crosswalk codec.
//!
//! One crosswalk document describes how to map between a dataset's native JSON shape and a shared target shape, and
//! that one document derives both directions: every two-way operation knows its own inverse, so [`decode`] undoes
//! [`encode`] over the paths the crosswalk maps. What cannot be undone is declared as one-way rules. Rules are gated
//! with trilean predicate trees.
//!
//! Documents are [`Value`]s, an ordered JSON value whose numbers are doubles read and written as JavaScript reads and
//! writes them, so a document means here what it means to the TypeScript implementation. The crate does no input or
//! output and compiles to `wasm32-unknown-unknown`.

#![forbid(unsafe_code)]

mod crosswalk;
mod error;
mod executor;
mod js;
mod ops;
mod output;
mod path;
mod roundtrip;
mod validate;
mod when;

pub use crosswalk::{
    AggregateFunction, Crosswalk, Direction, FormatKind, OneWayRule, RuleSides, SinglePath,
    TwoWayRule, parse_crosswalk, rule_sides,
};
pub use error::{CrossmapError, CrosswalkIssue, SyntaxIssue};
pub use executor::{Compiled, compile_crosswalk, decode, encode};
pub use js::{js_ordered, stringify, stringify_pretty};
pub use json_shape::Value;
pub use path::{
    EmptySite, PathMatch, PathStep, Reading, TrailStep, format_path, format_trail, is_path,
    parse_path, read_path, wildcard_count,
};
pub use roundtrip::assert_round_trip;
pub use validate::validate_crosswalk;
pub use when::{Gate, When, WhenElement};

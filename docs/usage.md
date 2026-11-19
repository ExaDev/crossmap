# Usage

The worked examples of the [crossmap README](../README.md), each in JavaScript, Python and Rust. The Rust blocks are compiled and run as the crate's doctests, so they cannot show code that does not build or results the codec does not give.

A crosswalk does not depend on what the dataset is about. The three examples below map a table, a graph and a nested record to a shared shape with the same small set of rules, and each one holds its round trip. Each is shown in JavaScript, Python and Rust; the crosswalk is the same JSON document in all three.

In Rust a document is a `crossmap::Value`, an ordered JSON value read with serde_json, whose numbers are doubles as JavaScript reads them. In JavaScript it is the value `JSON.parse` would return, and in Python the `dict`, `list`, `str`, number, `bool` and `None` values `json.loads` would return.

## Rows of a table

Sensor readings, such as a CSV read into JSON, with text numbers, a unit and a flag column.

```js
import { assertRoundTrip, encode, parseCrosswalk } from "crossmap";

const readings = parseCrosswalk({
  source: "field-sensors/reading",
  target: "observations/v1",
  rules: [
    { op: "move", from: "rows[].sensor", to: "observations[].deviceId" },
    { op: "format", from: "rows[].takenAt", to: "observations[].takenAtMs", kind: "isoDateTime" },
    { op: "format", from: "rows[].level", to: "observations[].level", kind: "numberText" },
    { op: "scale", from: "rows[].depthM", to: "observations[].depthMm", factor: 1000 },
    { op: "enum", from: "rows[].flag", to: "observations[].quality", map: { ok: "GOOD", sus: "SUSPECT" }, mapBack: { GOOD: "ok", SUSPECT: "sus" } },
  ],
  oneWay: [{ op: "drop", from: "rows[].batteryPct", direction: "encode" }],
});

const table = {
  rows: [
    { sensor: "S-01", takenAt: "2026-10-18T09:30:00.000Z", level: "12.5", depthM: 3, flag: "ok", batteryPct: 91 },
    { sensor: "S-02", takenAt: "2026-10-18T09:45:00.000Z", level: "7", depthM: 5, flag: "sus", batteryPct: 40 },
  ],
};

encode(readings, table);
// {
//   observations: [
//     { deviceId: "S-01", takenAtMs: 1792315800000, level: 12.5, depthMm: 3000, quality: "GOOD" },
//     { deviceId: "S-02", takenAtMs: 1792316700000, level: 7, depthMm: 5000, quality: "SUSPECT" },
//   ],
// }

// decode gives the rows back, except batteryPct: the drop rule declared it lossy.
assertRoundTrip(readings, [table]);
```

```python
from crosswalk_codec import assert_round_trip, encode, parse_crosswalk

readings = parse_crosswalk(
    {
        "source": "field-sensors/reading",
        "target": "observations/v1",
        "rules": [
            {"op": "move", "from": "rows[].sensor", "to": "observations[].deviceId"},
            {"op": "format", "from": "rows[].takenAt", "to": "observations[].takenAtMs", "kind": "isoDateTime"},
            {"op": "format", "from": "rows[].level", "to": "observations[].level", "kind": "numberText"},
            {"op": "scale", "from": "rows[].depthM", "to": "observations[].depthMm", "factor": 1000},
            {"op": "enum", "from": "rows[].flag", "to": "observations[].quality", "map": {"ok": "GOOD", "sus": "SUSPECT"}, "mapBack": {"GOOD": "ok", "SUSPECT": "sus"}},
        ],
        "oneWay": [{"op": "drop", "from": "rows[].batteryPct", "direction": "encode"}],
    }
)

table = {
    "rows": [
        {"sensor": "S-01", "takenAt": "2026-10-18T09:30:00.000Z", "level": "12.5", "depthM": 3, "flag": "ok", "batteryPct": 91},
        {"sensor": "S-02", "takenAt": "2026-10-18T09:45:00.000Z", "level": "7", "depthM": 5, "flag": "sus", "batteryPct": 40},
    ],
}

encode(readings, table)
# {'observations': [
#     {'deviceId': 'S-01', 'takenAtMs': 1792315800000, 'level': 12.5, 'depthMm': 3000, 'quality': 'GOOD'},
#     {'deviceId': 'S-02', 'takenAtMs': 1792316700000, 'level': 7, 'depthMm': 5000, 'quality': 'SUSPECT'},
# ]}

assert_round_trip(readings, [table])
```

```rust
use crossmap::{Value, assert_round_trip, encode, parse_crosswalk, stringify};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let readings = parse_crosswalk(&serde_json::from_str(
        r#"{
          "source": "field-sensors/reading",
          "target": "observations/v1",
          "rules": [
            { "op": "move", "from": "rows[].sensor", "to": "observations[].deviceId" },
            { "op": "format", "from": "rows[].takenAt", "to": "observations[].takenAtMs", "kind": "isoDateTime" },
            { "op": "format", "from": "rows[].level", "to": "observations[].level", "kind": "numberText" },
            { "op": "scale", "from": "rows[].depthM", "to": "observations[].depthMm", "factor": 1000 },
            { "op": "enum", "from": "rows[].flag", "to": "observations[].quality", "map": { "ok": "GOOD", "sus": "SUSPECT" }, "mapBack": { "GOOD": "ok", "SUSPECT": "sus" } }
          ],
          "oneWay": [{ "op": "drop", "from": "rows[].batteryPct", "direction": "encode" }]
        }"#,
    )?)?;

    let table: Value = serde_json::from_str(
        r#"{
          "rows": [
            { "sensor": "S-01", "takenAt": "2026-10-18T09:30:00.000Z", "level": "12.5", "depthM": 3, "flag": "ok", "batteryPct": 91 },
            { "sensor": "S-02", "takenAt": "2026-10-18T09:45:00.000Z", "level": "7", "depthM": 5, "flag": "sus", "batteryPct": 40 }
          ]
        }"#,
    )?;

    assert_eq!(
        stringify(&encode(&readings, &table)?),
        r#"{"observations":[{"deviceId":"S-01","takenAtMs":1792315800000,"level":12.5,"depthMm":3000,"quality":"GOOD"},{"deviceId":"S-02","takenAtMs":1792316700000,"level":7,"depthMm":5000,"quality":"SUSPECT"}]}"#
    );

    assert_round_trip(&readings, &[table])?;
    Ok(())
}
```

## A graph

Two arrays that refer to each other, here a citation network exported with its own field names, mapped onto nodes and edges.

```js
import { assertRoundTrip, encode, parseCrosswalk } from "crossmap";

const network = parseCrosswalk({
  source: "reading-group/export",
  target: "graph/v1",
  rules: [
    { op: "move", from: "papers[].key", to: "nodes[].id" },
    { op: "move", from: "papers[].venue", to: "nodes[].type" },
    { op: "move", from: "cites[].citing", to: "edges[].source" },
    { op: "move", from: "cites[].cited", to: "edges[].target" },
    { op: "enum", from: "cites[].kind", to: "edges[].type", map: { direct: "CITES", survey: "CITES_IN_SURVEY" }, mapBack: { CITES: "direct", CITES_IN_SURVEY: "survey" } },
  ],
});

const exported = {
  papers: [
    { key: "p1", venue: "journal" },
    { key: "p2", venue: "workshop" },
    { key: "p3", venue: "journal" },
  ],
  cites: [
    { citing: "p2", cited: "p1", kind: "direct" },
    { citing: "p3", cited: "p1", kind: "survey" },
  ],
};

encode(network, exported);
// {
//   nodes: [{ id: "p1", type: "journal" }, { id: "p2", type: "workshop" }, { id: "p3", type: "journal" }],
//   edges: [{ source: "p2", target: "p1", type: "CITES" }, { source: "p3", target: "p1", type: "CITES_IN_SURVEY" }],
// }

assertRoundTrip(network, [exported]);
```

```python
from crosswalk_codec import assert_round_trip, encode, parse_crosswalk

network = parse_crosswalk(
    {
        "source": "reading-group/export",
        "target": "graph/v1",
        "rules": [
            {"op": "move", "from": "papers[].key", "to": "nodes[].id"},
            {"op": "move", "from": "papers[].venue", "to": "nodes[].type"},
            {"op": "move", "from": "cites[].citing", "to": "edges[].source"},
            {"op": "move", "from": "cites[].cited", "to": "edges[].target"},
            {"op": "enum", "from": "cites[].kind", "to": "edges[].type", "map": {"direct": "CITES", "survey": "CITES_IN_SURVEY"}, "mapBack": {"CITES": "direct", "CITES_IN_SURVEY": "survey"}},
        ],
    }
)

exported = {
    "papers": [{"key": "p1", "venue": "journal"}, {"key": "p2", "venue": "workshop"}, {"key": "p3", "venue": "journal"}],
    "cites": [{"citing": "p2", "cited": "p1", "kind": "direct"}, {"citing": "p3", "cited": "p1", "kind": "survey"}],
}

encode(network, exported)
# {'nodes': [{'id': 'p1', 'type': 'journal'}, {'id': 'p2', 'type': 'workshop'}, {'id': 'p3', 'type': 'journal'}],
#  'edges': [{'source': 'p2', 'target': 'p1', 'type': 'CITES'}, {'source': 'p3', 'target': 'p1', 'type': 'CITES_IN_SURVEY'}]}

assert_round_trip(network, [exported])
```

```rust
use crossmap::{Value, assert_round_trip, encode, parse_crosswalk, stringify};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let network = parse_crosswalk(&serde_json::from_str(
        r#"{
          "source": "reading-group/export",
          "target": "graph/v1",
          "rules": [
            { "op": "move", "from": "papers[].key", "to": "nodes[].id" },
            { "op": "move", "from": "papers[].venue", "to": "nodes[].type" },
            { "op": "move", "from": "cites[].citing", "to": "edges[].source" },
            { "op": "move", "from": "cites[].cited", "to": "edges[].target" },
            { "op": "enum", "from": "cites[].kind", "to": "edges[].type", "map": { "direct": "CITES", "survey": "CITES_IN_SURVEY" }, "mapBack": { "CITES": "direct", "CITES_IN_SURVEY": "survey" } }
          ]
        }"#,
    )?)?;

    let exported: Value = serde_json::from_str(
        r#"{
          "papers": [{ "key": "p1", "venue": "journal" }, { "key": "p2", "venue": "workshop" }, { "key": "p3", "venue": "journal" }],
          "cites": [{ "citing": "p2", "cited": "p1", "kind": "direct" }, { "citing": "p3", "cited": "p1", "kind": "survey" }]
        }"#,
    )?;

    assert_eq!(
        stringify(&encode(&network, &exported)?),
        r#"{"nodes":[{"id":"p1","type":"journal"},{"id":"p2","type":"workshop"},{"id":"p3","type":"journal"}],"edges":[{"source":"p2","target":"p1","type":"CITES"},{"source":"p3","target":"p1","type":"CITES_IN_SURVEY"}]}"#
    );

    assert_round_trip(&network, &[exported])?;
    Ok(())
}
```

## A nested record with an optional block

A catalogue record that nests a list and an optional licence block, with a field that is lossy in one direction and a value added on the way out.

```js
import { assertRoundTrip, decode, encode, parseCrosswalk } from "crossmap";

const catalogue = parseCrosswalk({
  source: "branch-library/record",
  target: "catalogue/v2",
  rules: [
    { op: "move", from: "recordId", to: "id" },
    { op: "split", from: "subjects", to: "topics", separator: ";" },
    { op: "move", from: "copies[].barcode", to: "holdings[].barcode" },
    { op: "move", from: "digital", to: "digital" },
    {
      op: "move",
      from: "licence.url",
      to: "access.licenceUrl",
      when: { kind: "compare", op: "eq", left: { kind: "reference", key: "digital" }, right: { kind: "booleanLiteral", value: true } },
    },
  ],
  oneWay: [
    { op: "drop", from: "staffNotes", direction: "encode" },
    { op: "default", to: "origin", value: "branch-library", direction: "encode" },
  ],
});

const record = {
  recordId: "BL-1042",
  subjects: "maps;local history",
  copies: [{ barcode: "0041" }, { barcode: "0042" }],
  digital: true,
  licence: { url: "https://example.org/licence" },
  staffNotes: "re-bind spine",
};

const entry = encode(catalogue, record);
// {
//   id: "BL-1042",
//   topics: ["maps", "local history"],
//   holdings: [{ barcode: "0041" }, { barcode: "0042" }],
//   digital: true,
//   access: { licenceUrl: "https://example.org/licence" },
//   origin: "branch-library",
// }

decode(catalogue, entry);
// record again, except staffNotes: the drop rule declared it lossy

// A print-only record has no licence block. The gated rule is skipped, not an error.
const printOnly = { recordId: "BL-1043", subjects: "maps", copies: [{ barcode: "0043" }], digital: false };

// Throws RoundTripMismatchError naming the first path where decode(encode(sample)) differs from the sample.
assertRoundTrip(catalogue, [record, printOnly]);
```

```python
from crosswalk_codec import assert_round_trip, decode, encode, parse_crosswalk

digital = {"kind": "compare", "op": "eq", "left": {"kind": "reference", "key": "digital"}, "right": {"kind": "booleanLiteral", "value": True}}
catalogue = parse_crosswalk(
    {
        "source": "branch-library/record",
        "target": "catalogue/v2",
        "rules": [
            {"op": "move", "from": "recordId", "to": "id"},
            {"op": "split", "from": "subjects", "to": "topics", "separator": ";"},
            {"op": "move", "from": "copies[].barcode", "to": "holdings[].barcode"},
            {"op": "move", "from": "digital", "to": "digital"},
            {"op": "move", "from": "licence.url", "to": "access.licenceUrl", "when": digital},
        ],
        "oneWay": [
            {"op": "drop", "from": "staffNotes", "direction": "encode"},
            {"op": "default", "to": "origin", "value": "branch-library", "direction": "encode"},
        ],
    }
)

record = {
    "recordId": "BL-1042",
    "subjects": "maps;local history",
    "copies": [{"barcode": "0041"}, {"barcode": "0042"}],
    "digital": True,
    "licence": {"url": "https://example.org/licence"},
    "staffNotes": "re-bind spine",
}

entry = encode(catalogue, record)
# {'id': 'BL-1042', 'topics': ['maps', 'local history'], 'holdings': [{'barcode': '0041'}, {'barcode': '0042'}],
#  'digital': True, 'access': {'licenceUrl': 'https://example.org/licence'}, 'origin': 'branch-library'}

decode(catalogue, entry)
# record again, except staffNotes

print_only = {"recordId": "BL-1043", "subjects": "maps", "copies": [{"barcode": "0043"}], "digital": False}

# Raises RoundTripMismatchError naming the first path where decode(encode(sample)) differs from the sample.
assert_round_trip(catalogue, [record, print_only])
```

```rust
use crossmap::{Value, assert_round_trip, decode, encode, parse_crosswalk, stringify};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let catalogue = parse_crosswalk(&serde_json::from_str(
        r#"{
          "source": "branch-library/record",
          "target": "catalogue/v2",
          "rules": [
            { "op": "move", "from": "recordId", "to": "id" },
            { "op": "split", "from": "subjects", "to": "topics", "separator": ";" },
            { "op": "move", "from": "copies[].barcode", "to": "holdings[].barcode" },
            { "op": "move", "from": "digital", "to": "digital" },
            {
              "op": "move",
              "from": "licence.url",
              "to": "access.licenceUrl",
              "when": { "kind": "compare", "op": "eq", "left": { "kind": "reference", "key": "digital" }, "right": { "kind": "booleanLiteral", "value": true } }
            }
          ],
          "oneWay": [
            { "op": "drop", "from": "staffNotes", "direction": "encode" },
            { "op": "default", "to": "origin", "value": "branch-library", "direction": "encode" }
          ]
        }"#,
    )?)?;

    let record: Value = serde_json::from_str(
        r#"{
          "recordId": "BL-1042",
          "subjects": "maps;local history",
          "copies": [{ "barcode": "0041" }, { "barcode": "0042" }],
          "digital": true,
          "licence": { "url": "https://example.org/licence" },
          "staffNotes": "re-bind spine"
        }"#,
    )?;

    let entry = encode(&catalogue, &record)?;
    assert_eq!(
        stringify(&entry),
        r#"{"id":"BL-1042","topics":["maps","local history"],"holdings":[{"barcode":"0041"},{"barcode":"0042"}],"digital":true,"access":{"licenceUrl":"https://example.org/licence"},"origin":"branch-library"}"#
    );

    // The record again, except staffNotes.
    assert_eq!(
        stringify(&decode(&catalogue, &entry)?),
        r#"{"recordId":"BL-1042","subjects":"maps;local history","copies":[{"barcode":"0041"},{"barcode":"0042"}],"digital":true,"licence":{"url":"https://example.org/licence"}}"#
    );

    let print_only: Value = serde_json::from_str(
        r#"{ "recordId": "BL-1043", "subjects": "maps", "copies": [{ "barcode": "0043" }], "digital": false }"#,
    )?;

    // An Err(CrossmapError::RoundTripMismatch { .. }) names the first path where decode(encode(sample)) differs.
    assert_round_trip(&catalogue, &[record, print_only])?;
    Ok(())
}
```


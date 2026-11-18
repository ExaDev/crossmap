# crossmap

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/crossmap) [![crates.io](https://img.shields.io/crates/v/crossmap?logo=rust)](https://crates.io/crates/crossmap) [![npm](https://img.shields.io/npm/v/crossmap?logo=npm)](https://www.npmjs.com/package/crossmap) [![PyPI](https://img.shields.io/pypi/v/crosswalk-codec?logo=pypi&logoColor=white)](https://pypi.org/project/crosswalk-codec/) [![Release](https://img.shields.io/github/v/release/ExaDev/crossmap)](https://github.com/ExaDev/crossmap/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/crossmap/ci.yml?branch=main)](https://github.com/ExaDev/crossmap/actions)

A bidirectional crosswalk codec. One crosswalk document describes how to map between a dataset's native JSON shape and a shared target shape, and that one document derives both directions: every two-way operation knows its own inverse, so `decode` undoes `encode` over the paths the crosswalk maps. What cannot be undone is declared as one-way rules rather than hidden. Rules are gated with [trilean](https://github.com/ExaDev/trilean) predicate trees, and the format has a published JSON Schema.

The codec is written in Rust and published three ways, each the same codec over the same format and each held to the same [conformance corpus](conformance/README.md):

| Registry | Package | What it is |
| --- | --- | --- |
| crates.io | [`crossmap`](https://crates.io/crates/crossmap) | the library, with no input or output, which compiles to `wasm32-unknown-unknown` |
| crates.io | [`crossmap-cli`](https://crates.io/crates/crossmap-cli) | the `crossmap` command |
| npm | [`crossmap`](https://www.npmjs.com/package/crossmap) | the library compiled to WebAssembly, for Node 22 or later, Bun, Deno, browsers and Cloudflare Workers, with the `crossmap` command ([package README](packages/crossmap/README.md)) |
| PyPI | [`crosswalk-codec`](https://pypi.org/project/crosswalk-codec/) | the library as a native extension for CPython 3.11 or later, with the `crossmap` command ([package README](rust/bindings/crossmap-py/README.md)) |

## Install

```sh
cargo add crossmap serde_json    # the library; serde_json reads a document into a crossmap::Value
cargo install crossmap-cli       # the command
npm install crossmap             # the library and the command, for JavaScript
pip install crosswalk-codec      # the library and the command, for Python
```

## Usage

A crosswalk does not depend on what the dataset is about. The three examples below map a table, a graph and a nested record to a shared shape with the same small set of rules, and each one holds its round trip. Each is shown in JavaScript, Python and Rust; the crosswalk is the same JSON document in all three.

In Rust a document is a `crossmap::Value`, an ordered JSON value read with serde_json, whose numbers are doubles as JavaScript reads them. In JavaScript it is the value `JSON.parse` would return, and in Python the `dict`, `list`, `str`, number, `bool` and `None` values `json.loads` would return.

### Rows of a table

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

### A graph

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

### A nested record with an optional block

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

## API

Each package has the same functions, spelt in its language's convention. The rest of this README uses the JavaScript names.

| JavaScript | Python | Rust | |
| --- | --- | --- | --- |
| `parseCrosswalk(document)` | `parse_crosswalk(document)` | `parse_crosswalk(&Value)` | parses a crosswalk document, reporting every syntax issue at once |
| `validateCrosswalk(crosswalk)` | `validate_crosswalk(crosswalk)` | `validate_crosswalk(&Crosswalk)` | the structural defects of the rule list, empty when it can execute |
| `encode(crosswalk, document)`, `decode(crosswalk, document)` | `encode`, `decode` | `encode`, `decode` | translate a document in either direction |
| `compileCrosswalk(crosswalk)` | `compile_crosswalk(crosswalk)` | `compile_crosswalk(&Crosswalk)` | validates and prepares now, returning an `encode` and `decode` that take only the document |
| `assertRoundTrip(crosswalk, samples)` | `assert_round_trip(crosswalk, samples)` | `assert_round_trip(&Crosswalk, &[Value])` | checks that `decode(encode(sample))` gives each sample back |
| `ruleSides(rule)` | `rule_sides(rule)` | `rule_sides(&TwoWayRule)` | the `from` and `to` paths of a two-way rule |
| `crossmap/schemas/crossmap.schema.json` | `json_schema_text()` | `schema::json_schema_text()` | the [JSON Schema](#json-schema) of the format |

The errors are `CrossmapError` and its four kinds: `CrosswalkSyntaxError` for a document that is not a crosswalk, `CrosswalkStructureError` for a rule list that parses but cannot execute, `RuleApplicationError` naming the rule and path that failed, and `RoundTripMismatchError` naming the sample and path. In JavaScript and Python each is a class extending `CrossmapError`; in Rust each is a variant of the `CrossmapError` enum (`Syntax`, `Structure`, `RuleApplication`, `RoundTripMismatch`), whose `class_name` gives the name above.

## Command line

The `crossmap` command applies a crosswalk without writing code. It is the same command from all three registries (`cargo install crossmap-cli`, `npx crossmap` or `npm install -g crossmap`, and `pip install crosswalk-codec`):

```sh
crossmap encode crosswalk.json document.json
crossmap decode crosswalk.json shared.json
crossmap validate crosswalk.json
crossmap round-trip crosswalk.json samples.json
```

`encode` and `decode` print the translated document as JSON. `validate` and `round-trip` print nothing when they succeed; `samples.json` is a JSON array of source-shape documents. Any file argument can be `-` to read standard input, though not both at once.

Any file argument can also be a URL, so a published crosswalk applies to a published document without downloading either, and either one or both can be remote:

```sh
crossmap encode https://example.com/crosswalk.json https://example.com/document.json
crossmap validate https://example.com/crosswalk.json
```

The readable schemes are `http:`, `https:`, `data:` and `file:`, alongside plain paths and `-`. An argument is a URL when it starts with a scheme of two or more characters and a colon, so a Windows path such as `C:\x.json` stays a path. A `file:` URL names a path as Node's `fileURLToPath` reads it on the platform the command runs on. Redirects are followed. A remote read gives up after a timeout and refuses a body over a size cap, both named constants in `rust/crates/crossmap-cli/src/read_source.rs` with the reason for each. Any other scheme (`ftp:`, `s3:` and the like) exits 2 as unsupported, because reading it needs a client or credentials a data-only command should not take on. Fetching a crosswalk is safe in the sense that matters here: a crosswalk is data the codec validates, never code that runs.

The libraries do not read files or URLs: the Rust crate does no input or output, and the npm package's library imports no Node module, so it runs unchanged in a browser or worker. Where `fetch` exists, the caller does the read:

```js
import { decode, parseCrosswalk } from "crossmap";

const crosswalk = parseCrosswalk(await (await fetch("https://example.com/crosswalk.json")).json());
const native = decode(crosswalk, await (await fetch("https://example.com/shared.json")).json());
```

The exit status is 0 on success, 1 when the library rejects the crosswalk or the document (the reason is on standard error), and 2 for bad usage or an argument that cannot be read (a missing file, a failed or oversized fetch, an unsupported scheme) or is not JSON.

## The format

A crosswalk is `{ source, target, rules, keep, oneWay }`: two labels naming the shapes, a list of two-way rules, a list of paths carried through unchanged and a list of one-way rules. Only `source` and `target` are required; each list defaults to empty. `parseCrosswalk` validates the syntax and throws one error carrying every issue. `validateCrosswalk` checks the properties of the rule list as a whole, and `compileCrosswalk`, `encode`, `decode` and `assertRoundTrip` run it before anything executes (once per crosswalk object, see [Execution](#execution)).

### Paths

A path starts with a key and continues with any sequence of `.key`, a quoted key `["..."]`, a fixed index `[n]` or a wildcard `[]`. A bare key matches `[A-Za-z0-9_-]+`; any other key, such as one holding a dot, a bracket, a colon or a space, is written quoted, with `\"` and `\\` as its only escapes, so `["dc:title"]` and `meta["a.b"]` address those keys. No key may be exactly `__proto__`, bare or quoted, because the output's JSON check drops that key without a word. A bare key made of digits is a record key: `a.0` is the key `"0"` of the record `a`, and `a[0]` is the first element of the array `a`.

`[]` addresses every element of the array reached so far, so `parcels[].code` is the `code` of each parcel, and `grid[][]` is every cell of an array of arrays. Wildcards are index-aligned: the n-th wildcard of `from` pairs with the n-th wildcard of `to`, so `parcels[3].code` maps to `items[3].sku`. A rule's `to` has as many wildcards as its `from`; the keys and indices around them may differ, which is how a single `move` nests a field (`street` to `address.street`) or flattens one (`meta.owner.name` to `ownerName`). Every array a target wildcard iterates, at every depth, is fed by exactly one source array, because two arrays merged into one are not index-invertible. An empty source array, at any depth, encodes to an empty target array.

`[n]` addresses one element, for tuple-like arrays such as `point[0]` and `point[1]`. An index past the end of the array is an absent path, so reading it is a `RuleApplicationError` like any absent `from`; gate an optional position with a `when`. One array is addressed either by fixed indices or by a wildcard, never both on the same side. Writing a later index while nothing writes an earlier one leaves a gap, which is a `RuleApplicationError` naming the missing element.

Every `from` path and every `to` path is unique across the crosswalk, compared in canonical spelling (`["a"].b` is `a.b`), so one value has one destination and rule order carries no meaning. Two rules whose destinations overlap, one inside the other, are an error whichever runs first.

### Two-way rules

Each derives both directions from one declaration. Decode swaps `from` and `to` and applies the inverse. A `template` reads several fields and a `copy` writes several places; all of a rule's paths have the same number of wildcards, a template's fields come from the same element, and each path counts towards the uniqueness of `from` and `to` paths. A rule with one path on each side (`move`, `scale`, `enum`, `format` and `split`) may leave out `to` when it keeps the field at the same path, so `{ op: "move", from: "nodes[].id" }` means `{ op: "move", from: "nodes[].id", to: "nodes[].id" }`; parsing fills it in, so a parsed crosswalk always carries `to`, and the published JSON Schema leaves it optional for those ops.

| op | fields | encode | decode | inverse holds when |
| --- | --- | --- | --- | --- |
| `move` | `from`, `to` | carries any JSON value across | carries it back | always |
| `scale` | `factor`: finite, non-zero | `value * factor` | `value / factor` | the factor is an integer or a power of two; other factors can lose the last bit |
| `enum` | `map`, `mapBack` | `map[value]` | `mapBack[value]` | always: `mapBack` must be exactly the inverse of an injective `map`, checked when the crosswalk is parsed, and an unmapped value is an error |
| `format` | `kind`: `isoDateTime`, `isoDate`, `numberText`, `booleanText` or `jsonText` | parses the text: an ISO-8601 date or timestamp to epoch milliseconds, a calendar date (`YYYY-MM-DD`) to its UTC midnight, a decimal string to a number, `"true"` or `"false"` to a boolean, JSON text to the value it denotes | renders the canonical text: `toISOString`, its date part, `String(number)`, `"true"` or `"false"`, `JSON.stringify` | the input is already in the canonical spelling (for `jsonText`, no whitespace outside strings; a `__proto__` key is refused, since the output cannot carry it) |
| `split` | `separator`: non-empty | cuts the string at every separator | joins the parts with it | no part contains the separator; decode throws otherwise |
| `template` | `from`: a record of field names to paths, `template`: text with `{name}` placeholders | renders the string fields into the template | splits the text back into the fields | always: every field is used exactly once and a literal separates every two placeholders, checked when the crosswalk is parsed, and encode throws for a value containing the literal that follows its placeholder |
| `copy` | `from`, `to`: two or more paths | writes the one value at every `to` | reads every copy and writes the value back | always: decode throws when the copies disagree |

For example (a template writes a literal brace as `{{` or `}}`):

```js
{ op: "template", from: { given: "people[].given", family: "people[].family" }, to: "names[]", template: "{family}, {given}" }
{ op: "copy", from: "items[].id", to: ["nodes[].id", "labels[].text"] }
```

### Kept paths

`keep` lists paths whose value goes across unchanged, at the same path, in both directions. Each one means exactly the identity `move` from that path to itself, so these two crosswalks are the same crosswalk:

```js
{ source: "export", target: "graph/v1", keep: ["meta", "nodes[].id", "nodes[].label"] }
{ source: "export", target: "graph/v1", rules: [{ op: "move", from: "meta" }, { op: "move", from: "nodes[].id" }, { op: "move", from: "nodes[].label" }] }
```

A kept path is any path a `from` may be, wildcards included, and carries no `when`. `parseCrosswalk` turns each one into its `move`, appended after `rules` in the order listed, so a parsed crosswalk has no `keep` and everything else (validation, execution, round trips) sees only rules. Errors number a kept path as that rule: the n-th kept path is rule `rules.length + n`, counting from zero, and one-way rules are numbered after it. A path kept twice, or kept and also named by a rule, is a repeated path like any other. `keep` names each path it carries: a field that neither a rule nor `keep` names still does not survive encode.

### One-way rules

These are the declared lossy remainder, each applying in one named direction.

| op | fields | effect |
| --- | --- | --- |
| `drop` | `from`, `direction: "encode"` | states that `from` is deliberately not carried across. Nothing is written, so the path is simply absent from the output |
| `default` | `to`, `value`, `direction`: `"encode"` or `"decode"` | inserts `value` at `to` when running in that direction and `to` is still absent from the output. `to` has no wildcard |
| `aggregate` | `fn`: `count`, `sum`, `min` or `max`; `from`, `to`, `direction` | when running in that direction, reads the elements `from` reaches in the input and writes their count, or the sum, minimum or maximum of their numbers, at `to`. `to` has fewer wildcards than `from`, and the elements are grouped by the indexes at the wildcards `to` keeps, so `orders[].lines[].qty` into `sales[].units` writes one total per order. An empty group counts and sums to 0; `min` and `max` of an empty group throw |

### Gating with `when`

Every rule may carry `when`, a trilean predicate tree, evaluated against the governing document: the source while encoding and the target while decoding. References are paths in the same grammar. A definite `true` applies the rule. A definite `false` skips it. An indeterminate result, where the data needed to decide is absent, also skips it: that is the one deliberate non-throwing branch in the format. Gating a rule on a presence or value predicate is how an optional native field is expressed.

A two-way rule that iterates an array can be gated per element. A reference with wildcards names a field of the element the rule is visiting, written against the rule's `from` side: on a rule over `items[].radius`, `items[].kind` is the `kind` of the same item. The reference's part through its last wildcard must be the array the rule's `from` iterates at that depth, and it may have fewer wildcards than the rule, gating every inner element on a field of the outer one. While decoding, that part is rebased onto the `to` side's array, so `items[].kind` reads `shapes[i].kind` when the rule maps `items[]` to `shapes[]`; the field below it has to keep its name in both shapes, as with any gate. A gated element is skipped before anything below it is read, so an element that lacks the rule's path is skipped rather than absent. Collection references bind the same way. One-way rules visit no element, so their references have no wildcards.

```js
{
  op: "move",
  from: "items[].radius",
  to: "shapes[].r",
  when: { kind: "textCompare", op: "equals", left: { kind: "reference", key: "items[].kind" }, right: { kind: "textLiteral", value: "circle" } },
}
```

An element that every rule writing into it skips leaves a gap in the output array, which is a `RuleApplicationError` naming the element: map at least one field of every element unconditionally.

### Execution

The executor is pure and synchronous. Encode reads every `from` from the input as given and writes every `to` into a fresh output, so the input is never mutated. A `from` that is absent from the document is a `RuleApplicationError`, never a silent skip. Every document is JSON throughout: a Rust `Value` is JSON by construction, and the npm and Python packages refuse a value that is not JSON at the boundary with a `TypeError` naming where it is, rather than dropping or converting it (each package's README says which values it accepts).

A crosswalk is validated and prepared once, the first time it is used: `encode` and `decode` keep the prepared form for each crosswalk, so running one crosswalk over many documents (every instance of a collection, both halves of a round trip) validates it once. `compileCrosswalk(crosswalk)` does the same step explicitly, throwing `CrosswalkStructureError` there rather than on the first run, and returns `{ encode, decode }` taking only the document. The crosswalk is read when it is prepared, so in JavaScript changing a crosswalk object after it has been used has no effect on it; parse a new one instead. A parsed crosswalk cannot be changed in Rust or Python.

```js
import { compileCrosswalk } from "crossmap";

const codec = compileCrosswalk(network);
const shared = codec.encode(exported);
codec.decode(shared);
```

## Round trips

`assertRoundTrip(crosswalk, samples)` encodes and decodes each sample and deep-compares the result with it, leaving out the paths one-way rules touch: a dropped path cannot survive, and a decode-direction default or aggregate inserts a path the sample never had. It throws on the first difference. Its limits follow from the format:

- A crosswalk is a total mapping over the document. A field no rule maps does not survive encode, so a sample carrying one fails its own round trip.
- A `scale` with a non-integer factor can fail bit-identity: multiplying and then dividing is exact for integers and powers of two, and can differ in the last bit for factors such as `0.1`. Decode divides and does not multiply by a reciprocal, which is the more accurate route.
- A `when` must not read a field its own rule moves. Decode evaluates it against the target document, where that path no longer exists, so the rule would skip on the way back. Gate on a separate field that keeps the same path in both shapes, as `digital` does above. Static validation cannot decide this, so `assertRoundTrip` is the check.
- A sample that populates the target of an encode-direction `default` differs from its round trip, because a default only fills an absent target. Leave those paths unset in samples.
- Lookup tables are not available inside `when` in this version. A `lookup` node in a predicate throws when it is evaluated.

## JSON Schema

The crosswalk format is published as a JSON Schema 2020-12 document, canonicalised per RFC 8785. The crate writes it (`crossmap::schema::json_schema_text`, from `rust/crates/crossmap/src/schema.rs`), the repository commits it as `schemas/crossmap.schema.json`, and the tests fail when the committed file is not what the crate writes. The npm package exports it as `crossmap/schemas/crossmap.schema.json` and the Python package returns it from `json_schema_text()`, and the release checks both are byte for byte the crate's. It describes a crosswalk as a document may be written, so what `parseCrosswalk` fills in (the `rules`, `keep` and `oneWay` lists, a single-path rule's `to`) is optional in it. The `when` field is a `$ref` to trilean's published predicate schema, pinned to the trilean release `crossmap::schema::TRILEAN_VERSION` names, so the predicate grammar has one source of truth.

The schema is byte for byte the one the original TypeScript implementation generated from its Zod definitions, apart from the version its `$id` names: the crate's tests compare it with that file, kept as `rust/tests/fixtures/pre-port-crossmap.schema.json`.

## Not in this version

Each of these is a deliberate omission, listed so it is not mistaken for an oversight:

- `nest` and `unnest`: a `move` whose `to` is deeper nests, one whose `to` is shallower flattens, and a `move` of a whole record carries every field in it, so a dedicated operation would add nothing the format cannot already say.
- Lookup against external tables: the crosswalk would stop defining both directions on its own, since decode inverts encode only if the caller supplies the identical table both times. An injective table belongs in an `enum` rule (build `map` from it and `mapBack` from its inverse), where the bijection is checked and travels with the document.
- Array filter and sort: wildcards are index-aligned, and moving elements away from their positions would break every rule that decodes from them. Per-element `when` gating applies a rule to some elements without moving any.
- Regex split: nothing records which text a pattern matched, so the join is undetermined, and a backtracking pattern in a crosswalk read from anywhere would let its author make encoding arbitrarily expensive.
- A streaming executor: `encode` and `decode` take parsed values, so the document is already in memory, and a `when` can read any path of it. A sequence of records streams by calling `encode` per record.

## Development

The codec, the command and both bindings are one Cargo workspace in `rust/`, on the toolchain `rust/rust-toolchain.toml` pins (rustup installs it on first use). `packages/crossmap` is the npm package built from the wasm binding, and the repository root holds the release tooling; both install with pnpm (Node 22 or later). The Python package is built with maturin from `rust/bindings/crossmap-py`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the hooks, the commit conventions and the constraints a change must preserve, and [SECURITY.md](SECURITY.md) for reporting a vulnerability.

| Command | |
| --- | --- |
| `sh scripts/rust.sh fmt` / `clippy` / `test` | formatting, clippy with warnings denied, and every crate's tests |
| `sh scripts/rust.sh conformance` | the conformance corpus against the crates, failing unless every case executes and passes |
| `sh scripts/rust.sh deny` | cargo-deny's advisories, bans, licences and sources |
| `sh scripts/rust.sh schema-check` | fails when `schemas/crossmap.schema.json` is not what the crate writes (`sh scripts/rust.sh xtask schema` rewrites it) |
| `sh scripts/rust.sh bench` | encode and decode against hand-written copies of the same fields: each one's ratio to its copy in this run on this machine |
| `pnpm --dir packages/crossmap run build` / `test` | builds the npm package from the wasm binding, then packs it, installs the tarball into an empty project and runs its suites there |
| `maturin build --release --locked` then `pytest` | in `rust/bindings/crossmap-py`: builds the wheel, then runs its suites against it installed |

`CLAUDE.md` and `AGENTS.md` are symlinks to this file.

MIT licensed.

# crossmap

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/crossmap) [![crates.io](https://img.shields.io/badge/crates.io-264323?logo=rust&logoColor=white)](https://crates.io/crates/crossmap) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/crossmap) [![PyPI](https://img.shields.io/badge/PyPI-3775A9?logo=pypi&logoColor=white)](https://pypi.org/project/crosswalk-codec/) [![Release](https://img.shields.io/github/v/release/ExaDev/crossmap)](https://github.com/ExaDev/crossmap/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/crossmap/ci.yml?branch=main)](https://github.com/ExaDev/crossmap/actions)

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

A crosswalk does not depend on what the dataset is about. This one maps the rows of a table to a shared shape and holds its round trip; [docs/usage.md](docs/usage.md) has two more (a graph and a nested record).

Sensor readings, such as a CSV read into JSON, with text numbers, a unit and a flag column. Each language's version is below.

<details>
<summary>JavaScript</summary>

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

</details>

<details>
<summary>Python</summary>

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

</details>

<details>
<summary>Rust (a document is a `crossmap::Value`, read with serde_json)</summary>

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

</details>

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

<details>
<summary>JavaScript</summary>

```js
import { decode, parseCrosswalk } from "crossmap";

const crosswalk = parseCrosswalk(await (await fetch("https://example.com/crosswalk.json")).json());
const native = decode(crosswalk, await (await fetch("https://example.com/shared.json")).json());
```

</details>

<details>
<summary>Python (the standard library does the read)</summary>

```python
import json
from urllib.request import urlopen

from crosswalk_codec import decode, parse_crosswalk

crosswalk = parse_crosswalk(json.load(urlopen("https://example.com/crosswalk.json")))
native = decode(crosswalk, json.load(urlopen("https://example.com/shared.json")))
```

</details>

In Rust any HTTP client does the read, and `serde_json` turns the body into a `crossmap::Value` for `parse_crosswalk` and `decode`.

The exit status is 0 on success, 1 when the library rejects the crosswalk or the document (the reason is on standard error), and 2 for bad usage or an argument that cannot be read (a missing file, a failed or oversized fetch, an unsupported scheme) or is not JSON.

## The format

A crosswalk is `{ source, target, rules, keep, oneWay }`: two labels naming the shapes, a list of two-way rules, a list of paths carried through unchanged and a list of one-way rules. Only `source` and `target` are required; each list defaults to empty. Rules are `move`, `scale`, `enum`, `format`, `split`, `template` and `copy`, each derived in both directions, and the declared lossy remainder is `drop`, `default` and `aggregate`. A `when` predicate gates any rule.

[docs/format.md](docs/format.md) is the full reference: paths and wildcards, every rule and when its inverse holds, kept paths, one-way rules, gating, execution, round trips and what the format leaves out.

## JSON Schema

The crosswalk format is published as a JSON Schema 2020-12 document, canonicalised per RFC 8785. The crate writes it (`crossmap::schema::json_schema_text`, from `rust/crates/crossmap/src/schema.rs`), the repository commits it as `schemas/crossmap.schema.json`, and the tests fail when the committed file is not what the crate writes. The npm package exports it as `crossmap/schemas/crossmap.schema.json` and the Python package returns it from `json_schema_text()`, and the release checks both are byte for byte the crate's. The `when` field is a `$ref` to trilean's published predicate schema, pinned to the trilean release `crossmap::schema::TRILEAN_VERSION` names.

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

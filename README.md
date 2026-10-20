# twindex

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/twindex) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/twindex) [![Release](https://img.shields.io/github/v/release/ExaDev/twindex)](https://github.com/ExaDev/twindex/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/twindex/ci.yml?branch=main)](https://github.com/ExaDev/twindex/actions)

A bidirectional crosswalk codec. One crosswalk document describes how to map between a dataset's native JSON shape and a shared target shape, and that one document derives both directions: every two-way operation knows its own inverse, so `decode` undoes `encode` over the paths the crosswalk maps. What cannot be undone is declared as one-way rules rather than hidden. Rules are gated with [trilean](https://github.com/ExaDev/trilean) predicate trees, and the whole format is defined by one Zod schema with a generated JSON Schema shipped in the package.

## Usage

A crosswalk does not depend on what the dataset is about. The three examples below map a table, a graph and a nested record to a shared shape with the same small set of rules, and each one holds its round trip.

### Rows of a table

Sensor readings, such as a CSV read into JSON, with text numbers, a unit and a flag column:

```ts
import { assertRoundTrip, decode, encode, parseCrosswalk } from "twindex";

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

### A graph

Two arrays that refer to each other, here a citation network exported with its own field names, mapped onto nodes and edges:

```ts
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
  oneWay: [],
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

### A nested record with an optional block

A catalogue record that nests a list and an optional licence block, with a field that is lossy in one direction and a value added on the way out:

```ts
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

## The format

A crosswalk is `{ source, target, rules, oneWay }`: two labels naming the shapes, a list of two-way rules and a list of one-way rules. `parseCrosswalk` validates the syntax and throws one error carrying every issue. `validateCrosswalk` checks the properties of the rule list as a whole, and `encode`, `decode` and `assertRoundTrip` run it first.

### Paths

A path is `segment ('.' segment | '[]')*` with segments matching `[A-Za-z0-9_-]+` other than the exact name `__proto__`, which is refused because the output's JSON check drops that key without a word. `[]` addresses every element of the array reached so far, so `parcels[].code` is the `code` of each parcel. Wildcards are index-aligned: `parcels[3].code` maps to `items[3].sku`. A rule's `to` has the same wildcard pattern as its `from`, and one target array is fed by exactly one source array, because anything else is not index-invertible. Every `from` path and every `to` path is unique across the crosswalk, so one value has one destination and rule order carries no meaning.

### Two-way rules

Each derives both directions from one declaration. Decode swaps `from` and `to` and applies the inverse.

| op | fields | encode | decode | inverse holds when |
| --- | --- | --- | --- | --- |
| `move` | `from`, `to` | carries any JSON value across | carries it back | always |
| `scale` | `factor`: finite, non-zero | `value * factor` | `value / factor` | the factor is an integer or a power of two; other factors can lose the last bit |
| `enum` | `map`, `mapBack` | `map[value]` | `mapBack[value]` | always: `mapBack` must be exactly the inverse of an injective `map`, checked when the crosswalk is parsed, and an unmapped value is an error |
| `format` | `kind`: `isoDateTime` or `numberText` | parses the text: an ISO-8601 date or timestamp to epoch milliseconds, a decimal string to a number | renders the canonical text: `toISOString`, or `String(number)` | the input is already in the canonical spelling |
| `split` | `separator`: non-empty | cuts the string at every separator | joins the parts with it | no part contains the separator; decode throws otherwise |

### One-way rules

These are the declared lossy remainder, each applying in one named direction.

| op | fields | effect |
| --- | --- | --- |
| `drop` | `from`, `direction: "encode"` | states that `from` is deliberately not carried across. Nothing is written, so the path is simply absent from the output |
| `default` | `to`, `value`, `direction`: `"encode"` or `"decode"` | inserts `value` at `to` when running in that direction and `to` is still absent from the output. `to` has no wildcard |

### Gating with `when`

Every rule may carry `when`, a trilean predicate tree, evaluated against the governing document: the source while encoding and the target while decoding. References are paths in the same grammar, without wildcards. A definite `true` applies the rule. A definite `false` skips it. An indeterminate result, where the data needed to decide is absent, also skips it: that is the one deliberate non-throwing branch in the format. Gating a rule on a presence or value predicate is how an optional native field is expressed.

### Execution

The executor is pure and synchronous. Encode reads every `from` from the input as given and writes every `to` into a fresh output, so the input is never mutated. A `from` that is absent from the document is a `RuleApplicationError`, never a silent skip. The output is checked to be valid JSON throughout, so an input value that is not JSON (an `undefined` property, say) fails that check with a Zod error rather than reaching a caller.

The errors twindex defines all extend `TwindexError`: `CrosswalkSyntaxError` for a document that is not a crosswalk, `CrosswalkStructureError` for a rule list that parses but cannot execute, `RuleApplicationError` naming the rule and path that failed, and `RoundTripMismatchError` naming the sample and path.

## Round trips

`assertRoundTrip(crosswalk, samples)` encodes and decodes each sample and deep-compares the result with it, leaving out the paths one-way rules touch: a dropped path cannot survive, and a decode-side default inserts a path the sample never had. It throws on the first difference. Its limits follow from the format:

- A crosswalk is a total mapping over the document. A field no rule maps does not survive encode, so a sample carrying one fails its own round trip.
- A `scale` with a non-integer factor can fail bit-identity: multiplying and then dividing is exact for integers and powers of two, and can differ in the last bit for factors such as `0.1`. Decode divides and does not multiply by a reciprocal, which is the more accurate route.
- A `when` must not read a field its own rule moves. Decode evaluates it against the target document, where that path no longer exists, so the rule would skip on the way back. Gate on a separate field that keeps the same path in both shapes, as `digital` does above. Static validation cannot decide this, so `assertRoundTrip` is the check.
- A sample that populates the target of an encode-direction `default` differs from its round trip, because a default only fills an absent target. Leave those paths unset in samples.
- Lookup tables are not available inside `when` in this version. A `lookup` node in a predicate throws when it is evaluated.

## JSON Schema

The crosswalk format is published as a JSON Schema 2020-12 document, generated from the Zod definitions as part of the build and canonicalised per RFC 8785. It is exposed through the package exports map as `twindex/schemas/twindex.schema.json`. The `when` field is a `$ref` to trilean's published predicate schema, pinned to the trilean version this package depends on, so the predicate grammar has one source of truth.

## Not in this version

Each of these is a deliberate omission, listed so it is not mistaken for an oversight:

- `nest` and `unnest`: compose them from `move` rules.
- Templates or concatenation of several fields into one.
- Lookup against external tables.
- Aggregates and folds over arrays.
- Array filter and sort.
- Per-element `when` gating inside a wildcard.
- Paths through arrays of arrays.
- Key escaping, for keys containing `.` or `[]`.
- Numeric indices in paths.
- Regex split.
- One rule writing several targets.
- Further `format` kinds.
- A streaming executor.

## Development

Node 22 or later, pnpm, ESM only. See [CONTRIBUTING.md](CONTRIBUTING.md) for the hooks, the commit conventions and the constraints a change must preserve, and [SECURITY.md](SECURITY.md) for reporting a vulnerability.

| Script | |
| --- | --- |
| `pnpm lint` / `pnpm lint:check` | ESLint, fixing and check-only |
| `pnpm typecheck` | `tsc` over both tsconfig programs |
| `pnpm test` | Vitest, tests colocated as `*.unit.test.ts` |
| `pnpm build` | tsdown into `dist`, then the JSON Schema generation script |

`CLAUDE.md` and `AGENTS.md` are symlinks to this file.

MIT licensed.

# crossmap

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/crossmap) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/crossmap) [![Release](https://img.shields.io/github/v/release/ExaDev/crossmap)](https://github.com/ExaDev/crossmap/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/crossmap/ci.yml?branch=main)](https://github.com/ExaDev/crossmap/actions)

A bidirectional crosswalk codec. One crosswalk document describes how to map between a dataset's native JSON shape and a shared target shape, and that one document derives both directions: every two-way operation knows its own inverse, so `decode` undoes `encode` over the paths the crosswalk maps. What cannot be undone is declared as one-way rules rather than hidden. Rules are gated with [trilean](https://github.com/ExaDev/trilean) predicate trees, and the whole format is defined by one Zod schema with a generated JSON Schema shipped in the package.

## Usage

A crosswalk does not depend on what the dataset is about. The three examples below map a table, a graph and a nested record to a shared shape with the same small set of rules, and each one holds its round trip.

### Rows of a table

Sensor readings, such as a CSV read into JSON, with text numbers, a unit and a flag column:

```ts
import { assertRoundTrip, decode, encode, parseCrosswalk } from "crossmap";

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

## Command line

The package installs a `crossmap` command, so a crosswalk can be applied without writing code:

```sh
npx crossmap encode crosswalk.json document.json
npx crossmap decode crosswalk.json shared.json
npx crossmap validate crosswalk.json
npx crossmap round-trip crosswalk.json samples.json
```

`encode` and `decode` print the translated document as JSON. `validate` and `round-trip` print nothing when they succeed; `samples.json` is a JSON array of source-shape documents. Any file argument can be `-` to read standard input, though not both at once.

Any file argument can also be a URL, so a published crosswalk applies to a published document without downloading either, and either one or both can be remote:

```sh
npx crossmap encode https://example.com/crosswalk.json https://example.com/document.json
npx crossmap validate https://example.com/crosswalk.json
```

The readable schemes are `http:`, `https:`, `data:` and `file:`, alongside plain paths and `-`. An argument is a URL when it starts with a scheme of two or more characters and a colon, so a Windows path such as `C:\x.json` stays a path. Redirects are followed. A remote read gives up after a timeout and refuses a body over a size cap, both named constants in `cli/read-source.ts` with the reason for each. Any other scheme (`ftp:`, `s3:` and the like) exits 2 as unsupported, because reading it needs a client or credentials a data-only command should not take on. Fetching a crosswalk is safe in the sense that matters here: a crosswalk is data the codec validates, never code that runs.

The library does not read URLs and imports no Node module, so it runs unchanged in a browser or worker. Where `fetch` exists, the caller does the read:

```ts
import { decode, parseCrosswalk } from "crossmap";

const crosswalk = parseCrosswalk(await (await fetch("https://example.com/crosswalk.json")).json());
const native = decode(crosswalk, await (await fetch("https://example.com/shared.json")).json());
```

The exit status is 0 on success, 1 when the library rejects the crosswalk or the document (the reason is on standard error), and 2 for bad usage or an argument that cannot be read (a missing file, a failed or oversized fetch, an unsupported scheme) or is not JSON.

## The format

A crosswalk is `{ source, target, rules, oneWay }`: two labels naming the shapes, a list of two-way rules and a list of one-way rules. `parseCrosswalk` validates the syntax and throws one error carrying every issue. `validateCrosswalk` checks the properties of the rule list as a whole, and `encode`, `decode` and `assertRoundTrip` run it first.

### Paths

A path starts with a key and continues with any sequence of `.key`, a quoted key `["..."]`, a fixed index `[n]` or a wildcard `[]`. A bare key matches `[A-Za-z0-9_-]+`; any other key, such as one holding a dot, a bracket, a colon or a space, is written quoted, with `\"` and `\\` as its only escapes, so `["dc:title"]` and `meta["a.b"]` address those keys. No key may be exactly `__proto__`, bare or quoted, because the output's JSON check drops that key without a word. A bare key made of digits is a record key: `a.0` is the key `"0"` of the record `a`, and `a[0]` is the first element of the array `a`.

`[]` addresses every element of the array reached so far, so `parcels[].code` is the `code` of each parcel, and `grid[][]` is every cell of an array of arrays. Wildcards are index-aligned: the n-th wildcard of `from` pairs with the n-th wildcard of `to`, so `parcels[3].code` maps to `items[3].sku`. A rule's `to` has as many wildcards as its `from`; the keys and indices around them may differ, which is how a single `move` nests a field (`street` to `address.street`) or flattens one (`meta.owner.name` to `ownerName`). Every array a target wildcard iterates, at every depth, is fed by exactly one source array, because two arrays merged into one are not index-invertible. An empty source array, at any depth, encodes to an empty target array.

`[n]` addresses one element, for tuple-like arrays such as `point[0]` and `point[1]`. An index past the end of the array is an absent path, so reading it is a `RuleApplicationError` like any absent `from`; gate an optional position with a `when`. One array is addressed either by fixed indices or by a wildcard, never both on the same side. Writing a later index while nothing writes an earlier one leaves a gap, which is a `RuleApplicationError` naming the missing element.

Every `from` path and every `to` path is unique across the crosswalk, compared in canonical spelling (`["a"].b` is `a.b`), so one value has one destination and rule order carries no meaning. Two rules whose destinations overlap, one inside the other, are an error whichever runs first.

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

Every rule may carry `when`, a trilean predicate tree, evaluated against the governing document: the source while encoding and the target while decoding. References are paths in the same grammar. A definite `true` applies the rule. A definite `false` skips it. An indeterminate result, where the data needed to decide is absent, also skips it: that is the one deliberate non-throwing branch in the format. Gating a rule on a presence or value predicate is how an optional native field is expressed.

A two-way rule that iterates an array can be gated per element. A reference with wildcards names a field of the element the rule is visiting, written against the rule's `from` side: on a rule over `items[].radius`, `items[].kind` is the `kind` of the same item. The reference's part through its last wildcard must be the array the rule's `from` iterates at that depth, and it may have fewer wildcards than the rule, gating every inner element on a field of the outer one. While decoding, that part is rebased onto the `to` side's array, so `items[].kind` reads `shapes[i].kind` when the rule maps `items[]` to `shapes[]`; the field below it has to keep its name in both shapes, as with any gate. A gated element is skipped before anything below it is read, so an element that lacks the rule's path is skipped rather than absent. Collection references bind the same way. One-way rules visit no element, so their references have no wildcards.

```ts
{
  op: "move",
  from: "items[].radius",
  to: "shapes[].r",
  when: { kind: "textCompare", op: "equals", left: { kind: "reference", key: "items[].kind" }, right: { kind: "textLiteral", value: "circle" } },
}
```

An element that every rule writing into it skips leaves a gap in the output array, which is a `RuleApplicationError` naming the element: map at least one field of every element unconditionally.

### Execution

The executor is pure and synchronous. Encode reads every `from` from the input as given and writes every `to` into a fresh output, so the input is never mutated. A `from` that is absent from the document is a `RuleApplicationError`, never a silent skip. The output is checked to be valid JSON throughout, so an input value that is not JSON (an `undefined` property, say) fails that check with a Zod error rather than reaching a caller.

The errors crossmap defines all extend `CrossmapError`: `CrosswalkSyntaxError` for a document that is not a crosswalk, `CrosswalkStructureError` for a rule list that parses but cannot execute, `RuleApplicationError` naming the rule and path that failed, and `RoundTripMismatchError` naming the sample and path.

## Round trips

`assertRoundTrip(crosswalk, samples)` encodes and decodes each sample and deep-compares the result with it, leaving out the paths one-way rules touch: a dropped path cannot survive, and a decode-side default inserts a path the sample never had. It throws on the first difference. Its limits follow from the format:

- A crosswalk is a total mapping over the document. A field no rule maps does not survive encode, so a sample carrying one fails its own round trip.
- A `scale` with a non-integer factor can fail bit-identity: multiplying and then dividing is exact for integers and powers of two, and can differ in the last bit for factors such as `0.1`. Decode divides and does not multiply by a reciprocal, which is the more accurate route.
- A `when` must not read a field its own rule moves. Decode evaluates it against the target document, where that path no longer exists, so the rule would skip on the way back. Gate on a separate field that keeps the same path in both shapes, as `digital` does above. Static validation cannot decide this, so `assertRoundTrip` is the check.
- A sample that populates the target of an encode-direction `default` differs from its round trip, because a default only fills an absent target. Leave those paths unset in samples.
- Lookup tables are not available inside `when` in this version. A `lookup` node in a predicate throws when it is evaluated.

## JSON Schema

The crosswalk format is published as a JSON Schema 2020-12 document, generated from the Zod definitions as part of the build and canonicalised per RFC 8785. It is exposed through the package exports map as `crossmap/schemas/crossmap.schema.json`. The `when` field is a `$ref` to trilean's published predicate schema, pinned to the trilean version this package depends on, so the predicate grammar has one source of truth.

## Not in this version

Each of these is a deliberate omission, listed so it is not mistaken for an oversight:

- `nest` and `unnest`: a `move` whose `to` is deeper nests, one whose `to` is shallower flattens, and a `move` of a whole record carries every field in it, so a dedicated operation would add nothing the format cannot already say.
- Templates or concatenation of several fields into one.
- Lookup against external tables.
- Aggregates and folds over arrays.
- Array filter and sort.
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

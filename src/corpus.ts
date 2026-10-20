import { type Crosswalk, type When } from "./crosswalk";

/**
 * One corpus cell: a crosswalk and the native samples its round trip is asserted over. The name is the op-table row (or behavioural branch) the cell covers; the round-trip meta-test asserts a cell exists for every row, so coverage cannot silently drift.
 */
export interface CorpusCell {
  readonly name: string;
  readonly crosswalk: Crosswalk;
  readonly samples: readonly unknown[];
}

const whenQtyIsBig: When = { kind: "compare", op: "gt", left: { kind: "reference", key: "qty" }, right: { kind: "numberLiteral", value: 5 } };

/**
 * Samples carry only mapped fields (the crosswalk is a total mapping: an unmapped field does not survive encode, so a sample carrying one would fail its own round trip) and use the canonical ISO form decode emits, since any other ISO spelling names the same instant but not the same string.
 *
 * The deterministic corpus: one cell per op-table row (move, scale, enum, format isoDateTime, format numberText, split, drop, default encode-direction, default decode-direction), plus a wildcard-arity-one cell, a when-applied cell, a when-skipped cell, and one cell per path shape beyond records and one wildcard (nesting and flattening, an array of arrays, fixed indices, quoted keys). Scale factors are integers by design: multiply-then-divide is bit-identical for them (a non-integer factor is a documented round-trip caveat, not a corpus case).
 */
export const CORPUS: readonly CorpusCell[] = [
  {
    name: "move",
    crosswalk: { source: "native", target: "shared", rules: [{ op: "move", from: "a", to: "b" }], oneWay: [] },
    samples: [{ a: 1 }, { a: { nested: true } }, { a: [1, 2] }],
  },
  {
    name: "scale",
    crosswalk: { source: "native", target: "shared", rules: [{ op: "scale", from: "cents", to: "units", factor: 100 }], oneWay: [] },
    samples: [{ cents: 199 }, { cents: 0 }, { cents: -42 }],
  },
  {
    name: "enum",
    crosswalk: {
      source: "native",
      target: "shared",
      rules: [{ op: "enum", from: "status", to: "state", map: { open: "OPEN", closed: "CLOSED" }, mapBack: { OPEN: "open", CLOSED: "closed" } }],
      oneWay: [],
    },
    samples: [{ status: "open" }, { status: "closed" }],
  },
  {
    name: "format isoDateTime",
    crosswalk: { source: "native", target: "shared", rules: [{ op: "format", from: "at", to: "atMs", kind: "isoDateTime" }], oneWay: [] },
    samples: [{ at: "2026-10-18T10:15:00.000Z" }, { at: "2024-02-29T23:59:59.999Z" }],
  },
  {
    name: "format numberText",
    crosswalk: { source: "native", target: "shared", rules: [{ op: "format", from: "count", to: "countText", kind: "numberText" }], oneWay: [] },
    samples: [{ count: "1234" }, { count: "-7.5" }],
  },
  {
    name: "split",
    crosswalk: { source: "native", target: "shared", rules: [{ op: "split", from: "names", to: "nameParts", separator: "," }], oneWay: [] },
    samples: [{ names: "alpha,beta" }, { names: "solo" }, { names: "" }],
  },
  {
    name: "drop",
    crosswalk: {
      source: "native",
      target: "shared",
      rules: [{ op: "move", from: "kept", to: "kept" }],
      oneWay: [{ op: "drop", from: "internal", direction: "encode" }],
    },
    samples: [{ kept: 1, internal: "x" }, { kept: 2 }],
  },
  {
    name: "default encode-direction",
    crosswalk: {
      source: "native",
      target: "shared",
      rules: [{ op: "move", from: "name", to: "name" }],
      oneWay: [{ op: "default", to: "locale", value: "en-GB", direction: "encode" }],
    },
    samples: [{ name: "parcel" }],
  },
  {
    name: "default decode-direction",
    crosswalk: {
      source: "native",
      target: "shared",
      rules: [{ op: "move", from: "name", to: "name" }],
      oneWay: [{ op: "default", to: "origin", value: "migration", direction: "decode" }],
    },
    samples: [{ name: "parcel" }],
  },
  {
    name: "wildcard arity one",
    crosswalk: {
      source: "native",
      target: "shared",
      rules: [
        { op: "move", from: "papers[].id", to: "nodes[].ref" },
        { op: "scale", from: "papers[].citations", to: "nodes[].citationCount", factor: 1 },
      ],
      oneWay: [],
    },
    samples: [
      { papers: [{ id: "p1", citations: 3 }, { id: "p2", citations: 9 }] },
      { papers: [{ id: "only", citations: 0 }] },
      { papers: [] },
    ],
  },
  {
    name: "when applied",
    crosswalk: {
      source: "native",
      target: "shared",
      rules: [
        { op: "move", from: "qty", to: "qty" },
        { op: "move", from: "bonus", to: "perk", when: whenQtyIsBig },
      ],
      oneWay: [],
    },
    samples: [{ qty: 10, bonus: "yes" }],
  },
  {
    name: "when skipped",
    crosswalk: {
      source: "native",
      target: "shared",
      rules: [
        { op: "move", from: "qty", to: "qty" },
        { op: "move", from: "bonus", to: "perk", when: whenQtyIsBig },
      ],
      oneWay: [],
    },
    samples: [{ qty: 1 }],
  },
  {
    name: "nest and flatten",
    crosswalk: {
      source: "native",
      target: "shared",
      rules: [
        { op: "move", from: "street", to: "address.street" },
        { op: "move", from: "meta.owner.name", to: "ownerName" },
      ],
      oneWay: [],
    },
    samples: [{ street: "High St", meta: { owner: { name: "Ann" } } }],
  },
  {
    name: "array of arrays",
    crosswalk: { source: "native", target: "shared", rules: [{ op: "move", from: "grid[][]", to: "cells[][]" }], oneWay: [] },
    samples: [{ grid: [["a", "b"], [], ["c"]] }, { grid: [] }, { grid: [[]] }],
  },
  {
    name: "fixed index",
    crosswalk: {
      source: "native",
      target: "shared",
      rules: [
        { op: "move", from: "point[0]", to: "lat" },
        { op: "move", from: "point[1]", to: "lon" },
        { op: "move", from: "rows[][0]", to: "items[].name" },
      ],
      oneWay: [],
    },
    samples: [{ point: ["52.2N", "0.1E"], rows: [["a"], ["b"]] }],
  },
  {
    name: "quoted key",
    crosswalk: { source: "native", target: "shared", rules: [{ op: "move", from: '["dc:title"]', to: '["a.b"]["[x]"]' }], oneWay: [] },
    samples: [{ "dc:title": "Maps" }],
  },
];

/** Every op-table row the corpus must cover; the round-trip meta-test asserts one cell per name, so a deleted cell fails the suite rather than silently narrowing coverage. */
export const REQUIRED_ROWS: readonly string[] = [
  "move",
  "scale",
  "enum",
  "format isoDateTime",
  "format numberText",
  "split",
  "drop",
  "default encode-direction",
  "default decode-direction",
  "wildcard arity one",
  "when applied",
  "when skipped",
  "nest and flatten",
  "array of arrays",
  "fixed index",
  "quoted key",
];

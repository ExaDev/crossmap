/**
 * Measures encode and decode against a hand-written copy of the same fields, on the same machine in the same run, and prints the work each does rather than a time: the ratio of crossmap's median run to the baseline's, and the number of input property reads each makes per node (counted through a Proxy over a small document, so the count is exact and independent of load). Run with `pnpm bench`.
 */
import { isDeepStrictEqual } from "node:util";
import { type Crosswalk, decode, encode, parseCrosswalk } from "../src/index";

/** A document small enough that the per-call cost of a run shows beside its per-node cost. */
const SMALL_SIZE = 1_000;

/** A document between the two. */
const MEDIUM_SIZE = 30_000;

/** A document large enough that the per-node cost dominates: the size the gap to a hand-written copy was first measured at. */
const LARGE_SIZE = 300_000;

/** Node counts the ratios are measured at. */
const SIZES = [SMALL_SIZE, MEDIUM_SIZE, LARGE_SIZE];

/** Identity field moves the mixed crosswalk carries besides its non-identity rules, the shape of a catalogue entry that maps one field per rule. */
const IDENTITY_FIELDS = 6;

/** Timed rounds per measurement: each round runs the baseline and crossmap once, interleaved so load on a shared host falls on both, and the median of the rounds is kept. */
const ROUNDS = 7;

/** Untimed runs of each side before timing, so both are optimised by the JIT before they are compared. */
const WARMUPS = 2;

/** Nodes in the document whose reads are counted: the count is per node and exact, so a small document gives the same figure as a large one. */
const COUNTED_NODES = 100;

/** The factor the scale rule multiplies by. */
const SCALE_FACTOR = 1000;

/** How many distinct kinds the enum rule maps, cycled through the nodes. */
const KINDS = ["paper", "book", "thesis"] as const;

/** The enum rule's map from native kind to shared type. */
const KIND_MAP: Readonly<Record<string, string>> = { paper: "PAPER", book: "BOOK", thesis: "THESIS" };

/** The inverse of KIND_MAP, which the enum rule's mapBack must be. */
const KIND_MAP_BACK: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(KIND_MAP).map(([from, to]) => [to, from]));

const identityFieldNames = Array.from({ length: IDENTITY_FIELDS }, (_unused, position) => `f${String(position)}`);

/** The three identity moves the problem was first measured with. */
const identityCrosswalk = parseCrosswalk({
  source: "native",
  target: "shared",
  rules: [
    { op: "move", from: "meta", to: "meta" },
    { op: "move", from: "nodes[].id", to: "nodes[].id" },
    { op: "move", from: "nodes[].text", to: "nodes[].text" },
  ],
});

/** Identity moves for every field, plus one rule each of format, scale and enum. */
const mixedCrosswalk = parseCrosswalk({
  source: "native",
  target: "shared",
  rules: [
    { op: "move", from: "meta", to: "meta" },
    ...identityFieldNames.map((name) => ({ op: "move", from: `nodes[].${name}`, to: `nodes[].${name}` })),
    { op: "format", from: "nodes[].sizeText", to: "nodes[].size", kind: "numberText" },
    { op: "scale", from: "nodes[].weight", to: "nodes[].weightMilli", factor: SCALE_FACTOR },
    { op: "enum", from: "nodes[].kind", to: "nodes[].type", map: KIND_MAP, mapBack: KIND_MAP_BACK },
  ],
});

/** Identity moves for every field and one more gated per element, which the rule-at-a-time executor runs (a gate per element is not fused). */
const gatedCrosswalk = parseCrosswalk({
  source: "native",
  target: "shared",
  rules: [
    { op: "move", from: "meta", to: "meta" },
    ...identityFieldNames.map((name) => ({ op: "move", from: `nodes[].${name}`, to: `nodes[].${name}` })),
    { op: "move", from: "nodes[].weight", to: "nodes[].weight", when: { kind: "compare", op: "gte", left: { kind: "reference", key: "nodes[].weight" }, right: { kind: "numberLiteral", value: 0 } } },
  ],
});

interface IdentityNode {
  readonly id: string;
  readonly text: string;
}

type MixedNode = Readonly<Record<string, unknown>>;

interface Document<Node> {
  readonly meta: { readonly name: string; readonly version: number };
  readonly nodes: readonly Node[];
}

const meta = { name: "bench", version: 1 };

function identityDocument(count: number): Document<IdentityNode> {
  return { meta, nodes: Array.from({ length: count }, (_unused, index) => ({ id: `n${String(index)}`, text: `node ${String(index)}` })) };
}

function mixedDocument(count: number): Document<MixedNode> {
  return {
    meta,
    nodes: Array.from({ length: count }, (_unused, index) => ({
      ...Object.fromEntries(identityFieldNames.map((name) => [name, `${name}-${String(index)}`])),
      sizeText: String(index),
      weight: index,
      kind: KINDS[index % KINDS.length],
    })),
  };
}

/** The hand-written encode of the identity crosswalk: the fields it names, copied. */
function identityBaseline(doc: Document<IdentityNode>): unknown {
  return { meta: doc.meta, nodes: doc.nodes.map((node) => ({ id: node.id, text: node.text })) };
}

/** The hand-written encode of the mixed crosswalk, written as plainly as a caller would write it. */
function mixedEncodeBaseline(doc: Document<MixedNode>): Document<MixedNode> {
  return {
    meta: doc.meta,
    nodes: doc.nodes.map((node) => {
      const out: Record<string, unknown> = {};
      for (const name of identityFieldNames) {
        out[name] = node[name];
      }
      out["size"] = Number(node["sizeText"]);
      out["weightMilli"] = Number(node["weight"]) * SCALE_FACTOR;
      out["type"] = KIND_MAP[String(node["kind"])];

      return out;
    }),
  };
}

/** The hand-written encode of the gated crosswalk. */
function gatedBaseline(doc: Document<MixedNode>): unknown {
  return {
    meta: doc.meta,
    nodes: doc.nodes.map((node) => {
      const out: Record<string, unknown> = {};
      for (const name of identityFieldNames) {
        out[name] = node[name];
      }
      if (Number(node["weight"]) >= 0) {
        out["weight"] = node["weight"];
      }

      return out;
    }),
  };
}

/** The hand-written decode of the mixed crosswalk. */
function mixedDecodeBaseline(doc: Document<MixedNode>): unknown {
  return {
    meta: doc.meta,
    nodes: doc.nodes.map((node) => {
      const out: Record<string, unknown> = {};
      for (const name of identityFieldNames) {
        out[name] = node[name];
      }
      out["sizeText"] = String(node["size"]);
      out["weight"] = Number(node["weightMilli"]) / SCALE_FACTOR;
      out["kind"] = KIND_MAP_BACK[String(node["type"])];

      return out;
    }),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) {
    throw new Error("a median of no values");
  }

  return middle;
}

/** Runs a function once and returns how long it took, in the high-resolution clock's units; only ever compared with another such reading from the same run. */
function timed(run: () => unknown): number {
  const start = process.hrtime.bigint();
  run();

  return Number(process.hrtime.bigint() - start);
}

/** The median ratio of crossmap's run to the baseline's, with the two interleaved round by round. */
function ratio(baseline: () => unknown, crossmap: () => unknown): number {
  for (let warm = 0; warm < WARMUPS; warm += 1) {
    baseline();
    crossmap();
  }
  const baselineRuns: number[] = [];
  const crossmapRuns: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    baselineRuns.push(timed(baseline));
    crossmapRuns.push(timed(crossmap));
  }

  return median(crossmapRuns) / median(baselineRuns);
}

/** A running count of the reads made of a counted document. */
class ReadCounter {
  reads = 0;

  note(): void {
    this.reads += 1;
  }
}

/** Wraps a document so every property read, own-key check and key listing on it or anything beneath it is counted. */
function counted<T>(value: T, counter: ReadCounter): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const children = new Map<PropertyKey, unknown>();

  return new Proxy(value, {
    get(target, key, receiver) {
      counter.note();
      const found: unknown = Reflect.get(target, key, receiver);
      if (typeof found !== "object" || found === null) {
        return found;
      }
      const cached = children.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const wrapped = counted(found, counter);
      children.set(key, wrapped);

      return wrapped;
    },
    getOwnPropertyDescriptor(target, key) {
      counter.note();

      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    has(target, key) {
      counter.note();

      return Reflect.has(target, key);
    },
    ownKeys(target) {
      counter.note();

      return Reflect.ownKeys(target);
    },
  });
}

/** Input reads per node one run makes over a document of COUNTED_NODES nodes. */
function readsPerNode<Doc>(run: (doc: Doc) => unknown, doc: Doc): number {
  const counter = new ReadCounter();
  run(counted(doc, counter));

  return counter.reads / COUNTED_NODES;
}

/** One crosswalk in one direction, with the documents it reads and its hand-written equivalent. */
interface Scenario<Doc> {
  /** The label printed for the scenario. */
  readonly name: string;
  /** The crosswalk crossmap runs. */
  readonly crosswalk: Crosswalk;
  /** Which of encode and decode crossmap runs. */
  readonly direction: "encode" | "decode";
  /** Builds the input document of a given node count. */
  readonly document: (count: number) => Doc;
  /** The hand-written equivalent, which must give the same output. */
  readonly baseline: (doc: Doc) => unknown;
}

/**
 * Measures one scenario against its hand-written baseline and prints the counts and ratios.
 * @param scenario - The scenario.
 * @throws Error when the baseline and crossmap disagree on a small document, since the ratio would then compare different work.
 */
function measure<Doc>(scenario: Scenario<Doc>): void {
  const { name, crosswalk, direction, document, baseline } = scenario;
  const run = (doc: Doc): unknown => (direction === "encode" ? encode(crosswalk, doc) : decode(crosswalk, doc));
  const small = document(COUNTED_NODES);
  if (!isDeepStrictEqual(run(small), baseline(small))) {
    throw new Error(`${name}: the baseline and crossmap disagree, so the ratio would compare different work`);
  }
  const reads = `input reads per node: crossmap ${readsPerNode(run, small).toFixed(1)}, baseline ${readsPerNode(baseline, small).toFixed(1)}`;
  const ratios = SIZES.map((size) => {
    const doc = document(size);

    return `${String(size)} nodes ${ratio(() => baseline(doc), () => run(doc)).toFixed(1)}x`;
  });
  console.log(`${name}\n  ${reads}\n  ratio to baseline: ${ratios.join(", ")}`);
}

const mixedName = `${String(IDENTITY_FIELDS + 1)} moves + format, scale, enum`;
measure({ name: "3 identity moves, encode", crosswalk: identityCrosswalk, direction: "encode", document: identityDocument, baseline: identityBaseline });
measure({ name: "3 identity moves, decode", crosswalk: identityCrosswalk, direction: "decode", document: identityDocument, baseline: identityBaseline });
measure({ name: `${mixedName}, encode`, crosswalk: mixedCrosswalk, direction: "encode", document: mixedDocument, baseline: mixedEncodeBaseline });
measure({ name: `${mixedName}, decode`, crosswalk: mixedCrosswalk, direction: "decode", document: (count) => mixedEncodeBaseline(mixedDocument(count)), baseline: mixedDecodeBaseline });
measure({ name: `${String(IDENTITY_FIELDS + 1)} moves + 1 gated per element (not fused), encode`, crosswalk: gatedCrosswalk, direction: "encode", document: mixedDocument, baseline: gatedBaseline });

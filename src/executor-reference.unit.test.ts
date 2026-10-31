import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CORPUS } from "./corpus";
import { type Crosswalk, parseCrosswalk } from "./crosswalk";
import { RuleApplicationError } from "./errors";
import { decode, encode } from "./executor";
import { type Locus, parsePath } from "./paths";
import { ruleSides } from "./sides";
import { decodeReference, encodeReference } from "../test/support/reference-executor";

/** What one run of an executor produced: the output in its exact serialisation (so key order counts), or the error's class, message and, for a rule failure, its rule index and path. */
type Outcome = { readonly output: string; readonly value: unknown } | { readonly error: string; readonly message: string; readonly ruleIndex: number | undefined; readonly path: string | undefined };

function outcome(run: () => unknown): Outcome {
  try {
    const value = run();

    return { output: JSON.stringify(value), value };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return {
      error: error.constructor.name,
      message: error.message,
      ruleIndex: error instanceof RuleApplicationError ? error.ruleIndex : undefined,
      path: error instanceof RuleApplicationError ? error.path : undefined,
    };
  }
}

/** The kinds of outcome a generated case can have, each of which the generators must reach for the comparison to cover it. */
const OUTCOME_KINDS = ["output", "absent", "conflict", "gap", "operation", "structure", "not JSON"] as const;
type OutcomeKind = (typeof OUTCOME_KINDS)[number];

function kindOf(result: Outcome): OutcomeKind | undefined {
  if ("output" in result) {
    return "output";
  }
  if (result.error === "CrosswalkStructureError") {
    return "structure";
  }
  if (result.error === "ZodError") {
    return "not JSON";
  }
  if (result.ruleIndex === undefined) {
    return undefined;
  }
  if (result.message.includes("absent from the document")) {
    return "absent";
  }
  if (result.message.includes("two destinations") || result.message.includes("holds a value where") || result.message.includes("where the document has")) {
    return "conflict";
  }
  if (result.message.includes("gap")) {
    return "gap";
  }

  return "operation";
}

/**
 * Runs the executor and the reference over one input in one direction and requires the same outcome: the same output, key order included, or the same error class, message, rule index and path.
 * @returns The kind of outcome both gave.
 */
function sameOutcome(crosswalk: Crosswalk, doc: unknown, direction: "encode" | "decode"): OutcomeKind | undefined {
  const expected = outcome(() => (direction === "encode" ? encodeReference(crosswalk, doc) : decodeReference(crosswalk, doc)));
  const actual = outcome(() => (direction === "encode" ? encode(crosswalk, doc) : decode(crosswalk, doc)));
  if ("output" in expected && "output" in actual) {
    expect(actual.output).toBe(expected.output);
    expect(actual.value).toStrictEqual(expected.value);
  } else {
    expect(actual).toEqual(expected);
  }

  return kindOf(expected);
}

/** Record keys the generated paths and documents share, so a generated path is often present in a generated document. */
const KEYS = ["a", "b", "c"] as const;

/** Array keys the generated paths and documents share. */
const ARRAYS = ["xs", "ys"] as const;

/** The largest fixed index a generated path uses: past the length of most generated arrays, so an index both hits and misses. */
const MAX_INDEX = 2;

/** The longest generated array, long enough that a fixed index can fall inside it or past its end. */
const MAX_ARRAY_LENGTH = 3;

/** The deepest a generated document nests records inside records and arrays. */
const MAX_DEPTH = 3;

/** The most two-way rules a generated crosswalk carries. */
const MAX_RULES = 5;

/** The most one-way rules a generated crosswalk carries. */
const MAX_ONE_WAY_RULES = 2;

/** Generated cases per property: enough that every outcome kind is met, which each property checks. */
const RUNS = 1500;

/** The time one generated case may take: a handful of encodes and decodes of a small document, with the margin a heavily loaded runner needs, so the budget scales with the cases run rather than being a fixed figure. */
const MILLISECONDS_PER_CASE = 60;

/** Each property's own budget, derived from the cases it runs. */
const PROPERTY_TIMEOUT_MILLISECONDS = RUNS * MILLISECONDS_PER_CASE;

const key = fc.constantFrom(...KEYS);
const array = fc.constantFrom(...ARRAYS);
const index = fc.integer({ min: 0, max: MAX_INDEX });

/** Paths with no wildcard and no index: a key, nested keys, a whole array. */
const keyPath = fc.oneof(
  key,
  fc.tuple(key, key).map(([outer, inner]) => `${outer}.${inner}`),
  array,
);

/** Paths with no wildcard, a fixed index among them some of the time. */
const pathOfArity0 = fc.oneof(
  { weight: 4, arbitrary: keyPath },
  { weight: 1, arbitrary: fc.tuple(array, index, key).map(([list, position, field]) => `${list}[${String(position)}].${field}`) },
  { weight: 1, arbitrary: fc.tuple(array, index).map(([list, position]) => `${list}[${String(position)}]`) },
);

/** Paths with one wildcard and only keys around it: a field of each element, a nested field, the whole element, an array under a key. */
const keyedPathOfArity1 = fc.oneof(
  fc.tuple(array, key).map(([list, field]) => `${list}[].${field}`),
  fc.tuple(array, key, key).map(([list, outer, inner]) => `${list}[].${outer}.${inner}`),
  array.map((list) => `${list}[]`),
  fc.tuple(key, array, key).map(([outer, list, field]) => `${outer}.${list}[].${field}`),
);

/** Paths with one wildcard, under a fixed index some of the time. */
const pathOfArity1 = fc.oneof(
  { weight: 4, arbitrary: keyedPathOfArity1 },
  { weight: 1, arbitrary: fc.tuple(array, index, array, key).map(([list, position, inner, field]) => `${list}[${String(position)}].${inner}[].${field}`) },
);

/** Paths with two wildcards: a field of each element of each inner array, and each inner element whole. */
const pathOfArity2 = fc.oneof(
  fc.tuple(array, array, key).map(([outer, inner, field]) => `${outer}[].${inner}[].${field}`),
  fc.tuple(array, array).map(([outer, inner]) => `${outer}[].${inner}[]`),
);

/** The array path a rule's read side iterates at its first wildcard, which an element gate's reference must name. */
function firstArray(path: string): string | undefined {
  const at = path.indexOf("[]");

  return at < 0 ? undefined : path.slice(0, at);
}

/** A `when` decided once for the whole rule. */
const wholeRuleWhen = fc.tuple(key, fc.integer({ min: -1, max: 1 })).map(([field, value]) => ({ kind: "compare", op: "gt", left: { kind: "reference", key: field }, right: { kind: "numberLiteral", value } }));

/** A `when` decided once for the whole rule, or per element over the array the rule's `from` iterates. */
function whenFor(from: string): fc.Arbitrary<unknown> {
  const list = firstArray(from);
  if (list === undefined) {
    return wholeRuleWhen;
  }
  const perElement = fc.tuple(key, fc.constantFrom("open", "closed", "x")).map(([field, value]) => ({ kind: "textCompare", op: "equals", left: { kind: "reference", key: `${list}[].${field}` }, right: { kind: "textLiteral", value } }));

  return fc.oneof(wholeRuleWhen, perElement);
}

/** A scale factor that is an integer, which multiply-then-divide inverts exactly. */
const INTEGER_FACTOR = 2;

/** A scale factor below one. */
const FRACTION_FACTOR = 0.5;

/** A scale factor that is a power of ten, the unit change most crosswalks make. */
const DECIMAL_FACTOR = 1000;

/** A number with a fractional part, which number text and scaling must carry. */
const FRACTIONAL = 2.5;

/** A negative number. */
const NEGATIVE = -3;

const ENUM_MAP = { open: "OPEN", closed: "CLOSED" };
const ENUM_MAP_BACK = { OPEN: "open", CLOSED: "closed" };

/** The parameters of each single-path op. */
const SINGLE_PATH_PARAMETERS = {
  move: fc.constant({}),
  scale: fc.constantFrom(INTEGER_FACTOR, FRACTION_FACTOR, DECIMAL_FACTOR).map((factor) => ({ factor })),
  enum: fc.constant({ map: ENUM_MAP, mapBack: ENUM_MAP_BACK }),
  format: fc.constantFrom("isoDateTime", "isoDate", "numberText", "booleanText", "jsonText").map((kind) => ({ kind })),
  split: fc.constant({ separator: "," }),
};

/** An op with one path on each side, weighted towards `move`, the op most crosswalks are made of. */
const singlePathOp = fc.constantFrom<keyof typeof SINGLE_PATH_PARAMETERS>("move", "move", "move", "scale", "enum", "format", "split");

/**
 * A single-path rule over paths drawn from the given generator, with a `when` drawn for its `from` some of the time.
 * @param path - The paths both sides draw from.
 * @param when - The `when` generator for a given `from`.
 */
function singlePathRule(path: fc.Arbitrary<string>, when: (from: string) => fc.Arbitrary<unknown>): fc.Arbitrary<object> {
  return fc.tuple(path, path, singlePathOp).chain(([from, to, op]) => fc.tuple(SINGLE_PATH_PARAMETERS[op], fc.option(when(from), { nil: undefined })).map(([extra, gate]) => ({ op, from, to, ...extra, ...(gate === undefined ? {} : { when: gate }) })));
}

/** One two-way rule of every op and every path shape, with a `when` some of the time. */
const twoWayRule = fc.constantFrom(pathOfArity0, pathOfArity1, pathOfArity1, pathOfArity1, pathOfArity2).chain((path) => {
  const template = fc.tuple(path, path, path).map(([given, family, to]) => ({ op: "template", from: { given, family }, to, template: "{family}-{given}" }));
  const copy = fc.tuple(path, path, path).map(([from, first, second]) => ({ op: "copy", from, to: [first, second] }));

  return fc.oneof({ weight: 6, arbitrary: singlePathRule(path, whenFor) }, { weight: 1, arbitrary: template }, { weight: 1, arbitrary: copy });
});

/** A single-path rule over keys and one wildcard with only keys around it, gated only on the whole rule: the rule shape most crosswalks are made of, generated on its own so it is met often. */
const keyedRule = fc.constantFrom(keyPath, keyedPathOfArity1, keyedPathOfArity1).chain((path) => singlePathRule(path, () => wholeRuleWhen));

const direction = fc.constantFrom("encode", "decode");

/** One one-way rule of every op. */
const oneWayRule = fc.oneof(
  pathOfArity0.map((from) => ({ op: "drop", from, direction: "encode" })),
  fc.tuple(pathOfArity0, fc.constantFrom(0, "x", null, { nested: true }), direction).map(([to, value, way]) => ({ op: "default", to, value, direction: way })),
  fc.tuple(fc.constantFrom("count", "sum", "min", "max"), pathOfArity1, pathOfArity0, direction).map(([fn, from, to, way]) => ({ op: "aggregate", fn, from, to, direction: way })),
);

/** Whether two generated rules name a path in common, which validation refuses: the crosswalks are generated without such pairs so that most of them execute. */
function sharePath(left: object, right: object): boolean {
  const paths = (rule: object): readonly string[] => {
    try {
      const parsed = parseCrosswalk({ source: "n", target: "s", rules: [rule] }).rules[0];

      return parsed === undefined ? [] : [...ruleSides(parsed).from, ...ruleSides(parsed).to];
    } catch {
      // A rule the schema refuses names no path the comparison could keep apart; the crosswalk it is part of is refused in turn.
      return [];
    }
  };
  const theirs = new Set(paths(right));

  return paths(left).some((path) => theirs.has(path));
}

/**
 * A crosswalk of generated rules, some of them structurally invalid, which the comparison covers as well.
 * @param rule - The two-way rules to draw from.
 * @returns A parsed crosswalk, or `undefined` when the schema refuses a generated rule (a template whose fields repeat a path, say), which is no case for the executors.
 */
function crosswalkOf(rule: fc.Arbitrary<object>): fc.Arbitrary<Crosswalk | undefined> {
  return fc.tuple(fc.uniqueArray(rule, { minLength: 1, maxLength: MAX_RULES, comparator: sharePath }), fc.array(oneWayRule, { maxLength: MAX_ONE_WAY_RULES })).map(([rules, oneWay]) => {
    try {
      return parseCrosswalk({ source: "native", target: "shared", rules, oneWay });
    } catch {
      // The schema's refusal is this generator's filter, not a result under test.
      return undefined;
    }
  });
}

/** JSON scalars, several of which fit an op (enum keys, number text, ISO dates, separated text, JSON text). */
const jsonLeaf = fc.constantFrom<unknown>("open", "closed", "x", "1", "2.5", "2026-10-18", "2026-10-18T09:30:00.000Z", "true", '{"k":1}', "p,q", "p-q", 0, 1, FRACTIONAL, NEGATIVE, true, false, null);

/** Values that are not JSON, or are JSON only in a form the output check would rewrite: each must fail, or survive, exactly as the reference has it. */
const oddLeaf = fc.constantFrom<unknown>(
  undefined,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  BigInt(1),
  Symbol("s"),
  () => 0,
  new Date(0),
  Object.create(null),
  JSON.parse('{"__proto__":{"a":1},"a":1}'),
  Object.defineProperty([1], "extra", { value: true, enumerable: true }),
  { [Symbol("hidden")]: 1, a: 1 },
);

const document = fc.letrec<{ leaf: unknown; field: unknown; list: unknown; record: unknown }>((tie) => ({
  leaf: fc.oneof({ weight: 12, arbitrary: jsonLeaf }, { weight: 1, arbitrary: oddLeaf }),
  field: fc.oneof({ maxDepth: MAX_DEPTH, depthIdentifier: "document" }, tie("leaf"), tie("leaf"), tie("record")),
  list: fc.oneof(
    { maxDepth: MAX_DEPTH, depthIdentifier: "document" },
    tie("leaf"),
    fc.array(tie("record"), { maxLength: MAX_ARRAY_LENGTH }),
    fc.array(tie("record"), { maxLength: MAX_ARRAY_LENGTH }),
    fc.array(tie("leaf"), { maxLength: MAX_ARRAY_LENGTH }),
    fc.sparseArray(tie("record"), { maxLength: MAX_ARRAY_LENGTH }),
  ),
  record: fc.record({ a: tie("field"), b: tie("field"), c: tie("field"), xs: tie("list"), ys: tie("list") }, { requiredKeys: [] }),
})).record;

/** A leaf of a fitted document: mostly JSON, sometimes not. */
const fittedLeaf = fc.oneof({ weight: 12, arbitrary: jsonLeaf }, { weight: 1, arbitrary: oddLeaf });

/**
 * Makes every path of a list present in one document, as far as the paths agree on its shape: each key a record, each wildcard or index an array of the given length, each end a drawn leaf. Where two paths disagree (one ends where another goes deeper), the first one placed wins and the other stays absent, so a drawn leaf (which may be a fixture shared between cases) is never written into.
 * @param loci - The paths to make present.
 * @param length - The length of every array the paths cross.
 * @param draw - Draws a leaf.
 * @returns The document.
 */
function fitted(loci: readonly Locus[], length: number, draw: () => unknown): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const created = new WeakSet<object>([root]);
  for (const locus of loci) {
    place(root, locus, 0, { length, draw, created });
  }

  return root;
}

/** Places one path into a fitted document from the step at `at` down. */
function place(node: unknown, locus: Locus, at: number, fit: { readonly length: number; readonly draw: () => unknown; readonly created: WeakSet<object> }): void {
  const step = locus[at];
  if (step === undefined || typeof node !== "object" || node === null || !fit.created.has(node)) {
    return;
  }
  const next = locus[at + 1];
  const fresh = (): unknown => {
    if (next === undefined) {
      return fit.draw();
    }

    const container = next.kind === "key" ? {} : [];
    fit.created.add(container);

    return container;
  };
  if (step.kind === "key") {
    if (Array.isArray(node)) {
      return;
    }
    if (!Object.hasOwn(node, step.key)) {
      Reflect.set(node, step.key, fresh());
    }
    place(Reflect.get(node, step.key), locus, at + 1, fit);

    return;
  }
  if (!Array.isArray(node)) {
    return;
  }
  while (node.length < fit.length) {
    node.push(fresh());
  }
  const positions = step.kind === "wildcard" ? [...node.keys()] : [step.index].filter((position) => position < node.length);
  for (const position of positions) {
    place(node[position], locus, at + 1, fit);
  }
}

/**
 * Compares the two executors over generated crosswalks and documents: a generated native document encoded, a generated shared one decoded, a document fitted to each side's read paths in each direction, and what encode produced decoded (a shared document shaped by the crosswalk itself).
 * @returns Every kind of outcome met.
 */
function compareOver(crosswalks: fc.Arbitrary<Crosswalk | undefined>): ReadonlySet<OutcomeKind> {
  const seen = new Set<OutcomeKind>();
  const note = (kind: OutcomeKind | undefined): void => {
    if (kind !== undefined) {
      seen.add(kind);
    }
  };
  fc.assert(
    fc.property(crosswalks, fc.record({ native: document, shared: document, length: fc.integer({ min: 0, max: MAX_ARRAY_LENGTH }), draw: fc.gen() }), (crosswalk, { native, shared, length, draw }) => {
      if (crosswalk === undefined) {
        return;
      }
      const sides = crosswalk.rules.map(ruleSides);
      const fittedNative = fitted(sides.flatMap((side) => side.from).map(parsePath), length, () => draw(() => fittedLeaf));
      const fittedShared = fitted(sides.flatMap((side) => side.to).map(parsePath), length, () => draw(() => fittedLeaf));
      note(sameOutcome(crosswalk, native, "encode"));
      note(sameOutcome(crosswalk, shared, "decode"));
      note(sameOutcome(crosswalk, fittedNative, "encode"));
      note(sameOutcome(crosswalk, fittedShared, "decode"));
      const encoded = outcome(() => encodeReference(crosswalk, fittedNative));
      if ("output" in encoded) {
        note(sameOutcome(crosswalk, encoded.value, "decode"));
      }
    }),
    { numRuns: RUNS },
  );

  return seen;
}

describe("the executor against the reference executor", () => {
  it("gives the same output or the same error as the reference over crosswalks of every op and path shape, both ways", () => {
    expect([...compareOver(crosswalkOf(twoWayRule))].sort()).toEqual([...OUTCOME_KINDS].sort());
  }, PROPERTY_TIMEOUT_MILLISECONDS);

  it("gives the same output or the same error as the reference over crosswalks of keyed single-path rules, both ways", () => {
    expect([...compareOver(crosswalkOf(keyedRule))].sort()).toEqual([...OUTCOME_KINDS].sort());
  }, PROPERTY_TIMEOUT_MILLISECONDS);

  it("gives the same result as the reference over every corpus sample, both ways", () => {
    for (const cell of CORPUS) {
      for (const sample of cell.samples) {
        sameOutcome(cell.crosswalk, sample, "encode");
        sameOutcome(cell.crosswalk, encodeReference(cell.crosswalk, sample), "decode");
      }
    }
  });
});

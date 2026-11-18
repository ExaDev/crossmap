/**
 * Writes `conformance/crossmap/generated/differential.json`: a fixed, seeded sample of the crosswalks and documents the differential property test (`src/executor-reference.unit.test.ts`) generates, each with the outcome of the naive reference executor in `test/support/reference-executor.ts`. The generators below mirror that test's, restricted to JSON values (the property test also feeds non-JSON leaves and sparse arrays, which a JSON fixture cannot carry). Every case's outcome is also required to equal the optimised executor's, so a disagreement between the two fails generation rather than entering the corpus.
 *
 * Run with `pnpm exec tsx conformance/generate/differential.ts`, or with `--check` to compare against the committed file without writing it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { z } from "zod";
import { type Crosswalk, parseCrosswalk } from "../../src/crosswalk";
import { RuleApplicationError } from "../../src/errors";
import { decode, encode } from "../../src/executor";
import { type Locus, parsePath } from "../../src/paths";
import { ruleSides } from "../../src/sides";
import { decodeReference, encodeReference } from "../../test/support/reference-executor";
import { canonical } from "../runner/canonical";

/** The seed every sample is drawn from; changing it regenerates a different, equally valid corpus file. */
export const SEED = 20_261_118;

/** The most cases of one outcome kind the file keeps: the sample is drawn wide enough that every kind is met, then thinned so the file stays readable and the rarer kinds are not drowned by plain outputs. */
const MAX_PER_KIND = 70;

/** How many crosswalk and document pairs are drawn from each generator. */
const PAIRS_PER_GENERATOR = 220;

const KEYS = ["a", "b", "c"] as const;
const ARRAYS = ["xs", "ys"] as const;
const MAX_INDEX = 2;
const MAX_ARRAY_LENGTH = 3;
const MAX_DEPTH = 3;
const MAX_RULES = 5;
const MAX_ONE_WAY_RULES = 2;
const INTEGER_FACTOR = 2;
const FRACTION_FACTOR = 0.5;
const DECIMAL_FACTOR = 1000;
const FRACTIONAL = 2.5;
const NEGATIVE = -3;
const ENUM_MAP = { open: "OPEN", closed: "CLOSED" };
const ENUM_MAP_BACK = { OPEN: "open", CLOSED: "closed" };

const key = fc.constantFrom(...KEYS);
const array = fc.constantFrom(...ARRAYS);
const index = fc.integer({ min: 0, max: MAX_INDEX });

const keyPath = fc.oneof(
  key,
  fc.tuple(key, key).map(([outer, inner]) => `${outer}.${inner}`),
  array,
);
const pathOfArity0 = fc.oneof(
  { weight: 4, arbitrary: keyPath },
  { weight: 1, arbitrary: fc.tuple(array, index, key).map(([list, position, field]) => `${list}[${String(position)}].${field}`) },
  { weight: 1, arbitrary: fc.tuple(array, index).map(([list, position]) => `${list}[${String(position)}]`) },
);
const keyedPathOfArity1 = fc.oneof(
  fc.tuple(array, key).map(([list, field]) => `${list}[].${field}`),
  fc.tuple(array, key, key).map(([list, outer, inner]) => `${list}[].${outer}.${inner}`),
  array.map((list) => `${list}[]`),
  fc.tuple(key, array, key).map(([outer, list, field]) => `${outer}.${list}[].${field}`),
);
const pathOfArity1 = fc.oneof(
  { weight: 4, arbitrary: keyedPathOfArity1 },
  { weight: 1, arbitrary: fc.tuple(array, index, array, key).map(([list, position, inner, field]) => `${list}[${String(position)}].${inner}[].${field}`) },
);
const pathOfArity2 = fc.oneof(
  fc.tuple(array, array, key).map(([outer, inner, field]) => `${outer}[].${inner}[].${field}`),
  fc.tuple(array, array).map(([outer, inner]) => `${outer}[].${inner}[]`),
);

function firstArray(path: string): string | undefined {
  const at = path.indexOf("[]");

  return at < 0 ? undefined : path.slice(0, at);
}

const wholeRuleWhen = fc.tuple(key, fc.integer({ min: -1, max: 1 })).map(([field, value]) => ({ kind: "compare", op: "gt", left: { kind: "reference", key: field }, right: { kind: "numberLiteral", value } }));

function whenFor(from: string): fc.Arbitrary<unknown> {
  const list = firstArray(from);
  if (list === undefined) {
    return wholeRuleWhen;
  }
  const perElement = fc.tuple(key, fc.constantFrom("open", "closed", "x")).map(([field, value]) => ({ kind: "textCompare", op: "equals", left: { kind: "reference", key: `${list}[].${field}` }, right: { kind: "textLiteral", value } }));

  return fc.oneof(wholeRuleWhen, perElement);
}

const SINGLE_PATH_PARAMETERS = {
  move: fc.constant({}),
  scale: fc.constantFrom(INTEGER_FACTOR, FRACTION_FACTOR, DECIMAL_FACTOR).map((factor) => ({ factor })),
  enum: fc.constant({ map: ENUM_MAP, mapBack: ENUM_MAP_BACK }),
  format: fc.constantFrom("isoDateTime", "isoDate", "numberText", "booleanText", "jsonText").map((kind) => ({ kind })),
  split: fc.constant({ separator: "," }),
};
const singlePathOp = fc.constantFrom<keyof typeof SINGLE_PATH_PARAMETERS>("move", "move", "move", "scale", "enum", "format", "split");

function singlePathRule(path: fc.Arbitrary<string>, when: (from: string) => fc.Arbitrary<unknown>): fc.Arbitrary<object> {
  return fc.tuple(path, path, singlePathOp).chain(([from, to, op]) => fc.tuple(SINGLE_PATH_PARAMETERS[op], fc.option(when(from), { nil: undefined })).map(([extra, gate]) => ({ op, from, to, ...extra, ...(gate === undefined ? {} : { when: gate }) })));
}

const twoWayRule = fc.constantFrom(pathOfArity0, pathOfArity1, pathOfArity1, pathOfArity1, pathOfArity2).chain((path) => {
  const template = fc.tuple(path, path, path).map(([given, family, to]) => ({ op: "template", from: { given, family }, to, template: "{family}-{given}" }));
  const copy = fc.tuple(path, path, path).map(([from, first, second]) => ({ op: "copy", from, to: [first, second] }));

  return fc.oneof({ weight: 6, arbitrary: singlePathRule(path, whenFor) }, { weight: 1, arbitrary: template }, { weight: 1, arbitrary: copy });
});
const keyedRule = fc.constantFrom(keyPath, keyedPathOfArity1, keyedPathOfArity1).chain((path) => singlePathRule(path, () => wholeRuleWhen));

const direction = fc.constantFrom("encode", "decode");
const oneWayRule = fc.oneof(
  pathOfArity0.map((from) => ({ op: "drop", from, direction: "encode" })),
  fc.tuple(pathOfArity0, fc.constantFrom(0, "x", null, { nested: true }), direction).map(([to, value, way]) => ({ op: "default", to, value, direction: way })),
  fc.tuple(fc.constantFrom("count", "sum", "min", "max"), pathOfArity1, pathOfArity0, direction).map(([fn, from, to, way]) => ({ op: "aggregate", fn, from, to, direction: way })),
);

/** Whether two generated rules name a path in common, which validation refuses: the crosswalks are drawn without such pairs so that most of them execute. */
function sharePath(left: object, right: object): boolean {
  const paths = (rule: object): readonly string[] => {
    try {
      const parsed = parseCrosswalk({ source: "n", target: "s", rules: [rule] }).rules[0];

      return parsed === undefined ? [] : [...ruleSides(parsed).from, ...ruleSides(parsed).to];
    } catch {
      // A rule the schema refuses names no path to compare; the crosswalk it belongs to is refused in turn and dropped by the caller.
      return [];
    }
  };
  const theirs = new Set(paths(right));

  return paths(left).some((path) => theirs.has(path));
}

const RawCrosswalkSchema = z.object({ source: z.string(), target: z.string(), rules: z.array(z.looseObject({})), oneWay: z.array(z.looseObject({})) });

interface RawCrosswalk {
  readonly source: string;
  readonly target: string;
  readonly rules: readonly object[];
  readonly oneWay: readonly object[];
}

function crosswalkOf(rule: fc.Arbitrary<object>): fc.Arbitrary<RawCrosswalk> {
  return fc.tuple(fc.uniqueArray(rule, { minLength: 1, maxLength: MAX_RULES, comparator: sharePath }), fc.array(oneWayRule, { maxLength: MAX_ONE_WAY_RULES })).map(([rules, oneWay]) => ({ source: "native", target: "shared", rules, oneWay }));
}

const jsonLeaf = fc.constantFrom<unknown>("open", "closed", "x", "1", "2.5", "2026-10-18", "2026-10-18T09:30:00.000Z", "true", '{"k":1}', "p,q", "p-q", 0, 1, FRACTIONAL, NEGATIVE, true, false, null);

const document = fc.letrec<{ leaf: unknown; field: unknown; list: unknown; record: unknown }>((tie) => ({
  leaf: jsonLeaf,
  field: fc.oneof({ maxDepth: MAX_DEPTH, depthIdentifier: "document" }, tie("leaf"), tie("leaf"), tie("record")),
  list: fc.oneof({ maxDepth: MAX_DEPTH, depthIdentifier: "document" }, tie("leaf"), fc.array(tie("record"), { maxLength: MAX_ARRAY_LENGTH }), fc.array(tie("leaf"), { maxLength: MAX_ARRAY_LENGTH })),
  record: fc.record({ a: tie("field"), b: tie("field"), c: tie("field"), xs: tie("list"), ys: tie("list") }, { requiredKeys: [] }),
})).record;

interface Fit {
  readonly length: number;
  readonly draw: () => unknown;
  readonly created: WeakSet<object>;
}

/** Places one path into a fitted document from the step at `at` down, as far as the shape already placed allows. */
function place(node: unknown, locus: Locus, at: number, fit: Fit): void {
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

/** A document in which every path of the list is present, as far as the paths agree on a shape: each key a record, each wildcard or index an array of `length` elements, each end a drawn leaf. */
function fitted(loci: readonly Locus[], length: number, draw: () => unknown): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const created = new WeakSet<object>([root]);
  for (const locus of loci) {
    place(root, locus, 0, { length, draw, created });
  }

  return root;
}

type Expectation = { readonly output: unknown; readonly outputText: string } | { readonly error: { readonly class: string; readonly message: string; readonly ruleIndex?: number; readonly path?: string } };

/** A copy of a JSON value with every object's keys in canonical order. */
function sorted(value: unknown): unknown {
  return JSON.parse(canonical(value));
}

/** Runs one executor, reporting the output (with its exact serialisation, key order included) or the error's class, message, and for a rule failure its index and path. */
function outcome(run: () => unknown): Expectation {
  try {
    const value = run();

    return { output: JSON.parse(JSON.stringify(value)), outputText: JSON.stringify(value) };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return { error: { class: error.constructor.name, message: error.message, ...(error instanceof RuleApplicationError ? { ruleIndex: error.ruleIndex, path: error.path } : {}) } };
  }
}

interface GeneratedCase {
  readonly id?: string;
  readonly from: string;
  readonly kind: "run";
  readonly crosswalk: RawCrosswalk;
  readonly direction: "encode" | "decode";
  readonly document: unknown;
  readonly expect: Expectation;
}

const KINDS = ["output", "absent", "conflict", "gap", "operation", "structure"] as const;

function kindOf(expected: Expectation): (typeof KINDS)[number] {
  if ("output" in expected) {
    return "output";
  }
  const { class: name, message } = expected.error;
  if (name === "CrosswalkStructureError") {
    return "structure";
  }
  if (message.includes("absent from the document")) {
    return "absent";
  }
  if (message.includes("two destinations") || message.includes("holds a value where") || message.includes("where the document has")) {
    return "conflict";
  }
  if (message.includes("gap")) {
    return "gap";
  }

  return "operation";
}

/** Draws the cases of one generator, requiring the optimised executor to agree with the reference on every one. */
function casesFrom(generator: fc.Arbitrary<RawCrosswalk>, label: string, seed: number): readonly GeneratedCase[] {
  const pairs = fc.sample(fc.record({ raw: generator, native: document, shared: document, length: fc.integer({ min: 0, max: MAX_ARRAY_LENGTH }), draw: fc.gen() }), { seed, numRuns: PAIRS_PER_GENERATOR });
  const cases: GeneratedCase[] = [];
  const seen = new Set<string>();
  let counter = 0;
  const record = (unsortedRaw: RawCrosswalk, unsortedDoc: unknown, way: "encode" | "decode", what: string): Expectation => {
    // A fixture file keeps its keys in sorted order, so the case is drawn, run and recorded in that order: the expectation then holds for the bytes a loader reads.
    const raw = RawCrosswalkSchema.parse(sorted(unsortedRaw));
    const doc = sorted(unsortedDoc);
    const crosswalk = parseCrosswalk(raw);
    const reference = outcome(() => (way === "encode" ? encodeReference(crosswalk, doc) : decodeReference(crosswalk, doc)));
    const actual = outcome(() => (way === "encode" ? encode(crosswalk, doc) : decode(crosswalk, doc)));
    if (JSON.stringify(reference) !== JSON.stringify(actual)) {
      throw new Error(`the executor and the reference disagree (${label} ${what}): ${JSON.stringify({ raw, doc, reference, actual })}`);
    }
    const fingerprint = JSON.stringify([raw, way, doc]);
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      counter += 1;
      cases.push({ from: `src/executor-reference.unit.test.ts: the executor against the reference executor (${label}, sample ${String(counter)}, ${what}; seeded sample, expectation from the reference executor)`, kind: "run", crosswalk: raw, direction: way, document: doc, expect: reference });
    }

    return reference;
  };
  for (const { raw, native, shared, length, draw } of pairs) {
    let crosswalk: Crosswalk;
    try {
      crosswalk = parseCrosswalk(sorted(raw));
    } catch {
      // The schema's refusal is this generator's filter, not a result under test.
      continue;
    }
    const sides = crosswalk.rules.map(ruleSides);
    const fittedNative = fitted(sides.flatMap((side) => side.from).map(parsePath), length, () => draw(() => jsonLeaf));
    const fittedShared = fitted(sides.flatMap((side) => side.to).map(parsePath), length, () => draw(() => jsonLeaf));
    record(raw, native, "encode", "generated native");
    record(raw, shared, "decode", "generated shared");
    const encoded = record(raw, fittedNative, "encode", "fitted native");
    record(raw, fittedShared, "decode", "fitted shared");
    if ("output" in encoded) {
      record(raw, encoded.output, "decode", "decode of an encoding");
    }
  }

  return cases;
}

/**
 * Builds the file's text.
 * @returns The canonical JSON text of the generated cases, ending in a line feed.
 * @throws When the optimised executor and the reference disagree, or an outcome kind is never reached.
 */
export function generate(): string {
  const drawn = [...casesFrom(crosswalkOf(twoWayRule), "every op and path shape", SEED), ...casesFrom(crosswalkOf(keyedRule), "keyed single-path rules", SEED + 1)];
  const taken = new Map<string, number>();
  const cases = drawn.filter((generated) => {
    const kind = kindOf(generated.expect);
    const count = taken.get(kind) ?? 0;
    taken.set(kind, count + 1);

    return count < MAX_PER_KIND;
  });
  const reached = new Set(cases.map((generated) => kindOf(generated.expect)));
  for (const kind of KINDS) {
    if (!reached.has(kind)) {
      throw new Error(`the sample never reaches the outcome kind "${kind}"`);
    }
  }
  const numbered = cases.map((generated, position) => ({ ...generated, id: `generated.differential.${String(position + 1)}` }));

  return `${canonical({ cases: numbered })}\n`;
}

const path = join(import.meta.dirname, "../crossmap/generated/differential.json");

if (process.argv[1] === import.meta.filename) {
  const text = generate();
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== text) {
      throw new Error("conformance/crossmap/generated/differential.json is not what the generator writes: rerun it");
    }
  } else {
    writeFileSync(path, text);
  }
}

/**
 * The executor as it was before encode and decode were compiled, kept unchanged as the naive reference the compiled executor is tested against (src/executor-reference.unit.test.ts): one pass per rule, validation and the full output parse on every call. Its gap search is kept here too, since the shipped one in src/paths.ts was rewritten for speed. Not part of the package.
 */
import { type Crosswalk, type TwoWayRule } from "../../src/crosswalk";
import { CrosswalkStructureError, RuleApplicationError } from "../../src/errors";
import { enumDecode, enumEncode } from "../../src/ops/enum";
import { formatDecode, formatEncode } from "../../src/ops/format";
import { moveValue } from "../../src/ops/move";
import { applyOneWayRule } from "../../src/ops/one-way";
import { scaleDecode, scaleEncode } from "../../src/ops/scale";
import { splitDecode, splitEncode } from "../../src/ops/split";
import { type JsonValue, JsonValueSchema, type PredicateNode } from "trilean";
import { bindLocus, type ElementGate, type EmptySite, ensureArray, formatPath, type Locus, parsePathMemo, readTrail, type Trail, walkLocus, wildcardIndexes, writeMatches } from "../../src/paths";
import { ruleSides } from "../../src/sides";
import { copyDecode, copyEncode } from "../../src/ops/copy";
import { parseTemplateMemo, renderTemplate, splitTemplate } from "../../src/ops/template";
import { validateCrosswalk } from "../../src/validate";
import { evaluateWhen, whenArity } from "../../src/when";

/**
 * Encodes a native document into the shared shape. Every rule's `from` is read from `doc` exactly as given and every `to` is written into a fresh output, so the input is never mutated and rule order carries no meaning (validateCrosswalk, run first, enforces the path uniqueness that makes this safe). A rule's `when` is evaluated against `doc`: definite true applies, definite false or indeterminate skips. Two-way rules write first, then the output's absent paths gain any due `default` values.
 * @param crosswalk - The parsed crosswalk.
 * @param doc - The native (source-side) document.
 * @returns The shared (target-side) document.
 * @throws CrosswalkStructureError when the crosswalk fails structural validation.
 * @throws RuleApplicationError when a rule's `from` path is absent, a value does not fit the operation, two rules claim one output location, or an output array is left with an element no rule wrote (ruleIndex -1, since that gap belongs to no single rule).
 */
export function encodeReference(crosswalk: Crosswalk, doc: unknown): JsonValue {
  return run(crosswalk, doc, "encode");
}

/**
 * Decodes a shared document back into the native shape: the same executor with every two-way rule's paths swapped and each operation's inverse applied, so decode is a true inverse of encode over the paths the crosswalk maps. A rule's `when` is evaluated against `doc` (the target document, the decode input).
 * @param crosswalk - The parsed crosswalk.
 * @param doc - The shared (target-side) document.
 * @returns The native (source-side) document.
 * @throws CrosswalkStructureError when the crosswalk fails structural validation.
 * @throws RuleApplicationError when a rule's `to` path (the decode read side) is absent, a value does not fit the inverse operation, two rules claim one output location, or an output array is left with a gap (ruleIndex -1).
 */
export function decodeReference(crosswalk: Crosswalk, doc: unknown): JsonValue {
  return run(crosswalk, doc, "decode");
}

/** The rule index a RuleApplicationError carries when the failure belongs to the rule list as a whole: a gap in an output array is the absence of a write, which no one rule owns. */
const NO_SINGLE_RULE = -1;

function run(crosswalk: Crosswalk, doc: unknown, direction: "encode" | "decode"): JsonValue {
  const issues = validateCrosswalk(crosswalk);
  if (issues.length > 0) {
    throw new CrosswalkStructureError(issues);
  }
  const target: Record<string, unknown> = {};
  crosswalk.rules.forEach((rule, index) => {
    applyTwoWayRule(rule, index, { direction, doc, target });
  });
  crosswalk.oneWay.forEach((rule, index) => {
    if (rule.when !== undefined && !evaluateWhen(rule.when, doc)) {
      return;
    }
    try {
      applyOneWayRule(rule, direction, doc, target);
    } catch (error) {
      throw new RuleApplicationError(crosswalk.rules.length + index, rule.op === "default" ? rule.to : rule.from, errorMessage(error));
    }
  });
  const hole = findHole(target);
  if (hole !== undefined) {
    throw new RuleApplicationError(NO_SINGLE_RULE, formatPath(hole), "no rule wrote this array element, so the array would have a gap");
  }

  return parseJsonValue(target);
}

/**
 * How a rule's `when` applies: a gate with no wildcard references is decided once for the whole rule (`false` skips it, `undefined` lets it run), and one whose references carry wildcards becomes a per-element gate over the read side, evaluated once per element at the depth its references reach. `governing` is the rule's read-side path in this direction, so the gate's references are rebased onto the arrays it iterates.
 */
function elementGate(when: PredicateNode, doc: unknown, governing: Locus): ElementGate | false | undefined {
  const arity = whenArity(when);
  if (arity === 0) {
    return evaluateWhen(when, doc) ? undefined : false;
  }
  const wildcardPositions = governing.flatMap((step, position) => (step.kind === "wildcard" ? [position] : []));
  const arrayAt = (wildcard: number): Locus => {
    const position = wildcardPositions[wildcard];
    if (position === undefined) {
      throw new Error(`the rule's path has no wildcard ${String(wildcard)}: validateCrosswalk bounds a reference's wildcards by the rule's`);
    }

    return governing.slice(0, position + 1);
  };

  return { arity, admit: (indexes) => evaluateWhen(when, doc, { indexes, arrayAt }) };
}

/**
 * Applies one two-way rule: walks the governing read path one element at a time, reads the other read paths at the same indexes, transforms each element's values with the operation in this direction, and writes the results to the write-side paths at those indexes as it goes, so nothing per element outlives the element. Empty arrays met on any read side are materialised on every write-side path.
 * @throws RuleApplicationError when a read path is absent, two read paths address different elements, the operation rejects a value, or a write conflicts.
 */
function applyTwoWayRule(rule: TwoWayRule, index: number, context: RunContext): void {
  const { direction, doc, target } = context;
  const sides = ruleSides(rule);
  const [governingPath, ...otherReads] = direction === "encode" ? sides.from : sides.to;
  const writes = direction === "encode" ? sides.to : sides.from;
  if (governingPath === undefined) {
    throw new Error("a rule with no read path: ruleSides always returns at least one");
  }
  const governing = parsePathMemo(governingPath);
  const gate = rule.when === undefined ? undefined : elementGate(rule.when, doc, governing);
  if (gate === false) {
    return;
  }
  const writeLoci = writes.map((path) => parsePathMemo(path));
  const readPath = (direction === "encode" ? sides.from : sides.to).join(", ");
  const empties: { readonly locus: Locus; readonly empty: EmptySite }[] = [];
  let governingCount = 0;
  const countWalk = (locus: Locus): { readonly empties: readonly EmptySite[] | undefined; readonly count: number } => {
    let count = 0;
    const walked = walkLocus(doc, locus, gate, () => {
      count += 1;
    });

    return { empties: walked, count };
  };
  const governingWalk = countWalk(governing);
  if (governingWalk.empties === undefined) {
    throw new RuleApplicationError(index, governingPath, "the path is absent from the document");
  }
  governingCount = governingWalk.count;
  for (const empty of governingWalk.empties) {
    empties.push({ locus: governing, empty });
  }
  const otherWalks = otherReads.map((path) => {
    const locus = parsePathMemo(path);
    const walked = countWalk(locus);
    if (walked.empties === undefined) {
      throw new RuleApplicationError(index, path, "the path is absent from the document");
    }
    if (walked.count !== governingCount) {
      throw new RuleApplicationError(index, path, `addresses different elements from ${governingPath}, so the paths cannot be paired element by element`);
    }
    for (const empty of walked.empties) {
      empties.push({ locus, empty });
    }

    return locus;
  });
  walkLocus(doc, governing, gate, (trail, value) => {
    const indexes = wildcardIndexes(governing, trail);
    const values = [value, ...otherWalks.map((locus, position) => {
      const found = readTrail(doc, bindLocus(locus, indexes));
      if (!found.found) {
        throw new RuleApplicationError(index, otherReads[position] ?? governingPath, `addresses different elements from ${governingPath}, so the paths cannot be paired element by element`);
      }

      return found.value;
    })];
    const results = transform(rule, direction, values, { index, path: readPath });
    const outputs = writeLoci.map((locus, position) => ({ trail: bindLocus(locus, indexes), value: results[position] }));
    try {
      writeMatches(target, outputs);
    } catch (error) {
      throw new RuleApplicationError(index, writes.join(", "), errorMessage(error));
    }
  });
  try {
    for (const { locus, empty } of empties) {
      // An existing empty source array yields no matches, so without this its counterpart would never come into being: decode would find the path absent, or an inner array would leave a gap or a shorter outer array.
      const emptyIndexes = wildcardIndexes(locus, empty.trail);
      for (const writeLocus of writeLoci) {
        ensureArray(target, bindLocus(writeLocus, emptyIndexes, empty.wildcard));
      }
    }
  } catch (error) {
    throw new RuleApplicationError(index, writes.join(", "), errorMessage(error));
  }
}

/** What every rule in one encode or decode call shares: the direction, the input document and the output under construction. */
interface RunContext {
  readonly direction: "encode" | "decode";
  readonly doc: unknown;
  readonly target: Record<string, unknown>;
}

/** Applies one two-way rule's operation to one element's values in the given direction (one value per read path in, one per write path out), turning the operation's own thrown errors into RuleApplicationErrors that name the rule and path. */
function transform(rule: TwoWayRule, direction: "encode" | "decode", values: readonly unknown[], where: { readonly index: number; readonly path: string }): readonly unknown[] {
  try {
    switch (rule.op) {
      case "template": {
        const pieces = parseTemplateMemo(rule.template);
        const names = Object.keys(rule.from);
        if (direction === "encode") {
          return [renderTemplate(pieces, new Map(names.map((name, position) => [name, values[position]])))];
        }
        const [text] = values;
        if (typeof text !== "string") {
          throw new Error(`template decode applies to strings, found: ${JSON.stringify(text)}`);
        }
        const parts = splitTemplate(pieces, text);

        return names.map((name) => parts.get(name));
      }
      case "copy":
        return direction === "encode" ? copyEncode(rule, values[0]) : [copyDecode(values)];
      case "move":
      case "scale":
      case "enum":
      case "format":
      case "split":
        return [applyOp(rule, direction, values[0])];
      default:
        return unhandledOp();
    }
  } catch (error) {
    if (error instanceof RuleApplicationError) {
      throw error;
    }
    throw new RuleApplicationError(where.index, where.path, errorMessage(error));
  }
}

/** Applies a single-path operation to one value in the given direction. */
function applyOp(rule: Exclude<TwoWayRule, { readonly op: "template" | "copy" }>, direction: "encode" | "decode", value: unknown): unknown {
  switch (rule.op) {
    case "move":
      return moveValue(rule, value);
    case "scale":
      return direction === "encode" ? scaleEncode(rule, value) : scaleDecode(rule, value);
    case "enum":
      return direction === "encode" ? enumEncode(rule, value) : enumDecode(rule, value);
    case "format":
      return direction === "encode" ? formatEncode(rule, value) : formatDecode(rule, value);
    case "split":
      return direction === "encode" ? splitEncode(rule, value) : splitDecode(rule, value);
    default:
      return unhandledOp();
  }
}

/** Unreachable for any rule that passed the schema: the default arm exists so the switch is total, and reaching it means this package's schema and executor disagree. */
function unhandledOp(): never {
  throw new Error("no operation handler for the rule's op: the schema and the executor disagree");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/** The output document is only as JSON as the input document was (move passes values through untouched), so the declared JsonValue return type is earned at this boundary: a non-JSON value anywhere in the output fails loudly here rather than reaching a caller as a lie. */
function parseJsonValue(target: Record<string, unknown>): JsonValue {
  return JsonValueSchema.parse(target);
}

/**
 * Finds the first array element nothing wrote: a hole left when a rule wrote a later index of an array (a fixed index past the next free one, or a gated rule skipping an element no other rule wrote). Holes are counted before any array is walked, so a large sparse array costs one key listing rather than a pass over its length.
 * @param value - The output document under construction.
 * @param trail - The location of `value` in the document, prefixed to the returned trail; the root call omits it.
 * @returns The trail of the first hole in depth-first order, or `undefined` when there is none.
 */
function findHole(value: unknown, trail: Trail = []): Trail | undefined {
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      const index = value.findIndex((_element: unknown, position) => !Object.hasOwn(value, position));

      return [...trail, { kind: "index", index }];
    }
    for (const [index, element] of value.entries()) {
      const hole = findHole(element, [...trail, { kind: "index", index }]);
      if (hole !== undefined) {
        return hole;
      }
    }

    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const hole = findHole(child, [...trail, { kind: "key", key }]);
      if (hole !== undefined) {
        return hole;
      }
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { type Crosswalk, type TwoWayRule } from "./crosswalk";
import { CrosswalkStructureError, RuleApplicationError } from "./errors";
import { enumDecode, enumEncode } from "./ops/enum";
import { formatDecode, formatEncode } from "./ops/format";
import { moveValue } from "./ops/move";
import { applyOneWayRule } from "./ops/one-way";
import { scaleDecode, scaleEncode } from "./ops/scale";
import { splitDecode, splitEncode } from "./ops/split";
import { type JsonValue, JsonValueSchema, type PredicateNode } from "trilean";
import { bindLocus, type ElementGate, ensureArray, findHole, formatPath, type Locus, parsePathMemo, readLocus, wildcardIndexes, writeMatches } from "./paths";
import { validateCrosswalk } from "./validate";
import { evaluateWhen, whenArity } from "./when";

/**
 * Encodes a native document into the shared shape. Every rule's `from` is read from `doc` exactly as given and every `to` is written into a fresh output, so the input is never mutated and rule order carries no meaning (validateCrosswalk, run first, enforces the path uniqueness that makes this safe). A rule's `when` is evaluated against `doc`: definite true applies, definite false or indeterminate skips. Two-way rules write first, then the output's absent paths gain any due `default` values.
 * @param crosswalk - The parsed crosswalk.
 * @param doc - The native (source-side) document.
 * @returns The shared (target-side) document.
 * @throws CrosswalkStructureError when the crosswalk fails structural validation.
 * @throws RuleApplicationError when a rule's `from` path is absent, a value does not fit the operation, two rules claim one output location, or an output array is left with an element no rule wrote (ruleIndex -1, since that gap belongs to no single rule).
 */
export function encode(crosswalk: Crosswalk, doc: unknown): JsonValue {
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
export function decode(crosswalk: Crosswalk, doc: unknown): JsonValue {
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
    const fromPath = direction === "encode" ? rule.from : rule.to;
    const toPath = direction === "encode" ? rule.to : rule.from;
    const fromLocus = parsePathMemo(fromPath);
    const toLocus = parsePathMemo(toPath);
    const gate = rule.when === undefined ? undefined : elementGate(rule.when, doc, fromLocus);
    if (gate === false) {
      return;
    }
    const reading = readLocus(doc, fromLocus, gate);
    if (reading === undefined) {
      throw new RuleApplicationError(index, fromPath, "the path is absent from the document");
    }
    const writes = reading.matches.map((match) => ({
      trail: bindLocus(toLocus, wildcardIndexes(fromLocus, match.trail)),
      value: applyOp(rule, direction, match.value, { index, path: fromPath }),
    }));
    try {
      writeMatches(target, writes);
      for (const empty of reading.empties) {
        // An existing empty source array yields no matches, so without this its counterpart would never come into being: decode would find the path absent, or an inner array would leave a gap or a shorter outer array.
        ensureArray(target, bindLocus(toLocus, wildcardIndexes(fromLocus, empty.trail), empty.wildcard));
      }
    } catch (error) {
      throw new RuleApplicationError(index, toPath, errorMessage(error));
    }
  });
  crosswalk.oneWay.forEach((rule, index) => {
    if (rule.when !== undefined && !evaluateWhen(rule.when, doc)) {
      return;
    }
    try {
      applyOneWayRule(rule, direction, target);
    } catch (error) {
      throw new RuleApplicationError(crosswalk.rules.length + index, rule.op === "drop" ? rule.from : rule.to, errorMessage(error));
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

/** Applies one two-way rule's operation to one value in the given direction, turning the operation's own thrown errors into RuleApplicationErrors that name the rule and path. */
function applyOp(rule: TwoWayRule, direction: "encode" | "decode", value: unknown, where: { readonly index: number; readonly path: string }): unknown {
  try {
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
  } catch (error) {
    throw new RuleApplicationError(where.index, where.path, errorMessage(error));
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

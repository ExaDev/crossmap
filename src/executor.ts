import { type Crosswalk, type TwoWayRule } from "./crosswalk";
import { CrosswalkStructureError, RuleApplicationError } from "./errors";
import { enumDecode, enumEncode } from "./ops/enum";
import { formatDecode, formatEncode } from "./ops/format";
import { moveValue } from "./ops/move";
import { applyOneWayRule } from "./ops/one-way";
import { scaleDecode, scaleEncode } from "./ops/scale";
import { splitDecode, splitEncode } from "./ops/split";
import { type JsonValue, JsonValueSchema } from "trilean";
import { type Locus, parsePathMemo, readLocus, writeMatches } from "./paths";
import { validateCrosswalk } from "./validate";
import { evaluateWhen } from "./when";

/**
 * Encodes a native document into the shared shape. Every rule's `from` is read from `doc` exactly as given and every `to` is written into a fresh output, so the input is never mutated and rule order carries no meaning (validateCrosswalk, run first, enforces the path uniqueness that makes this safe). A rule's `when` is evaluated against `doc`: definite true applies, definite false or indeterminate skips. Two-way rules write first, then the output's absent paths gain any due `default` values.
 * @param crosswalk - The parsed crosswalk.
 * @param doc - The native (source-side) document.
 * @returns The shared (target-side) document.
 * @throws CrosswalkStructureError when the crosswalk fails structural validation.
 * @throws RuleApplicationError when a rule's `from` path is absent or a value does not fit the operation.
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
 * @throws RuleApplicationError when a rule's `to` path (the decode read side) is absent or a value does not fit the inverse operation.
 */
export function decode(crosswalk: Crosswalk, doc: unknown): JsonValue {
  return run(crosswalk, doc, "decode");
}

function run(crosswalk: Crosswalk, doc: unknown, direction: "encode" | "decode"): JsonValue {
  const issues = validateCrosswalk(crosswalk);
  if (issues.length > 0) {
    throw new CrosswalkStructureError(issues);
  }
  const target: Record<string, unknown> = {};
  crosswalk.rules.forEach((rule, index) => {
    if (rule.when !== undefined && !evaluateWhen(rule.when, doc)) {
      return;
    }
    const fromPath = direction === "encode" ? rule.from : rule.to;
    const toPath = direction === "encode" ? rule.to : rule.from;
    const fromLocus = parsePathMemo(fromPath);
    const toLocus = parsePathMemo(toPath);
    const matches = readLocus(doc, fromLocus);
    if (matches === undefined) {
      throw new RuleApplicationError(index, fromPath, "the path is absent from the document");
    }
    const writes = matches.map((match) => ({
      keys: projectKeys(fromLocus, toLocus, match.keys),
      value: applyOp(rule, direction, match.value, { index, path: fromPath }),
    }));
    try {
      writeMatches(target, writes);
      if (matches.length === 0 && toLocus.some((step) => step.kind === "wildcard")) {
        materialiseEmptyRoot(target, toLocus, index, toPath);
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

  return parseJsonValue(target);
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

/**
 * The concrete key trail of `toLocus` for one match found at `fromLocus`: key steps contribute their own key, and each wildcard step takes the array index the match used at the corresponding wildcard of the from-side, in order. Wildcard counts and nesting order are equal by structural validation, so the indexes always run out exactly.
 */
function projectKeys(fromLocus: Locus, toLocus: Locus, sourceKeys: readonly string[]): readonly string[] {
  const indexes: string[] = [];
  fromLocus.forEach((step, position) => {
    if (step.kind === "wildcard") {
      const index = sourceKeys[position];
      if (index === undefined) {
        throw new Error(`the read match has fewer keys than its locus has steps: ${sourceKeys.join(".")}`);
      }
      indexes.push(index);
    }
  });
  const keys: string[] = [];
  for (const step of toLocus) {
    if (step.kind === "key") {
      keys.push(step.key);
      continue;
    }
    const index = indexes.shift();
    if (index === undefined) {
      throw new Error(`the target locus has more wildcards than the source provided indexes for`);
    }
    keys.push(index);
  }

  return keys;
}

/**
 * A source array that exists with zero elements reads as zero matches, so no element write happens and the target wildcard root would never come into being: decode of that output would then find the path absent and fail. An existing-but-empty array is real structure, so its root is materialised as an empty array (only when nothing is there yet, so a sibling rule that already wrote elements is never clobbered).
 */
function materialiseEmptyRoot(target: Record<string, unknown>, toLocus: Locus, index: number, toPath: string): void {
  const rootKeys: string[] = [];
  for (const step of toLocus) {
    if (step.kind === "wildcard") {
      break;
    }
    rootKeys.push(step.key);
  }
  const rootLocus: Locus = toLocus.slice(0, rootKeys.length);
  if (readLocus(target, rootLocus) !== undefined) {
    return;
  }
  try {
    writeMatches(target, [{ keys: rootKeys, value: [] }]);
  } catch (error) {
    throw new RuleApplicationError(index, toPath, errorMessage(error));
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

import type { TwoWayRule } from "./crosswalk";

/**
 * The paths a two-way rule reads and writes, in the order its operation takes and produces values: encode reads `from` and writes `to`, decode the reverse. Most rules have one path on each side; a `template` reads several fields (in its `from` record's key order, the order its placeholder names are listed) and a `copy` writes several targets.
 */
export interface RuleSides {
  readonly from: readonly string[];
  readonly to: readonly string[];
}

/**
 * The sides of a two-way rule.
 * @param rule - The rule.
 * @returns Its `from` and `to` paths as lists, each non-empty.
 */
export function ruleSides(rule: TwoWayRule): RuleSides {
  switch (rule.op) {
    case "template":
      return { from: Object.values(rule.from), to: [rule.to] };
    case "copy":
      return { from: [rule.from], to: rule.to };
    case "move":
    case "scale":
    case "enum":
    case "format":
    case "split":
      return { from: [rule.from], to: [rule.to] };
    default:
      return unhandledOp();
  }
}

/** Unreachable for any rule that passed the schema: the default arm exists so the switch is total. */
function unhandledOp(): never {
  throw new Error("no sides for the rule's op: the schema and ruleSides disagree");
}

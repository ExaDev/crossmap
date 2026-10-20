import type { OneWayRule } from "../crosswalk";
import { bindLocus, parsePathMemo, readTrail, writeMatches } from "../paths";
import { aggregateWrites } from "./aggregate";

/**
 * Applies a one-way rule to the output document under construction, after every two-way rule has written. `aggregate` writes its derived values, read from the input document, when the executor is running the direction it names. `drop` declares that its `from` is deliberately not carried across: in the executor's fresh output a path no rule writes is already absent, so the declaration is what the format and assertRoundTrip's exclusion list consume, and there is nothing to do. `default` inserts its value only when the executor is running the direction it names and its `to` is still absent from the output.
 * @param rule - The one-way rule to apply.
 * @param direction - The direction the executor is running.
 * @param doc - The input document of this run, which an aggregate reads.
 * @param target - The output document under construction.
 */
export function applyOneWayRule(rule: OneWayRule, direction: "encode" | "decode", doc: unknown, target: Record<string, unknown>): void {
  if (rule.op === "drop") {
    return;
  }
  if (rule.direction !== direction) {
    return;
  }
  if (rule.op === "aggregate") {
    writeMatches(target, aggregateWrites(rule, doc));

    return;
  }
  // validateCrosswalk rejects a wildcard in a default's `to`, so binding with no indexes yields its one concrete trail (bindLocus throws if a wildcard were there).
  const trail = bindLocus(parsePathMemo(rule.to), []);
  if (readTrail(target, trail).found) {
    return;
  }
  writeMatches(target, [{ trail, value: rule.value }]);
}

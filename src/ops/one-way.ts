import type { OneWayRule } from "../crosswalk";
import { type Locus, parsePathMemo, readLocus, writeMatches } from "../paths";

/**
 * Applies a one-way rule to the output document under construction, after every two-way rule has written. `drop` declares that its `from` is deliberately not carried across: in the executor's fresh output a path no rule writes is already absent, so the declaration is what the format and assertRoundTrip's exclusion list consume, and there is nothing to do. `default` inserts its value only when the executor is running the direction it names and its `to` is still absent from the output.
 * @param rule - The one-way rule to apply.
 * @param direction - The direction the executor is running.
 * @param target - The output document under construction.
 */
export function applyOneWayRule(
  rule: OneWayRule,
  direction: "encode" | "decode",
  target: Record<string, unknown>,
): void {
  if (rule.op === "drop") {
    return;
  }
  if (rule.direction !== direction) {
    return;
  }
  const locus = parsePathMemo(rule.to);
  if (readLocus(target, locus) !== undefined) {
    return;
  }
  writeMatches(target, [{ keys: keysOf(locus), value: rule.value }]);
}

/** The concrete key trail of a wildcard-free locus (validateCrosswalk rejects wildcards in a default's `to`), which is exactly the trail writeMatches needs. */
function keysOf(locus: Locus): readonly string[] {
  const keys: string[] = [];
  for (const step of locus) {
    if (step.kind !== "key") {
      throw new Error("a default rule's to path must be wildcard-free");
    }
    keys.push(step.key);
  }

  return keys;
}

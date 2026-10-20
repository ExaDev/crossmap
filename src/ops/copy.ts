import type { CopyRule } from "../crosswalk";

/**
 * The encode half of `copy`: the one value read at `from`, once for each `to` path.
 * @param rule - The rule, whose `to` paths fix how many copies are written.
 * @param value - The value read at `from`.
 * @returns One copy per `to` path, in order.
 */
export function copyEncode(rule: CopyRule, value: unknown): readonly unknown[] {
  return rule.to.map(() => value);
}

/**
 * The decode half of `copy`: the copies read at the `to` paths must all be equal, and that one value is written back to `from`. Copies that disagree have no single preimage (something edited one copy and not the others), so they are a hard error rather than a silent choice of one.
 * @param values - The values read at the `to` paths, in order.
 * @returns The one value for `from`.
 * @throws Error when the copies differ.
 */
export function copyDecode(values: readonly unknown[]): unknown {
  const [first, ...others] = values;
  others.forEach((other, position) => {
    if (!jsonEqual(first, other)) {
      throw new Error(`the copies disagree: to path ${String(position + 1)} holds ${JSON.stringify(other)} where the first holds ${JSON.stringify(first)}`);
    }
  });

  return first;
}

/** Deep equality over JSON values: leaves with Object.is, arrays by length then element, records by own key set then value. */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((element: unknown, index) => jsonEqual(element, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);

    return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }

  return Object.is(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { SplitRule } from "../crosswalk";

/** The encode half of `split`: cuts a string into its parts at every occurrence of the separator. */
export function splitEncode(rule: SplitRule, value: unknown): string[] {
  if (typeof value !== "string") {
    throw new Error(`split applies to strings, found: ${JSON.stringify(value)}`);
  }

  return value.split(rule.separator);
}

/** The decode half of `split`: joins the parts back with the separator. A part that itself contains the separator would make the join ambiguous (re-encoding it would split at the wrong place), so it is a hard error: the crosswalk's separator must not occur inside a part. */
export function splitDecode(rule: SplitRule, value: unknown): string {
  if (!Array.isArray(value)) {
    throw new Error(`split decode applies to arrays of strings, found: ${JSON.stringify(value)}`);
  }
  const parts: string[] = [];
  for (const element of value) {
    if (typeof element !== "string") {
      throw new Error(`split decode applies to arrays of strings, found: ${JSON.stringify(value)}`);
    }
    if (element.includes(rule.separator)) {
      throw new Error(`a split part contains the separator, so the join is ambiguous: ${JSON.stringify(element)}`);
    }
    parts.push(element);
  }

  return parts.join(rule.separator);
}

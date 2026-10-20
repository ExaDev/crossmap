import type { AggregateFunction, AggregateRule } from "../crosswalk";
import { bindLocus, type Locus, parsePathMemo, readLocus, type Trail, wildcardCount, wildcardIndexes } from "../paths";

/**
 * Computes an aggregate rule's results against the governing input document: the matches of `from` grouped by their indexes at the first `k` wildcards, where `k` is the wildcard count of `to`, and one value per group written at `to` bound to those indexes. Every group is enumerated from the arrays themselves, so a group with no elements (an empty inner array) still gets its result.
 * @param rule - The rule; validateCrosswalk has checked that `to` has fewer wildcards than `from`.
 * @param doc - The governing input document (the source while encoding, the target while decoding).
 * @returns One write per group.
 * @throws Error when `from` is absent from the document, a value does not fit the function, or `min` or `max` meets a group with no values.
 */
export function aggregateWrites(rule: AggregateRule, doc: unknown): readonly { readonly trail: Trail; readonly value: number }[] {
  const from = parsePathMemo(rule.from);
  const to = parsePathMemo(rule.to);
  const groupDepth = wildcardCount(to);
  const reading = readLocus(doc, from);
  const groups = readLocus(doc, prefixThroughWildcard(from, groupDepth));
  if (reading === undefined || groups === undefined) {
    throw new Error("the path is absent from the document");
  }
  const groupValues = groups.matches.map((group) => ({ indexes: wildcardIndexes(from, group.trail), values: new Array<unknown>() }));
  const byKey = new Map(groupValues.map((group) => [group.indexes.join(","), group.values]));
  for (const match of reading.matches) {
    const key = wildcardIndexes(from, match.trail).slice(0, groupDepth).join(",");
    const bucket = byKey.get(key);
    // Every match descends from an element of the group array, which the second reading enumerated, so a miss means the two readings disagree: a bug here, not a data condition.
    if (bucket === undefined) {
      throw new Error(`a match of ${rule.from} belongs to no group at [${key}]`);
    }
    bucket.push(match.value);
  }

  return groupValues.map((group) => ({ trail: bindLocus(to, group.indexes), value: combine(rule.fn, group.values) }));
}

/** The prefix of a locus through its n-th wildcard, the array whose elements form the groups; the whole document (the empty prefix) for n of zero. */
function prefixThroughWildcard(locus: Locus, wildcards: number): Locus {
  if (wildcards === 0) {
    return [];
  }
  let seen = 0;
  const end = locus.findIndex((step) => {
    if (step.kind === "wildcard") {
      seen += 1;
    }

    return seen === wildcards;
  });

  return locus.slice(0, end + 1);
}

/**
 * Combines one group's values.
 * @param fn - The aggregate function.
 * @param values - The group's values in index order.
 * @returns The count, or the sum, minimum or maximum of finite numbers.
 * @throws Error for a value that is not a finite number (except under `count`, which counts any value), a sum that overflows, or `min` or `max` of no values, which has no answer.
 */
export function combine(fn: AggregateFunction, values: readonly unknown[]): number {
  if (fn === "count") {
    return values.length;
  }
  const numbers = values.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${fn} applies to finite numbers, found: ${JSON.stringify(value)}`);
    }

    return value;
  });
  if (fn === "sum") {
    const total = numbers.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total)) {
      throw new Error("the sum overflows to a non-finite value");
    }

    return total;
  }
  if (numbers.length === 0) {
    throw new Error(`${fn} of no values has no answer: gate the rule with when, or use count`);
  }

  // A reduce rather than Math.min(...numbers): spreading a large group as arguments overflows the call stack.
  return numbers.reduce((best, value) => (fn === "min" ? Math.min(best, value) : Math.max(best, value)));
}

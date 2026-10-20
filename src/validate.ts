import type { Crosswalk, OneWayRule, TwoWayRule } from "./crosswalk";
import type { CrosswalkIssue } from "./errors";
import { canonicalPath, formatPath, type Locus, PATH_REGEX, parsePathMemo, wildcardCount } from "./paths";
import { visitReferences } from "./when";

/**
 * Validates a syntactically parsed crosswalk against the structural rules that make its rule list executable and decode a true inverse of encode. Schema parsing (parseCrosswalk) checks each rule in isolation; these checks are properties of the rule list as a whole, which is why they are reported as a list rather than thrown mid-parse. Each check below returns its issues and the results are concatenated, so a check with nothing to report returns an empty list.
 *
 * Checked here: per two-way rule, the `to` path has as many wildcards as the `from` path (key and index steps around them may differ, which is how a rule nests or flattens); across rules, every `to`-side array a wildcard iterates, at every depth, is fed by exactly one `from`-side array; every `to` path and every `from` path is unique, compared in canonical spelling; no array is addressed both by a fixed index and by a wildcard on the same side; `when` reference paths (references and collection references alike) are well-formed and contain no wildcards; a `default` rule's `to` is wildcard-free (a default has no source array to size a materialisation from).
 * @param crosswalk - The parsed crosswalk.
 * @returns Every issue found (empty means valid). Issue indices number the two-way rules first, then the one-way rules.
 */
export function validateCrosswalk(crosswalk: Crosswalk): readonly CrosswalkIssue[] {
  const ruleCount = crosswalk.rules.length;

  return [
    ...crosswalk.rules.flatMap((rule, index): readonly CrosswalkIssue[] => [
      ...checkWildcardAlignment(rule, index),
      ...checkWhenPaths(rule.when, index, parsePathMemo(rule.from)),
    ]),
    ...crosswalk.oneWay.flatMap((rule, index): readonly CrosswalkIssue[] => {
      const oneWayIndex = ruleCount + index;

      return rule.op === "default" ? [...checkWhenPaths(rule.when, oneWayIndex, undefined), ...checkDefaultTo(rule, oneWayIndex)] : checkWhenPaths(rule.when, oneWayIndex, undefined);
    }),
    ...checkPathUniqueness(crosswalk),
    ...checkWildcardRoots(crosswalk),
    ...checkIndexWildcardMix(crosswalk),
  ];
}

/** Design check (a): the `to` path must have as many wildcards as the `from` path, because runtime mapping is index-aligned (the n-th wildcard of `from` pairs with the n-th of `to`, so `papers[3].id` maps to `nodes[3].ref`) and carrying every index across is what makes decode a true inverse. The key and index steps between wildcards are free: `a` to `b.a` nests and `a[].b.c` to `x[].c` flattens, and decode reverses either by the same pairing. */
function checkWildcardAlignment(rule: TwoWayRule, index: number): readonly CrosswalkIssue[] {
  const fromWildcards = wildcardCount(parsePathMemo(rule.from));
  const toWildcards = wildcardCount(parsePathMemo(rule.to));
  if (fromWildcards === toWildcards) {
    return [];
  }

  return [
    {
      ruleIndex: index,
      message: `to has ${String(toWildcards)} wildcards where from has ${String(fromWildcards)}: mapping is index-aligned, one wildcard to one`,
    },
  ];
}

/** Design check (e), plus the same for collection references: every reference must be a well-formed path, and a reference with wildcards names a field of the element a two-way rule is visiting, so it is allowed only on a two-way rule, with no more wildcards than the rule's `from`, and with its part through its last wildcard equal to the `from` path's part through the same wildcard (the array the rule iterates there). That last condition is what lets decode rebase the reference onto the `to` side's array; a wildcard into some other array would have no element to bind to. One-way rules have no visited element, so their references are wildcard-free. */
function checkWhenPaths(when: unknown, index: number, from: Locus | undefined): readonly CrosswalkIssue[] {
  const issues: CrosswalkIssue[] = [];
  visitReferences(when, (reference) => {
    if (typeof reference !== "string" || !PATH_REGEX.test(reference)) {
      issues.push({ ruleIndex: index, message: `when references a path that is malformed: ${JSON.stringify(reference)}` });

      return;
    }
    const problem = elementReferenceProblem(parsePathMemo(reference), from);
    if (problem !== undefined) {
      issues.push({ ruleIndex: index, message: `when reference ${reference} ${problem}` });
    }
  });

  return issues;
}

/** Why a reference's wildcards cannot bind to the element its rule visits, or `undefined` when they can (including when it has none). */
function elementReferenceProblem(reference: Locus, from: Locus | undefined): string | undefined {
  const wildcards = wildcardCount(reference);
  if (wildcards === 0) {
    return undefined;
  }
  if (from === undefined) {
    return "contains a wildcard, but a one-way rule visits no element to bind it to";
  }
  if (wildcards > wildcardCount(from)) {
    return `contains ${String(wildcards)} wildcards where its rule's from has ${String(wildcardCount(from))}`;
  }
  const referenceArray = formatPath(reference.slice(0, reference.findLastIndex((step) => step.kind === "wildcard") + 1));
  const fromArray = wildcardArrays(from)[wildcards - 1];
  if (referenceArray !== fromArray) {
    return `contains a wildcard into ${referenceArray}, which is not the array its rule's from iterates at that depth (${String(fromArray)})`;
  }

  return undefined;
}

/** A `default` inserts one value at one place: a wildcard in its `to` would need an array length no rule supplies. */
function checkDefaultTo(rule: OneWayRule & { op: "default" }, index: number): readonly CrosswalkIssue[] {
  if (wildcardCount(parsePathMemo(rule.to)) === 0) {
    return [];
  }

  return [
    {
      ruleIndex: index,
      message: `a default rule's to path must be wildcard-free: ${rule.to}`,
    },
  ];
}

/** The issue index of a defect that lies between rules rather than in one (CrosswalkIssue's documented negative index). */
const BETWEEN_RULES = -1;

/** The sentinel a repeated path is recorded under: no single rule owns the conflict. */
const DUPLICATE = -1;

/** Design checks (c) and (d): one value, one destination. A repeated `to` makes rule order significant (later writes would overwrite earlier ones) and a repeated `from` reads one value twice, which only one destination can hold. Paths are compared in canonical spelling, so `a.b` and `["a"].b` are one path. */
function checkPathUniqueness(crosswalk: Crosswalk): readonly CrosswalkIssue[] {
  const ruleCount = crosswalk.rules.length;
  const toPaths = new Map<string, number>();
  const fromPaths = new Map<string, number>();
  crosswalk.rules.forEach((rule, index) => {
    notePath(toPaths, rule.to, index);
    notePath(fromPaths, rule.from, index);
  });
  crosswalk.oneWay.forEach((rule, index) => {
    if (rule.op === "drop") {
      notePath(fromPaths, rule.from, ruleCount + index);
    } else {
      notePath(toPaths, rule.to, ruleCount + index);
    }
  });
  const issues: CrosswalkIssue[] = [];
  for (const [path, index] of toPaths) {
    if (index === DUPLICATE) {
      issues.push({ ruleIndex: BETWEEN_RULES, message: `two rules write the same to path: ${path}` });
    }
  }
  for (const [path, index] of fromPaths) {
    if (index === DUPLICATE) {
      issues.push({ ruleIndex: BETWEEN_RULES, message: `two rules read the same from path: ${path}` });
    }
  }

  return issues;
}

/** Records a path in the map, marking a duplicate with the sentinel (the first index is kept for the message-free bookkeeping; the issue names no rule because the conflict is between two). */
function notePath(paths: Map<string, number>, path: string, index: number): void {
  const canonical = canonicalPath(path);
  paths.set(canonical, paths.has(canonical) ? DUPLICATE : index);
}

/** Design check (b): every `to`-side array a wildcard iterates (the path prefix through that wildcard, e.g. `papers[]` or `papers[].tags[]`), at every depth, is fed by exactly one `from`-side array at the same depth. Two source arrays merging into one target array are not index-invertible: decode could not tell which source a given element came from. Checking only the outermost array would miss two inner arrays (`p[].a[]` and `p[].b[]`) merging under one shared outer pair. */
function checkWildcardRoots(crosswalk: Crosswalk): readonly CrosswalkIssue[] {
  const issues: CrosswalkIssue[] = [];
  const feeders = new Map<string, string>();
  crosswalk.rules.forEach((rule, index) => {
    const fromArrays = wildcardArrays(parsePathMemo(rule.from));
    const toArrays = wildcardArrays(parsePathMemo(rule.to));
    toArrays.forEach((toArray, depth) => {
      const fromArray = fromArrays[depth];
      if (fromArray === undefined) {
        // Check (a) reports the unequal wildcard count; there is no array at this depth to pair.
        return;
      }
      const existing = feeders.get(toArray);
      if (existing !== undefined && existing !== fromArray) {
        issues.push({
          ruleIndex: index,
          message: `two source arrays (${existing}, ${fromArray}) feed the one target array ${toArray}: the merge is not index-invertible`,
        });

        return;
      }
      feeders.set(toArray, fromArray);
    });
  });

  return issues;
}

/** The canonical path prefix through each wildcard of a locus, outermost first: the arrays its wildcards iterate. */
function wildcardArrays(locus: Locus): readonly string[] {
  const arrays: string[] = [];
  locus.forEach((step, position) => {
    if (step.kind === "wildcard") {
      arrays.push(formatPath(locus.slice(0, position + 1)));
    }
  });

  return arrays;
}

/** An array is addressed by position or by wildcard on one side, never both: a fixed index into an array that a wildcard also iterates makes the array's length depend on two rules, so an empty source array would encode to a one-element target that decode cannot read back, and reading one element both ways would write it twice on the way back. Each side (every `from` path, and every `to` path including a default's) is checked on its own, since the two sides are different documents. */
function checkIndexWildcardMix(crosswalk: Crosswalk): readonly CrosswalkIssue[] {
  const fromSide = crosswalk.rules.map((rule) => rule.from);
  const toSide = [...crosswalk.rules.map((rule) => rule.to), ...crosswalk.oneWay.flatMap((rule) => (rule.op === "default" ? [rule.to] : []))];

  return [...mixedArrays(fromSide), ...mixedArrays(toSide)].map((array) => ({
    ruleIndex: BETWEEN_RULES,
    message: `the array ${array} is addressed both by a fixed index and by a wildcard`,
  }));
}

/** The canonical locations (wildcards in the prefix printed as `[]`) of every array some path addresses by index and another by wildcard. */
function mixedArrays(paths: readonly string[]): readonly string[] {
  const indexed = new Set<string>();
  const iterated = new Set<string>();
  for (const path of paths) {
    const locus = parsePathMemo(path);
    locus.forEach((step, position) => {
      if (step.kind === "key") {
        return;
      }
      const array = position === 0 ? "" : formatPath(locus.slice(0, position));
      (step.kind === "index" ? indexed : iterated).add(array);
    });
  }

  return [...indexed].filter((array) => iterated.has(array));
}

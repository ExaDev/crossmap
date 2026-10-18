import type { Crosswalk, OneWayRule, TwoWayRule } from "./crosswalk";
import type { CrosswalkIssue } from "./errors";
import { type Locus, PATH_REGEX, parsePathMemo } from "./paths";

/**
 * Validates a syntactically parsed crosswalk against the structural rules that make its rule list executable and decode a true inverse of encode. Schema parsing (parseCrosswalk) checks each rule in isolation; these checks are properties of the rule list as a whole, which is why they are reported as a list rather than thrown mid-parse. Each check below returns its issues and the results are concatenated, so a check with nothing to report returns an empty list.
 *
 * Checked here: per two-way rule, the `to` path's wildcard count and nesting order equal the `from` path's; across rules, every `to`-side wildcard root array is fed by exactly one `from`-side wildcard root; every `to` path and every `from` path is unique; `when` reference paths (references and collection references alike) are well-formed and contain no wildcards; a `default` rule's `to` is wildcard-free (a default has no source array to size a materialisation from).
 * @param crosswalk - The parsed crosswalk.
 * @returns Every issue found (empty means valid). Issue indices number the two-way rules first, then the one-way rules.
 */
export function validateCrosswalk(crosswalk: Crosswalk): readonly CrosswalkIssue[] {
  const ruleCount = crosswalk.rules.length;

  return [
    ...crosswalk.rules.flatMap((rule, index): readonly CrosswalkIssue[] => [
      ...checkWildcardAlignment(rule, index),
      ...checkWhenPaths(rule.when, index),
    ]),
    ...crosswalk.oneWay.flatMap((rule, index): readonly CrosswalkIssue[] => {
      const oneWayIndex = ruleCount + index;

      return rule.op === "default" ? [...checkWhenPaths(rule.when, oneWayIndex), ...checkDefaultTo(rule, oneWayIndex)] : checkWhenPaths(rule.when, oneWayIndex);
    }),
    ...checkPathUniqueness(crosswalk),
    ...checkWildcardRoots(crosswalk),
  ];
}

/** Design check (a): the `to` path's wildcards must match the `from` path's in count and nesting order, because runtime mapping is index-aligned (`papers[3].id` maps to `nodes[3].id`) and that is what makes decode a true inverse. */
function checkWildcardAlignment(rule: TwoWayRule, index: number): readonly CrosswalkIssue[] {
  const fromWildcardPattern = wildcardPattern(parsePathMemo(rule.from));
  const toWildcardPattern = wildcardPattern(parsePathMemo(rule.to));
  if (fromWildcardPattern === toWildcardPattern) {
    return [];
  }

  return [
    {
      ruleIndex: index,
      message: `wildcard pattern of to (${toWildcardPattern}) must equal from (${fromWildcardPattern}): mapping is index-aligned`,
    },
  ];
}

/** The wildcard signature of a locus: which steps are wildcards, in order, e.g. "key-wildcard-key". */
function wildcardPattern(locus: Locus): string {
  return locus.map((step) => step.kind).join("-");
}

/** Design check (e), plus the same for collection references: a `when` is evaluated against one governing document as a whole, so a wildcard inside it has no element to bind to. The grammar is re-checked too, so an exotic-but-schematic predicate cannot smuggle in a malformed path. */
function checkWhenPaths(when: unknown, index: number): readonly CrosswalkIssue[] {
  const issues: CrosswalkIssue[] = [];
  walkPredicate(when, (reference) => {
    if (typeof reference !== "string" || !PATH_REGEX.test(reference) || reference.includes("[]")) {
      issues.push({
        ruleIndex: index,
        message: `when references a path that is malformed or contains a wildcard: ${JSON.stringify(reference)}`,
      });
    }
  });

  return issues;
}

/** Visits every string a predicate tree uses as a reference key or collection name, without enumerating trilean node kinds: the tree has already passed PredicateNodeSchema, so an object with a `key`/`collection` string field in these positions is a reference the resolvers will receive. */
function walkPredicate(node: unknown, visit: (reference: unknown) => void): void {
  if (Array.isArray(node)) {
    node.forEach((element) => {
      walkPredicate(element, visit);
    });

    return;
  }
  if (!isRecord(node)) {
    return;
  }
  if (typeof node["key"] === "string") {
    visit(node["key"]);
  }
  if (typeof node["collection"] === "string") {
    visit(node["collection"]);
  }
  for (const value of Object.values(node)) {
    if (typeof value === "object" && value !== null) {
      walkPredicate(value, visit);
    }
  }
}

/** A `default` inserts one value at one place: a wildcard in its `to` would need an array length no rule supplies. */
function checkDefaultTo(rule: OneWayRule & { op: "default" }, index: number): readonly CrosswalkIssue[] {
  if (!rule.to.includes("[]")) {
    return [];
  }

  return [
    {
      ruleIndex: index,
      message: `a default rule's to path must be wildcard-free: ${rule.to}`,
    },
  ];
}

/** The sentinel a repeated path is recorded under: no single rule owns the conflict. */
const DUPLICATE = -1;

/** Design checks (c) and (d): one value, one destination. A repeated `to` makes rule order significant (later writes would overwrite earlier ones) and a repeated `from` reads one value twice, which only one destination can hold. */
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
      issues.push({ ruleIndex: -1, message: `two rules write the same to path: ${path}` });
    }
  }
  for (const [path, index] of fromPaths) {
    if (index === DUPLICATE) {
      issues.push({ ruleIndex: -1, message: `two rules read the same from path: ${path}` });
    }
  }

  return issues;
}

/** Records a path in the map, marking a duplicate with the sentinel (the first index is kept for the message-free bookkeeping; the issue names no rule because the conflict is between two). */
function notePath(paths: Map<string, number>, path: string, index: number): void {
  paths.set(path, paths.has(path) ? DUPLICATE : index);
}

/** Design check (b): every `to`-side wildcard root array (the path prefix ending in the first wildcard, e.g. `papers[]`) is fed by exactly one `from`-side root. Two source arrays merging into one target array are not index-invertible: decode could not tell which source a given element came from. */
function checkWildcardRoots(crosswalk: Crosswalk): readonly CrosswalkIssue[] {
  const issues: CrosswalkIssue[] = [];
  const toRoots = new Map<string, string>();
  crosswalk.rules.forEach((rule, index) => {
    const fromRoot = wildcardRoot(rule.from);
    const toRoot = wildcardRoot(rule.to);
    if (fromRoot === undefined || toRoot === undefined) {
      return;
    }
    const existing = toRoots.get(toRoot);
    if (existing !== undefined && existing !== fromRoot) {
      issues.push({
        ruleIndex: index,
        message: `two source arrays (${existing}, ${fromRoot}) feed the one target array ${toRoot}: the merge is not index-invertible`,
      });

      return;
    }
    toRoots.set(toRoot, fromRoot);
  });

  return issues;
}

/** The path prefix up to and including the first wildcard, or undefined for a wildcard-free path. */
function wildcardRoot(path: string): string | undefined {
  const cut = path.indexOf("[]");

  return cut === -1 ? undefined : path.slice(0, cut + 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One reason a crosswalk document or path string failed schema or grammar parsing: a human-readable message naming the offending value. Zod's own issue objects are collapsed into these so the public error surface stays stable across Zod versions.
 */
export interface SyntaxIssue {
  readonly message: string;
}

/**
 * One structural defect of an otherwise syntactically valid crosswalk: which rule (two-way rules first, then one-way rules, continuing the count; negative when the defect lies between rules, not in one) and what is wrong. Structural checks are properties of the rule list as a whole (wildcard correlation, path uniqueness), which is why they are collected rather than thrown mid-parse.
 */
export interface CrosswalkIssue {
  readonly ruleIndex: number;
  readonly message: string;
}

/** The root of this package's error taxonomy: every error crossmap throws is a `CrossmapError`, so callers can catch the family with one check. */
export class CrossmapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when a crosswalk document or a path string fails its schema or grammar: the value is syntactically not a crosswalk. Carries every issue found, not just the first, so one failed parse reports the whole document. */
export class CrosswalkSyntaxError extends CrossmapError {
  readonly issues: readonly SyntaxIssue[];

  constructor(issues: readonly SyntaxIssue[]) {
    super(`crosswalk syntax error: ${issues.map((issue) => issue.message).join("; ")}`);
    this.issues = issues;
  }
}

/** Thrown by encode and decode when validateCrosswalk finds a structural defect: the crosswalk parses but its rule list is not executable as written. Carries every issue, matching validateCrosswalk's report. */
export class CrosswalkStructureError extends CrossmapError {
  readonly issues: readonly CrosswalkIssue[];

  constructor(issues: readonly CrosswalkIssue[]) {
    super(`crosswalk structure error: ${issues.map((issue) => (issue.ruleIndex < 0 ? issue.message : `rule ${String(issue.ruleIndex)}: ${issue.message}`)).join("; ")}`);
    this.issues = issues;
  }
}

/** Thrown when a rule cannot be applied to a concrete document: its `from` path is absent, a value has the wrong shape for the operation, or two destinations conflict. `ruleIndex` numbers two-way rules first, then one-way rules, and is negative when the failure belongs to no single rule (an output array element that no rule wrote). Rule application failures are hard errors by design; an optional native field is expressed with a `when` presence gate, never by skipping the rule. */
export class RuleApplicationError extends CrossmapError {
  readonly ruleIndex: number;

  readonly path: string;

  constructor(ruleIndex: number, path: string, message: string) {
    super(ruleIndex < 0 ? `${path}: ${message}` : `rule ${String(ruleIndex)} (${path}): ${message}`);
    this.ruleIndex = ruleIndex;
    this.path = path;
  }
}

/** Thrown by assertRoundTrip when decode(encode(sample)) differs from the sample on a path the crosswalk promises to preserve. The path names the first differing location in the sample. */
export class RoundTripMismatchError extends CrossmapError {
  readonly sampleIndex: number;

  readonly path: string;

  constructor(sampleIndex: number, path: string, message: string) {
    super(`sample ${String(sampleIndex)} (${path}): ${message}`);
    this.sampleIndex = sampleIndex;
    this.path = path;
  }
}

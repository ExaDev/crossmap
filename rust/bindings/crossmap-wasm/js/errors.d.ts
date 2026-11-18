/** One reason a crosswalk document or path string failed schema or grammar parsing: a message naming the offending value. */
export interface SyntaxIssue {
  readonly message: string;
}

/** One structural defect of an otherwise syntactically valid crosswalk: which rule (two-way rules first, then one-way rules, continuing the count; negative when the defect lies between rules, not in one) and what is wrong. */
export interface CrosswalkIssue {
  readonly ruleIndex: number;
  readonly message: string;
}

/** The root of this package's error taxonomy: every error crossmap throws is a `CrossmapError`, so callers can catch the family with one check. */
export declare class CrossmapError extends Error {
  constructor(message: string);
}

/** Thrown when a crosswalk document or a path string fails its schema or grammar: the value is syntactically not a crosswalk. Carries every issue found, not just the first, so one failed parse reports the whole document. */
export declare class CrosswalkSyntaxError extends CrossmapError {
  readonly issues: readonly SyntaxIssue[];
  constructor(issues: readonly SyntaxIssue[]);
}

/** Thrown by encode and decode when validateCrosswalk finds a structural defect: the crosswalk parses but its rule list is not executable as written. Carries every issue, matching validateCrosswalk's report. */
export declare class CrosswalkStructureError extends CrossmapError {
  readonly issues: readonly CrosswalkIssue[];
  constructor(issues: readonly CrosswalkIssue[]);
}

/** Thrown when a rule cannot be applied to a concrete document: its `from` path is absent, a value has the wrong shape for the operation, or two destinations conflict. `ruleIndex` numbers two-way rules first, then one-way rules, and is negative when the failure belongs to no single rule (an output array element that no rule wrote). */
export declare class RuleApplicationError extends CrossmapError {
  readonly ruleIndex: number;
  readonly path: string;
  constructor(ruleIndex: number, path: string, message: string);
}

/** Thrown by assertRoundTrip when decode(encode(sample)) differs from the sample on a path the crosswalk promises to preserve. The path names the first differing location in the sample. */
export declare class RoundTripMismatchError extends CrossmapError {
  readonly sampleIndex: number;
  readonly path: string;
  constructor(sampleIndex: number, path: string, message: string);
}

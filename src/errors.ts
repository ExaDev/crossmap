/**
 * One reason a crosswalk document or path string failed schema or grammar parsing: a human-readable message naming the offending value. Zod's own issue objects are collapsed into these so the public error surface stays stable across Zod versions.
 */
export interface SyntaxIssue {
  readonly message: string;
}

/** The root of this package's error taxonomy: every error twindex throws is a `TwindexError`, so callers can catch the family with one check. */
export class TwindexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when a crosswalk document or a path string fails its schema or grammar: the value is syntactically not a crosswalk. Carries every issue found, not just the first, so one failed parse reports the whole document. */
export class CrosswalkSyntaxError extends TwindexError {
  readonly issues: readonly SyntaxIssue[];

  constructor(issues: readonly SyntaxIssue[]) {
    super(`crosswalk syntax error: ${issues.map((issue) => issue.message).join("; ")}`);
    this.issues = issues;
  }
}

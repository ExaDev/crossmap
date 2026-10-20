import { describe, expect, it } from "vitest";
import { CrosswalkStructureError } from "./errors";

describe("CrosswalkStructureError", () => {
  it("prefixes an issue in one rule with its index and leaves a between-rule issue unnumbered", () => {
    const error = new CrosswalkStructureError([
      { ruleIndex: 2, message: "wildcard mismatch" },
      { ruleIndex: -1, message: "two rules write the same to path: id" },
    ]);

    expect(error.message).toBe("crosswalk structure error: rule 2: wildcard mismatch; two rules write the same to path: id");
  });
});

import { describe, expect, it } from "vitest";
import type { SplitRule } from "../crosswalk";
import { splitDecode, splitEncode } from "./split";

describe("split", () => {
  const rule: SplitRule = { op: "split", from: "names", to: "nameParts", separator: "," };
  const hyphenRule: SplitRule = { ...rule, separator: "-" };

  it("splits on encode and joins on decode", () => {
    expect(splitEncode(rule, "alpha,beta")).toEqual(["alpha", "beta"]);
    expect(splitDecode(rule, ["alpha", "beta"])).toBe("alpha,beta");
  });

  it("keeps empty parts on both halves", () => {
    expect(splitEncode(rule, "")).toEqual([""]);
    expect(splitDecode(rule, [""])).toBe("");
  });

  it("throws for a non-string on encode", () => {
    expect(() => splitEncode(rule, ["a"])).toThrow(/applies to strings/);
  });

  it("throws for a non-array or non-string parts on decode", () => {
    expect(() => splitDecode(rule, "alpha")).toThrow(/arrays of strings/);
    expect(() => splitDecode(rule, ["a", 1])).toThrow(/arrays of strings/);
  });

  it("throws when a part contains the separator, so the join stays unambiguous", () => {
    expect(() => splitDecode(hyphenRule, ["a-b", "c"])).toThrow(/contains the separator/);
  });
});

import { describe, expect, it } from "vitest";
import type { CopyRule } from "../crosswalk";
import { copyDecode, copyEncode } from "./copy";

describe("copy", () => {
  const rule: CopyRule = { op: "copy", from: "id", to: ["ref", "meta.ref"] };

  it("writes one copy per to path", () => {
    expect(copyEncode(rule, { a: [1] })).toEqual([{ a: [1] }, { a: [1] }]);
  });

  it("decodes copies that agree, compared deeply", () => {
    expect(copyDecode([{ a: [1], b: null }, { b: null, a: [1] }])).toEqual({ a: [1], b: null });
  });

  it.each([
    ["scalars", ["x", "y"]],
    ["arrays of different length", [[1], [1, 1]]],
    ["records with different keys", [{ a: 1 }, { b: 1 }]],
    ["an array against a record", [[], {}]],
  ])("refuses copies that disagree: %s", (_name, values) => {
    expect(() => copyDecode(values)).toThrow(/the copies disagree/);
  });
});

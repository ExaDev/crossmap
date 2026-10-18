import { describe, expect, it } from "vitest";
import type { EnumRule } from "../crosswalk";
import { enumDecode, enumEncode } from "./enum";

describe("enum", () => {
  const rule: EnumRule = {
    op: "enum",
    from: "status",
    to: "state",
    map: { open: "OPEN", closed: "CLOSED" },
    mapBack: { OPEN: "open", CLOSED: "closed" },
  };

  it("maps through map on encode and mapBack on decode", () => {
    expect(enumEncode(rule, "open")).toBe("OPEN");
    expect(enumDecode(rule, "CLOSED")).toBe("closed");
  });

  it("throws for a non-string value", () => {
    expect(() => enumEncode(rule, 1)).toThrow(/strings/);
  });

  it("throws for an unmapped value in either direction", () => {
    expect(() => enumEncode(rule, "paused")).toThrow(/no entry in map/);
    expect(() => enumDecode(rule, "PAUSED")).toThrow(/no entry in mapBack/);
  });
});

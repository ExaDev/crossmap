import { describe, expect, it } from "vitest";
import { CrosswalkSchema, parseCrosswalk } from "./crosswalk";
import { CrosswalkSyntaxError } from "./errors";

const validCrosswalk = {
  source: "native",
  target: "shared",
  rules: [
    { op: "move", from: "a", to: "b" },
    { op: "scale", from: "cents", to: "units", factor: 0.01 },
    { op: "enum", from: "status", to: "state", map: { open: "OPEN" }, mapBack: { OPEN: "open" } },
    { op: "format", from: "when", to: "whenIso", kind: "isoDateTime" },
    { op: "split", from: "names", to: "nameParts", separator: "," },
    { op: "template", from: { given: "given", family: "family" }, to: "display", template: "{family}, {given}" },
    { op: "copy", from: "id", to: ["ref", "meta.ref"] },
  ],
  oneWay: [
    { op: "drop", from: "internal", direction: "encode" },
    { op: "default", to: "locale", value: "en-GB", direction: "encode" },
  ],
};

describe("CrosswalkSchema", () => {
  it("accepts a crosswalk using every op and narrows with the attached guard", () => {
    expect(CrosswalkSchema.is(validCrosswalk)).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(CrosswalkSchema.is([])).toBe(false);
  });

  it("rejects an unknown top-level field", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, extra: 1 })).toBe(false);
  });

  it("rejects an unknown op", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "teleport", from: "a", to: "b" }] })).toBe(false);
  });

  it("rejects an unknown rule field", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "move", from: "a", to: "b", why: "x" }] })).toBe(false);
  });

  it("rejects a malformed path", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "move", from: "a..b", to: "c" }] })).toBe(false);
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "move", from: ".a", to: "c" }] })).toBe(false);
  });

  it("rejects a zero factor", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "scale", from: "a", to: "b", factor: 0 }] })).toBe(false);
  });

  it("rejects a non-finite factor", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "scale", from: "a", to: "b", factor: Number.NaN }] })).toBe(false);
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "scale", from: "a", to: "b", factor: Number.POSITIVE_INFINITY }] })).toBe(false);
  });

  it("rejects a mapBack that does not invert map", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "enum", from: "a", to: "b", map: { open: "OPEN" }, mapBack: { OPEN: "closed" } }] })).toBe(false);
  });

  it("rejects a non-injective map", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "enum", from: "a", to: "b", map: { open: "S", closed: "S" }, mapBack: { S: "open" } }] })).toBe(false);
  });

  it("rejects a mapBack entry map never produces", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "enum", from: "a", to: "b", map: { open: "OPEN" }, mapBack: { OPEN: "open", CLOSED: "closed" } }] })).toBe(false);
  });

  it("rejects an unknown format kind", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "format", from: "a", to: "b", kind: "upperCase" }] })).toBe(false);
  });

  it.each([
    ["an unused field", { given: "g", family: "f" }, "{given}", "from field family appears in no placeholder, so encode would lose it"],
    ["an unknown placeholder", { given: "g" }, "{given} {nick}", "placeholder {nick} names no from field"],
    ["a repeated placeholder", { given: "g" }, "{given} {given}", "placeholder {given} appears twice: decode could not tell which occurrence holds the value"],
    ["adjacent placeholders", { given: "g", family: "f" }, "{given}{family}", "placeholders {given} and {family} are adjacent: with no literal between them, decode cannot tell where one ends"],
    ["no placeholder", {}, "fixed", "a template needs at least one placeholder"],
    ["a lone closing brace", { given: "g" }, "{given} }", "a lone } at position 8: write }} for a literal brace"],
  ])("rejects a template with %s", (_name, from, template, message) => {
    expect(() => parseCrosswalk({ ...validCrosswalk, rules: [{ op: "template", from, to: "t", template }] })).toThrow(message);
  });

  it("rejects a template field named __proto__ and a copy to one path", () => {
    const protoFrom: unknown = JSON.parse('{"__proto__": "a"}');
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "template", from: protoFrom, to: "t", template: "<{__proto__}>" }] })).toBe(false);
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "copy", from: "a", to: ["b"] }] })).toBe(false);
  });

  it("rejects an empty separator", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [{ op: "split", from: "a", to: "b", separator: "" }] })).toBe(false);
  });

  it("rejects a drop rule whose direction is decode", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, oneWay: [{ op: "drop", from: "a", direction: "decode" }] })).toBe(false);
  });

  it("rejects a default rule with a non-JSON value", () => {
    expect(CrosswalkSchema.is({ ...validCrosswalk, oneWay: [{ op: "default", to: "a", value: undefined, direction: "encode" }] })).toBe(false);
  });

  it("accepts a when predicate from the trilean grammar", () => {
    const rule = { op: "move", from: "a", to: "b", when: { kind: "exists", operand: { kind: "reference", key: "a" } } };
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [rule] })).toBe(true);
  });

  it("rejects a when predicate outside the trilean grammar", () => {
    const rule = { op: "move", from: "a", to: "b", when: { kind: "exists", operand: { kind: "nope" } } };
    expect(CrosswalkSchema.is({ ...validCrosswalk, rules: [rule] })).toBe(false);
  });
});

describe("parseCrosswalk", () => {
  it("parses the valid crosswalk and defaults omitted arrays", () => {
    const parsed = parseCrosswalk({ source: "a", target: "b" });
    expect(parsed.rules).toEqual([]);
    expect(parsed.oneWay).toEqual([]);
  });

  it("returns the full crosswalk", () => {
    const parsed = parseCrosswalk(validCrosswalk);
    expect(parsed.rules[0]).toEqual({ op: "move", from: "a", to: "b" });
  });

  it("throws CrosswalkSyntaxError carrying every issue", () => {
    try {
      parseCrosswalk({ source: "a", target: "b", rules: [{ op: "move", from: "a..", to: "b" }, { op: "move", from: "c", to: "d..", when: 3 }] });
      expect.unreachable("parseCrosswalk should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CrosswalkSyntaxError);
      const issues = (error as CrosswalkSyntaxError).issues;
      expect(issues.length).toBeGreaterThan(1);
    }
  });
});

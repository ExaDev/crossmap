import { describe, expect, it } from "vitest";
import { type Crosswalk, parseCrosswalk } from "./crosswalk";
import { CrosswalkStructureError, RuleApplicationError } from "./errors";
import { decode, encode } from "./executor";

const crosswalk = (doc: unknown): Crosswalk => parseCrosswalk(doc);

describe("encode", () => {
  it("moves values into a fresh output without mutating the input", () => {
    const cw = crosswalk({ source: "n", target: "s", rules: [{ op: "move", from: "a.b", to: "x.y" }], oneWay: [] });
    const doc = { a: { b: 1 } };
    expect(encode(cw, doc)).toEqual({ x: { y: 1 } });
    expect(doc).toEqual({ a: { b: 1 } });
  });

  it("is order-independent across rules", () => {
    const rules = [
      { op: "move", from: "a", to: "x" },
      { op: "move", from: "b", to: "y" },
      { op: "scale", from: "c", to: "z", factor: 2 },
    ];
    const doc = { a: 1, b: 2, c: 3 };
    const forward = encode(crosswalk({ source: "n", target: "s", rules, oneWay: [] }), doc);
    const shuffled = encode(crosswalk({ source: "n", target: "s", rules: [rules[2], rules[0], rules[1]], oneWay: [] }), doc);
    expect(shuffled).toEqual(forward);
  });

  it("throws RuleApplicationError for a missing from path", () => {
    const cw = crosswalk({ source: "n", target: "s", rules: [{ op: "move", from: "absent", to: "x" }], oneWay: [] });
    expect(() => encode(cw, {})).toThrow(RuleApplicationError);
    try {
      encode(cw, {});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuleApplicationError);
      const applied = error as RuleApplicationError;
      expect(applied.ruleIndex).toBe(0);
      expect(applied.path).toBe("absent");
    }
  });

  it("throws CrosswalkStructureError for a structurally invalid crosswalk", () => {
    const cw = crosswalk({ source: "n", target: "s", rules: [{ op: "move", from: "a", to: "x" }, { op: "move", from: "a", to: "y" }], oneWay: [] });
    expect(() => encode(cw, { a: 1 })).toThrow(CrosswalkStructureError);
  });

  it("maps wildcards index-aligned and materialises the target array", () => {
    const cw = crosswalk({
      source: "n",
      target: "s",
      rules: [
        { op: "move", from: "papers[].id", to: "nodes[].ref" },
        { op: "move", from: "papers[].title", to: "nodes[].title" },
      ],
      oneWay: [],
    });
    expect(encode(cw, { papers: [{ id: "p1", title: "T1" }, { id: "p2", title: "T2" }] })).toEqual({
      nodes: [{ ref: "p1", title: "T1" }, { ref: "p2", title: "T2" }],
    });
  });

  it("materialises an empty array for an existing empty source array", () => {
    const cw = crosswalk({ source: "n", target: "s", rules: [{ op: "move", from: "papers[].id", to: "nodes[].ref" }], oneWay: [] });
    expect(encode(cw, { papers: [] })).toEqual({ nodes: [] });
  });

  it("skips a rule whose when evaluates definite false or indeterminate", () => {
    const when = (key: string) => ({ kind: "exists", operand: { kind: "reference", key } });
    const gated = (w: unknown) => crosswalk({ source: "n", target: "s", rules: [{ op: "move", from: "a", to: "x", when: w }], oneWay: [] });
    // The output holds only what rules write: `flag` gates the rule but is not itself mapped, so it does not appear.
    expect(encode(gated(when("flag")), { flag: true, a: 1 })).toEqual({ x: 1 });
    expect(encode(gated(when("flag")), { flag: false, a: 1 })).toEqual({ x: 1 });
    expect(encode(gated({ kind: "not", operand: when("flag") }), { flag: false, a: 1 })).toEqual({});
    expect(encode(gated(when("flag")), { a: 1 })).toEqual({});
  });

  it("inserts an encode-direction default, in that direction only", () => {
    const cw = crosswalk({
      source: "n",
      target: "s",
      rules: [{ op: "move", from: "name", to: "name" }],
      oneWay: [{ op: "default", to: "locale", value: "en-GB", direction: "encode" }],
    });
    expect(encode(cw, { name: "parcel" })).toEqual({ name: "parcel", locale: "en-GB" });
    expect(decode(cw, { name: "parcel", locale: "en-GB" })).toEqual({ name: "parcel" });
  });
});

describe("decode", () => {
  it("inverts encode over the mapped paths", () => {
    const cw = crosswalk({
      source: "n",
      target: "s",
      rules: [
        { op: "move", from: "name", to: "label" },
        { op: "scale", from: "cents", to: "units", factor: 100 },
        { op: "enum", from: "status", to: "state", map: { open: "OPEN" }, mapBack: { OPEN: "open" } },
        { op: "split", from: "names", to: "nameParts", separator: ";" },
        { op: "format", from: "count", to: "countText", kind: "numberText" },
      ],
      oneWay: [],
    });
    const native = { name: "parcel", cents: 450, status: "open", names: "a;b", count: "12" };
    expect(decode(cw, encode(cw, native))).toEqual(native);
  });

  it("evaluates when against the decode input", () => {
    const cw = crosswalk({
      source: "n",
      target: "s",
      rules: [
        { op: "move", from: "kind", to: "kind" },
        { op: "move", from: "secret", to: "hidden", when: { kind: "textCompare", op: "equals", left: { kind: "reference", key: "kind" }, right: { kind: "textLiteral", value: "special" } } },
      ],
      oneWay: [],
    });
    expect(decode(cw, { kind: "special", hidden: "s" })).toEqual({ kind: "special", secret: "s" });
    expect(decode(cw, { kind: "plain", hidden: "s" })).toEqual({ kind: "plain" });
  });

  it("inserts a decode-direction default into the decode output", () => {
    const cw = crosswalk({
      source: "n",
      target: "s",
      rules: [{ op: "move", from: "name", to: "name" }],
      oneWay: [{ op: "default", to: "origin", value: "migration", direction: "decode" }],
    });
    expect(decode(cw, { name: "parcel" })).toEqual({ name: "parcel", origin: "migration" });
    expect(encode(cw, { name: "parcel" })).toEqual({ name: "parcel" });
  });

  it("throws RuleApplicationError when the decode read side is absent", () => {
    const cw = crosswalk({ source: "n", target: "s", rules: [{ op: "move", from: "a", to: "x" }], oneWay: [] });
    expect(() => decode(cw, {})).toThrow(RuleApplicationError);
  });
});

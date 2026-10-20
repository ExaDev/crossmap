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

describe("paths beyond records and one wildcard", () => {
  const roundTrip = (rules: readonly unknown[], native: unknown) => {
    const cw = crosswalk({ source: "n", target: "s", rules, oneWay: [] });
    const shared = encode(cw, native);

    return { shared, back: decode(cw, shared) };
  };

  it("nests and flattens with move rules", () => {
    const { shared, back } = roundTrip(
      [
        { op: "move", from: "street", to: "address.street" },
        { op: "move", from: "meta.owner.name", to: "ownerName" },
      ],
      { street: "High St", meta: { owner: { name: "Ann" } } },
    );
    expect(shared).toEqual({ address: { street: "High St" }, ownerName: "Ann" });
    expect(back).toEqual({ street: "High St", meta: { owner: { name: "Ann" } } });
  });

  it("maps an array of arrays index-aligned at both levels", () => {
    const native = { grid: [[1, 2], [], [1]] };
    const { shared, back } = roundTrip([{ op: "scale", from: "grid[][]", to: "cells[][]", factor: 2 }], native);
    expect(shared).toEqual({ cells: [[2, 2 * 2], [], [2]] });
    expect(back).toEqual(native);
  });

  it("keeps an inner empty array, trailing or not, so the outer array keeps its length", () => {
    const native = { p: [{ t: [] }, { t: ["x"] }, { t: [] }] };
    const { shared, back } = roundTrip([{ op: "move", from: "p[].t[]", to: "n[].l[]" }], native);
    expect(shared).toEqual({ n: [{ l: [] }, { l: ["x"] }, { l: [] }] });
    expect(back).toEqual(native);
  });

  it("treats a key spelled as a digit as a record key", () => {
    const { shared, back } = roundTrip([{ op: "move", from: "x.y", to: "a.0" }], { x: { y: "v" } });
    expect(shared).toEqual({ a: { "0": "v" } });
    expect(back).toEqual({ x: { y: "v" } });
  });

  it("reads and writes keys that need quoting", () => {
    const native = { "dc:title": "Maps", "a.b": { "[x]": 1 } };
    const { shared, back } = roundTrip(
      [
        { op: "move", from: '["dc:title"]', to: "title" },
        { op: "move", from: '["a.b"]["[x]"]', to: '["c d"]' },
      ],
      native,
    );
    expect(shared).toEqual({ title: "Maps", "c d": 1 });
    expect(back).toEqual(native);
  });

  it("maps fixed positions of a tuple", () => {
    const { shared, back } = roundTrip(
      [
        { op: "move", from: "point[0]", to: "lat" },
        { op: "move", from: "point[1]", to: "lon" },
      ],
      { point: ["52.2N", "0.1E"] },
    );
    expect(shared).toEqual({ lat: "52.2N", lon: "0.1E" });
    expect(back).toEqual({ point: ["52.2N", "0.1E"] });
  });

  it("maps a fixed index under a wildcard", () => {
    const native = { rows: [["a", 1], ["b", 2]] };
    const { shared, back } = roundTrip(
      [
        { op: "move", from: "rows[][0]", to: "items[].name" },
        { op: "move", from: "rows[][1]", to: "items[].count" },
      ],
      native,
    );
    expect(shared).toEqual({ items: [{ name: "a", count: 1 }, { name: "b", count: 2 }] });
    expect(back).toEqual(native);
  });

  it("throws RuleApplicationError when the array is shorter than a fixed index", () => {
    const cw = crosswalk({ source: "n", target: "s", rules: [{ op: "move", from: "point[1]", to: "lon" }], oneWay: [] });
    expect(() => encode(cw, { point: [1] })).toThrow(RuleApplicationError);
  });

  it("throws RuleApplicationError naming the gap when no rule writes an earlier element", () => {
    const cw = crosswalk({ source: "n", target: "s", rules: [{ op: "move", from: "lon", to: "point[1]" }], oneWay: [] });
    expect(() => encode(cw, { lon: 1 })).toThrow("point[0]: no rule wrote this array element, so the array would have a gap");
    try {
      encode(cw, { lon: 1 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuleApplicationError);
      expect(error instanceof RuleApplicationError ? error.ruleIndex : undefined).toBe(-1);
    }
  });

  it("throws for two rules claiming one location whichever comes first", () => {
    const whole = { op: "move", from: "a", to: "x" };
    const part = { op: "move", from: "b", to: "x.y" };
    for (const rules of [[whole, part], [part, whole]]) {
      const cw = crosswalk({ source: "n", target: "s", rules, oneWay: [] });
      expect(() => encode(cw, { a: { z: 1 }, b: 2 })).toThrow(RuleApplicationError);
    }
  });
});

describe("per-element when", () => {
  const isCircle = { kind: "textCompare", op: "equals", left: { kind: "reference", key: "items[].kind" }, right: { kind: "textLiteral", value: "circle" } };
  const shapes = crosswalk({
    source: "n",
    target: "s",
    rules: [
      { op: "move", from: "items[].kind", to: "shapes[].kind" },
      { op: "move", from: "items[].radius", to: "shapes[].r", when: isCircle },
    ],
    oneWay: [],
  });
  const native = { items: [{ kind: "circle", radius: 2 }, { kind: "square" }, { kind: "circle", radius: 1 }] };

  it("applies a rule only to the elements whose own field passes, skipping elements that lack the path", () => {
    expect(encode(shapes, native)).toEqual({ shapes: [{ kind: "circle", r: 2 }, { kind: "square" }, { kind: "circle", r: 1 }] });
  });

  it("rebases the reference onto the target array while decoding", () => {
    expect(decode(shapes, encode(shapes, native))).toEqual(native);
  });

  it("gates an inner wildcard on a field of the outer element", () => {
    const priced = { kind: "exists", operand: { kind: "reference", key: "orders[].currency" } };
    const cw = crosswalk({
      source: "n",
      target: "s",
      rules: [
        { op: "move", from: "orders[].id", to: "sales[].id" },
        { op: "move", from: "orders[].currency", to: "sales[].currency", when: priced },
        { op: "scale", from: "orders[].lines[].pence", to: "sales[].lines[].pounds", factor: 100, when: priced },
      ],
      oneWay: [],
    });
    const orders = { orders: [{ id: "a", currency: "GBP", lines: [{ pence: 1 }] }, { id: "b" }] };
    const shared = encode(cw, orders);
    expect(shared).toEqual({ sales: [{ id: "a", currency: "GBP", lines: [{ pounds: 100 }] }, { id: "b" }] });
    expect(decode(cw, shared)).toEqual(orders);
  });

  it("binds a collection reference to the visited element", () => {
    const anyHeavy = { kind: "some", collection: "boxes[].parts", item: { kind: "compare", op: "gt", left: { kind: "reference", key: "kg" }, right: { kind: "numberLiteral", value: 1 } } };
    const cw = crosswalk({
      source: "n",
      target: "s",
      rules: [
        { op: "move", from: "boxes[].parts", to: "crates[].parts" },
        { op: "move", from: "boxes[].label", to: "crates[].warning", when: anyHeavy },
      ],
      oneWay: [],
    });
    const boxes = { boxes: [{ parts: [{ kg: 2 }], label: "heavy" }, { parts: [{ kg: 1 }], label: "light" }] };
    expect(encode(cw, boxes)).toEqual({ crates: [{ parts: [{ kg: 2 }], warning: "heavy" }, { parts: [{ kg: 1 }] }] });
  });

  it("throws naming the gap when a gated rule is the only writer of an element", () => {
    const cw = crosswalk({ source: "n", target: "s", rules: [{ op: "move", from: "items[].radius", to: "radii[]", when: isCircle }], oneWay: [] });
    expect(() => encode(cw, { items: [{ kind: "square" }, { kind: "circle", radius: 1 }] })).toThrow("radii[0]: no rule wrote this array element");
  });

});

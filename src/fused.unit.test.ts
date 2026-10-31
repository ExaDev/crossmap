import { describe, expect, it } from "vitest";
import { parseCrosswalk } from "./crosswalk";
import { fusedPlan, runFused } from "./fused";

const rules = (list: readonly object[]) => parseCrosswalk({ source: "n", target: "s", rules: list }).rules;

describe("fusedPlan", () => {
  it("fuses keyed single-path rules, grouping the rules of one array into one walk", () => {
    const plan = fusedPlan(
      rules([
        { op: "move", from: "meta", to: "meta" },
        { op: "move", from: "nodes[].id", to: "nodes[].id" },
        { op: "scale", from: "nodes[].w", to: "nodes[].attributes.weight", factor: 2 },
        { op: "move", from: "edges[].source", to: "links[].from" },
      ]),
      "encode",
    );
    expect(plan?.items.map((item) => (item.kind === "group" ? { array: item.arrayWrite, fields: item.fields.map((field) => field.write) } : item.write))).toEqual([
      ["meta"],
      { array: ["nodes"], fields: [["id"], ["attributes", "weight"]] },
      { array: ["links"], fields: [["from"]] },
    ]);
  });

  it.each([
    ["a rule with several paths on a side", [{ op: "copy", from: "a", to: ["b", "c"] }]],
    ["a fixed index", [{ op: "move", from: "rows[0].a", to: "first" }]],
    ["two wildcards", [{ op: "move", from: "rows[].cells[]", to: "grid[].cells[]" }]],
    ["a gate per element", [{ op: "move", from: "rows[].a", to: "out[].a", when: { kind: "textCompare", op: "equals", left: { kind: "reference", key: "rows[].k" }, right: { kind: "textLiteral", value: "x" } } }]],
    [
      "a write path running through another",
      [
        { op: "move", from: "a", to: "x" },
        { op: "move", from: "b", to: "x.y" },
      ],
    ],
    [
      "a location both iterated and written into by key",
      [
        { op: "move", from: "rows[].a", to: "x[].a" },
        { op: "move", from: "b", to: "x.b" },
      ],
    ],
  ])("leaves %s to the general executor", (_name, list) => {
    expect(fusedPlan(rules(list), "encode")).toBeUndefined();
  });

  it("leaves to the general executor two source arrays feeding one output array, which only decode can meet", () => {
    const list = rules([
      { op: "move", from: "rows[].a", to: "left[].a" },
      { op: "move", from: "rows[].b", to: "right[].b" },
    ]);
    expect(fusedPlan(list, "encode")).toBeDefined();
    expect(fusedPlan(list, "decode")).toBeUndefined();
  });
});

describe("runFused", () => {
  const plan = fusedPlan(
    rules([
      { op: "move", from: "meta", to: "meta" },
      { op: "move", from: "nodes[].id", to: "items[].id" },
      { op: "move", from: "nodes[].text", to: "items[].label.text" },
    ]),
    "encode",
  );
  if (plan === undefined) {
    throw new Error("the plan under test should fuse");
  }

  it("walks each array once into one output element per element, sharing a record moved whole", () => {
    const meta = { name: "g" };
    const output = runFused(plan, { meta, nodes: [{ id: "a", text: "x" }, { id: "b", text: "y" }] });
    expect(output).toEqual({ meta, items: [{ id: "a", label: { text: "x" } }, { id: "b", label: { text: "y" } }] });
    expect(output?.["meta"]).toBe(meta);
  });

  /** An array whose first element is a hole. */
  const holed = (...after: readonly unknown[]): unknown[] => {
    const array: unknown[] = [];
    array[1] = undefined;
    array.splice(1, 1, ...after);

    return array;
  };

  it("gives way on an absent path, a hole or a value of the wrong shape", () => {
    expect(runFused(plan, { meta: {}, nodes: [{ id: "a" }] })).toBeUndefined();
    expect(runFused(plan, { meta: {}, nodes: holed({ id: "a", text: "x" }) })).toBeUndefined();
    expect(runFused(plan, { meta: {}, nodes: { id: "a", text: "x" } })).toBeUndefined();
  });

  it("gives way on a value it would store that is not exact JSON, which the general executor reports or rewrites", () => {
    expect(runFused(plan, { meta: { list: holed(2) }, nodes: [] })).toBeUndefined();
    expect(runFused(plan, { meta: Number.NaN, nodes: [] })).toBeUndefined();
    expect(runFused(plan, { meta: {}, nodes: [{ id: undefined, text: "x" }] })).toBeUndefined();
    const bare: unknown = Object.create(null);
    expect(runFused(plan, { meta: bare, nodes: [] })).toBeUndefined();
    expect(runFused(plan, { meta: { list: [1, 2] }, nodes: [] })).toEqual({ meta: { list: [1, 2] }, items: [] });
  });
});

import { describe, expect, it } from "vitest";
import type { AggregateFunction, AggregateRule } from "../crosswalk";
import { aggregateWrites, combine } from "./aggregate";

/** Named figures, so the cases assert against names rather than bare literals. */
const figures = { small: 2, large: 7, total: 9, negative: -3, three: 3 };

const cases: readonly (readonly [AggregateFunction, readonly unknown[], number])[] = [
    ["count", [figures.small, "x", null], figures.three],
    ["sum", [figures.small, figures.large], figures.total],
    ["min", [figures.large, figures.negative, figures.small], figures.negative],
    ["max", [figures.small, figures.large], figures.large],
    ["count", [], 0],
    ["sum", [], 0],
];
const emptyless: readonly AggregateFunction[] = ["min", "max"];

describe("combine", () => {
  it.each(cases)("%s of %j is %j", (fn, values, expected) => {
    expect(combine(fn, values)).toBe(expected);
  });

  it.each(emptyless)("%s of no values throws", (fn) => {
    expect(() => combine(fn, [])).toThrow(/has no answer/);
  });

  it("refuses a value that is not a finite number", () => {
    expect(() => combine("sum", [1, "2"])).toThrow(/finite numbers/);
    expect(() => combine("max", [Number.NaN])).toThrow(/finite numbers/);
  });

  it("refuses a sum that overflows", () => {
    expect(() => combine("sum", [Number.MAX_VALUE, Number.MAX_VALUE])).toThrow(/overflows/);
  });
});

describe("aggregateWrites", () => {
  it("writes one total for the whole array", () => {
    const rule: AggregateRule = { op: "aggregate", fn: "count", from: "items[]", to: "itemCount", direction: "encode" };
    expect(aggregateWrites(rule, { items: ["a", "b"] })).toEqual([{ trail: [{ kind: "key", key: "itemCount" }], value: 2 }]);
  });

  it("writes one total per outer element, including elements whose inner array is empty", () => {
    const rule: AggregateRule = { op: "aggregate", fn: "sum", from: "orders[].lines[].qty", to: "sales[].units", direction: "encode" };
    const doc = { orders: [{ lines: [{ qty: figures.small }, { qty: figures.large }] }, { lines: [] }] };
    expect(aggregateWrites(rule, doc).map((write) => write.value)).toEqual([figures.total, 0]);
  });

  it("throws when the path is absent", () => {
    const rule: AggregateRule = { op: "aggregate", fn: "count", from: "items[]", to: "n", direction: "encode" };
    expect(() => aggregateWrites(rule, {})).toThrow(/absent/);
  });
});

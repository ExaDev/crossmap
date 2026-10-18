import { describe, expect, it } from "vitest";
import type { ComparisonOperator, ExpressionNode, PredicateNode } from "trilean";
import { evaluateWhen } from "./when";

/** Named so every figure the cases assert against is a name rather than a bare literal. */
const data = {
  bigQuantity: 5,
  smallQuantity: 1,
  largeOrder: 10,
  tinyOrder: 3,
  secondTiny: 2,
  halfDozen: 9,
};

const ref = (key: string): ExpressionNode => ({ kind: "reference", key });
const num = (value: number): ExpressionNode => ({ kind: "numberLiteral", value });
const gt = (left: ExpressionNode, right: ExpressionNode, op: ComparisonOperator = "gt"): PredicateNode => ({ kind: "compare", op, left, right });
const quantityAbove = (threshold: number): PredicateNode => gt(ref("qty"), num(threshold));
const someLineAbove = (threshold: number): PredicateNode => ({ kind: "some", collection: "lines", item: gt(ref("qty"), num(threshold)) });

describe("evaluateWhen", () => {
  it("applies on a definite true comparison", () => {
    expect(evaluateWhen(quantityAbove(data.bigQuantity), { qty: data.largeOrder })).toBe(true);
  });

  it("skips on a definite false comparison", () => {
    expect(evaluateWhen(quantityAbove(data.bigQuantity), { qty: data.tinyOrder })).toBe(false);
  });

  it("skips on an indeterminate comparison over a missing reference", () => {
    expect(evaluateWhen(quantityAbove(data.bigQuantity), {})).toBe(false);
  });

  it("skips on an indeterminate comparison over a non-scalar reference", () => {
    expect(evaluateWhen(quantityAbove(data.bigQuantity), { meta: { a: 1 } })).toBe(false);
    expect(evaluateWhen(quantityAbove(data.bigQuantity), { tags: [1] })).toBe(false);
  });

  it("reads nested wildcard-free paths", () => {
    expect(evaluateWhen(quantityAbove(data.bigQuantity), { order: { header: { total: data.largeOrder } } })).toBe(false);
    expect(evaluateWhen(gt(ref("order.header.total"), num(data.bigQuantity)), { order: { header: { total: data.largeOrder } } })).toBe(true);
  });

  it("skips when a not-value meets not-known logic", () => {
    const predicate: PredicateNode = { kind: "not", operand: quantityAbove(data.bigQuantity) };
    expect(evaluateWhen(predicate, {})).toBe(false);
  });

  it("evaluates a some over a path-resolved collection with item field references", () => {
    const predicate = someLineAbove(data.bigQuantity);
    expect(evaluateWhen(predicate, { lines: [{ qty: data.smallQuantity }, { qty: data.halfDozen }] })).toBe(true);
    expect(evaluateWhen(predicate, { lines: [{ qty: data.smallQuantity }, { qty: data.secondTiny }] })).toBe(false);
  });

  it("throws for a some over a missing collection", () => {
    expect(() => evaluateWhen(someLineAbove(data.bigQuantity), {})).toThrow(/resolved to nothing/);
  });

  it("throws for a collection with a non-record element", () => {
    expect(() => evaluateWhen(someLineAbove(data.bigQuantity), { lines: [data.halfDozen] })).toThrow(/non-record element/);
  });

  it("throws for a lookup node, which v1 does not support", () => {
    const predicate = gt({ kind: "lookup", table: "codes", keys: [ref("code")] }, num(data.bigQuantity));
    expect(() => evaluateWhen(predicate, { code: "a" })).toThrow(/lookup tables are not supported/);
  });
});

import fc from "fast-check";
import { JsonValueSchema } from "trilean";
import { describe, expect, it } from "vitest";
import { isExactJson } from "./exact-json";

/** Requires that a value the check accepts is one the schema parses into a strictly equal copy, which is what lets the executor return it without the copy. */
function acceptedMeansParsedUnchanged(value: unknown): void {
  if (isExactJson(value)) {
    expect(JsonValueSchema.parse(value)).toStrictEqual(value);
  }
}

/** A number with a fractional part. */
const FRACTIONAL = 1.5;

describe("isExactJson", () => {
  it("accepts JSON scalars, arrays and plain records", () => {
    for (const value of ["", "x", 0, -0, FRACTIONAL, true, false, null, [], [1, "a", null], {}, { a: { b: [1, { c: "d" }] } }]) {
      expect(isExactJson(value)).toBe(true);
    }
  });

  it("refuses what the schema refuses: non-finite numbers, undefined, bigints, symbols, functions and class instances", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, BigInt(1), Symbol("s"), () => 0, new Date(0), new Map(), [undefined], { a: undefined }, { [Symbol("k")]: 1 }]) {
      expect(isExactJson(value)).toBe(false);
      expect(JsonValueSchema.safeParse(value).success).toBe(false);
    }
  });

  it("refuses what the schema accepts only by rewriting it, so the caller parses it instead", () => {
    const holed: unknown[] = [];
    holed[1] = 1;
    const bare: unknown = Object.create(null);
    const hidden = Object.defineProperty({ a: 1 }, "b", { value: 2, enumerable: false });
    const named = Object.defineProperty([1], "extra", { value: true, enumerable: true });
    const proto: unknown = JSON.parse('{"__proto__":{"a":1},"b":2}');
    /** An array of a subclass, which the schema copies into an ordinary array. */
    class Rows extends Array<number> {}
    const rows = Rows.from([1]);
    for (const value of [holed, bare, hidden, named, proto, rows]) {
      expect(isExactJson(value)).toBe(false);
    }
  });

  it("accepts a value only when the schema parses it into a strictly equal copy, over generated values of every kind", () => {
    fc.assert(fc.property(fc.oneof(fc.jsonValue(), fc.anything({ withBigInt: true, withBoxedValues: true, withDate: true, withMap: true, withSet: true, withNullPrototype: true, withObjectString: true, withSparseArray: true, withTypedArray: true, withUnicodeString: true })), acceptedMeansParsedUnchanged));
  });
});

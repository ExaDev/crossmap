import { describe, expect, it } from "vitest";
import type { ScaleRule } from "../crosswalk";
import { scaleDecode, scaleEncode } from "./scale";

/** Named so every figure the cases assert against is a name rather than a bare literal. */
const data = {
  gramsPerKilogram: 100,
  parcelGrams: 199,
  parcelKilograms: 19900,
  none: 0,
  belowZero: -42,
  overflowFactor: 1e308,
};

describe("scale", () => {
  const rule: ScaleRule = { op: "scale", from: "grams", to: "kilograms", factor: data.gramsPerKilogram };

  it("multiplies on encode and divides on decode", () => {
    expect(scaleEncode(rule, data.parcelGrams)).toBe(data.parcelKilograms);
    expect(scaleDecode(rule, data.parcelKilograms)).toBe(data.parcelGrams);
  });

  it("is exact for zero and negative values under an integer factor", () => {
    expect(scaleEncode(rule, data.none)).toBe(data.none);
    expect(scaleDecode(rule, data.none)).toBe(data.none);
    expect(scaleEncode(rule, data.belowZero)).toBe(data.belowZero * data.gramsPerKilogram);
  });

  it("throws for a non-number value in either direction", () => {
    expect(() => scaleEncode(rule, "12")).toThrow(/finite numbers/);
    expect(() => scaleDecode(rule, null)).toThrow(/finite numbers/);
  });

  it("throws for a non-finite result", () => {
    expect(() => scaleEncode({ ...rule, factor: data.overflowFactor }, data.overflowFactor)).toThrow(/overflows/);
  });
});

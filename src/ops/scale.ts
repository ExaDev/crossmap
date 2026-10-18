import type { ScaleRule } from "../crosswalk";

/**
 * `scale`: multiplies by `factor` while encoding and divides by it while decoding. `factor` is a finite non-zero number by schema, so decode never divides by zero.
 * @param factor - The operation's factor applied in the given direction.
 * @param direction - Multiplies encoding, divides decoding: the divide is a true division, never a multiplication by the reciprocal (1 / factor is itself rounded, so the two routes disagree in the last bit for factors like 0.01, and the division is the accurate one).
 * @param value - The value to scale.
 * @returns The scaled number.
 * @throws Error when the value is not a finite number or the result is not finite (an overflowing result has no JSON representation and no inverse).
 */
function scaleBy(factor: number, direction: "encode" | "decode", value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`scale applies to finite numbers, found: ${JSON.stringify(value)}`);
  }
  const scaled = direction === "encode" ? value * factor : value / factor;
  if (!Number.isFinite(scaled)) {
    throw new Error(`scaling by the rule's factor overflows to a non-finite value: ${String(value)} against factor ${String(factor)}`);
  }

  return scaled;
}

/** The encode half: `value * factor`. Multiply-then-divide is bit-identical for integer and power-of-two factors; arbitrary decimal factors may lose the last bit (documented in the README's round-trip caveats). */
export function scaleEncode(rule: ScaleRule, value: unknown): number {
  return scaleBy(rule.factor, "encode", value);
}

/** The decode half: `value / factor`. */
export function scaleDecode(rule: ScaleRule, value: unknown): number {
  return scaleBy(rule.factor, "decode", value);
}

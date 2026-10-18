import type { MoveRule } from "../crosswalk";

/**
 * `move`: carries a value across unchanged in both directions. The self-inverse op: encode and decode apply the identity to the value, and the executor's path swap does the rest.
 * @param _rule - The rule (unused: move has no parameters beyond its paths).
 * @param value - The value read at `from` (encode) or `to` (decode).
 * @returns The same value, any JSON value being movable.
 */
export function moveValue(_rule: MoveRule, value: unknown): unknown {
  return value;
}

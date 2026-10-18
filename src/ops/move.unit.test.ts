import { describe, expect, it } from "vitest";
import type { MoveRule } from "../crosswalk";
import { moveValue } from "./move";

describe("moveValue", () => {
  const rule: MoveRule = { op: "move", from: "a", to: "b" };

  it("carries any JSON value across unchanged", () => {
    for (const value of [1, "x", null, true, { deep: [1] }, [1, 2]]) {
      expect(moveValue(rule, value)).toBe(value);
    }
  });
});

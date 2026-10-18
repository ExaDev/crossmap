import { describe, expect, it } from "vitest";
import { CORPUS, REQUIRED_ROWS } from "./corpus";
import { type Crosswalk, parseCrosswalk } from "./crosswalk";
import { CrosswalkStructureError, RoundTripMismatchError } from "./errors";
import { assertRoundTrip } from "./roundtrip";

describe("assertRoundTrip", () => {
  it("has one corpus cell per required op-table row", () => {
    const names = CORPUS.map((cell) => cell.name);
    for (const row of REQUIRED_ROWS) {
      expect(names).toContain(row);
    }
    expect(names).toHaveLength(REQUIRED_ROWS.length);
  });

  it("every corpus cell round-trips over every sample", () => {
    for (const cell of CORPUS) {
      assertRoundTrip(cell.crosswalk, cell.samples);
    }
  });

  it("throws RoundTripMismatchError for a broken correspondence", () => {
    const cw: Crosswalk = parseCrosswalk({ source: "n", target: "s", rules: [{ op: "scale", from: "v", to: "w", factor: 3 }], oneWay: [] });
    // 0.1 * 3 / 3 !== 0.1 under float multiply-then-divide: the documented non-integer-factor caveat, asserted here as the failure it is.
    expect(() => { assertRoundTrip(cw, [{ v: 0.1 }]); }).toThrow(RoundTripMismatchError);
  });

  it("throws CrosswalkStructureError without running any sample", () => {
    const cw: Crosswalk = parseCrosswalk({ source: "n", target: "s", rules: [{ op: "move", from: "a", to: "x" }, { op: "move", from: "a", to: "y" }], oneWay: [] });
    expect(() => { assertRoundTrip(cw, []); }).toThrow(CrosswalkStructureError);
  });

  it("excludes a dropped path and a decode-default path from the comparison", () => {
    const cw: Crosswalk = parseCrosswalk({
      source: "n",
      target: "s",
      rules: [{ op: "move", from: "kept", to: "kept" }],
      oneWay: [
        { op: "drop", from: "internal", direction: "encode" },
        { op: "default", to: "origin", value: "migration", direction: "decode" },
      ],
    });
    expect(() => { assertRoundTrip(cw, [{ kept: 1, internal: "secret" }]); }).not.toThrow();
  });
});

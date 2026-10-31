import { describe, expect, it, vi } from "vitest";
import { parseCrosswalk } from "./crosswalk";
import { CrosswalkStructureError } from "./errors";
import { compileCrosswalk, decode, encode } from "./executor";
import { assertRoundTrip } from "./roundtrip";
import { validateCrosswalk } from "./validate";

vi.mock(import("./validate"), async (original) => {
  const actual = await original();

  return { ...actual, validateCrosswalk: vi.fn(actual.validateCrosswalk) };
});

/** How many encode and decode calls each test makes over one crosswalk object, any number above one showing whether validation repeats. */
const CALLS = 3;

const crosswalk = () => parseCrosswalk({ source: "n", target: "s", rules: [{ op: "move", from: "rows[].a", to: "items[].b" }] });

describe("compileCrosswalk", () => {
  it("encodes and decodes as encode and decode do", () => {
    const cw = crosswalk();
    const compiled = compileCrosswalk(cw);
    const doc = { rows: [{ a: 1 }, { a: 2 }] };
    expect(compiled.encode(doc)).toEqual(encode(cw, doc));
    expect(compiled.decode({ items: [{ b: 1 }] })).toEqual(decode(cw, { items: [{ b: 1 }] }));
    expect(compiled.crosswalk).toBe(cw);
  });

  it("returns the one compiled form for one crosswalk object", () => {
    const cw = crosswalk();
    expect(compileCrosswalk(cw)).toBe(compileCrosswalk(cw));
    expect(compileCrosswalk(crosswalk())).not.toBe(compileCrosswalk(cw));
  });

  it("validates a crosswalk once however many times it is run, through any entry point", () => {
    const cw = crosswalk();
    vi.mocked(validateCrosswalk).mockClear();
    for (let call = 0; call < CALLS; call += 1) {
      encode(cw, { rows: [{ a: call }] });
      decode(cw, { items: [{ b: call }] });
      compileCrosswalk(cw).encode({ rows: [] });
    }
    assertRoundTrip(cw, [{ rows: [{ a: 1 }] }]);
    expect(validateCrosswalk).toHaveBeenCalledTimes(1);
  });

  it("throws CrosswalkStructureError for a structurally invalid crosswalk, on every attempt", () => {
    const invalid = parseCrosswalk({
      source: "n",
      target: "s",
      rules: [
        { op: "move", from: "a", to: "x" },
        { op: "move", from: "b", to: "x" },
      ],
    });
    for (let call = 0; call < CALLS; call += 1) {
      expect(() => compileCrosswalk(invalid)).toThrow(CrosswalkStructureError);
      expect(() => encode(invalid, { a: 1, b: 2 })).toThrow(CrosswalkStructureError);
    }
  });
});

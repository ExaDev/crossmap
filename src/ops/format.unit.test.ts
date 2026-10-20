import { describe, expect, it } from "vitest";
import type { FormatRule } from "../crosswalk";
import { formatDecode, formatEncode } from "./format";

/** Named so every figure the cases assert against is a name rather than a bare literal. */
const data = {
  octoberDateOnly: "2026-10-18",
  octoberInstant: "2026-10-18T10:15:00.000Z",
  offsetForm: "2026-10-18T10:15:00+01:00",
  wholeCount: "1234",
  wholeNumber: 1234,
  decimalCount: "-7.5",
  decimalNumber: -7.5,
};

/**
 * The epoch milliseconds an ISO string denotes, per the same ECMA-262 date-time-string conversion the operation under test performs. The ISO strings above are the authoritative fixtures: what the cases really pin down is that each string converts to one number and that number renders back as the canonical form.
 */
const epochOf = (iso: string): number => new Date(iso).getTime();

describe("format isoDateTime", () => {
  const rule: FormatRule = { op: "format", from: "at", to: "atMs", kind: "isoDateTime" };

  it("parses an ISO timestamp to epoch milliseconds and renders it back", () => {
    expect(formatEncode(rule, data.octoberInstant)).toBe(epochOf(data.octoberInstant));
    expect(formatDecode(rule, epochOf(data.octoberInstant))).toBe(data.octoberInstant);
  });

  it("accepts a date-only and an offset form on encode", () => {
    expect(formatEncode(rule, data.octoberDateOnly)).toBe(epochOf(data.octoberDateOnly));
    expect(formatEncode(rule, data.offsetForm)).toBe(epochOf(data.offsetForm));
  });

  it("throws for a non-ISO string on encode", () => {
    expect(() => formatEncode(rule, "18/10/2026")).toThrow(/not an ISO-8601/);
    expect(() => formatEncode(rule, "next Tuesday")).toThrow(/not an ISO-8601/);
  });

  it("throws for a well-shaped but nonexistent instant", () => {
    expect(() => formatEncode(rule, "2026-02-30")).toThrow(/nonexistent/);
  });

  it("throws for a non-string on encode and a non-number on decode", () => {
    expect(() => formatEncode(rule, 0)).toThrow(/applies to strings/);
    expect(() => formatDecode(rule, "0")).toThrow(/finite numbers/);
  });
});

describe("format numberText", () => {
  const rule: FormatRule = { op: "format", from: "n", to: "nText", kind: "numberText" };

  it("parses decimal text to a number and renders it back", () => {
    expect(formatEncode(rule, data.wholeCount)).toBe(data.wholeNumber);
    expect(formatDecode(rule, data.wholeNumber)).toBe(data.wholeCount);
    expect(formatEncode(rule, data.decimalCount)).toBe(data.decimalNumber);
    expect(formatDecode(rule, data.decimalNumber)).toBe(data.decimalCount);
  });

  it("throws for non-decimal text", () => {
    expect(() => formatEncode(rule, "12x")).toThrow(/decimal number/);
    expect(() => formatEncode(rule, "")).toThrow(/decimal number/);
  });
});

describe("format isoDate", () => {
  const rule: FormatRule = { op: "format", from: "on", to: "onMs", kind: "isoDate" };

  it("parses a calendar date to its UTC midnight and renders the date back", () => {
    expect(formatEncode(rule, data.octoberDateOnly)).toBe(epochOf(data.octoberDateOnly));
    expect(formatDecode(rule, epochOf(data.octoberDateOnly))).toBe(data.octoberDateOnly);
  });

  it.each(["2026-10-18T10:15:00Z", "2026-02-30", "18/10/2026", "2026-1-8"])("refuses %s on encode", (text) => {
    expect(() => formatEncode(rule, text)).toThrow(Error);
  });

  it("refuses an instant that is not a UTC midnight on decode", () => {
    expect(() => formatDecode(rule, epochOf(data.octoberInstant))).toThrow(/UTC midnight/);
  });
});

describe("format booleanText", () => {
  const rule: FormatRule = { op: "format", from: "flag", to: "isSet", kind: "booleanText" };

  it("converts both spellings and refuses others", () => {
    expect(formatEncode(rule, "true")).toBe(true);
    expect(formatEncode(rule, "false")).toBe(false);
    expect(formatDecode(rule, true)).toBe("true");
    expect(formatDecode(rule, false)).toBe("false");
    expect(() => formatEncode(rule, "True")).toThrow(Error);
    expect(() => formatEncode(rule, "1")).toThrow(Error);
    expect(() => formatDecode(rule, "true")).toThrow(Error);
  });
});

describe("format jsonText", () => {
  const rule: FormatRule = { op: "format", from: "raw", to: "value", kind: "jsonText" };

  it("parses JSON text and renders it back canonically", () => {
    const text = '{"a":[1,null,"x"],"b":{"c":true}}';
    expect(formatEncode(rule, text)).toEqual({ a: [1, null, "x"], b: { c: true } });
    expect(formatDecode(rule, formatEncode(rule, text))).toBe(text);
  });

  it("refuses text that is not JSON, and JSON holding a __proto__ key anywhere", () => {
    expect(() => formatEncode(rule, "{a:1}")).toThrow(/not JSON text/);
    expect(() => formatEncode(rule, '{"x":[{"__proto__":1}]}')).toThrow(/__proto__/);
  });

  it("refuses a decode value JSON cannot express", () => {
    expect(() => formatDecode(rule, undefined)).toThrow(/JSON cannot express/);
  });
});

import { describe, expect, it } from "vitest";
import { CrosswalkSyntaxError } from "./errors";
import { bindLocus, canonicalPath, findHole, formatPath, type PathStep, parsePath, parsePathMemo, readLocus, type Trail, type TrailStep, wildcardIndexes, writeMatches } from "./paths";

const key = (name: string): TrailStep => ({ kind: "key", key: name });
const at = (index: number): TrailStep => ({ kind: "index", index });
const wildcard: PathStep = { kind: "wildcard" };

/** Named figures, so the cases assert against names rather than bare literals. */
const figures = { multiDigitIndex: 12, largestIndex: 999_999_999, laterIndex: 5 };

describe("parsePath", () => {
  it.each([
    ["a", [key("a")]],
    ["a.b", [key("a"), key("b")]],
    ["a[]", [key("a"), wildcard]],
    ["a[].b", [key("a"), wildcard, key("b")]],
    ["a[].b[].c", [key("a"), wildcard, key("b"), wildcard, key("c")]],
    ["grid[][]", [key("grid"), wildcard, wildcard]],
    ["a[0]", [key("a"), at(0)]],
    ["a[12].b", [key("a"), at(figures.multiDigitIndex), key("b")]],
    ["a[][0][]", [key("a"), wildcard, at(0), wildcard]],
    ["a.0", [key("a"), key("0")]],
    ["snake_case-key.digits123", [key("snake_case-key"), key("digits123")]],
    ['["a.b"]', [key("a.b")]],
    ['a["x y"].b', [key("a"), key("x y"), key("b")]],
    ['a["[]"]', [key("a"), key("[]")]],
    [String.raw`["say \"hi\""]`, [key('say "hi"')]],
    [String.raw`["back\\slash"]`, [key(String.raw`back\slash`)]],
    ['[""]', [key("")]],
    ['["__proto__x"]', [key("__proto__x")]],
    ["__proto__x", [key("__proto__x")]],
    ["a[999999999]", [key("a"), at(figures.largestIndex)]],
  ])("parses %s", (path, expected) => {
    expect(parsePath(path)).toEqual(expected);
  });

  it.each([
    "",
    ".a",
    "a.",
    "a..b",
    "[]",
    "[0]",
    "a[].[]",
    "a.[0]",
    "a b",
    "a.b-c.d e",
    "a[",
    "a[01]",
    "a[-1]",
    "a[1234567890]",
    "ä",
    "__proto__",
    "a.__proto__",
    '["__proto__"]',
    'a["__proto__"]',
    'a["unterminated',
    'a["x"',
    String.raw`a["bad\escape"]`,
    'a["x""]',
  ])("rejects %s", (path) => {
    expect(() => parsePath(path)).toThrow(CrosswalkSyntaxError);
  });
});

describe("formatPath", () => {
  it.each([
    "a",
    "a.b[].c",
    "grid[][]",
    "a[3].b",
    '["a.b"].c',
    String.raw`["say \"hi\" \\ there"]`,
    '[""]',
    'a["0 1"][0]',
  ])("prints the canonical spelling back for %s", (path) => {
    expect(formatPath(parsePath(path))).toBe(path);
    expect(parsePath(formatPath(parsePath(path)))).toEqual(parsePath(path));
  });

  it("canonicalises a quoted key the bare class covers", () => {
    expect(canonicalPath('["a"]["b"]')).toBe("a.b");
    expect(canonicalPath('a["0"]')).toBe("a.0");
  });
});

describe("parsePathMemo", () => {
  it("returns the same locus for a repeated path", () => {
    expect(parsePathMemo("a[].b")).toBe(parsePathMemo("a[].b"));
  });

  it("throws for a malformed path exactly like parsePath", () => {
    expect(() => parsePathMemo("a.")).toThrow(CrosswalkSyntaxError);
  });
});

describe("readLocus", () => {
  it("reads a wildcard-free path", () => {
    expect(readLocus({ a: { b: 1 } }, parsePath("a.b"))).toEqual({ matches: [{ trail: [key("a"), key("b")], value: 1 }], empties: [] });
  });

  it("reads one match per element across a wildcard", () => {
    const doc = { papers: [{ id: 1 }, { id: 2 }] };
    expect(readLocus(doc, parsePath("papers[].id"))?.matches).toEqual([
      { trail: [key("papers"), at(0), key("id")], value: 1 },
      { trail: [key("papers"), at(1), key("id")], value: 2 },
    ]);
  });

  it("reads nested wildcards in row-major order", () => {
    const doc = { grid: [[0, 1], [2, 1]] };
    expect(readLocus(doc, parsePath("grid[][]"))?.matches).toEqual([
      { trail: [key("grid"), at(0), at(0)], value: 0 },
      { trail: [key("grid"), at(0), at(1)], value: 1 },
      { trail: [key("grid"), at(1), at(0)], value: 2 },
      { trail: [key("grid"), at(1), at(1)], value: 1 },
    ]);
  });

  it("reads one fixed element", () => {
    expect(readLocus({ pair: ["x", "y"] }, parsePath("pair[1]"))?.matches).toEqual([{ trail: [key("pair"), at(1)], value: "y" }]);
  });

  it("reads a key that needs quoting", () => {
    expect(readLocus({ "a.b": { "[]": 3 } }, parsePath('["a.b"]["[]"]'))?.matches).toEqual([{ trail: [key("a.b"), key("[]")], value: 3 }]);
  });

  it("reports every empty array a wildcard meets, with the wildcard's ordinal", () => {
    expect(readLocus({ p: [] }, parsePath("p[].t[]"))?.empties).toEqual([{ trail: [key("p")], wildcard: 0 }]);
    expect(readLocus({ p: [{ t: ["x"] }, { t: [] }] }, parsePath("p[].t[]"))).toEqual({
      matches: [{ trail: [key("p"), at(0), key("t"), at(0)], value: "x" }],
      empties: [{ trail: [key("p"), at(1), key("t")], wildcard: 1 }],
    });
  });

  it.each([
    ["a missing key", { a: {} }, "a.b"],
    ["a wildcard over a missing array", {}, "a[].b"],
    ["a key step meeting an array", { a: [1] }, "a.b"],
    ["a wildcard step meeting a record", { a: { b: 1 } }, "a[]"],
    ["an index past the end", { a: [1] }, "a[1]"],
    ["an index step meeting a record", { a: { "0": 1 } }, "a[0]"],
    ["a record key spelled as a digit meeting an array", { a: [1] }, "a.0"],
  ])("returns undefined for %s", (_name, doc, path) => {
    expect(readLocus(doc, parsePath(path))).toBeUndefined();
  });
});

describe("wildcardIndexes and bindLocus", () => {
  it("take the indexes at wildcard steps and put them back", () => {
    const from = parsePath("p[].q[0].r[]");
    const trail: Trail = [key("p"), at(2), key("q"), at(0), key("r"), at(figures.laterIndex)];
    expect(wildcardIndexes(from, trail)).toEqual([2, figures.laterIndex]);
    expect(bindLocus(parsePath("x[].y[]"), [2, figures.laterIndex])).toEqual([key("x"), at(2), key("y"), at(figures.laterIndex)]);
  });

  it("stops before the limiting wildcard", () => {
    expect(bindLocus(parsePath("x[].y[].z"), [2], 1)).toEqual([key("x"), at(2), key("y")]);
  });

  it("throws when the tuple is short", () => {
    expect(() => bindLocus(parsePath("x[]"), [])).toThrow(Error);
  });
});

describe("writeMatches", () => {
  it("writes through records it creates", () => {
    const target: Record<string, unknown> = {};
    writeMatches(target, [{ trail: [key("a"), key("b")], value: 1 }]);
    expect(target).toEqual({ a: { b: 1 } });
  });

  it("creates a record, not an array, for a key spelled as a digit", () => {
    const target: Record<string, unknown> = {};
    writeMatches(target, [{ trail: [key("a"), key("0")], value: "v" }]);
    expect(target).toEqual({ a: { "0": "v" } });
  });

  it("creates an array for an index step", () => {
    const target: Record<string, unknown> = {};
    writeMatches(target, [{ trail: [key("a"), at(0)], value: "v" }]);
    expect(target).toEqual({ a: ["v"] });
  });

  it("materialises an array to the highest index written", () => {
    const target: Record<string, unknown> = {};
    writeMatches(target, [
      { trail: [key("nodes"), at(0), key("id")], value: "x" },
      { trail: [key("nodes"), at(2), key("id")], value: "z" },
    ]);
    expect(target).toEqual({ nodes: [{ id: "x" }, undefined, { id: "z" }] });
  });

  it("writes into an existing container without replacing it", () => {
    const target: Record<string, unknown> = { a: { keep: true } };
    writeMatches(target, [{ trail: [key("a"), key("b")], value: 1 }]);
    expect(target).toEqual({ a: { keep: true, b: 1 } });
  });

  it("throws for an empty trail", () => {
    expect(() => { writeMatches({}, [{ trail: [], value: 1 }]); }).toThrow(RangeError);
  });

  it("throws for a key step into an array and an index step into a record", () => {
    expect(() => { writeMatches({ a: [] }, [{ trail: [key("a"), key("b")], value: 1 }]); }).toThrow(RangeError);
    expect(() => { writeMatches({ a: {} }, [{ trail: [key("a"), at(0)], value: 1 }]); }).toThrow(RangeError);
  });

  it("throws when an intermediate step already holds a value", () => {
    expect(() => { writeMatches({ a: 1 }, [{ trail: [key("a"), key("b")], value: 2 }]); }).toThrow(RangeError);
  });

  it("throws when the final location already holds a value, in either order", () => {
    expect(() => { writeMatches({ a: { b: 1 } }, [{ trail: [key("a")], value: 2 }]); }).toThrow(RangeError);
    expect(() => { writeMatches({ a: 1 }, [{ trail: [key("a")], value: 2 }]); }).toThrow(RangeError);
  });
});

describe("findHole", () => {
  it("finds the first element nothing wrote, at any depth", () => {
    const target: Record<string, unknown> = {};
    writeMatches(target, [{ trail: [key("a"), at(0), key("b"), at(1)], value: 1 }]);
    expect(findHole(target)).toEqual([key("a"), at(0), key("b"), at(0)]);
  });

  it("finds nothing in a dense document", () => {
    expect(findHole({ a: [1, [2, { b: [] }]], c: null })).toBeUndefined();
  });
});

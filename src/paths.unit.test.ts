import { describe, expect, it } from "vitest";
import { CrosswalkSyntaxError } from "./errors";
import { parsePath, parsePathMemo, readLocus, writeMatches } from "./paths";

describe("parsePath", () => {
  it.each([
    ["a", [{ kind: "key", key: "a" }]],
    ["a.b", [{ kind: "key", key: "a" }, { kind: "key", key: "b" }]],
    ["a[]", [{ kind: "key", key: "a" }, { kind: "wildcard" }]],
    ["a[].b", [{ kind: "key", key: "a" }, { kind: "wildcard" }, { kind: "key", key: "b" }]],
    ["a[].b[].c", [{ kind: "key", key: "a" }, { kind: "wildcard" }, { kind: "key", key: "b" }, { kind: "wildcard" }, { kind: "key", key: "c" }]],
    ["snake_case-key.digits123", [{ kind: "key", key: "snake_case-key" }, { kind: "key", key: "digits123" }]],
  ])("parses %s", (path, expected) => {
    expect(parsePath(path)).toEqual(expected);
  });

  it.each([
    "",
    ".a",
    "a.",
    "a..b",
    "[]",
    "a[].[]",
    "a b",
    "a.b-c.d e",
    "a[0]",
    "a[",
    "ä",
  ])("rejects %s", (path) => {
    expect(() => parsePath(path)).toThrow(CrosswalkSyntaxError);
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
    expect(readLocus({ a: { b: 1 } }, parsePath("a.b"))).toEqual([{ keys: ["a", "b"], value: 1 }]);
  });

  it("reads one match per element across a wildcard", () => {
    const doc = { papers: [{ id: 1 }, { id: 2 }] };
    expect(readLocus(doc, parsePath("papers[].id"))).toEqual([
      { keys: ["papers", "0", "id"], value: 1 },
      { keys: ["papers", "1", "id"], value: 2 },
    ]);
  });

  it("reads nested wildcards in row-major order", () => {
    const doc = { grid: [[0, 1], [2, 1]] };
    expect(readLocus(doc, parsePath("grid[][]"))).toMatchObject([
      { keys: ["grid", "0", "0"], value: 0 },
      { keys: ["grid", "0", "1"], value: 1 },
      { keys: ["grid", "1", "0"], value: 2 },
      { keys: ["grid", "1", "1"], value: 1 },
    ]);
  });

  it("returns undefined for a missing key", () => {
    expect(readLocus({ a: {} }, parsePath("a.b"))).toBeUndefined();
  });

  it("returns undefined for a wildcard over a missing array", () => {
    expect(readLocus({}, parsePath("a[].b"))).toBeUndefined();
  });

  it("returns undefined when a key step meets an array", () => {
    expect(readLocus({ a: [1] }, parsePath("a.b"))).toBeUndefined();
  });

  it("returns undefined when a wildcard step meets a record", () => {
    expect(readLocus({ a: { b: 1 } }, parsePath("a[]"))).toBeUndefined();
  });
});

describe("writeMatches", () => {
  it("writes through records it creates", () => {
    const target: Record<string, unknown> = {};
    writeMatches(target, [{ keys: ["a", "b"], value: 1 }]);
    expect(target).toEqual({ a: { b: 1 } });
  });

  it("materialises an array to the highest index written", () => {
    const target: Record<string, unknown> = {};
    writeMatches(target, [
      { keys: ["nodes", "0", "id"], value: "x" },
      { keys: ["nodes", "2", "id"], value: "z" },
    ]);
    expect(target).toEqual({ nodes: [{ id: "x" }, undefined, { id: "z" }] });
  });

  it("writes into an existing container without replacing it", () => {
    const target: Record<string, unknown> = { a: { keep: true } };
    writeMatches(target, [{ keys: ["a", "b"], value: 1 }]);
    expect(target).toEqual({ a: { keep: true, b: 1 } });
  });

  it("throws for an empty trail", () => {
    expect(() => { writeMatches({}, [{ keys: [], value: 1 }]); }).toThrow(RangeError);
  });

  it("throws for a non-index key into an array", () => {
    const target: Record<string, unknown> = { a: [] };
    expect(() => { writeMatches(target, [{ keys: ["a", "b"], value: 1 }]); }).toThrow(RangeError);
  });

  it("throws when an intermediate step already holds a value", () => {
    const target: Record<string, unknown> = { a: 1 };
    expect(() => { writeMatches(target, [{ keys: ["a", "b"], value: 2 }]); }).toThrow(RangeError);
  });
});

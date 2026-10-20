import { describe, expect, it } from "vitest";
import { type Crosswalk, parseCrosswalk } from "./crosswalk";
import { validateCrosswalk } from "./validate";

const crosswalk = (doc: unknown): Crosswalk => parseCrosswalk(doc);

describe("validateCrosswalk", () => {
  it("accepts a valid crosswalk", () => {
    const cw = crosswalk({
      source: "native",
      target: "shared",
      rules: [
        { op: "move", from: "a", to: "b" },
        { op: "move", from: "papers[].id", to: "nodes[].ref" },
      ],
      oneWay: [{ op: "default", to: "locale", value: "en-GB", direction: "encode" }],
    });
    expect(validateCrosswalk(cw)).toEqual([]);
  });

  it("rejects a to path whose wildcards differ from its from path", () => {
    const cw = crosswalk({ source: "a", target: "b", rules: [{ op: "move", from: "papers[].id", to: "node.id" }], oneWay: [] });
    expect(validateCrosswalk(cw).map((issue) => issue.message).join()).toContain("wildcard");
  });

  it("rejects a to path with more wildcards than its from path", () => {
    const cw = crosswalk({ source: "a", target: "b", rules: [{ op: "move", from: "grid[].row", to: "cells[][]" }], oneWay: [] });
    expect(validateCrosswalk(cw).map((issue) => issue.message)).toEqual(["to path cells[][] has 2 wildcards where the first from has 1: mapping is index-aligned, one wildcard to one"]);
  });

  it.each([
    ["nesting", "a", "b.a"],
    ["flattening", "a.b.c", "c"],
    ["flattening inside a wildcard", "a[].b.c", "x[].c"],
    ["moving a wildcard under a record", "a[].b", "a.b[]"],
    ["an array of arrays", "grid[][]", "cells[][]"],
  ])("accepts a change of depth around equal wildcards: %s", (_name, from, to) => {
    expect(validateCrosswalk(crosswalk({ source: "a", target: "b", rules: [{ op: "move", from, to }], oneWay: [] }))).toEqual([]);
  });

  it("rejects two source arrays feeding one target wildcard root", () => {
    const cw = crosswalk({
      source: "a",
      target: "b",
      rules: [
        { op: "move", from: "papers[].id", to: "nodes[].ref" },
        { op: "move", from: "books[].id", to: "nodes[].title" },
      ],
      oneWay: [],
    });
    expect(validateCrosswalk(cw).map((issue) => issue.message).join()).toContain("not index-invertible");
  });

  it("rejects two inner source arrays feeding one inner target array under a shared outer pair", () => {
    const cw = crosswalk({
      source: "a",
      target: "b",
      rules: [
        { op: "move", from: "p[].a[].v", to: "n[].l[].v" },
        { op: "move", from: "p[].b[].w", to: "n[].l[].w" },
      ],
      oneWay: [],
    });
    expect(validateCrosswalk(cw).map((issue) => issue.message)).toEqual(["two source arrays (p[].a[], p[].b[]) feed the one target array n[].l[]: the merge is not index-invertible"]);
  });

  it("rejects one path spelled two ways", () => {
    const cw = crosswalk({ source: "a", target: "b", rules: [{ op: "move", from: "x", to: "a.b" }, { op: "move", from: "y", to: '["a"]["b"]' }], oneWay: [] });
    expect(validateCrosswalk(cw).map((issue) => issue.message)).toEqual(["two rules write the same to path: a.b"]);
  });

  it.each([
    ["to side", [{ op: "move", from: "p[].x", to: "n[].x" }, { op: "move", from: "q", to: "n[0].y" }], "n"],
    ["from side", [{ op: "move", from: "a[0].y", to: "first" }, { op: "move", from: "a[].x", to: "items[].x" }], "a"],
    ["a default's to", [{ op: "move", from: "p[].x", to: "n[].x" }], "n"],
  ])("rejects an array addressed both by index and by wildcard on the %s", (name, rules, array) => {
    const oneWay = name === "a default's to" ? [{ op: "default", to: "n[0].z", value: 1, direction: "encode" }] : [];
    expect(validateCrosswalk(crosswalk({ source: "a", target: "b", rules, oneWay })).map((issue) => issue.message)).toEqual([`the array ${array} is addressed both by a fixed index and by a wildcard`]);
  });

  it("accepts fixed indices into an array no wildcard iterates", () => {
    const cw = crosswalk({ source: "a", target: "b", rules: [{ op: "move", from: "lat", to: "point[0]" }, { op: "move", from: "lon", to: "point[1]" }], oneWay: [] });
    expect(validateCrosswalk(cw)).toEqual([]);
  });

  it("accepts two rules sharing one wildcard root pair", () => {
    const cw = crosswalk({
      source: "a",
      target: "b",
      rules: [
        { op: "move", from: "papers[].id", to: "nodes[].ref" },
        { op: "move", from: "papers[].title", to: "nodes[].title" },
      ],
      oneWay: [],
    });
    expect(validateCrosswalk(cw)).toEqual([]);
  });

  it("rejects a repeated to path across two-way and one-way rules", () => {
    const cw = crosswalk({
      source: "a",
      target: "b",
      rules: [{ op: "move", from: "x", to: "b" }],
      oneWay: [{ op: "default", to: "b", value: 1, direction: "encode" }],
    });
    expect(validateCrosswalk(cw).map((issue) => issue.message).join()).toContain("same to path");
  });

  it("rejects a repeated from path across two-way and one-way rules", () => {
    const cw = crosswalk({
      source: "a",
      target: "b",
      rules: [{ op: "move", from: "x", to: "b" }],
      oneWay: [{ op: "drop", from: "x", direction: "encode" }],
    });
    expect(validateCrosswalk(cw).map((issue) => issue.message).join()).toContain("same from path");
  });

  it("rejects a wildcard inside a when reference", () => {
    const cw = crosswalk({
      source: "a",
      target: "b",
      rules: [{ op: "move", from: "x", to: "y", when: { kind: "exists", operand: { kind: "reference", key: "rows[].flag" } } }],
      oneWay: [],
    });
    expect(validateCrosswalk(cw).map((issue) => issue.message).join()).toContain("wildcard");
  });

  it("accepts a quoted key whose text contains brackets inside a when reference", () => {
    const cw = crosswalk({
      source: "a",
      target: "b",
      rules: [{ op: "move", from: "x", to: "y", when: { kind: "exists", operand: { kind: "reference", key: 'meta["rows[]"]' } } }],
      oneWay: [],
    });
    expect(validateCrosswalk(cw)).toEqual([]);
  });

  it("rejects a wildcard inside a when collection reference", () => {
    const cw = crosswalk({
      source: "a",
      target: "b",
      rules: [{ op: "move", from: "x", to: "y", when: { kind: "some", collection: "rows[]", item: { kind: "compare", op: "eq", left: { kind: "reference", key: "flag" }, right: { kind: "numberLiteral", value: 1 } } } }],
      oneWay: [],
    });
    expect(validateCrosswalk(cw).map((issue) => issue.message).join()).toContain("wildcard");
  });

  it("rejects a wildcard in a default rule's to path", () => {
    const cw = crosswalk({ source: "a", target: "b", rules: [], oneWay: [{ op: "default", to: "rows[].flag", value: 1, direction: "encode" }] });
    expect(validateCrosswalk(cw).map((issue) => issue.message).join()).toContain("wildcard-free");
  });
});

describe("validateCrosswalk on per-element when references", () => {
  const exists = (key: string) => ({ kind: "exists", operand: { kind: "reference", key } });
  const issuesOf = (rules: readonly unknown[], oneWay: readonly unknown[] = []) => validateCrosswalk(crosswalk({ source: "a", target: "b", rules, oneWay })).map((issue) => issue.message);

  it("accepts a reference into the array the rule iterates, at any depth up to the rule's", () => {
    expect(issuesOf([{ op: "move", from: "p[].q[].v", to: "n[].m[].v", when: exists("p[].flag") }])).toEqual([]);
    expect(issuesOf([{ op: "move", from: "p[].q[].v", to: "n[].m[].v", when: exists("p[].q[].flag") }])).toEqual([]);
  });

  it("rejects a reference into another array", () => {
    expect(issuesOf([{ op: "move", from: "p[].v", to: "n[].v", when: exists("other[].flag") }])).toEqual(["when reference other[].flag contains a wildcard into other[], which is not the array its rule's from iterates at that depth (p[])"]);
  });

  it("rejects a reference with more wildcards than the rule", () => {
    expect(issuesOf([{ op: "move", from: "p[].v", to: "n[].v", when: exists("p[].q[].flag") }])).toEqual(["when reference p[].q[].flag contains 2 wildcards where its rule's from has 1"]);
  });

  it("rejects a wildcard reference on a one-way rule", () => {
    expect(issuesOf([], [{ op: "drop", from: "p[].v", direction: "encode", when: exists("p[].flag") }])).toEqual(["when reference p[].flag contains a wildcard, but a one-way rule visits no element to bind it to"]);
  });
});

describe("validateCrosswalk on multi-path rules", () => {
  const issuesOf = (rules: readonly unknown[]) => validateCrosswalk(crosswalk({ source: "a", target: "b", rules, oneWay: [] })).map((issue) => issue.message);

  it("rejects template fields from different arrays", () => {
    expect(issuesOf([{ op: "template", from: { a: "p[].a", b: "q[].b" }, to: "t[]", template: "{a}/{b}" }])).toEqual(["from path q[].b iterates different arrays from the rule's other from paths: the fields of one element must come from one element"]);
  });

  it("checks every copy target's wildcards and uniqueness", () => {
    expect(issuesOf([{ op: "copy", from: "p[].a", to: ["n[].a", "flat"] }])).toEqual(["to path flat has 0 wildcards where the first from has 1: mapping is index-aligned, one wildcard to one"]);
    expect(issuesOf([{ op: "copy", from: "a", to: ["x", "y"] }, { op: "move", from: "b", to: "y" }])).toEqual(["two rules write the same to path: y"]);
  });

  it("counts every template field as a read", () => {
    expect(issuesOf([{ op: "template", from: { a: "a", b: "b" }, to: "t", template: "{a}/{b}" }, { op: "move", from: "b", to: "u" }])).toEqual(["two rules read the same from path: b"]);
  });
});

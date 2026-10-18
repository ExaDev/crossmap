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

  it("rejects a different nesting order of wildcards", () => {
    const cw = crosswalk({ source: "a", target: "b", rules: [{ op: "move", from: "a[].b", to: "a.b[]" }], oneWay: [] });
    expect(validateCrosswalk(cw)).toHaveLength(1);
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

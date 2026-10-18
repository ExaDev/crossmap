import { describe, expect, it } from "vitest";
import { parseCrosswalk } from "./crosswalk";
import { CrosswalkSyntaxError, RuleApplicationError } from "./errors";
import { decode, encode } from "./executor";

const move = (from: string, to: string) => parseCrosswalk({ source: "n", target: "s", rules: [{ op: "move", from, to }] });

describe("keys that name members of Object.prototype", () => {
  it("refuses a __proto__ segment in a path, so Object.prototype is never reachable", () => {
    expect(() => move("a.b", "__proto__.polluted")).toThrow(CrosswalkSyntaxError);
    expect(() => move("__proto__.x", "b.x")).toThrow(CrosswalkSyntaxError);
    expect(() => move("a.__proto__", "b.c")).toThrow(CrosswalkSyntaxError);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("still accepts a segment that merely contains or extends the word", () => {
    expect(() => move("a.__proto__x", "b.x__proto__")).not.toThrow();
    expect(() => move("__proto", "proto__")).not.toThrow();
  });

  it("treats a name inherited from Object.prototype as absent", () => {
    expect(() => encode(move("valueOf", "b"), { a: 1 })).toThrow(RuleApplicationError);
    expect(() => encode(move("constructor.name", "b.name"), { a: 1 })).toThrow(RuleApplicationError);
  });

  it("does not map an enum value that only the prototype chain names", () => {
    const cw = parseCrosswalk({ source: "n", target: "s", rules: [{ op: "enum", from: "k", to: "v", map: { a: "A" }, mapBack: { A: "a" } }] });
    expect(() => encode(cw, { k: "constructor" })).toThrow(RuleApplicationError);
    expect(() => decode(cw, { v: "toString" })).toThrow(RuleApplicationError);
  });
});

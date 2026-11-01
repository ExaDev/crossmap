import { describe, expect, it } from "vitest";
import { parseCrosswalk, ruleSides } from "./index";

/**
 * Parses one two-way rule inside a crosswalk, so the rule under test is what the schema accepts.
 * @param rule - The rule's document.
 * @returns The rule as parsed.
 */
function parsed(rule: unknown) {
  const [first] = parseCrosswalk({ source: "native", target: "shared", rules: [rule], oneWay: [] }).rules;
  if (first === undefined) {
    return expect.unreachable("the crosswalk has the one rule");
  }

  return first;
}

describe("ruleSides", () => {
  it("gives the one path on each side of a rule that has one", () => {
    expect(ruleSides(parsed({ op: "move", from: "meta", to: "info" }))).toEqual({ from: ["meta"], to: ["info"] });
    expect(ruleSides(parsed({ op: "scale", from: "a", to: "b", factor: 2 }))).toEqual({ from: ["a"], to: ["b"] });
    expect(ruleSides(parsed({ op: "split", from: "a", to: "b", separator: "," }))).toEqual({ from: ["a"], to: ["b"] });
  });

  it("gives a template's fields in its record's key order and a copy's every target", () => {
    expect(ruleSides(parsed({ op: "template", from: { family: "people[].family", given: "people[].given" }, to: "names[]", template: "{family}, {given}" }))).toEqual({
      from: ["people[].family", "people[].given"],
      to: ["names[]"],
    });
    expect(ruleSides(parsed({ op: "copy", from: "items[].id", to: ["nodes[].id", "labels[].text"] }))).toEqual({ from: ["items[].id"], to: ["nodes[].id", "labels[].text"] });
  });
});

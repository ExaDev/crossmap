import { describe, expect, it } from "vitest";
import { parseTemplate, renderTemplate, splitTemplate } from "./template";

const fields = (entries: Record<string, unknown>): ReadonlyMap<string, unknown> => new Map(Object.entries(entries));

describe("parseTemplate", () => {
  it("separates literals and placeholders and unescapes doubled braces", () => {
    expect(parseTemplate("{{{a}}} - {b}")).toEqual([
      { kind: "literal", text: "{" },
      { kind: "placeholder", name: "a" },
      { kind: "literal", text: "} - " },
      { kind: "placeholder", name: "b" },
    ]);
  });

  it.each(["{", "{a", "{a-b}", "{}", "x } y", "{__proto__}"])("rejects %s", (template) => {
    expect(() => parseTemplate(template)).toThrow(Error);
  });
});

describe("template", () => {
  const pieces = parseTemplate("{family}, {given} ({id})");

  it("renders and splits back", () => {
    const values = fields({ family: "Lovelace", given: "Ada", id: "a1" });
    const text = renderTemplate(pieces, values);
    expect(text).toBe("Lovelace, Ada (a1)");
    expect(splitTemplate(pieces, text)).toEqual(values);
  });

  it("splits empty fields", () => {
    expect(splitTemplate(pieces, ",  ()")).toEqual(fields({ family: "", given: "", id: "" }));
  });

  it("refuses a value holding the boundary that follows it, which would split elsewhere", () => {
    expect(() => renderTemplate(pieces, fields({ family: "Smith, Jr", given: "Ann", id: "x" }))).toThrow("template field family holds \"Smith, Jr\"");
  });

  it("accepts a value holding a boundary that does not follow it", () => {
    const values = fields({ family: "Smith", given: "Ann, PhD", id: "x" });
    expect(splitTemplate(pieces, renderTemplate(pieces, values))).toEqual(values);
  });

  it("refuses a value that is not a string", () => {
    expect(() => renderTemplate(pieces, fields({ family: "a", given: "b", id: 1 }))).toThrow(/must be a string/);
  });

  it("refuses text without the template's shape", () => {
    expect(() => splitTemplate(pieces, "no separators here")).toThrow(Error);
    expect(() => splitTemplate(parseTemplate("<{a}>"), ">")).toThrow(Error);
  });
});

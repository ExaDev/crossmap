import { readFileSync } from "node:fs";
import { join } from "node:path";
import canonicalize from "canonicalize";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const schemaPath = join(import.meta.dirname, "../schemas/crossmap.schema.json");

describe("the built JSON Schema", () => {
  const file = readFileSync(schemaPath, "utf8");
  const parsed: unknown = JSON.parse(file);

  it("is exactly the RFC 8785 canonical form of its own content", () => {
    expect(canonicalize(parsed)).toBe(file);
  });

  it("refs trilean's published predicate schema at the installed version", () => {
    // Read as a file rather than through require.resolve: trilean's exports map does not expose package.json (the same reason the generate script reads it this way).
    const trileanPackageJson: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "../node_modules/trilean/package.json"), "utf8"));
    const trileanVersion: unknown = isRecord(trileanPackageJson) ? trileanPackageJson["version"] : undefined;
    expect(trileanVersion).toBeTypeOf("string");
    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) {
      throw new Error("the built schema is not a JSON object");
    }
    const defs: unknown = parsed["$defs"];
    expect(isRecord(defs)).toBe(true);
    if (!isRecord(defs)) {
      throw new Error("the built schema has no $defs object");
    }
    const when: unknown = defs["When"];
    expect(isRecord(when)).toBe(true);
    if (!isRecord(when)) {
      throw new Error("the built schema has no $defs.When entry");
    }
    expect(when["$ref"]).toBe(`https://cdn.jsdelivr.net/npm/trilean@${String(trileanVersion)}/schemas/trilean.schema.json#/$defs/PredicateNode`);
  });

  it("describes the documents parseCrosswalk accepts: the rule lists, and a single-path rule's to, may be left out", () => {
    const shape = z.object({
      $defs: z.object({
        Crosswalk: z.object({
          required: z.array(z.string()),
          properties: z.object({ rules: z.object({ items: z.object({ oneOf: z.array(z.object({ properties: z.object({ op: z.object({ const: z.string() }) }), required: z.array(z.string()) })) }) }) }),
        }),
      }),
    });
    const crosswalk = shape.parse(parsed).$defs.Crosswalk;
    expect(crosswalk.required.sort()).toEqual(["source", "target"]);
    const requiresTo = Object.fromEntries(crosswalk.properties.rules.items.oneOf.map((rule) => [rule.properties.op.const, rule.required.includes("to")]));
    expect(requiresTo).toEqual({ move: false, scale: false, enum: false, format: false, split: false, template: true, copy: true });
  });
});

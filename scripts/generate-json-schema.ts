/* Generates schemas/crossmap.schema.json from the package's own Zod schemas via z.toJSONSchema() (https://zod.dev/json-schema). Run as part of `pnpm build` (see package.json's build script), so schemas/ is always fresh for a real `npm publish`: prepublishOnly runs the full build, not tsdown alone.

   Imports from the freshly-built ../dist/index.js: the build script runs tsdown first, so the schema describes exactly what the published dist validates.

   The runtime `when` field is trilean's PredicateNodeSchema itself, registered in one z.registry() under id "When". Rather than embedding the converted predicate subtree, $defs.When is overwritten after conversion with an external $ref to trilean's published schema (a version-pinned jsDelivr URL plus the #/$defs/PredicateNode fragment): an embedded copy can drift from the published trilean schema with no signal, and defeats the cross-package composition the version-pinned $id exists for. A $defs entry that is itself an external $ref is valid 2020-12, so Ajv-class tooling resolves it from the CDN. Every internal "#/$defs/When" reference the conversion emitted already resolves through to that entry.

   zod's own registry-conversion output (z.toJSONSchema(registry)) is a *bag* of separately-addressable documents with cross-references written as bare id strings, which are not resolvable inside one JSON document; the `uri` callback below redirects every such reference to an in-document JSON Pointer fragment ("#/$defs/<id>") instead. "__shared" is the fixed key zod uses internally for schemas reused across registered roots; mapping it to the empty string keeps its already-correct internal fragments intact.

   This script imports the freshly-built dist/index.js, so it is a member of tsconfig.node.json's program rather than tsconfig.json's runtime src/ one.

   No try/catch anywhere in this script: any failure (a Zod throw, a filesystem error) crashes it loudly with a non-zero exit. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import { PredicateNodeSchema } from "trilean";
import { z } from "zod";
import { CrosswalkSchema } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const schemasDir = join(repoRoot, "schemas");
const outputPath = join(schemasDir, "crossmap.schema.json");

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Read straight from the repo's own package.json rather than hardcoding a version (parse to `unknown`, narrow with a type guard, throw rather than mask a malformed or missing field with a fallback).
const packageJsonPath = join(repoRoot, "package.json");
const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (!isPlainRecord(packageJson)) {
  throw new Error(`expected ${packageJsonPath} to parse to a JSON object`);
}
const packageVersion = packageJson["version"];
if (typeof packageVersion !== "string") {
  throw new Error(`expected ${packageJsonPath} to have a string "version"`);
}

// The trilean version of the actual install (an exact pin in package.json), so the external $ref names precisely the predicate schema this build validated against. Read as a file rather than through require.resolve: trilean's exports map does not expose package.json.
const trileanPackageJsonPath = join(repoRoot, "node_modules/trilean/package.json");
const trileanPackageJson: unknown = JSON.parse(readFileSync(trileanPackageJsonPath, "utf8"));
if (!isPlainRecord(trileanPackageJson)) {
  throw new Error(`expected ${trileanPackageJsonPath} to parse to a JSON object`);
}
const trileanVersion = trileanPackageJson["version"];
if (typeof trileanVersion !== "string") {
  throw new Error("expected node_modules/trilean/package.json to have a string \"version\"");
}

const registry = z.registry<z.core.JSONSchemaMeta>();
registry.add(CrosswalkSchema, { id: "Crosswalk" });
registry.add(PredicateNodeSchema, { id: "When" });

const { schemas } = z.toJSONSchema(registry, {
  uri: (id) => (id === "__shared" ? "" : `#/$defs/${id}`),
});

/* z.toJSONSchema's registry overload types `schemas` as a plain Record, so noUncheckedIndexedAccess widens each lookup to `T | undefined` even though both ids were just registered above and are therefore always present: fail loudly rather than let a silently-undefined entry flow into the spread below. */
const crosswalkEntry = schemas["Crosswalk"];
if (crosswalkEntry === undefined) {
  throw new Error("z.toJSONSchema produced no Crosswalk entry for the registered CrosswalkSchema.");
}
const whenEntry = schemas["When"];
if (whenEntry === undefined) {
  throw new Error("z.toJSONSchema produced no When entry for the registered PredicateNodeSchema.");
}

// Each entry comes back as its own complete JSON Schema resource ($schema on every registry entry, and an $id equal to its own fragment-only ref once `uri` is set, which is not a valid resource identifier and is meaningless once nested under $defs): both belong to "this is a standalone document", no longer true once nested, so both are stripped.
const crosswalkDef: z.core.JSONSchema.JSONSchema = { ...crosswalkEntry };
delete crosswalkDef.$schema;
delete crosswalkDef.$id;

const sharedDefs = schemas["__shared"]?.$defs ?? {};

// Version-pinned (never "latest"): jsDelivr serves files straight out of a published npm package by version, so this identifies the exact schema shipped in this specific published version.
const combined: z.core.JSONSchema.JSONSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://cdn.jsdelivr.net/npm/crossmap@${packageVersion}/schemas/crossmap.schema.json`,
  $defs: {
    Crosswalk: crosswalkDef,
    When: {
      $ref: `https://cdn.jsdelivr.net/npm/trilean@${trileanVersion}/schemas/trilean.schema.json#/$defs/PredicateNode`,
    },
    ...sharedDefs,
  },
  $ref: "#/$defs/Crosswalk",
};

// RFC 8785 (JSON Canonicalization Scheme) output via the "canonicalize" package rather than a hand-rolled sort: RFC 8785's number rule has edge cases a naive reimplementation gets wrong. Written with no trailing newline, so the file's bytes are exactly the JCS form of its own content: canonicalize(JSON.parse(file)) === file.
const canonicalJson = canonicalize(combined);
if (canonicalJson === undefined) {
  throw new Error("canonicalize() produced no output for the combined JSON Schema document.");
}

mkdirSync(schemasDir, { recursive: true });
writeFileSync(outputPath, canonicalJson, "utf8");

console.log(`Wrote combined JSON Schema document to ${outputPath}`);

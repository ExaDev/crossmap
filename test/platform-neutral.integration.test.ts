// The library is platform neutral: it runs in a browser, a worker and Node alike, so nothing it ships may import a Node module. Only tsdown's `platform: 'neutral'` enforces that today, and it does so by bundling, not by refusing; this reads the source and the built output directly, so a `node:` import (or a bare built-in such as `fs`) fails the suite instead of surfacing at a consumer's bundler. The command under cli/ is the one place allowed Node APIs and is deliberately not checked.

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

/** The module specifier in every static import, re-export, dynamic import and require in a source text. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

/**
 * The Node built-in modules a source text imports.
 * @param text - JavaScript or TypeScript source, or a declaration file.
 * @returns Each specifier that is a `node:` URL or a bare built-in module name.
 */
function nodeImports(text: string): string[] {
  const builtins = new Set(builtinModules);

  return [...text.matchAll(SPECIFIER)].map((match) => match[1] ?? "").filter((specifier) => specifier.startsWith("node:") || builtins.has(specifier));
}

function filesUnder(directory: string, accept: (name: string) => boolean): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && accept(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The first Node import in each file that has one, as `file: specifier`, so a failure names the offender. */
function offenders(files: readonly string[]): string[] {
  return files.flatMap((file) => {
    const [first] = nodeImports(readFileSync(file, "utf8"));

    return first === undefined ? [] : [`${file.slice(root.length + 1)}: ${first}`];
  });
}

describe("nodeImports", () => {
  it("finds every import form and ignores ordinary specifiers and mentions in prose", () => {
    const text = [
      'import { readFileSync } from "node:fs";',
      "export { join } from 'node:path';",
      'import "node:process";',
      'const lazy = await import("node:os");',
      'const legacy = require("node:util");',
      'import fs from "fs";',
      'import { z } from "zod";',
      'import { run } from "./run";',
      "// the library never imports node:child_process",
    ].join("\n");

    expect(nodeImports(text)).toEqual(["node:fs", "node:path", "node:process", "node:os", "node:util", "fs"]);
  });
});

describe("the library", () => {
  // Test files under src/ run in Node and are not part of the entry's module graph, so they may import Node modules; every other file under src/ is shipped.
  const sources = filesUnder(join(root, "src"), (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

  it("has source files to check", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("imports no Node module from src/", () => {
    expect(offenders(sources)).toEqual([]);
  });

  it("ships no Node import in the built dist/", () => {
    const built = filesUnder(join(root, "dist"), (name) => /\.(?:js|mjs|cjs|d\.ts|d\.mts|d\.cts)$/.test(name));

    expect(built.length).toBeGreaterThan(0);
    expect(offenders(built)).toEqual([]);
  });
});

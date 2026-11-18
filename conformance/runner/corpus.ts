import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { z } from "zod";
import { BaseCaseSchema, type Case } from "./cases";
import { canonical } from "./canonical";

/** A name the loaders accept: lower-case ASCII letters, digits, dots, hyphens and underscores, starting with a letter or digit. */
const NAME = /^[a-z0-9][a-z0-9._-]*$/u;

/** The files the root may hold besides the corpus directory. */
const ROOT_FILES = ["README.md", "PROPERTIES.md", "case.schema.json", "manifest.json", "manifest.schema.json"];

/** Directories skipped at any depth: they hold the runners and generators, never cases. */
const SKIPPED_DIRECTORIES = ["runner", "generate", "fixtures", "schema"];

/** The depth of a corpus file's path: `<package>/<area>/<name>.json`. */
const CORPUS_PATH_PARTS = 3;

const ManifestSchema = z.object({
  files: z.record(
    z.string(),
    z.object({ cases: z.number(), generated: z.literal(true).optional(), skip: z.object({ rust: z.array(z.string()), ts: z.array(z.string()) }) }),
  ),
});

const CorpusFileSchema = z.object({ cases: z.array(BaseCaseSchema) });

/** The manifest's entry for one corpus file. */
export type ManifestEntry = z.infer<typeof ManifestSchema>["files"][string];

/** Where problems are reported: an array satisfies it, and a function taking it cannot be mistaken for one that reads the array. */
interface Sink {
  readonly push: (problem: string) => void;
}

/** A corpus file's path under the root and its cases. */
export interface CorpusFile {
  readonly path: string;
  readonly cases: readonly Case[];
}

/** What loading found: the files, and every problem with the corpus as a whole (never thrown, so one run reports them all). */
export interface Loaded {
  readonly files: readonly CorpusFile[];
  readonly manifest: Readonly<Record<string, ManifestEntry>>;
  readonly problems: readonly string[];
}

/** Compiled validators by schema text: compiling the case schema is the dominant cost of loading a small corpus, and a schema file does not change within a process. */
const compiled = new Map<string, ValidateFunction>();

function compile(ajv: Ajv2020, path: string): ValidateFunction {
  const schemaText = readFileSync(path, "utf8");
  const found = compiled.get(schemaText);
  if (found !== undefined) {
    return found;
  }
  const schema: unknown = JSON.parse(schemaText);
  const validate = ajv.compile(z.looseObject({}).parse(schema));
  compiled.set(schemaText, validate);

  return validate;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Reads a file as UTF-8, refusing invalid bytes and a byte order mark. */
function readText(path: string, problems: Sink): string | undefined {
  try {
    const text = decoder.decode(readFileSync(path));
    if (text.startsWith("﻿")) {
      problems.push(`${path}: begins with a byte order mark`);

      return undefined;
    }

    return text;
  } catch {
    problems.push(`${path}: is not valid UTF-8`);

    return undefined;
  }
}

/** Compares two strings by UTF-16 code unit, which `<` does. */
function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Every `.json` path under a directory, relative to the root, in UTF-16 code-unit order; any entry the selection rules refuse is a problem. */
function discover(root: string, directory: string, problems: Sink): string[] {
  const found: string[] = [];
  const entries = readdirSync(join(root, directory), { withFileTypes: true }).sort((left, right) => byCodeUnit(left.name, right.name));
  for (const entry of entries) {
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.includes(entry.name)) {
        continue;
      }
      if (directory === "" && entry.name !== "crossmap") {
        problems.push(`${relative}: a directory at the root that is not the package directory`);
        continue;
      }
      found.push(...discover(root, relative, problems));
      continue;
    }
    if (directory === "") {
      if (!ROOT_FILES.includes(entry.name)) {
        problems.push(`${relative}: a file at the root that is not one of ${ROOT_FILES.join(", ")}`);
      }
      continue;
    }
    const stem = entry.name.slice(0, -".json".length);
    const area = directory.split("/")[1] ?? "";
    if (!entry.name.endsWith(".json") || !NAME.test(stem) || !NAME.test(area) || relative.split("/").length !== CORPUS_PATH_PARTS) {
      problems.push(`${relative}: is not a corpus file at <package>/<area>/<name>.json`);
      continue;
    }
    found.push(relative);
  }

  return found;
}

/** Whether the text is the canonical serialisation of what it parses to: sorted keys, two-space indent, one trailing line feed. */
function isCanonical(text: string, value: unknown): boolean {
  return `${canonical(value)}\n` === text;
}

/** Loads the manifest, reporting what is wrong with it. */
function loadManifest(root: string, ajv: Ajv2020, problems: Sink): Readonly<Record<string, ManifestEntry>> {
  const text = readText(join(root, "manifest.json"), problems);
  if (text === undefined) {
    return {};
  }
  const parsed: unknown = JSON.parse(text);
  if (!isCanonical(text, parsed)) {
    problems.push("manifest.json: is not in canonical form");
  }
  const validate = compile(ajv, join(root, "manifest.schema.json"));
  if (!validate(parsed)) {
    problems.push(`manifest.json: ${ajv.errorsText(validate.errors)}`);

    return {};
  }

  return ManifestSchema.parse(parsed).files;
}

/** Checks each file against the manifest: it is listed, its count agrees and its skip lists are the cases marked, sorted. */
function checkManifest(files: readonly CorpusFile[], manifest: Readonly<Record<string, ManifestEntry>>, problems: Sink): void {
  for (const file of files) {
    const entry = manifest[file.path];
    if (entry === undefined) {
      problems.push(`${file.path}: is not in the manifest`);
      continue;
    }
    if (entry.cases !== file.cases.length) {
      problems.push(`${file.path}: the manifest says ${String(entry.cases)} cases and the file holds ${String(file.cases.length)}`);
    }
    for (const implementation of ["ts", "rust"] as const) {
      const marked = file.cases.filter((entryCase) => entryCase.skip === implementation).map((entryCase) => entryCase.id).sort(byCodeUnit);
      if (JSON.stringify(marked) !== JSON.stringify(entry.skip[implementation])) {
        problems.push(`${file.path}: the cases marked skip ${implementation} differ from the manifest's sorted list`);
      }
    }
  }
  for (const path of Object.keys(manifest)) {
    if (!files.some((file) => file.path === path)) {
      problems.push(`${path}: is in the manifest and not on disk`);
    }
  }
}

/**
 * Loads and checks the corpus under `root` against the case schema and the manifest.
 * @param root - The conformance directory.
 * @returns The files with their cases and every problem found; an empty corpus is a problem.
 */
export function loadCorpus(root: string): Loaded {
  const problems: string[] = [];
  const ajv = new Ajv2020({ allErrors: false, strict: false });
  const validateCase = compile(ajv, join(root, "case.schema.json"));
  const manifest = loadManifest(root, ajv, problems);
  const files: CorpusFile[] = [];
  const ids = new Map<string, string>();
  for (const path of discover(root, "", problems)) {
    const text = readText(join(root, path), problems);
    if (text === undefined) {
      continue;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isCanonical(text, parsed)) {
      problems.push(`${path}: is not in canonical form (sorted keys, two-space indent, one trailing line feed)`);
    }
    if (!validateCase(parsed)) {
      problems.push(`${path}: ${ajv.errorsText(validateCase.errors)}`);
      continue;
    }
    const { cases } = CorpusFileSchema.parse(parsed);
    for (const entry of cases) {
      const earlier = ids.get(entry.id);
      if (earlier !== undefined) {
        problems.push(`${path}: the id ${entry.id} is also used in ${earlier}`);
      }
      ids.set(entry.id, path);
    }
    files.push({ path, cases });
  }
  checkManifest(files, manifest, problems);
  if (files.reduce((count, file) => count + file.cases.length, 0) === 0) {
    problems.push("the corpus holds no cases");
  }

  return { files, manifest, problems };
}

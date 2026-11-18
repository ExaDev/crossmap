import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import canonicalize from "canonicalize";
import { z } from "zod";
import { isUrl, readSource } from "../../cli/read-source";
import { run as runCli } from "../../cli/run";
import { assertRoundTrip, CrosswalkStructureError, CrosswalkSyntaxError, decode, encode, parseCrosswalk, RoundTripMismatchError, RuleApplicationError, ruleSides, validateCrosswalk } from "../../src/index";
import { formatPath, parsePath, readLocus } from "../../src/paths";
import { type Case, type ErrorExpectSchema, isKind, KindSchemas } from "./cases";

/** The repository root, where the built schema and the package manifest live. */
const REPOSITORY = join(import.meta.dirname, "../..");

type ErrorExpect = z.infer<typeof ErrorExpectSchema>;

const JsonObject = z.looseObject({});
const PackageSchema = z.object({ version: z.string() });

/**
 * Whether two JSON values are equal, objects irrespective of key order.
 * @param left - A JSON value.
 * @param right - Another.
 * @returns True when they denote the same JSON.
 */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item: unknown, position) => jsonEqual(item, right[position]));
  }
  const leftEntries = Object.entries(left);
  const rightRecord = new Map(Object.entries(right));

  return leftEntries.length === rightRecord.size && leftEntries.every(([name, member]) => rightRecord.has(name) && jsonEqual(member, rightRecord.get(name)));
}

/** The value as the fixture carries it: what `JSON.parse` of its serialisation gives. */
function normalise(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Describes a difference between a value and the expected one, or nothing when they agree. */
function same(value: unknown, expected: unknown): string[] {
  const got = normalise(value);

  return jsonEqual(got, expected) ? [] : [`got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`];
}

function describeThrown(thrown: unknown): string {
  return thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
}

/** Compares a thrown value with an `errorExpect`, returning each difference. */
function compareError(thrown: unknown, expected: ErrorExpect): string[] {
  if (!(thrown instanceof Error)) {
    return [`threw a non-error: ${String(thrown)}`];
  }
  if (thrown.name !== expected.class) {
    return [`expected a ${expected.class}, got ${describeThrown(thrown)}`];
  }
  const problems: string[] = [];
  const located = thrown instanceof RuleApplicationError ? { index: thrown.ruleIndex, path: thrown.path, expectedIndex: expected.ruleIndex } : thrown instanceof RoundTripMismatchError ? { index: thrown.sampleIndex, path: thrown.path, expectedIndex: expected.sampleIndex } : undefined;
  if (located !== undefined) {
    if (located.expectedIndex !== undefined && located.index !== located.expectedIndex) {
      problems.push(`index ${String(located.index)}, expected ${String(located.expectedIndex)}`);
    }
    if (expected.path !== undefined && located.path !== expected.path) {
      problems.push(`path ${located.path}, expected ${expected.path}`);
    }
  }
  if (expected.message !== undefined && thrown.message !== expected.message) {
    problems.push(`message ${JSON.stringify(thrown.message)}, expected ${JSON.stringify(expected.message)}`);
  }
  for (const part of expected.messageContains ?? []) {
    if (!thrown.message.includes(part)) {
      problems.push(`message ${JSON.stringify(thrown.message)} lacks ${JSON.stringify(part)}`);
    }
  }
  if (expected.minIssues !== undefined && thrown instanceof CrosswalkSyntaxError && thrown.issues.length < expected.minIssues) {
    problems.push(`${String(thrown.issues.length)} issues, expected at least ${String(expected.minIssues)}`);
  }
  if (expected.issues !== undefined && thrown instanceof CrosswalkStructureError) {
    problems.push(...same(thrown.issues, expected.issues));
  }

  return problems;
}

/**
 * Runs `action` and compares its result or its thrown error with an expectation that is either `{ error }` or a success shape.
 * @param expectedError - The error the case expects, or `undefined` when it expects a result.
 * @param action - The behaviour under test.
 * @param compareSuccess - Compares a returned value with the expectation.
 * @returns Each difference.
 */
function expectOutcome(expectedError: ErrorExpect | undefined, action: () => unknown, compareSuccess: () => (value: unknown) => string[]): string[] {
  let value: unknown;
  try {
    value = action();
  } catch (thrown) {
    return expectedError === undefined ? [`threw ${describeThrown(thrown)}, expected a result`] : compareError(thrown, expectedError);
  }
  if (expectedError !== undefined) {
    return [`returned ${JSON.stringify(normalise(value))}, expected a ${expectedError.class}`];
  }

  return compareSuccess()(value);
}

function substitute(value: string, replacements: Readonly<Record<string, string>>): string {
  return Object.entries(replacements).reduce((current, [name, replacement]) => current.replaceAll(`{${name}}`, replacement), value);
}

function versionOf(path: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(REPOSITORY, path), "utf8"));

  return PackageSchema.parse(parsed).version;
}

/** One response a case's local server gives. */
interface Response {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

async function listen(responses: Readonly<Record<string, Response>>): Promise<{ readonly server: Server; readonly origin: string }> {
  const server = createServer((request, reply) => {
    const found = responses[request.url ?? ""] ?? { status: 404, body: "missing" };
    reply.writeHead(found.status, { "content-type": "application/json", ...found.headers }).end(found.body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the case server is not listening on a TCP port");
  }

  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
}

type CliCase = z.infer<(typeof KindSchemas)["cli"]>;

/** Compares one output stream with an expectation of exact text or of substrings. */
function compareStream(stream: string, got: string, expected: string | { readonly contains: readonly string[] }, replacements: Readonly<Record<string, string>>): string[] {
  if (typeof expected === "string") {
    const want = substitute(expected, replacements);

    return got === want ? [] : [`${stream} was ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`];
  }

  return expected.contains.flatMap((part) => (got.includes(substitute(part, replacements)) ? [] : [`${stream} ${JSON.stringify(got)} lacks ${JSON.stringify(substitute(part, replacements))}`]));
}

/** Writes a CLI case's files, runs the command in process and compares its status and streams. */
async function runCliCase(entry: CliCase, replacements: Readonly<Record<string, string>>): Promise<string[]> {
  for (const [name, content] of Object.entries(entry.files)) {
    const path = join(replacements["dir"] ?? "", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  let stdout = "";
  let stderr = "";
  const status = await runCli(entry.args.map((argument) => substitute(argument, replacements)), {
    readText: async (source) => (source === "-" ? entry.stdin : readSource(source)),
    writeStdout: (chunk) => {
      stdout += chunk;
    },
    writeStderr: (chunk) => {
      stderr += chunk;
    },
    version: replacements["version"] ?? "",
  });
  const { expect } = entry;
  const problems: string[] = status === expect.status ? [] : [`exit status ${String(status)}, expected ${String(expect.status)}`];
  if (expect.stdout !== undefined) {
    problems.push(...compareStream("stdout", stdout, expect.stdout, replacements));
  }
  if ("stdoutJson" in expect) {
    try {
      const printed: unknown = JSON.parse(stdout);
      problems.push(...same(printed, expect.stdoutJson));
    } catch {
      problems.push(`stdout is not JSON: ${JSON.stringify(stdout)}`);
    }
  }
  const wanted = expect.stderr;
  if (wanted?.equals !== undefined) {
    problems.push(...compareStream("stderr", stderr, wanted.equals, replacements));
  }
  if (wanted?.startsWith !== undefined && !stderr.startsWith(substitute(wanted.startsWith, replacements))) {
    problems.push(`stderr ${JSON.stringify(stderr)} does not start with ${JSON.stringify(substitute(wanted.startsWith, replacements))}`);
  }
  if (wanted?.contains !== undefined) {
    problems.push(...compareStream("stderr", stderr, { contains: wanted.contains }, replacements));
  }

  return problems;
}

async function cliCase(entry: CliCase): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "crossmap-conformance-"));
  const started = entry.server === undefined ? undefined : await listen(entry.server);
  try {
    return await runCliCase(entry, { dir, dirUrl: pathToFileURL(dir).href, version: versionOf("package.json"), origin: started?.origin ?? "" });
  } finally {
    started?.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (started === undefined) {
        resolve();

        return;
      }
      started.server.close(() => {
        resolve();
      });
    });
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolves an RFC 6901 pointer in a document. */
function pointerGet(document: unknown, pointer: string): unknown {
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((node, part) => {
      const step: unknown = typeof node === "object" && node !== null ? Reflect.get(node, part) : undefined;

      return step;
    }, document);
}

const SchemaRulesSchema = z.array(z.object({ properties: z.object({ op: z.object({ const: z.string() }) }), required: z.array(z.string()) }));

function schemaCase(entry: Case): string[] {
  const file = readFileSync(join(REPOSITORY, "schemas/crossmap.schema.json"), "utf8");
  const parsed: unknown = JSON.parse(file);
  const replacements = { trileanVersion: versionOf("node_modules/trilean/package.json"), packageVersion: versionOf("package.json") };
  switch (entry.kind) {
    case "schema-canonical":
      return canonicalize(parsed) === file ? [] : ["the schema file is not the RFC 8785 canonical form of its content"];
    case "schema-when-ref":
      return same(pointerGet(parsed, "/$defs/When/$ref"), substitute(KindSchemas["schema-when-ref"].parse(entry).expect, replacements));
    case "schema-pointer": {
      const wanted = KindSchemas["schema-pointer"].parse(entry);
      const value = pointerGet(parsed, wanted.pointer);

      return same(wanted.sorted === true && Array.isArray(value) ? value.toSorted((left, right) => String(left).localeCompare(String(right))) : value, typeof wanted.expect === "string" ? substitute(wanted.expect, replacements) : wanted.expect);
    }
    case "schema-rule-requires-to": {
      const wanted = KindSchemas["schema-rule-requires-to"].parse(entry);
      const rule = SchemaRulesSchema.parse(pointerGet(parsed, "/$defs/Crosswalk/properties/rules/items/oneOf")).find((candidate) => candidate.properties.op.const === wanted.op);

      return rule === undefined ? [`the schema has no rule for ${wanted.op}`] : same(rule.required.includes("to"), wanted.expect);
    }
    default: {
      const wanted = KindSchemas["schema-validates"].parse(entry);
      const ajv = new Ajv2020({ strict: false });
      const trilean: unknown = JSON.parse(readFileSync(join(REPOSITORY, "node_modules/trilean/schemas/trilean.schema.json"), "utf8"));
      ajv.addSchema(JsonObject.parse(trilean), `https://cdn.jsdelivr.net/npm/trilean@${replacements.trileanVersion}/schemas/trilean.schema.json`);
      const accepted = ajv.compile(JsonObject.parse(parsed))(wanted.document);

      return accepted === wanted.expect ? [] : [`the schema ${accepted ? "accepts" : "rejects"} the document, expected it to ${wanted.expect ? "accept" : "reject"} it`];
    }
  }
}

function errorMessage(entry: Case): string[] {
  const { error, expect } = KindSchemas["error-message"].parse(entry);
  const built = ((): Error | undefined => {
    switch (error.class) {
      case "CrosswalkStructureError":
        return new CrosswalkStructureError(error.issues);
      case "CrosswalkSyntaxError":
        return new CrosswalkSyntaxError(error.issues);
      case "RuleApplicationError":
        return new RuleApplicationError(error.ruleIndex, error.path, error.message);
      case "RoundTripMismatchError":
        return new RoundTripMismatchError(error.sampleIndex, error.path, error.message);
      default:
        return undefined;
    }
  })();

  return built === undefined ? [`unknown error class ${error.class}`] : same(built.message, expect.message);
}

function runCase(entry: Case): string[] {
  const wanted = KindSchemas.run.parse(entry);
  const input = structuredClone(wanted.document);
  const problems = expectOutcome(
    "error" in wanted.expect ? wanted.expect.error : undefined,
    () => {
      const crosswalk = parseCrosswalk(wanted.crosswalk);

      return wanted.direction === "encode" ? encode(crosswalk, input) : decode(crosswalk, input);
    },
    () => (value) => {
      const expected = wanted.expect;
      if ("error" in expected) {
        return [];
      }
      const found = same(value, expected.output);
      if (expected.outputText !== undefined && JSON.stringify(value) !== expected.outputText) {
        found.push(`serialised as ${JSON.stringify(value)}, expected ${expected.outputText}`);
      }

      return found;
    },
  );
  if (!jsonEqual(input, wanted.document)) {
    problems.push("mutated its input document");
  }

  return problems;
}

/** Executes the case kinds that concern parsing, paths and structure. */
function executeCore(entry: Case): string[] | undefined {
  switch (entry.kind) {
    case "path-parse": {
      const wanted = KindSchemas["path-parse"].parse(entry);

      return expectOutcome("error" in wanted.expect ? wanted.expect.error : undefined, () => parsePath(wanted.path), () => (value) => ("steps" in wanted.expect ? same(value, wanted.expect.steps) : []));
    }
    case "path-format": {
      const wanted = KindSchemas["path-format"].parse(entry);
      const printed = formatPath(parsePath(wanted.path));

      return [...same(printed, wanted.expect.canonical), ...(jsonEqual(normalise(parsePath(printed)), normalise(parsePath(wanted.path))) ? [] : ["the canonical spelling parses to a different path"])];
    }
    case "path-read": {
      const wanted = KindSchemas["path-read"].parse(entry);
      const found = readLocus(wanted.document, parsePath(wanted.path));

      return found === undefined ? same(false, wanted.expect.found) : [...same(true, wanted.expect.found), ...same(found.matches, wanted.expect.matches), ...same(found.empties, wanted.expect.empties)];
    }
    case "parse": {
      const wanted = KindSchemas.parse.parse(entry);

      return expectOutcome("error" in wanted.expect ? wanted.expect.error : undefined, () => parseCrosswalk(wanted.crosswalk), () => (value) => ("crosswalk" in wanted.expect ? same(value, wanted.expect.crosswalk) : []));
    }
    case "validate": {
      const wanted = KindSchemas.validate.parse(entry);

      return same({ issues: validateCrosswalk(parseCrosswalk(wanted.crosswalk)) }, wanted.expect);
    }
    case "rule-sides": {
      const wanted = KindSchemas["rule-sides"].parse(entry);
      const [rule] = parseCrosswalk({ source: "n", target: "s", rules: [wanted.rule] }).rules;

      return rule === undefined ? ["the rule did not parse"] : same(ruleSides(rule), wanted.expect);
    }
    case "error-message":
      return errorMessage(entry);
    default:
      return undefined;
  }
}

/**
 * Executes one case against the TypeScript implementation.
 * @param entry - The case.
 * @returns Each way the implementation's behaviour differs from the case's expectation; empty when it conforms.
 */
export async function executeCase(entry: Case): Promise<string[]> {
  try {
    if (!isKind(entry.kind)) {
      return [`unknown kind ${entry.kind}`];
    }
    const core = executeCore(entry);
    if (core !== undefined) {
      return core;
    }
    const kind: string = entry.kind;
    switch (kind) {
      case "run":
        return runCase(entry);
      case "round-trip": {
        const wanted = KindSchemas["round-trip"].parse(entry);

        return expectOutcome("error" in wanted.expect ? wanted.expect.error : undefined, () => {
          assertRoundTrip(parseCrosswalk(wanted.crosswalk), wanted.samples);

          return true;
        }, () => (value) => same(value, true));
      }
      case "cli":
        return await cliCase(KindSchemas.cli.parse(entry));
      case "is-url": {
        const wanted = KindSchemas["is-url"].parse(entry);

        return same(isUrl(wanted.argument), wanted.expect);
      }
      default:
        return schemaCase(entry);
    }
  } catch (error) {
    return [`the runner failed on this case: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`];
  }
}

// Runs the conformance corpus through the installed package: every case of every kind except the JSON Schema kinds (`schema-*`), which concern the schema file rather than the codec. The API cases call the package's exports, the path cases the binding's conformance exports, and the `cli` cases run the installed `crossmap` command as a child process, the way `npx crossmap` does. `scripts/test-packed.js` sets CROSSMAP_CORPUS to the repository's `conformance` directory.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertRoundTrip, CrosswalkStructureError, CrosswalkSyntaxError, decode, encode, parseCrosswalk, RoundTripMismatchError, RuleApplicationError, ruleSides, validateCrosswalk } from "crossmap";

// The installed package's directory, beside this file in the consumer: its package.json is not exported, so it is found by place, as npm installs it.
const installed = fileURLToPath(new URL("node_modules/crossmap/", import.meta.url));
// The binding's conformance exports are not part of the package's API, so they are reached by file, which is the module the package entry point has already started.
const binding = await import(pathToFileURL(join(installed, "dist/crossmap.js")).href);
const { version } = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
const bin = join(installed, "dist/cli.js");

const corpus = process.env.CROSSMAP_CORPUS;
assert.ok(corpus !== undefined, "CROSSMAP_CORPUS names the conformance directory");

const NOT_CORPUS = new Set(["runner", "generate", "fixtures", "schema"]);

function corpusFiles(directory, prefix = "") {
  return readdirSync(directory)
    .filter((name) => !name.startsWith(".") && !NOT_CORPUS.has(name))
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(path).isDirectory()) return corpusFiles(path, relative);

      return name.endsWith(".json") ? [relative] : [];
    });
}

const manifest = JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8"));
const files = corpusFiles(join(corpus, "crossmap")).map((name) => `crossmap/${name}`);
assert.deepEqual(files, Object.keys(manifest.files).sort(), "the corpus files are the ones the manifest lists");

/** Whether two JSON values are equal, objects irrespective of key order. */
function jsonEqual(left, right) {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  const leftKeys = Object.keys(left);
  const rightKeys = new Set(Object.keys(right));

  return leftKeys.length === rightKeys.size && leftKeys.every((key) => rightKeys.has(key) && jsonEqual(left[key], right[key]));
}

function normalise(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function same(value, expected) {
  const got = normalise(value);

  return jsonEqual(got, expected) ? [] : [`got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`];
}

function compareError(thrown, expected) {
  if (!(thrown instanceof Error)) return [`threw a non-error: ${String(thrown)}`];
  if (thrown.name !== expected.class) return [`expected a ${expected.class}, got ${thrown.name}: ${thrown.message}`];
  const problems = [];
  const located = thrown instanceof RuleApplicationError ? [thrown.ruleIndex, expected.ruleIndex] : thrown instanceof RoundTripMismatchError ? [thrown.sampleIndex, expected.sampleIndex] : undefined;
  if (located !== undefined) {
    if (located[1] !== undefined && located[0] !== located[1]) problems.push(`index ${String(located[0])}, expected ${String(located[1])}`);
    if (expected.path !== undefined && thrown.path !== expected.path) problems.push(`path ${thrown.path}, expected ${expected.path}`);
  }
  if (expected.message !== undefined && thrown.message !== expected.message) problems.push(`message ${JSON.stringify(thrown.message)}, expected ${JSON.stringify(expected.message)}`);
  for (const part of expected.messageContains ?? []) {
    if (!thrown.message.includes(part)) problems.push(`message ${JSON.stringify(thrown.message)} lacks ${JSON.stringify(part)}`);
  }
  if (expected.minIssues !== undefined && thrown instanceof CrosswalkSyntaxError && thrown.issues.length < expected.minIssues) problems.push(`${String(thrown.issues.length)} issues, expected at least ${String(expected.minIssues)}`);
  if (expected.issues !== undefined && thrown instanceof CrosswalkStructureError) problems.push(...same(thrown.issues, expected.issues));

  return problems;
}

/** Runs `action` against an expectation that is `{ error }` or a success shape checked by `compare`. */
function outcome(expect, action, compare) {
  const expectedError = "error" in expect ? expect.error : undefined;
  let value;
  try {
    value = action();
  } catch (thrown) {
    return expectedError === undefined ? [`threw ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}, expected a result`] : compareError(thrown, expectedError);
  }
  if (expectedError !== undefined) return [`returned ${JSON.stringify(normalise(value))}, expected a ${expectedError.class}`];

  return compare(value);
}

function substitute(text, replacements) {
  return Object.entries(replacements).reduce((current, [name, value]) => current.replaceAll(`{${name}}`, value), text);
}

function errorMessage(entry) {
  const error = entry.error;
  const issues = (error.issues ?? []).map((issue) => ({ message: issue.message, ruleIndex: issue.ruleIndex ?? -1 }));
  const built = {
    CrosswalkStructureError: () => new CrosswalkStructureError(issues),
    CrosswalkSyntaxError: () => new CrosswalkSyntaxError(issues),
    RuleApplicationError: () => new RuleApplicationError(error.ruleIndex ?? 0, error.path ?? "", error.message ?? ""),
    RoundTripMismatchError: () => new RoundTripMismatchError(error.sampleIndex ?? 0, error.path ?? "", error.message ?? ""),
  }[error.class];

  return built === undefined ? [`unknown error class ${error.class}`] : same(built().message, entry.expect.message);
}

function runCase(entry) {
  const input = structuredClone(entry.document);
  const problems = outcome(
    entry.expect,
    () => {
      const crosswalk = parseCrosswalk(entry.crosswalk);

      return entry.direction === "encode" ? encode(crosswalk, input) : decode(crosswalk, input);
    },
    (value) => {
      const found = same(value, entry.expect.output);
      if (entry.expect.outputText !== undefined && JSON.stringify(value) !== entry.expect.outputText) found.push(`serialised as ${JSON.stringify(value)}, expected ${entry.expect.outputText}`);

      return found;
    },
  );
  if (!jsonEqual(input, entry.document)) problems.push("mutated its input document");

  return problems;
}

async function listen(responses) {
  const server = createServer((request, reply) => {
    const found = responses[request.url ?? ""] ?? { status: 404, body: "missing" };
    reply.writeHead(found.status, { "content-type": "application/json", ...found.headers }).end(found.body);
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  return { server, origin: `http://127.0.0.1:${String(server.address().port)}` };
}

/** Runs the installed command without blocking this process, so a server in this process can answer it. */
async function runCommand(args, stdin) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function compareStream(stream, got, expected, replacements) {
  if (typeof expected === "string") {
    const want = substitute(expected, replacements);

    return got === want ? [] : [`${stream} was ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`];
  }

  return expected.contains.flatMap((part) => (got.includes(substitute(part, replacements)) ? [] : [`${stream} ${JSON.stringify(got)} lacks ${JSON.stringify(substitute(part, replacements))}`]));
}

async function cliCase(entry) {
  const dir = mkdtempSync(join(tmpdir(), "crossmap-conformance-"));
  const started = entry.server === undefined ? undefined : await listen(entry.server);
  try {
    const replacements = { dir, dirUrl: pathToFileURL(dir).href, version, origin: started?.origin ?? "" };
    for (const [name, content] of Object.entries(entry.files ?? {})) {
      const path = join(dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    const result = await runCommand(
      entry.args.map((argument) => substitute(argument, replacements)),
      entry.stdin ?? "",
    );
    const { expect } = entry;
    const problems = result.status === expect.status ? [] : [`exit status ${String(result.status)}, expected ${String(expect.status)}`];
    if (expect.stdout !== undefined) problems.push(...compareStream("stdout", result.stdout, expect.stdout, replacements));
    if ("stdoutJson" in expect) {
      try {
        problems.push(...same(JSON.parse(result.stdout), expect.stdoutJson));
      } catch {
        problems.push(`stdout is not JSON: ${JSON.stringify(result.stdout)}`);
      }
    }
    const wanted = expect.stderr;
    if (wanted?.equals !== undefined) problems.push(...compareStream("stderr", result.stderr, wanted.equals, replacements));
    if (wanted?.startsWith !== undefined && !result.stderr.startsWith(substitute(wanted.startsWith, replacements))) problems.push(`stderr ${JSON.stringify(result.stderr)} does not start with ${JSON.stringify(substitute(wanted.startsWith, replacements))}`);
    if (wanted?.contains !== undefined) problems.push(...compareStream("stderr", result.stderr, { contains: wanted.contains }, replacements));

    return problems;
  } finally {
    if (started !== undefined) {
      started.server.closeAllConnections();
      await new Promise((resolve) => {
        started.server.close(resolve);
      });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One executor per kind this suite runs. A kind the corpus has that is neither here nor a JSON Schema kind fails the suite. */
const EXECUTORS = {
  "path-parse": (entry) => outcome(entry.expect, () => binding.conformancePathParse(entry.path), (value) => ("steps" in entry.expect ? same(value, entry.expect.steps) : [])),
  "path-format": (entry) => {
    const printed = binding.conformancePathFormat(entry.path);

    return [...same(printed, entry.expect.canonical), ...(jsonEqual(binding.conformancePathParse(printed), binding.conformancePathParse(entry.path)) ? [] : ["the canonical spelling parses to a different path"])];
  },
  "path-read": (entry) => {
    const read = binding.conformancePathRead(entry.document, entry.path);

    return read.found ? [...same(true, entry.expect.found), ...same(read.matches, entry.expect.matches), ...same(read.empties, entry.expect.empties)] : same(false, entry.expect.found);
  },
  parse: (entry) => outcome(entry.expect, () => parseCrosswalk(entry.crosswalk), (value) => ("crosswalk" in entry.expect ? same(value, entry.expect.crosswalk) : [])),
  validate: (entry) => same({ issues: validateCrosswalk(parseCrosswalk(entry.crosswalk)) }, entry.expect),
  "rule-sides": (entry) => same(ruleSides(parseCrosswalk({ source: "n", target: "s", rules: [entry.rule] }).rules[0]), entry.expect),
  "error-message": errorMessage,
  run: runCase,
  "round-trip": (entry) =>
    outcome(
      entry.expect,
      () => {
        assertRoundTrip(parseCrosswalk(entry.crosswalk), entry.samples);

        return true;
      },
      (value) => same(value, true),
    ),
  cli: cliCase,
  "is-url": (entry) => same(binding.cliIsUrl(entry.argument), entry.expect),
};

const isSchemaKind = (kind) => kind.startsWith("schema-");

let executed = 0;
let skipped = 0;
for (const file of files) {
  const { cases } = JSON.parse(readFileSync(join(corpus, file), "utf8"));
  const marked = new Set(manifest.files[file].skip.rust);
  assert.equal(cases.length, manifest.files[file].cases, `${file} holds the number of cases the manifest records`);
  const runnable = cases.filter((entry) => !isSchemaKind(entry.kind));
  if (runnable.length === 0) continue;
  describe(file, () => {
    for (const entry of runnable) {
      const execute = EXECUTORS[entry.kind];
      if (marked.has(entry.id) || entry.skip === "rust") {
        skipped += 1;
        it(entry.id, { skip: entry.reason ?? "marked to skip on rust" }, () => {});
        continue;
      }
      executed += 1;
      it(entry.id, async () => {
        assert.ok(execute !== undefined, `no executor for the kind ${entry.kind}`);
        assert.deepEqual(await execute(entry), [], entry.from);
      });
    }
  });
}

describe("the corpus run", () => {
  it("executed cases, and only skipped what is marked", () => {
    assert.ok(executed > 0, "the corpus has cases to run");
    console.log(`conformance: ${String(executed)} cases executed, ${String(skipped)} skipped as marked`);
  });
});

// Runs the package's tests against the package as a consumer gets it: `npm pack` writes the tarball, which is checked to hold exactly the published files, then installed into a fresh directory outside the repository with nothing else in it, and the tests (copied beside it) import `crossmap` by name and run the installed `crossmap` command, in plain Node. Run it after `npm run build`.
//
// The fresh directory is removed afterwards; the exit status is the test run's.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const corpus = fileURLToPath(new URL("../../../conformance", import.meta.url));

/** The files the tarball must hold: the manifest and readme npm always adds, the built `dist` and the copied schemas. A file added to the build, or one that stops being built, is a deliberate change here. */
const PUBLISHED = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  "dist/api.d.ts",
  "dist/api.js",
  "dist/cli.js",
  "dist/crossmap.js",
  "dist/crossmap_bg.wasm",
  "dist/crossmap_inline.js",
  "dist/errors.d.ts",
  "dist/errors.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/init.browser.js",
  "dist/init.node.js",
  "dist/init.workerd.js",
  "dist/read-source.js",
]);

function npm(args, cwd) {
  const result = spawnSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} exited ${String(result.status)}`);
  }

  return result.stdout;
}

const work = mkdtempSync(join(tmpdir(), "crossmap-packed-"));
let status = 1;
try {
  const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", work], packageDirectory));
  const files = packed.files.map((file) => file.path);
  const schemas = files.filter((path) => /^schemas\/[^/]+\.schema\.json$/u.test(path));
  const unexpected = files.filter((path) => !PUBLISHED.has(path) && !schemas.includes(path));
  const missing = [...PUBLISHED].filter((path) => !files.includes(path));
  if (unexpected.length > 0 || missing.length > 0 || schemas.length === 0) {
    throw new Error(`the tarball differs from the published file list: unexpected ${JSON.stringify(unexpected)}, missing ${JSON.stringify(missing)}, schemas ${JSON.stringify(schemas)}`);
  }
  console.log(`${packed.filename}: ${String(files.length)} files (${schemas.join(", ")})`);

  const consumer = join(work, "consumer");
  cpSync(join(packageDirectory, "test"), consumer, { recursive: true });
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ name: "crossmap-consumer", private: true, type: "module" }, null, 2)}\n`);
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", join(work, packed.filename)], consumer);

  const tests = readdirSync(consumer).filter((name) => name.endsWith(".test.js"));
  const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
    cwd: consumer,
    stdio: "inherit",
    env: { ...process.env, CROSSMAP_CORPUS: corpus },
  });
  status = run.status ?? 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exitCode = status;

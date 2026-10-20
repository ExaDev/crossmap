// Runs the built command (dist-cli/crossmap.mjs) as a child process, the way `npx crossmap` does, so what is checked is the shipped file: its shebang line, its imports resolving against the installed dependencies, its stdin handling and its exit status. The `bin` entry in package.json must name that same file, which is checked here too. The build runs first through turbo.json's `_test` dependency.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const binPath = fileURLToPath(new URL("../dist-cli/crossmap.mjs", import.meta.url));
const crosswalkPath = fileURLToPath(new URL("./fixtures/consignment.crosswalk.json", import.meta.url));

function runCli(args: readonly string[], stdin?: string) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8", input: stdin });
}

describe("the crossmap command", () => {
  it("is the file package.json's bin names, with a node shebang, and ships in the tarball", () => {
    const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));

    expect(manifest).toMatchObject({ bin: { crossmap: "./dist-cli/crossmap.mjs" } });
    expect(typeof manifest === "object" && manifest !== null && "files" in manifest ? manifest.files : undefined).toContain("dist-cli");
    expect(existsSync(binPath)).toBe(true);
    expect(readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("encodes a document read from standard input and exits 0", () => {
    const result = runCli(["encode", crosswalkPath, "-"], JSON.stringify({ consignmentId: "MF-2041", weightGrams: 1250000 }));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: "MF-2041", weightKilograms: 1250 });
  });

  it("exits 1 with the library's message on standard error when a rule cannot apply", () => {
    const result = runCli(["encode", crosswalkPath, "-"], "{}");

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/rule 0 \(consignmentId\)/);
    expect(result.stdout).toBe("");
  });

  it("exits 2 for a file that does not exist", () => {
    const result = runCli(["validate", "no-such-crosswalk.json"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/cannot read no-such-crosswalk\.json/);
  });

  it("reports the package version", () => {
    const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const version = typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : undefined;

    expect(runCli(["--version"]).stdout.trim()).toBe(version);
  });
});

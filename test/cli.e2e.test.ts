// Runs the built command (dist-cli/crossmap.mjs) as a child process, the way `npx crossmap` does, so what is checked is the shipped file: its shebang line, its imports resolving against the installed dependencies, its stdin handling and its exit status. The `bin` entry in package.json must name that same file, which is checked here too. The build runs first through turbo.json's `_test` dependency.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const binPath = fileURLToPath(new URL("../dist-cli/crossmap.mjs", import.meta.url));
const crosswalkPath = fileURLToPath(new URL("./fixtures/consignment.crosswalk.json", import.meta.url));
const documentPath = fileURLToPath(new URL("./fixtures/consignment.document.json", import.meta.url));

function runCli(args: readonly string[], stdin?: string) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8", input: stdin });
}

/** Runs the command without blocking this process, which a test needs when the command talks to a server in this same process: `spawnSync` would hold the event loop and the server could never answer. */
async function runCliAsync(args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
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

describe("the crossmap command reading URLs", () => {
  const crosswalkText = readFileSync(crosswalkPath, "utf8");
  const documentText = readFileSync(documentPath, "utf8");
  const encoded = { id: "MF-2041", weightKilograms: 1250 };
  const bodies = new Map<string, { status: number; body: string }>([
    ["/crosswalk.json", { status: 200, body: crosswalkText }],
    ["/document.json", { status: 200, body: documentText }],
    ["/shared.json", { status: 200, body: JSON.stringify(encoded) }],
    ["/samples.json", { status: 200, body: `[${documentText}]` }],
    ["/not-json", { status: 200, body: "<html>" }],
    ["/gone", { status: 410, body: "gone" }],
  ]);
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const entry = bodies.get(request.url ?? "") ?? { status: 404, body: "missing" };
      response.writeHead(entry.status, { "content-type": "application/json" }).end(entry.body);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("the server is not listening on a TCP port");
    origin = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("encodes a local document with a remote crosswalk", async () => {
    const result = await runCliAsync(["encode", `${origin}/crosswalk.json`, documentPath]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(encoded);
  });

  it("encodes a remote document with a local crosswalk", async () => {
    const result = await runCliAsync(["encode", crosswalkPath, `${origin}/document.json`]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(encoded);
  });

  it("encodes when both the crosswalk and the document are remote", async () => {
    const result = await runCliAsync(["encode", `${origin}/crosswalk.json`, `${origin}/document.json`]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(encoded);
  });

  it("decodes, validates and round-trips from URLs too", async () => {
    const [decoded, validated, roundTripped] = await Promise.all([
      runCliAsync(["decode", `${origin}/crosswalk.json`, `${origin}/shared.json`]),
      runCliAsync(["validate", `${origin}/crosswalk.json`]),
      runCliAsync(["round-trip", `${origin}/crosswalk.json`, `${origin}/samples.json`]),
    ]);

    expect(JSON.parse(decoded.stdout)).toEqual(JSON.parse(documentText));
    expect([decoded.status, validated.status, roundTripped.status]).toEqual([0, 0, 0]);
    expect(validated.stdout + roundTripped.stdout).toBe("");
  });

  it("reads a data: URL and a file: URL", async () => {
    const [data, file] = await Promise.all([
      runCliAsync(["encode", crosswalkPath, `data:application/json,${encodeURIComponent(documentText)}`]),
      runCliAsync(["validate", pathToFileURL(crosswalkPath).href]),
    ]);

    expect(JSON.parse(data.stdout)).toEqual(encoded);
    expect(file.status).toBe(0);
  });

  it("exits 2 naming the URL and the status for a non-2xx response", async () => {
    const result = await runCliAsync(["validate", `${origin}/gone`]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`cannot read ${origin}/gone: HTTP 410`);
    expect(result.stdout).toBe("");
  });

  it("exits 2 naming the URL for a body that is not JSON", async () => {
    const result = await runCliAsync(["validate", `${origin}/not-json`]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`${origin}/not-json is not valid JSON`);
  });

  it("exits 2 naming the URL when nothing is listening", async () => {
    const result = await runCliAsync(["validate", "http://127.0.0.1:1/crosswalk.json"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("cannot read http://127.0.0.1:1/crosswalk.json: ");
  });

  it("keeps exit 1 for a remote crosswalk the codec rejects", async () => {
    bodies.set("/bad-crosswalk.json", { status: 200, body: '{"rules":"none"}' });
    const result = await runCliAsync(["validate", `${origin}/bad-crosswalk.json`]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^crosswalk syntax error: /);
  });

  it("exits 2 for a scheme it does not read, naming the scheme and the supported ones", async () => {
    const urls = ["ftp://example.test/crosswalk.json", "s3://bucket/crosswalk.json"];
    const results = await Promise.all(urls.map(async (url) => runCliAsync(["validate", url])));

    results.forEach((result, index) => {
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`cannot read ${urls[index] ?? ""}: unsupported scheme`);
      expect(result.stderr).toContain("http:, https:, data:, file:");
    });
  });
});

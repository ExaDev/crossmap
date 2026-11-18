// Runs the installed `crossmap` command as a child process, the way `npx crossmap` does, so what is checked is the shipped file: its shebang line, its imports resolving inside the installed package, its standard input and its exit status. The scenarios are the TypeScript package's test/cli.e2e.test.ts, against the command the wasm package ships.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// The installed package's directory, beside this file in the consumer: its package.json is not exported, so it is found by place, as npm installs it.
const installed = fileURLToPath(new URL("node_modules/crossmap/", import.meta.url));
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
const binPath = join(installed, manifest.bin.crossmap);
// The command as npm links it into the consumer's node_modules/.bin, which is what `npx crossmap` runs.
const linkedBin = fileURLToPath(new URL("node_modules/.bin/crossmap", import.meta.url));
const crosswalkPath = fileURLToPath(new URL("./fixtures/consignment.crosswalk.json", import.meta.url));
const documentPath = fileURLToPath(new URL("./fixtures/consignment.document.json", import.meta.url));

function runCli(args, stdin) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8", input: stdin });
}

/** Runs the command without blocking this process, which a test needs when the command talks to a server in this same process: `spawnSync` would hold the event loop and the server could never answer. */
async function runCliAsync(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args]);
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
    child.stdin.end();
  });
}

describe("the crossmap command", () => {
  it("is the file package.json's bin names, with a node shebang, ships in the tarball and is linked into .bin", () => {
    assert.deepEqual(manifest.bin, { crossmap: "./dist/cli.js" });
    assert.ok(manifest.files.includes("dist"));
    assert.ok(existsSync(binPath));
    assert.ok(readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env node\n"));
    const linked = spawnSync(linkedBin, ["--version"], { encoding: "utf8" });
    assert.equal(linked.status, 0);
    assert.equal(linked.stdout.trim(), manifest.version);
  });

  it("encodes a document read from standard input and exits 0", () => {
    const result = runCli(["encode", crosswalkPath, "-"], JSON.stringify({ consignmentId: "MF-2041", weightGrams: 1250000 }));

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { id: "MF-2041", weightKilograms: 1250 });
  });

  it("exits 1 with the library's message on standard error when a rule cannot apply", () => {
    const result = runCli(["encode", crosswalkPath, "-"], "{}");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /rule 0 \(consignmentId\)/u);
    assert.equal(result.stdout, "");
  });

  it("exits 2 for a file that does not exist", () => {
    const result = runCli(["validate", "no-such-crosswalk.json"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /cannot read no-such-crosswalk\.json/u);
  });

  it("reports the package version", () => {
    assert.equal(runCli(["--version"]).stdout.trim(), manifest.version);
  });

  it("exits 2 with the usage text for no command", () => {
    const result = runCli([]);

    assert.equal(result.status, 2);
    assert.ok(result.stderr.startsWith("expected a command and its files\n\nUsage: crossmap encode"));
  });

  it("stops quietly when standard output closes early, with the status it settled on", async () => {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [binPath, "encode", crosswalkPath, documentPath]);
      let stderr = "";
      // The reader goes away before the command writes, as `| head -c 0` does, so its write fails with EPIPE.
      child.stdout.destroy();
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        resolve({ status, stderr });
      });
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });
});

describe("the crossmap command reading URLs", () => {
  const crosswalkText = readFileSync(crosswalkPath, "utf8");
  const documentText = readFileSync(documentPath, "utf8");
  const encoded = { id: "MF-2041", weightKilograms: 1250 };
  const bodies = new Map([
    ["/crosswalk.json", { status: 200, body: crosswalkText }],
    ["/document.json", { status: 200, body: documentText }],
    ["/shared.json", { status: 200, body: JSON.stringify(encoded) }],
    ["/samples.json", { status: 200, body: `[${documentText}]` }],
    ["/not-json", { status: 200, body: "<html>" }],
    ["/gone", { status: 410, body: "gone" }],
  ]);
  let server;
  let origin;

  before(async () => {
    server = createServer((request, response) => {
      const entry = bodies.get(request.url ?? "") ?? { status: 404, body: "missing" };
      response.writeHead(entry.status, { "content-type": "application/json" }).end(entry.body);
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${String(server.address().port)}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });

  it("encodes a local document with a remote crosswalk", async () => {
    const result = await runCliAsync(["encode", `${origin}/crosswalk.json`, documentPath]);

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), encoded);
  });

  it("encodes a remote document with a local crosswalk", async () => {
    const result = await runCliAsync(["encode", crosswalkPath, `${origin}/document.json`]);

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), encoded);
  });

  it("encodes when both the crosswalk and the document are remote", async () => {
    const result = await runCliAsync(["encode", `${origin}/crosswalk.json`, `${origin}/document.json`]);

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), encoded);
  });

  it("decodes, validates and round-trips from URLs too", async () => {
    const [decoded, validated, roundTripped] = await Promise.all([
      runCliAsync(["decode", `${origin}/crosswalk.json`, `${origin}/shared.json`]),
      runCliAsync(["validate", `${origin}/crosswalk.json`]),
      runCliAsync(["round-trip", `${origin}/crosswalk.json`, `${origin}/samples.json`]),
    ]);

    assert.deepEqual(JSON.parse(decoded.stdout), JSON.parse(documentText));
    assert.deepEqual([decoded.status, validated.status, roundTripped.status], [0, 0, 0]);
    assert.equal(validated.stdout + roundTripped.stdout, "");
  });

  it("reads a data: URL and a file: URL", async () => {
    const [data, file] = await Promise.all([runCliAsync(["encode", crosswalkPath, `data:application/json,${encodeURIComponent(documentText)}`]), runCliAsync(["validate", pathToFileURL(crosswalkPath).href])]);

    assert.deepEqual(JSON.parse(data.stdout), encoded);
    assert.equal(file.status, 0);
  });

  it("exits 2 naming the URL and the status for a non-2xx response", async () => {
    const result = await runCliAsync(["validate", `${origin}/gone`]);

    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes(`cannot read ${origin}/gone: HTTP 410`));
    assert.equal(result.stdout, "");
  });

  it("exits 2 naming the URL for a body that is not JSON", async () => {
    const result = await runCliAsync(["validate", `${origin}/not-json`]);

    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes(`${origin}/not-json is not valid JSON`));
  });

  it("exits 2 naming the URL when nothing is listening", async () => {
    const result = await runCliAsync(["validate", "http://127.0.0.1:1/crosswalk.json"]);

    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes("cannot read http://127.0.0.1:1/crosswalk.json: "));
  });

  it("keeps exit 1 for a remote crosswalk the codec rejects", async () => {
    bodies.set("/bad-crosswalk.json", { status: 200, body: '{"rules":"none"}' });
    const result = await runCliAsync(["validate", `${origin}/bad-crosswalk.json`]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^crosswalk syntax error: /u);
  });

  it("exits 2 for a scheme it does not read, naming the scheme and the supported ones", async () => {
    const urls = ["ftp://example.test/crosswalk.json", "s3://bucket/crosswalk.json"];
    const results = await Promise.all(urls.map(async (url) => runCliAsync(["validate", url])));

    results.forEach((result, index) => {
      assert.equal(result.status, 2);
      assert.ok(result.stderr.includes(`cannot read ${urls[index]}: unsupported scheme`));
      assert.ok(result.stderr.includes("http:, https:, data:, file:"));
    });
  });
});

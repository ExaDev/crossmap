import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FETCH_TIMEOUT_MS, isUrl, MAX_RESPONSE_BYTES, readSource } from "./read-source";

function portOf(listening: Server): number {
  const address = listening.address();
  if (typeof address !== "object" || address === null) throw new Error("the server is not listening on a TCP port");

  return address.port;
}

const HTTP = { ok: 200, found: 302, notFound: 404 } as const;

/** How long a test server pauses between the parts of a body, so the client sees them as separate chunks. */
const CHUNK_GAP_MS = 20;

/** The timeout used where a test needs the request to expire: short, because the server will never answer. */
const EXPIRY_MS = 50;

async function listen(listening: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    listening.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
}

async function close(listening: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    listening.close(() => {
      resolve();
    });
  });
}

/** Limits small enough to reach in a test, with a timeout long enough that a healthy local response never trips it. */
const SMALL = { timeoutMs: 5_000, maxBytes: 64 } as const;

describe("isUrl", () => {
  it("takes an argument as a URL only when it starts with a scheme of two or more characters and a colon", () => {
    for (const url of ["http://a.test/x.json", "https://a.test", "data:application/json,{}", "file:///tmp/x.json", "ftp://a.test/x", "s3://bucket/x.json", "git+ssh://a.test/x", "HTTPS://A.TEST/X"]) {
      expect(isUrl(url), url).toBe(true);
    }
  });

  it("keeps paths, standard input and Windows drive paths as paths", () => {
    for (const path of ["-", "x.json", "./x.json", "../a/x.json", "/tmp/x.json", "C:\\x.json", "C:/x.json", "c:x.json", "dir/a:b.json", "1a:b.json"]) {
      expect(isUrl(path), path).toBe(false);
    }
  });
});

describe("the limits", () => {
  it("are positive, and the size cap is a whole number of bytes", () => {
    expect(FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_RESPONSE_BYTES)).toBe(true);
    expect(MAX_RESPONSE_BYTES).toBeGreaterThan(0);
  });
});

describe("readSource", () => {
  let server: Server;
  let base: string;
  const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse) => void>();
  const scratch = mkdtempSync(join(tmpdir(), "crossmap-read-source-"));

  beforeAll(async () => {
    server = createServer((request, response) => {
      const handler = handlers.get(request.url ?? "");
      if (handler === undefined) {
        response.writeHead(HTTP.notFound, { "content-type": "text/plain" }).end("missing");

        return;
      }
      handler(request, response);
    });
    await listen(server);
    base = `http://127.0.0.1:${String(portOf(server))}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await close(server);
    rmSync(scratch, { recursive: true, force: true });
  });

  it("reads an http body", async () => {
    handlers.set("/ok", (_request, response) => {
      response.writeHead(HTTP.ok).end('{"a":1}');
    });

    expect(await readSource(`${base}/ok`, SMALL)).toBe('{"a":1}');
  });

  it("follows a redirect", async () => {
    handlers.set("/from", (_request, response) => {
      response.writeHead(HTTP.found, { location: "/ok" }).end();
    });
    handlers.set("/ok", (_request, response) => {
      response.writeHead(HTTP.ok).end("target");
    });

    expect(await readSource(`${base}/from`, SMALL)).toBe("target");
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = Buffer.from("é€", "utf8");
    handlers.set("/split", (_request, response) => {
      response.write(bytes.subarray(0, 1));
      setTimeout(() => {
        response.end(bytes.subarray(1));
      }, CHUNK_GAP_MS);
    });

    expect(await readSource(`${base}/split`, SMALL)).toBe("é€");
  });

  it("rejects a non-2xx status, naming the status", async () => {
    await expect(readSource(`${base}/absent`, SMALL)).rejects.toThrow(/^HTTP 404 Not Found$/);
  });

  it("rejects a body whose declared length is over the cap, without reading it", async () => {
    handlers.set("/declared", (_request, response) => {
      response.writeHead(HTTP.ok, { "content-length": String(SMALL.maxBytes + 1) }).end("x".repeat(SMALL.maxBytes + 1));
    });

    await expect(readSource(`${base}/declared`, SMALL)).rejects.toThrow(/over the 64 byte limit/);
  });

  it("rejects a streamed body that grows past the cap with no declared length", async () => {
    handlers.set("/stream", (_request, response) => {
      response.writeHead(HTTP.ok, { "transfer-encoding": "chunked" });
      response.write("x".repeat(SMALL.maxBytes));
      setTimeout(() => {
        response.end("y");
      }, CHUNK_GAP_MS);
    });

    await expect(readSource(`${base}/stream`, SMALL)).rejects.toThrow(/over the 64 byte limit/);
  });

  it("accepts a body of exactly the cap", async () => {
    handlers.set("/exact", (_request, response) => {
      response.writeHead(HTTP.ok).end("x".repeat(SMALL.maxBytes));
    });

    expect(await readSource(`${base}/exact`, SMALL)).toHaveLength(SMALL.maxBytes);
  });

  it("rejects a server that never answers once the timeout passes", async () => {
    handlers.set("/silent", () => undefined);

    await expect(readSource(`${base}/silent`, { ...SMALL, timeoutMs: EXPIRY_MS })).rejects.toThrow(/no response within 50 ms/);
  });

  it("rejects a body that stalls after the headers once the timeout passes", async () => {
    handlers.set("/stall", (_request, response) => {
      response.writeHead(HTTP.ok, { "transfer-encoding": "chunked" });
      response.write("{");
    });

    await expect(readSource(`${base}/stall`, { ...SMALL, timeoutMs: EXPIRY_MS })).rejects.toThrow(/not complete within 50 ms/);
  });

  it("rejects a connection that is refused, with the cause", async () => {
    const unused = createServer();
    await listen(unused);
    const port = portOf(unused);
    await close(unused);

    await expect(readSource(`http://127.0.0.1:${String(port)}/`, SMALL)).rejects.toThrow(/fetch failed \(.*ECONNREFUSED/);
  });

  it("reads a data URL, percent-encoded or base64", async () => {
    expect(await readSource('data:application/json,{"a":%201}', SMALL)).toBe('{"a": 1}');
    expect(await readSource(`data:application/json;base64,${Buffer.from('{"b":2}').toString("base64")}`, SMALL)).toBe('{"b":2}');
  });

  it("applies the cap to a data URL", async () => {
    await expect(readSource(`data:text/plain,${"x".repeat(SMALL.maxBytes + 1)}`, SMALL)).rejects.toThrow(/over the 64 byte limit/);
  });

  it("reads a file URL and a plain path to the same text", async () => {
    const path = join(scratch, "a b.json");
    writeFileSync(path, '{"file":true}');

    expect(await readSource(pathToFileURL(path).href, SMALL)).toBe('{"file":true}');
    expect(await readSource(path, SMALL)).toBe('{"file":true}');
  });

  it("rejects a file URL for a missing file and one naming a remote host", async () => {
    await expect(readSource(pathToFileURL(join(scratch, "absent.json")).href, SMALL)).rejects.toThrow(/ENOENT/);
    await expect(readSource("file://example.test/x.json", SMALL)).rejects.toThrow(/host/);
  });

  it("rejects any other scheme as unsupported, listing the supported ones", async () => {
    const urls = ["ftp://example.test/x.json", "s3://bucket/x.json", "git+ssh://example.test/x"];

    await Promise.all(
      urls.map(async (url) => {
        await expect(readSource(url, SMALL), url).rejects.toThrow(/^unsupported scheme [a-z+0-9]+: \(supported: http:, https:, data:, file:, plain paths and -\)$/);
      }),
    );
  });
});

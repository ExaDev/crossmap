// Reading the text a command-line argument names, for the `crossmap` command's Node shim: standard input for `-`, a URL when the argument starts with a scheme (the binding decides, by the native command's rule), otherwise a file path. The native command reads the same sources with the same bounds and the same exit statuses; this is its reader in Node.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cliIsUrl } from "./crossmap.js";

/** The argument that stands for standard input. */
export const STDIN = "-";

/** How long one remote read may take, from sending the request to the last byte of the body. A command has no one watching a progress indicator, so a server that accepts the connection and then stalls would otherwise hang it for as long as the socket stays open. Generous enough for a slow link to deliver a document within MAX_RESPONSE_BYTES. The native command's FETCH_TIMEOUT. */
export const FETCH_TIMEOUT_MS = 30_000;

const BYTES_PER_MIB = 1024 * 1024;

/** The most bytes a remote body may hold: 64 MiB. The body is buffered whole and then parsed as one JSON text, so the peak memory is a multiple of its size, and a server (or a redirect to one) that streams without end would otherwise grow the process until it is killed. The native command's MAX_RESPONSE_BYTES. */
export const MAX_RESPONSE_BYTES = 64 * BYTES_PER_MIB;

/** The URL schemes the command reads, in the order the error for any other scheme lists them. */
const SUPPORTED_SCHEMES = ["http", "https", "data", "file"];

function describe(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;

  return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
}

/** Reads a response body as UTF-8 text, refusing it as soon as it is known to exceed the cap, whether from its declared length or from the bytes received (the sink throwing makes `pipeTo` cancel the source, so an endless body stops being read). */
async function readBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) throw new Error(`the response is ${String(declared)} bytes, over the ${String(maxBytes)} byte limit`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let received = 0;
  await response.body?.pipeTo(
    new WritableStream({
      write: (chunk) => {
        received += chunk.byteLength;
        if (received > maxBytes) throw new Error(`the response is over the ${String(maxBytes)} byte limit`);
        text += decoder.decode(chunk, { stream: true });
      },
    }),
  );

  return text + decoder.decode();
}

async function fetchText(url, timeoutMs, maxBytes) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error(`no response within ${String(timeoutMs)} ms`, { cause: error });
    throw new Error(describe(error), { cause: error });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${String(response.status)} ${response.statusText}`.trimEnd());
  }
  try {
    return await readBody(response, maxBytes);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error(`the body was not complete within ${String(timeoutMs)} ms`, { cause: error });
    throw new Error(describe(error), { cause: error });
  }
}

/**
 * Reads the text a command-line argument names. `http:`, `https:` and `data:` go through `fetch`, which follows redirects; `file:` is turned into a path and read as paths are. Any other scheme is refused.
 * @param {string} argument - A path, `-`, or a URL.
 * @returns {Promise<string>} The text, decoded as UTF-8.
 * @throws When the source is unreadable, unsupported, slow or larger than the cap. The message does not repeat the argument; the caller names it.
 */
export async function readSource(argument) {
  if (argument === STDIN) return readFileSync(0, "utf8");
  if (!cliIsUrl(argument)) return readFileSync(argument, "utf8");
  const url = new URL(argument);
  const scheme = url.protocol.slice(0, -1);
  if (!SUPPORTED_SCHEMES.includes(scheme)) {
    throw new Error(`unsupported scheme ${url.protocol} (supported: ${SUPPORTED_SCHEMES.map((name) => `${name}:`).join(", ")}, plain paths and -)`);
  }

  return scheme === "file" ? readFileSync(fileURLToPath(url), "utf8") : fetchText(argument, FETCH_TIMEOUT_MS, MAX_RESPONSE_BYTES);
}

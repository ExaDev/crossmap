import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The path that stands for standard input. */
export const STDIN = "-";

/**
 * How long one remote read may take, from sending the request to the last byte of the body. A command has no user watching a progress indicator, so a server that accepts the connection and then stalls would otherwise hang it for as long as the socket stays open; this bounds that. Generous enough for a slow link to deliver a document within MAX_RESPONSE_BYTES.
 */
export const FETCH_TIMEOUT_MS = 30_000;

const BYTES_PER_KIB = 1024;
const RESPONSE_LIMIT_MIB = 64;

/**
 * The most bytes a remote body may hold: 64 MiB. The body is buffered whole and then parsed as one JSON text, so the peak memory is a multiple of its size, and a server (or a redirect to one) that streams without end would otherwise grow the process until it is killed. A crosswalk is a few kilobytes and a document or sample set is data a person chose to apply it to, so the bound sits well above any plausible input and well below the limit of a single JavaScript string.
 */
export const MAX_RESPONSE_BYTES = RESPONSE_LIMIT_MIB * BYTES_PER_KIB * BYTES_PER_KIB;

/** The URL schemes the command reads, in the order the error for any other scheme lists them. */
const SUPPORTED_SCHEMES = ["http", "https", "data", "file"] as const;

/** The bounds on a remote read, injectable so a test can reach them without a 64 MiB body or a 30 second wait. */
export interface ReadLimits {
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

const DEFAULT_LIMITS: ReadLimits = { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES };

/**
 * A scheme of two or more characters (a letter, then letters, digits, `+`, `-` or `.`, as RFC 3986 allows) followed by a colon. Two characters at least, so a Windows drive path such as `C:\x.json` stays a path; the character set beyond letters admits `s3:` and `git+ssh:`, which must be reported as unsupported schemes rather than read as file names.
 */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;

/**
 * Whether a command-line argument names a URL rather than a path or standard input.
 * @param argument - The crosswalk, document or samples argument.
 * @returns True when the argument starts with a URL scheme.
 */
export function isUrl(argument: string): boolean {
  return URL_SCHEME.test(argument);
}

function isSupportedScheme(scheme: string): scheme is (typeof SUPPORTED_SCHEMES)[number] {
  return SUPPORTED_SCHEMES.some((name) => name === scheme);
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;

  return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
}

/** Reads a response body as UTF-8 text, refusing it as soon as it is known to exceed the cap, whether from its declared length or from the bytes received (the sink throwing makes `pipeTo` cancel the source, so an endless body stops being read). */
async function readBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) throw new Error(`the response is ${String(declared)} bytes, over the ${String(maxBytes)} byte limit`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let received = 0;
  await response.body?.pipeTo(
    new WritableStream<Uint8Array>({
      write: (chunk) => {
        received += chunk.byteLength;
        if (received > maxBytes) throw new Error(`the response is over the ${String(maxBytes)} byte limit`);
        text += decoder.decode(chunk, { stream: true });
      },
    }),
  );

  return text + decoder.decode();
}

async function fetchText(url: string, limits: ReadLimits): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(limits.timeoutMs) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error(`no response within ${String(limits.timeoutMs)} ms`, { cause: error });
    throw new Error(describe(error), { cause: error });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${String(response.status)} ${response.statusText}`.trimEnd());
  }
  try {
    return await readBody(response, limits.maxBytes);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error(`the body was not complete within ${String(limits.timeoutMs)} ms`, { cause: error });
    throw new Error(describe(error), { cause: error });
  }
}

/**
 * Reads the text a command-line argument names: standard input for `-`, a URL when the argument starts with a scheme, otherwise a file path. `http:`, `https:` and `data:` go through `fetch`, which follows redirects; `file:` is turned into a path and read as paths are. Any other scheme is refused.
 * @param argument - A path, `-`, or a URL.
 * @param limits - The timeout and size cap for a remote read.
 * @returns The text, decoded as UTF-8.
 * @throws When the source is unreadable, unsupported, slow or larger than the cap. The message does not repeat the argument; the caller names it.
 */
export async function readSource(argument: string, limits: ReadLimits = DEFAULT_LIMITS): Promise<string> {
  if (argument === STDIN) return readFileSync(0, "utf8");
  if (!isUrl(argument)) return readFileSync(argument, "utf8");
  const url = new URL(argument);
  const scheme = url.protocol.slice(0, -1);
  if (!isSupportedScheme(scheme)) {
    throw new Error(`unsupported scheme ${url.protocol} (supported: ${SUPPORTED_SCHEMES.map((name) => `${name}:`).join(", ")}, plain paths and -)`);
  }

  return scheme === "file" ? readFileSync(fileURLToPath(url), "utf8") : fetchText(argument, limits);
}

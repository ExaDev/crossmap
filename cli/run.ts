import { parseArgs } from "node:util";
import type { Crosswalk } from "../src/index";
import { assertRoundTrip, CrosswalkStructureError, decode, encode, parseCrosswalk, TwindexError, validateCrosswalk } from "../src/index";

/** Everything the command touches outside its own arguments, injected so the command runs the same under test as under Node. */
export interface CliIo {
  /** The text of a file, or of standard input for `-`. */
  readText: (path: string) => string;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  version: string;
}

/** The path that stands for standard input. */
const STDIN = "-";

/** The command did what was asked: a document was translated, or a crosswalk or round trip checked out. */
export const EXIT_OK = 0;
/** The inputs were readable but the library rejected them: a crosswalk that fails its schema or its structural checks, a rule that cannot apply to the document, or a round trip that does not reproduce its sample. The reason is on standard error. */
export const EXIT_REJECTED = 1;
/** The command could not run: bad usage, or a file that is unreadable or not JSON. */
export const EXIT_USAGE = 2;

const usage = `Usage: twindex encode     <crosswalk.json> <document.json>
       twindex decode     <crosswalk.json> <document.json>
       twindex validate   <crosswalk.json>
       twindex round-trip <crosswalk.json> <samples.json>

Applies a twindex crosswalk to JSON documents.

  encode      prints the document translated from the crosswalk's source shape
              to its target shape
  decode      prints the document translated back, from target shape to source
  validate    checks the crosswalk's schema and structure, printing nothing
              when it is sound
  round-trip  checks that decoding the encoding of every sample reproduces it
              on the paths the crosswalk preserves; <samples.json> is a JSON
              array of source-shape documents. Prints nothing on success

  <crosswalk.json>  the crosswalk, or - to read it from standard input
  <document.json>   the document, or - to read it from standard input
  -h, --help        show this text
  -v, --version     show the version

Only one argument may be -. Output is JSON on standard output.

Exit status: 0 on success, 1 when the library rejected the crosswalk or the
document (the reason is on standard error), 2 for bad usage or a file that is
unreadable or not JSON.
`;

type Json = { ok: true; value: unknown } | { ok: false; message: string };

function readJson(io: Readonly<CliIo>, path: string): Json {
  const name = path === STDIN ? "standard input" : path;
  let text: string;
  try {
    text = io.readText(path);
  } catch (error) {
    return { ok: false, message: `cannot read ${name}: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const value: unknown = JSON.parse(text);

    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function fail(io: Readonly<CliIo>, status: number, lines: readonly string[]): number {
  io.writeStderr(`${lines.join("\n").trimEnd()}\n`);

  return status;
}

/** The arguments each subcommand takes after its name: the crosswalk, then a document where the command has one. */
const ARGUMENT_COUNT = { encode: 2, decode: 2, validate: 1, "round-trip": 2 } as const;

type Command = keyof typeof ARGUMENT_COUNT;

type Handler = (io: Readonly<CliIo>, crosswalk: Crosswalk, document: unknown) => number;

function isCommand(value: string): value is Command {
  return Object.hasOwn(ARGUMENT_COUNT, value);
}

function print(io: Readonly<CliIo>, value: unknown): number {
  io.writeStdout(`${JSON.stringify(value, undefined, 2)}\n`);

  return EXIT_OK;
}

function validate(crosswalk: Crosswalk): number {
  const issues = validateCrosswalk(crosswalk);
  if (issues.length > 0) throw new CrosswalkStructureError(issues);

  return EXIT_OK;
}

function roundTrip(io: Readonly<CliIo>, crosswalk: Crosswalk, samples: unknown): number {
  if (!Array.isArray(samples)) return fail(io, EXIT_USAGE, ["the samples file must hold a JSON array of documents"]);
  assertRoundTrip(crosswalk, samples);

  return EXIT_OK;
}

/** One handler per command, so adding a command to ARGUMENT_COUNT without a handler is a type error. */
const handlers: Record<Command, Handler> = {
  encode: (io, crosswalk, document) => print(io, encode(crosswalk, document)),
  decode: (io, crosswalk, document) => print(io, decode(crosswalk, document)),
  validate: (_io, crosswalk) => validate(crosswalk),
  "round-trip": (io, crosswalk, document) => roundTrip(io, crosswalk, document),
};

/**
 * Runs the command and returns its exit status. Every error the library defines is reported on standard error as a status; anything else thrown is a defect in the library, so it propagates instead of being worded as bad input.
 * @param args - The arguments after the executable.
 * @param io - Files, output streams and the version.
 * @returns The exit status.
 */
export function run(args: readonly string[], io: Readonly<CliIo>): number {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(args);
  } catch (error) {
    return fail(io, EXIT_USAGE, [error instanceof Error ? error.message : String(error), "", usage]);
  }
  if (parsed.values.version === true) {
    io.writeStdout(`${io.version}\n`);

    return EXIT_OK;
  }
  if (parsed.values.help === true) {
    io.writeStdout(usage);

    return EXIT_OK;
  }
  const [command, ...operands] = parsed.positionals;
  if (command === undefined || !isCommand(command) || operands.length !== ARGUMENT_COUNT[command]) {
    return fail(io, EXIT_USAGE, ["expected a command and its files", "", usage]);
  }
  if (operands.filter((operand) => operand === STDIN).length > 1) {
    return fail(io, EXIT_USAGE, ["only one argument can be read from standard input"]);
  }
  const files: unknown[] = [];
  for (const operand of operands) {
    const file = readJson(io, operand);
    if (!file.ok) return fail(io, EXIT_USAGE, [file.message]);
    files.push(file.value);
  }
  const [crosswalkDocument, document] = files;

  try {
    return handlers[command](io, parseCrosswalk(crosswalkDocument), document);
  } catch (error) {
    if (error instanceof TwindexError) return fail(io, EXIT_REJECTED, [error.message]);
    throw error;
  }
}

function parseCommandLine(args: readonly string[]): {
  values: { help?: boolean; version?: boolean };
  positionals: string[];
} {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

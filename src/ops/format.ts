import type { FormatRule } from "../crosswalk";

function parseIsoDateTime(value: string): number {
  // The ISO-8601 shapes v1 accepts: a calendar date, or a timestamp with hours and minutes, optional seconds and milliseconds, and either a Z or a numeric offset when a time is present.
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))?)?$/u.exec(value);
  if (parts === null) {
    throw new Error(`value is not an ISO-8601 date or timestamp: ${JSON.stringify(value)}`);
  }
  const epochMilliseconds = new Date(value).getTime();
  if (Number.isNaN(epochMilliseconds)) {
    // A structurally impossible field (a month of 13), which Date recognises as invalid.
    throw new Error(`value is a well-formed but nonexistent instant: ${JSON.stringify(value)}`);
  }
  // Date's parser silently rolls a nonexistent calendar date forward (30 February becomes 2 March) rather than rejecting it, so the written calendar date is checked against the parsed one in the string's own zone (an offset can cross midnight, so the same instant's UTC date would disagree legitimately). Accepting the rollover would have decode render a different date than encode was given, with nothing anywhere reporting it.
  const MINUTES_PER_HOUR = 60;
  const MILLISECONDS_PER_MINUTE = 60000;
  const zoneOffsetMinutes = parts[5] === undefined ? 0 : (parts[5] === "-" ? -1 : 1) * (Number(parts[6]) * MINUTES_PER_HOUR + Number(parts[7]));
  const inWrittenZone = new Date(epochMilliseconds + zoneOffsetMinutes * MILLISECONDS_PER_MINUTE);
  if (inWrittenZone.getUTCFullYear() !== Number(parts[1]) || inWrittenZone.getUTCMonth() + 1 !== Number(parts[2]) || inWrittenZone.getUTCDate() !== Number(parts[3])) {
    throw new Error(`value is a well-formed but nonexistent instant (the date rolls forward): ${JSON.stringify(value)}`);
  }

  return epochMilliseconds;
}

function parseNumberText(value: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) {
    throw new Error(`value is not a decimal number in text form: ${JSON.stringify(value)}`);
  }

  return parsed;
}

/** The length of a UTC day in milliseconds: epoch milliseconds denote a calendar date only at a multiple of it (ECMAScript time has no leap seconds). */
const MILLISECONDS_PER_DAY = 86_400_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function parseIsoDate(value: string): number {
  if (!ISO_DATE.test(value)) {
    throw new Error(`value is not an ISO-8601 calendar date (YYYY-MM-DD): ${JSON.stringify(value)}`);
  }

  return parseIsoDateTime(value);
}

function renderIsoDate(value: number): string {
  if (!Number.isInteger(value / MILLISECONDS_PER_DAY)) {
    throw new Error(`value is not a UTC midnight, so it names no calendar date: ${String(value)}`);
  }
  const text = new Date(value).toISOString().slice(0, "YYYY-MM-DD".length);
  if (!ISO_DATE.test(text)) {
    throw new Error(`value is outside the four-digit years an ISO calendar date can spell: ${String(value)}`);
  }

  return text;
}

function parseBooleanText(value: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`value is not "true" or "false": ${JSON.stringify(value)}`);
}

/**
 * Parses JSON text. A parsed `__proto__` key is refused: JSON.parse makes it an ordinary own key, but the output's JSON value check drops it without a word, so the value would silently lose it (the reason the path grammar refuses that key too).
 */
function parseJsonText(value: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`value is not JSON text: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (holdsProtoKey(parsed)) {
    throw new Error(`JSON text holds a __proto__ key, which the output cannot carry: ${JSON.stringify(value)}`);
  }

  return parsed;
}

function holdsProtoKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((element: unknown) => holdsProtoKey(element));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, child]) => key === "__proto__" || holdsProtoKey(child));
  }

  return false;
}

/** The encode half of `format`: parses the native textual form into the shared machine form (an ISO-8601 timestamp or calendar date to epoch milliseconds, a decimal string to a number, `"true"` or `"false"` to a boolean, JSON text to the value it denotes). */
export function formatEncode(rule: FormatRule, value: unknown): unknown {
  if (typeof value !== "string") {
    throw new Error(`format (${rule.kind}) applies to strings, found: ${JSON.stringify(value)}`);
  }
  switch (rule.kind) {
    case "isoDateTime":
      return parseIsoDateTime(value);
    case "isoDate":
      return parseIsoDate(value);
    case "numberText":
      return parseNumberText(value);
    case "booleanText":
      return parseBooleanText(value);
    case "jsonText":
      return parseJsonText(value);
    default:
      return unhandledKind();
  }
}

/** The decode half of `format`: renders the shared machine form back into the canonical textual form (`toISOString`, its date part, `String(number)`, `"true"` or `"false"`, `JSON.stringify`). */
export function formatDecode(rule: FormatRule, value: unknown): string {
  switch (rule.kind) {
    case "isoDateTime":
      return new Date(finiteNumber(rule, value)).toISOString();
    case "isoDate":
      return renderIsoDate(finiteNumber(rule, value));
    case "numberText":
      return String(finiteNumber(rule, value));
    case "booleanText":
      if (typeof value !== "boolean") {
        throw new Error(`format (booleanText) decode applies to booleans, found: ${JSON.stringify(value)}`);
      }

      return String(value);
    case "jsonText":
      return renderJsonText(value);
    default:
      return unhandledKind();
  }
}

/** JSON.stringify returns `undefined`, not text, for a value JSON cannot express (`undefined` or a function at the top level), so that case is an error here rather than a non-string leaking out. */
function renderJsonText(value: unknown): string {
  const text: unknown = JSON.stringify(value);
  if (typeof text !== "string") {
    throw new Error("format (jsonText) decode applies to JSON values, found a value JSON cannot express");
  }

  return text;
}

function finiteNumber(rule: FormatRule, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`format (${rule.kind}) decode applies to finite numbers, found: ${JSON.stringify(value)}`);
  }

  return value;
}

/** Unreachable for any rule that passed the schema: the default arm exists so the switch is total. */
function unhandledKind(): never {
  throw new Error("no format handler for the rule's kind: the schema and the format op disagree");
}

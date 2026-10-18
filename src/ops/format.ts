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

/** The encode half of `format`: parses the native textual form into the shared machine form (an ISO-8601 timestamp to epoch milliseconds; a decimal string to a number). */
export function formatEncode(rule: FormatRule, value: unknown): number {
  if (typeof value !== "string") {
    throw new Error(`format (${rule.kind}) applies to strings, found: ${JSON.stringify(value)}`);
  }

  return rule.kind === "isoDateTime" ? parseIsoDateTime(value) : parseNumberText(value);
}

/** The decode half of `format`: renders the shared machine form back into the native textual form. */
export function formatDecode(rule: FormatRule, value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`format (${rule.kind}) decode applies to finite numbers, found: ${JSON.stringify(value)}`);
  }

  return rule.kind === "isoDateTime" ? new Date(value).toISOString() : String(value);
}

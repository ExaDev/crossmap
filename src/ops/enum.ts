import type { EnumRule } from "../crosswalk";

function throughMap(map: Readonly<Record<string, string>>, value: unknown, mapName: string): string {
  if (typeof value !== "string") {
    throw new Error(`enum applies to strings, found: ${JSON.stringify(value)}`);
  }
  const mapped = map[value];
  if (mapped === undefined) {
    throw new Error(`value ${JSON.stringify(value)} has no entry in ${mapName}`);
  }

  return mapped;
}

/** The encode half of `enum`: `map[value]`. An unmapped value is a hard error rather than a pass-through: a value the crosswalk did not enumerate reaching the shared shape silently is exactly the drift the crosswalk exists to prevent. */
export function enumEncode(rule: EnumRule, value: unknown): string {
  return throughMap(rule.map, value, "map");
}

/** The decode half of `enum`: `mapBack[value]`, which the schema guarantees is map's exact inverse. */
export function enumDecode(rule: EnumRule, value: unknown): string {
  return throughMap(rule.mapBack, value, "mapBack");
}

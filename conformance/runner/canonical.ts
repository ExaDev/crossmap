/** The number of spaces one level of nesting adds. */
const INDENT = "  ";

/**
 * Serialises a JSON value in the corpus's canonical form: keys in ascending UTF-16 code-unit order, two-space indent, one element per line, `[]` and `{}` for empty containers, numbers as `JSON.stringify` writes them.
 * @param value - A JSON value parsed from text.
 * @param indent - The indentation of the line the value starts on.
 * @returns The text, without a trailing line feed.
 * @throws When a number is not finite, which JSON cannot carry.
 */
export function canonical(value: unknown, indent = ""): string {
  if (typeof value !== "object" || value === null) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("a non-finite number cannot be written as JSON");
    }

    return JSON.stringify(value);
  }
  const next = `${indent}${INDENT}`;
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[\n${value.map((item: unknown) => `${next}${canonical(item, next)}`).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return entries.length === 0 ? "{}" : `{\n${entries.map(([name, member]) => `${next}${JSON.stringify(name)}: ${canonical(member, next)}`).join(",\n")}\n${indent}}`;
}

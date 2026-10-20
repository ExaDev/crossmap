/**
 * One piece of a parsed template: literal text, or a placeholder naming one of the rule's `from` fields.
 */
export type TemplatePiece = { readonly kind: "literal"; readonly text: string } | { readonly kind: "placeholder"; readonly name: string };

/** A placeholder name, and so a `from` field name of a template rule: `[A-Za-z0-9_]+` other than `__proto__`, which as a key of the rule's `from` record would be dropped by JSON tooling the way a path segment of that name is. */
export const PLACEHOLDER_NAME = /^(?!__proto__$)[A-Za-z0-9_]+$/u;

/**
 * Parses a template string: `{name}` is a placeholder, `{{` and `}}` are a literal `{` and `}`, and every other character is literal. Adjacent literal characters are merged, so no two literal pieces are adjacent.
 * @param template - The template text.
 * @returns The pieces in order.
 * @throws Error for a `{` that opens neither `{{` nor a placeholder of name characters closed by `}`, or a `}` that is not part of `}}`.
 */
export function parseTemplate(template: string): readonly TemplatePiece[] {
  const pieces: TemplatePiece[] = [];
  let literal = "";
  let index = 0;
  while (index < template.length) {
    const char = template.charAt(index);
    const pair = template.slice(index, index + 2);
    if (pair === "{{" || pair === "}}") {
      literal += char;
      index += 2;
      continue;
    }
    if (char === "}") {
      throw new Error(`a lone } at position ${String(index)}: write }} for a literal brace`);
    }
    if (char !== "{") {
      literal += char;
      index += 1;
      continue;
    }
    const close = template.indexOf("}", index);
    const name = close === -1 ? "" : template.slice(index + 1, close);
    if (!PLACEHOLDER_NAME.test(name)) {
      throw new Error(`a { at position ${String(index)} opens no placeholder: write {name} with a name of [A-Za-z0-9_]+ other than __proto__, or {{ for a literal brace`);
    }
    if (literal !== "") {
      pieces.push({ kind: "literal", text: literal });
      literal = "";
    }
    pieces.push({ kind: "placeholder", name });
    index = close + 1;
  }
  if (literal !== "") {
    pieces.push({ kind: "literal", text: literal });
  }

  return pieces;
}

/**
 * The structural problems that stop a template from having a unique inverse, given the rule's `from` field names. With none, every rendering that {@link renderTemplate} accepts splits back into the values it was rendered from.
 * @param pieces - The parsed template.
 * @param fields - The rule's `from` field names.
 * @returns One message per problem; empty when the template is sound.
 */
export function templateProblems(pieces: readonly TemplatePiece[], fields: readonly string[]): readonly string[] {
  const problems: string[] = [];
  const names = pieces.flatMap((piece) => (piece.kind === "placeholder" ? [piece.name] : []));
  if (names.length === 0) {
    problems.push("a template needs at least one placeholder");
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      problems.push(`placeholder {${name}} appears twice: decode could not tell which occurrence holds the value`);
    }
    seen.add(name);
    if (!fields.includes(name)) {
      problems.push(`placeholder {${name}} names no from field`);
    }
  }
  for (const field of fields) {
    if (!seen.has(field)) {
      problems.push(`from field ${field} appears in no placeholder, so encode would lose it`);
    }
  }
  pieces.forEach((piece, position) => {
    const next = pieces[position + 1];
    if (piece.kind === "placeholder" && next?.kind === "placeholder") {
      problems.push(`placeholders {${piece.name}} and {${next.name}} are adjacent: with no literal between them, decode cannot tell where one ends`);
    }
  });

  return problems;
}

/**
 * Splits a rendered text back into its fields, the decode half of `template`: the text must start with the leading literal and end with the trailing one, and each placeholder takes the text up to the first occurrence of the literal that follows it.
 * @param pieces - The parsed template, sound per {@link templateProblems}.
 * @param text - The rendered text.
 * @returns Each placeholder's text, by name.
 * @throws Error when the text does not have the template's shape.
 */
export function splitTemplate(pieces: readonly TemplatePiece[], text: string): ReadonlyMap<string, string> {
  const first = pieces[0];
  const last = pieces.at(-1);
  const leading = first?.kind === "literal" ? first.text : "";
  const trailing = last?.kind === "literal" && pieces.length > 1 ? last.text : "";
  if (!text.startsWith(leading) || !text.endsWith(trailing) || text.length < leading.length + trailing.length) {
    throw new Error(`text does not have the template's leading ${JSON.stringify(leading)} and trailing ${JSON.stringify(trailing)}: ${JSON.stringify(text)}`);
  }
  let rest = text.slice(leading.length, text.length - trailing.length);
  const middle = pieces.slice(leading === "" ? 0 : 1, trailing === "" ? pieces.length : -1);
  const parts = new Map<string, string>();
  middle.forEach((piece, position) => {
    if (piece.kind === "literal") {
      return;
    }
    const boundary = middle[position + 1];
    if (boundary === undefined) {
      parts.set(piece.name, rest);

      return;
    }
    if (boundary.kind !== "literal") {
      throw new Error("adjacent placeholders reached splitTemplate: templateProblems rejects them");
    }
    const at = rest.indexOf(boundary.text);
    if (at === -1) {
      throw new Error(`text lacks the template's ${JSON.stringify(boundary.text)} after {${piece.name}}: ${JSON.stringify(text)}`);
    }
    parts.set(piece.name, rest.slice(0, at));
    rest = rest.slice(at + boundary.text.length);
  });

  return parts;
}

/**
 * Renders the fields into the template, the encode half of `template`. The rendering is split back at once and compared with the fields, so a value containing the literal that follows its placeholder (which decode would cut at the wrong place) is refused here, rather than producing text that decodes to different values.
 * @param pieces - The parsed template, sound per {@link templateProblems}.
 * @param fields - Each placeholder's value, by name.
 * @returns The rendered text.
 * @throws Error when a value is not a string, or when the rendering does not split back into the same values.
 */
export function renderTemplate(pieces: readonly TemplatePiece[], fields: ReadonlyMap<string, unknown>): string {
  const text = pieces
    .map((piece) => {
      if (piece.kind === "literal") {
        return piece.text;
      }
      const value = fields.get(piece.name);
      if (typeof value !== "string") {
        throw new Error(`template field ${piece.name} must be a string, found: ${JSON.stringify(value)}`);
      }

      return value;
    })
    .join("");
  const back = splitTemplate(pieces, text);
  for (const piece of pieces) {
    if (piece.kind !== "placeholder") {
      continue;
    }
    const name = piece.name;
    const value = fields.get(name);
    if (back.get(name) !== value) {
      throw new Error(`template field ${name} holds ${JSON.stringify(value)}, which contains text the template uses as a boundary, so the rendering would not split back into the same fields`);
    }
  }

  return text;
}

const templateCache = new Map<string, readonly TemplatePiece[]>();

/**
 * Memoised {@link parseTemplate} for the executor, which renders or splits the same template once per element: keyed by the template text, so an entry can never serve the wrong pieces.
 * @param template - The template text, already accepted by the rule schema.
 * @returns The parsed pieces.
 * @throws Error as {@link parseTemplate}.
 */
export function parseTemplateMemo(template: string): readonly TemplatePiece[] {
  const cached = templateCache.get(template);
  if (cached !== undefined) {
    return cached;
  }
  const pieces = parseTemplate(template);
  templateCache.set(template, pieces);

  return pieces;
}

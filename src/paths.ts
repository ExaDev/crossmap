import { CrosswalkSyntaxError } from "./errors";
import { getOwn, setOwn } from "./own";

/**
 * One step of a parsed path: a record key, one fixed array index, or a wildcard addressing every element of the array the preceding steps reach.
 */
export type PathStep = { readonly kind: "key"; readonly key: string } | { readonly kind: "index"; readonly index: number } | { readonly kind: "wildcard" };

/**
 * A parsed path: the ordered steps of a path string. Parsing is total for every string: a malformed path throws {@link CrosswalkSyntaxError} rather than returning a partial locus.
 */
export type Locus = readonly PathStep[];

/**
 * One step of a concrete location in a document: a record key or an array index. A trail is a locus with every wildcard instantiated, so record keys and array positions stay distinct kinds (a record key spelled `0` is never mistaken for the first element of an array).
 */
export type TrailStep = { readonly kind: "key"; readonly key: string } | { readonly kind: "index"; readonly index: number };

/** A concrete location in a document, as the steps from the root that reach it. */
export type Trail = readonly TrailStep[];

/** The bare key characters: a key made only of these, other than `__proto__`, is written without quotes. */
const BARE_KEY = "[A-Za-z0-9_-]+";

/**
 * A bare segment: `[A-Za-z0-9_-]+` except exactly `__proto__`. An output holding an own `__proto__` key is checked by trilean's JSON value schema, which drops the key without a word, so a rule mapping that key would lose its value silently; refusing the segment in the grammar makes it fail loudly where the crosswalk is parsed.
 */
const SEGMENT = `(?!__proto__(?![A-Za-z0-9_-]))${BARE_KEY}`;

/**
 * A quoted key: `["` then any characters, with `"` and `\` written as `\"` and `\\`, then `"]`. Those two are the only escapes, so every key has exactly one quoted spelling, which is what lets the `__proto__` refusal be a lookahead on that one spelling.
 */
const QUOTED = String.raw`\["(?!__proto__"\])(?:[^"\\]|\\["\\])*"\]`;

/**
 * The most digits an index may have: every number of up to nine digits is a valid ECMAScript array index (the largest index is 2^32 - 2, which has ten digits, but not every ten-digit number is below it), so the bound is the widest digit count the grammar can accept without a numeric range check.
 */
const MAX_INDEX_DIGITS = 9;

/** A fixed array index: `[n]` with `n` a non-negative decimal integer without leading zeros. */
const INDEX = String.raw`\[(?:0|[1-9][0-9]{0,${String(MAX_INDEX_DIGITS - 1)}})\]`;

const WILDCARD = String.raw`\[\]`;

/** A whole key that prints bare: the bare segment class, other than `__proto__`. */
const BARE_SEGMENT_REGEX = new RegExp(`^${SEGMENT}$`, "u");

/**
 * The path grammar, as one anchored regex the crosswalk schema also uses for its `from`/`to` fields (schema-level checks are syntax only; the structural checks live in validateCrosswalk): a bare segment or a quoted key, then any sequence of `.segment`, a quoted key, a fixed index `[n]` or a wildcard `[]`.
 */
export const PATH_REGEX = new RegExp(`^(?:${SEGMENT}|${QUOTED})(?:\\.${SEGMENT}|${QUOTED}|${INDEX}|${WILDCARD})*$`, "u");

/**
 * Parses a path string into its locus.
 * @param path - The path string, matching {@link PATH_REGEX}.
 * @returns The parsed locus.
 * @throws CrosswalkSyntaxError when the string does not match {@link PATH_REGEX}: it is empty, has an empty segment, a leading or trailing dot, starts with `[]` or an index, has an unterminated quoted key, an index with a leading zero or more than nine digits, a quoted or bare key that is exactly `__proto__`, or a character outside the bare segment class outside quotes.
 */
export function parsePath(path: string): Locus {
  if (!PATH_REGEX.test(path)) {
    throw new CrosswalkSyntaxError([{ message: `malformed path: ${path}` }]);
  }
  const steps: PathStep[] = [];
  let index = 0;
  while (index < path.length) {
    if (path[index] === ".") {
      index += 1;
      continue;
    }
    if (path.startsWith("[]", index)) {
      steps.push({ kind: "wildcard" });
      index += 2;
      continue;
    }
    if (path.startsWith('["', index)) {
      const quoted = readQuoted(path, index + 2);
      steps.push({ kind: "key", key: quoted.key });
      index = quoted.end;
      continue;
    }
    if (path[index] === "[") {
      const close = path.indexOf("]", index);
      steps.push({ kind: "index", index: Number(path.slice(index + 1, close)) });
      index = close + 1;
      continue;
    }
    const segment = /^[A-Za-z0-9_-]+/u.exec(path.slice(index));
    // PATH_REGEX has already accepted the whole string, so a position that is not a dot, a bracket or a quote always starts with a full segment: a miss here would mean the two patterns disagree, which is a bug in this module rather than a data condition.
    if (segment === null) {
      throw new CrosswalkSyntaxError([{ message: `malformed path: ${path}` }]);
    }
    steps.push({ kind: "key", key: segment[0] });
    index += segment[0].length;
  }

  return steps;
}

/** Reads a quoted key's body starting just after its opening `["`, undoing the two escapes, and returns the key with the position just after its closing `"]`. PATH_REGEX has accepted the string, so the closing quote exists. */
function readQuoted(path: string, start: number): { readonly key: string; readonly end: number } {
  let key = "";
  let index = start;
  while (path[index] !== '"') {
    if (path[index] === "\\") {
      index += 1;
    }
    key += path.charAt(index);
    index += 1;
  }

  return { key, end: index + 2 };
}

/**
 * Prints steps in the path grammar, the inverse of {@link parsePath}: `parsePath(formatPath(locus))` equals `locus` for every locus parsePath returns, and `formatPath(parsePath(path))` is the one canonical spelling of `path` (a key that the bare segment class covers is printed bare, any other quoted). A key of exactly `__proto__` prints quoted for messages, though the grammar refuses to parse it back.
 * @param steps - A locus or a trail.
 * @returns The canonical path string.
 */
export function formatPath(steps: readonly PathStep[]): string {
  return steps
    .map((step, position) => {
      switch (step.kind) {
        case "wildcard":
          return "[]";
        case "index":
          return `[${String(step.index)}]`;
        case "key":
          if (BARE_SEGMENT_REGEX.test(step.key)) {
            return position === 0 ? step.key : `.${step.key}`;
          }

          return `["${step.key.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
        default:
          return unhandledStep();
      }
    })
    .join("");
}

/** Unreachable: PathStep has exactly three kinds, and this arm exists so the switch is total. */
function unhandledStep(): never {
  throw new Error("a path step of no known kind: the PathStep type and formatPath disagree");
}

/**
 * The canonical spelling of a path string, so two spellings of one path (a bare key and its quoted form) compare equal.
 * @param path - A path string matching {@link PATH_REGEX}.
 * @returns The canonical string {@link formatPath} prints for it.
 * @throws CrosswalkSyntaxError as {@link parsePath}.
 */
export function canonicalPath(path: string): string {
  return formatPath(parsePathMemo(path));
}

/** The number of wildcard steps in a locus: its wildcard arity, the length of the index tuple every match carries. */
export function wildcardCount(locus: Locus): number {
  return locus.filter((step) => step.kind === "wildcard").length;
}

/**
 * One location a locus addresses in a concrete document: the value found and the trail reaching it, with every wildcard step instantiated to the array index it addressed.
 */
export interface PathMatch {
  readonly trail: Trail;
  readonly value: unknown;
}

/**
 * An existing array with no elements that a wildcard step reached: real structure the matches cannot show, because it yields none. `wildcard` is the ordinal (from zero) of the wildcard step that met it, so the site can be projected onto the corresponding wildcard of another locus.
 */
export interface EmptySite {
  readonly trail: Trail;
  readonly wildcard: number;
}

/** A per-element filter for {@link readLocus}: which elements, identified by their indexes at the first `arity` wildcards, a gated rule visits. */
export interface ElementGate {
  readonly arity: number;
  readonly admit: (indexes: readonly number[]) => boolean;
}

/** Everything one locus addresses in a document: the matches in index order, and every empty array a wildcard step met on the way. */
export interface LocusReading {
  readonly matches: readonly PathMatch[];
  readonly empties: readonly EmptySite[];
}

/**
 * Reads every location a locus addresses in a document. A wildcard step yields one match per element of the array it reaches, so a locus with wildcard arity `a` yields exactly one match per `a`-dimensional index combination of the arrays it traverses; a fixed index step addresses one element.
 * @param root - The document to read from.
 * @param locus - The parsed path to read.
 * @param gate - Optional per-element admission: once the first `arity` wildcards are expanded, each element is kept only if `admit` returns true for its indexes at those wildcards, and nothing below a refused element is read (so an element that lacks the rest of the path is skipped, not absent). Empty arrays met at or above that depth are still reported.
 * @returns The reading, or `undefined` when any step of the path is absent from the document: a missing key, a key step meeting a non-record, an index step meeting a non-array or an index past the array's end, or a wildcard meeting a non-array (a wildcard over a missing array is absence too, not an empty list).
 */
export function readLocus(root: unknown, locus: Locus, gate?: ElementGate): LocusReading | undefined {
  let frontier: readonly PathMatch[] = [{ trail: [], value: root }];
  const empties: EmptySite[] = [];
  let wildcardOrdinal = 0;
  for (const step of locus) {
    const next: PathMatch[] = [];
    for (const site of frontier) {
      if (step.kind === "key") {
        if (!isRecord(site.value) || !Object.hasOwn(site.value, step.key)) {
          return undefined;
        }
        next.push({ trail: [...site.trail, step], value: getOwn(site.value, step.key) });
        continue;
      }
      if (!Array.isArray(site.value)) {
        return undefined;
      }
      const array: readonly unknown[] = site.value;
      if (step.kind === "index") {
        if (step.index >= array.length) {
          return undefined;
        }
        next.push({ trail: [...site.trail, step], value: array[step.index] });
        continue;
      }
      if (array.length === 0) {
        empties.push({ trail: site.trail, wildcard: wildcardOrdinal });
      }
      array.forEach((element, index) => {
        next.push({ trail: [...site.trail, { kind: "index", index }], value: element });
      });
    }
    if (step.kind === "wildcard") {
      wildcardOrdinal += 1;
    }
    frontier = gate !== undefined && step.kind === "wildcard" && wildcardOrdinal === gate.arity ? next.filter((site) => gate.admit(wildcardIndexes(locus, site.trail))) : next;
  }

  return { matches: frontier, empties };
}

/**
 * Visits every location a locus addresses without holding a record per element: the trail buffer is reused across visits, so a caller that walks a wildcard over millions of elements pays only the output it writes. Semantics match {@link readLocus} exactly: the same absence rules, the same empty-array reporting, the same gate behaviour, and visits in the same index order.
 * @param root - The document to read from.
 * @param locus - The parsed path to read.
 * @param gate - Optional per-element admission, as {@link readLocus} takes it.
 * @param visit - Called for each match with the trail (valid only until the next visit; copy it to keep it) and the value found.
 * @returns The empty arrays a wildcard step met, or `undefined` under the same conditions {@link readLocus} returns `undefined`.
 */
export function walkLocus(root: unknown, locus: Locus, gate: ElementGate | undefined, visit: (trail: Trail, value: unknown) => void): readonly EmptySite[] | undefined {
  const empties: EmptySite[] = [];
  const trail: TrailStep[] = [];

  /**
   * Walks one step of the locus over one value.
   * @param position - The step's position in the locus.
   * @param value - The value the steps so far reached.
   * @returns False when the locus is absent from the document.
   */
  const walk = (position: number, value: unknown): boolean => {
    const step = locus[position];
    if (step === undefined) {
      visit(trail, value);

      return true;
    }
    if (step.kind === "key") {
      if (!isRecord(value) || !Object.hasOwn(value, step.key)) {
        return false;
      }
      trail.push(step);
      const deeper = walk(position + 1, getOwn(value, step.key));
      trail.pop();

      return deeper;
    }
    if (!Array.isArray(value)) {
      return false;
    }
    if (step.kind === "index") {
      if (step.index >= value.length) {
        return false;
      }
      trail.push(step);
      const deeper = walk(position + 1, value[step.index]);
      trail.pop();

      return deeper;
    }
    if (gate?.arity === countWildcards(locus, position) + 1) {
      if (value.length === 0) {
        empties.push({ trail: [...trail], wildcard: countWildcards(locus, position) });
      }
      for (let index = 0; index < value.length; index += 1) {
        trail.push({ kind: "index", index });
        if (Object.hasOwn(value, index) && gate.admit(wildcardIndexes(locus, trail))) {
          if (!walk(position + 1, value[index])) {
            return false;
          }
        }
        trail.pop();
      }

      return true;
    }
    if (value.length === 0) {
      empties.push({ trail: [...trail], wildcard: countWildcards(locus, position) });
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        continue;
      }
      trail.push({ kind: "index", index });
      const deeper = walk(position + 1, value[index]);
      trail.pop();
      if (!deeper) {
        return false;
      }
    }

    return true;
  };

  return walk(0, root) ? empties : undefined;
}

/** How many wildcard steps a locus holds before a position (the position's own step excluded). */
function countWildcards(locus: Locus, position: number): number {
  let count = 0;
  for (let at = 0; at < position; at += 1) {
    if (locus[at]?.kind === "wildcard") {
      count += 1;
    }
  }

  return count;
}

/**
 * The array indexes a trail took at a locus's wildcard steps, in order: the index tuple of one match. The trail was produced by {@link readLocus} over this locus (or a prefix of it), so its step at each wildcard position is an index.
 * @param locus - The locus the trail was read through.
 * @param trail - The trail (or a prefix of it, for an empty site).
 * @returns The index at each wildcard step the trail covers.
 */
export function wildcardIndexes(locus: Locus, trail: Trail): readonly number[] {
  const indexes: number[] = [];
  trail.forEach((step, position) => {
    if (locus[position]?.kind === "wildcard") {
      if (step.kind !== "index") {
        throw new Error(`the trail has a key where its locus has a wildcard: ${formatPath(trail)}`);
      }
      indexes.push(step.index);
    }
  });

  return indexes;
}

/**
 * Instantiates a locus with an index tuple: key and index steps are copied, and the n-th wildcard takes the n-th index. With `wildcardLimit`, the trail stops just before that wildcard (the location of the array it would iterate).
 * @param locus - The locus to bind.
 * @param indexes - One index per wildcard the bound part covers.
 * @param wildcardLimit - The ordinal of the wildcard to stop before; omitted, the whole locus is bound.
 * @returns The concrete trail.
 * @throws Error when the tuple has fewer indexes than the bound part has wildcards, which structural validation rules out.
 */
export function bindLocus(locus: Locus, indexes: readonly number[], wildcardLimit?: number): Trail {
  const trail: TrailStep[] = [];
  let ordinal = 0;
  for (const step of locus) {
    if (step.kind !== "wildcard") {
      trail.push(step);
      continue;
    }
    if (ordinal === wildcardLimit) {
      break;
    }
    const index = indexes[ordinal];
    if (index === undefined) {
      throw new Error(`the index tuple is shorter than the wildcards of ${formatPath(locus)}`);
    }
    trail.push({ kind: "index", index });
    ordinal += 1;
  }

  return trail;
}

/**
 * Reads one concrete location.
 * @param root - The document.
 * @param trail - The location.
 * @returns `{ found: true, value }` when every step exists (an own record key, or an index inside an array), else `{ found: false }`.
 */
export function readTrail(root: unknown, trail: Trail): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  let value = root;
  for (const step of trail) {
    if (step.kind === "key") {
      if (!isRecord(value) || !Object.hasOwn(value, step.key)) {
        return { found: false };
      }
      value = getOwn(value, step.key);
      continue;
    }
    if (!Array.isArray(value) || step.index >= value.length || !Object.hasOwn(value, step.index)) {
      return { found: false };
    }
    const array: readonly unknown[] = value;
    value = array[step.index];
  }

  return { found: true, value };
}

/**
 * Every object or array {@link writeMatches} has stored as a value (as opposed to a container it created to reach a deeper location). A value is a leaf of the output: a later trail that runs through it would merge into, and mutate, a value that may be the caller's own input object (`move` carries values across by reference), so such a trail is a conflict. Weakly held, so it never keeps a document alive.
 */
const placedValues = new WeakSet<object>();

/**
 * Records that a container was stored in an output as a value by a writer other than {@link writeMatches}, so that later writes through {@link writeMatches} treat it as the leaf it is rather than as structure to merge into.
 * @param value - The object or array stored.
 */
export function markPlaced(value: object): void {
  placedValues.add(value);
}

/**
 * Writes values into a target document, creating every intermediate record and array the trails need (materialising an array to the highest index written into it). An index step creates or enters an array and a key step a record, so the two never stand in for each other.
 * @param target - The mutable output document; records and arrays along each trail are created in it as needed.
 * @param writes - The locations to write, each with its trail and its value.
 * @throws RangeError when a trail is empty, a step's kind does not fit the container it meets (a key into an array, an index into a record), an intermediate step already holds a value another write stored (a scalar, or an object stored whole), or the final location already holds anything: each of the last three is two destinations claiming one location, which would otherwise make the result depend on rule order.
 */
export function writeMatches(target: Record<string, unknown>, writes: readonly { readonly trail: Trail; readonly value: unknown }[]): void {
  for (const write of writes) {
    writeOne(target, write.trail, write.value, true);
  }
}

/** One write of {@link writeMatches}; `asValue` false stores an object as structure that later trails may still run through ({@link ensureArray}). */
function writeOne(target: Record<string, unknown>, trail: Trail, value: unknown, asValue: boolean): void {
  const last = trail.at(-1);
  if (last === undefined) {
    throw new RangeError("a trail must address at least one step");
  }
  let node: Record<string, unknown> | unknown[] = target;
  for (let depth = 0; depth < trail.length - 1; depth += 1) {
    const step = trail[depth];
    const nextStep = trail[depth + 1];
    if (step === undefined || nextStep === undefined) {
      throw new RangeError("a trail step is missing inside the trail's own length");
    }
    const existing = childOf(node, step, trail, depth);
    if (existing !== undefined && (!isContainer(existing) || placedValues.has(existing))) {
      throw new RangeError(`intermediate path step ${formatPath(trail.slice(0, depth + 1))} holds a value where the trail needs a container`);
    }
    const child: Record<string, unknown> | unknown[] = existing ?? (nextStep.kind === "index" ? [] : {});
    if (existing === undefined) {
      placeInto(node, step, child, formatPath(trail.slice(0, depth + 1)));
    }
    node = child;
  }
  if (childOf(node, last, trail, trail.length - 1) !== undefined) {
    throw new RangeError(`two destinations write the one location ${formatPath(trail)}`);
  }
  placeInto(node, last, value, formatPath(trail));
  if (asValue && isContainer(value)) {
    placedValues.add(value);
  }
}

/**
 * Makes sure an array exists at a location, as structure rather than a value: an existing array is left as it is, and a missing one is created empty, so later writes may still fill it. This is how an empty source array keeps its counterpart in the output.
 * @param target - The mutable output document.
 * @param trail - The array's location.
 * @throws RangeError when the location already holds something other than an array, or when reaching it conflicts as {@link writeMatches} describes.
 */
export function ensureArray(target: Record<string, unknown>, trail: Trail): void {
  const existing = readTrail(target, trail);
  if (existing.found) {
    if (!Array.isArray(existing.value)) {
      throw new RangeError(`the location of an empty source array already holds a non-array value: ${formatPath(trail)}`);
    }

    return;
  }
  writeOne(target, trail, [], false);
}

/** The value one step down from a container, or `undefined` when the step is not yet written; a step whose kind does not fit the container throws. */
function childOf(node: Record<string, unknown> | readonly unknown[], step: TrailStep, trail: Trail, depth: number): unknown {
  if (isReadonlyArray(node)) {
    if (step.kind !== "index") {
      throw new RangeError(`path step ${formatPath(trail.slice(0, depth + 1))} is a record key where the document has an array`);
    }

    return node[step.index];
  }
  if (step.kind !== "key") {
    throw new RangeError(`path step ${formatPath(trail.slice(0, depth + 1))} is an array index where the document has a record`);
  }

  return getOwn(node, step.key);
}

/** Stores a value one step down from a container. The step's kind has already been checked against the container by {@link childOf}, so the final throw is unreachable for any caller in this module. */
function placeInto(node: Record<string, unknown> | readonly unknown[], step: TrailStep, value: unknown, location: string): void {
  if (Array.isArray(node) && step.kind === "index") {
    Reflect.set(node, step.index, value);

    return;
  }
  if (isRecord(node) && step.kind === "key") {
    setOwn(node, step.key, value);

    return;
  }
  throw new RangeError(`path step ${location} does not fit the container it meets`);
}

/**
 * Finds the first array element nothing wrote: a hole left when a rule wrote a later index of an array (a fixed index past the next free one, or a gated rule skipping an element no other rule wrote). Holes are counted before any array is walked, so a large sparse array costs one key listing rather than a pass over its length.
 * @param value - The output document under construction.
 * @param trail - The location of `value` in the document, prefixed to the returned trail; the root call omits it.
 * @returns The trail of the first hole in depth-first order, or `undefined` when there is none.
 */
export function findHole(value: unknown, trail: Trail = []): Trail | undefined {
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      const index = value.findIndex((_element: unknown, position) => !Object.hasOwn(value, position));

      return [...trail, { kind: "index", index }];
    }
    for (const [index, element] of value.entries()) {
      const hole = findHole(element, [...trail, { kind: "index", index }]);
      if (hole !== undefined) {
        return hole;
      }
    }

    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const hole = findHole(child, [...trail, { kind: "key", key }]);
      if (hole !== undefined) {
        return hole;
      }
    }
  }

  return undefined;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

/**
 * Array.isArray's own predicate (`value is any[]`) cannot narrow a `readonly unknown[]` out of a union, because a readonly array is not assignable to a mutable one; this guard can, which is all childOf needs (it only reads the array it is handed).
 */
function isReadonlyArray(value: Record<string, unknown> | readonly unknown[]): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const locusCache = new Map<string, Locus>();

/**
 * Memoised {@link parsePath} for the paths a crosswalk's rules name, which are re-read by validation and by every encode and decode call over the same document: the cache is keyed by the path string, which is content-addressed (two identical strings are the same path), so an entry can never serve the wrong locus.
 * @param path - The path string.
 * @returns The parsed locus.
 * @throws CrosswalkSyntaxError as {@link parsePath}.
 */
export function parsePathMemo(path: string): Locus {
  const cached = locusCache.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const locus = parsePath(path);
  locusCache.set(path, locus);

  return locus;
}

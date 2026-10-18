import { CrosswalkSyntaxError } from "./errors";

/**
 * One step of a parsed path: a record key, or a wildcard addressing every element of the array the preceding steps reach.
 */
export type PathStep = { readonly kind: "key"; readonly key: string } | { readonly kind: "wildcard" };

/**
 * A parsed path: the ordered steps of a path string, with `[]` represented as wildcard steps. Parsing is total for every string: a malformed path throws {@link CrosswalkSyntaxError} rather than returning a partial locus.
 */
export type Locus = readonly PathStep[];

/**
 * The path grammar, as one anchored regex the crosswalk schema also uses for its `from`/`to` fields (schema-level checks are syntax only; the structural checks live in validateCrosswalk): `segment ('.' segment | '[]')*` where a segment is `[A-Za-z0-9_-]+`.
 */
export const PATH_REGEX = /^(?:[A-Za-z0-9_-]+)(?:\.(?:[A-Za-z0-9_-]+)|\[\])*$/;

/**
 * Parses a path string into its locus.
 * @param path - The path string, matching {@link PATH_REGEX}.
 * @returns The parsed locus.
 * @throws CrosswalkSyntaxError when the string is empty, has empty segments, a leading or trailing dot, `[]` at the start, adjacent `[]`, or any character outside the segment class.
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
    const segment = /^[A-Za-z0-9_-]+/u.exec(path.slice(index));
    // PATH_REGEX has already accepted the whole string, so a non-wildcard position always starts with a full segment: a miss here would mean the two patterns disagree, which is a bug in this module rather than a data condition.
    if (segment === null) {
      throw new CrosswalkSyntaxError([{ message: `malformed path: ${path}` }]);
    }
    steps.push({ kind: "key", key: segment[0] });
    index += segment[0].length;
  }

  return steps;
}

/**
 * One location a locus addresses in a concrete document: the value found and the key trail reaching it, with every wildcard step instantiated to the array index it addressed.
 */
export interface PathMatch {
  readonly keys: readonly string[];
  readonly value: unknown;
}

/**
 * Reads every location a locus addresses in a document. A wildcard step yields one match per element of the array it reaches, so a locus with wildcard arity `a` yields exactly one match per `a`-dimensional index combination of the arrays it traverses.
 * @param root - The document to read from.
 * @param locus - The parsed path to read.
 * @returns Every match in index order, or `undefined` when any step of the path is absent from the document (a wildcard over a missing array is absence too, not an empty list).
 */
export function readLocus(root: unknown, locus: Locus): readonly PathMatch[] | undefined {
  let frontier: readonly PathMatch[] = [{ keys: [], value: root }];
  for (const step of locus) {
    const next: PathMatch[] = [];
    for (const site of frontier) {
      if (step.kind === "key") {
        if (!isRecord(site.value) || !(step.key in site.value)) {
          return undefined;
        }
        const container: Record<string, unknown> = site.value;
        next.push({ keys: [...site.keys, step.key], value: container[step.key] });
      } else {
        if (!Array.isArray(site.value)) {
          return undefined;
        }
        const array: readonly unknown[] = site.value;
        array.forEach((element, index) => {
          next.push({ keys: [...site.keys, String(index)], value: element });
        });
      }
    }
    frontier = next;
  }

  return frontier;
}

/**
 * Writes matches into a target document, creating every intermediate record and array the key trails need (materialising an array to the highest index written into it). Trails are expected to come from {@link readLocus} over the corresponding source locus, so index alignment between the two sides holds by construction.
 * @param target - The mutable output document; records and arrays along each trail are created in it as needed.
 * @param matches - The locations to write, each with its concrete key trail and its value.
 * @throws RangeError when a trail is empty, a key is not a record key or a non-negative array index, or an intermediate step already holds a value (two destinations where one is a prefix of the other). The first two are impossible for trails this module produces; the throw guards against composing it with hand-built trails.
 */
export function writeMatches(
  target: Record<string, unknown>,
  matches: readonly { keys: readonly string[]; value: unknown }[],
): void {
  for (const match of matches) {
    const keys = match.keys;
    const last = keys.length - 1;
    if (last < 0) {
      throw new RangeError("a key trail must address at least one step");
    }
    let node: Record<string, unknown> | unknown[] = target;
    for (let depth = 0; depth < last; depth += 1) {
      const key = keys[depth] ?? "";
      const nextKey = keys[depth + 1] ?? "";
      const soFar = keys.slice(0, depth + 1).join(".");
      const child = childContainer(node, key, nextKey, soFar);
      if (Array.isArray(node)) {
        node[arrayIndex(key)] = child;
      } else {
        node[key] = child;
      }
      node = child;
    }
    const key = keys[last] ?? "";
    if (Array.isArray(node)) {
      node[arrayIndex(key)] = match.value;
    } else {
      node[key] = match.value;
    }
  }
}

/**
 * The container one level down a key trail needs: an existing record or array is reused as is (so an array materialised by an earlier trail keeps its length), a yet-unwritten step gets a record for a record key or an array for an index key, and an intermediate step already holding a value is a conflict between two destinations (one a prefix of the other), which throws rather than silently replacing the earlier value.
 */
function childContainer(
  node: Record<string, unknown> | readonly unknown[],
  key: string,
  nextKey: string,
  soFar: string,
): Record<string, unknown> | unknown[] {
  const existing: unknown = isReadonlyArray(node) ? node[arrayIndex(key)] : node[key];
  if (isContainer(existing)) {
    return existing;
  }
  if (existing !== undefined) {
    throw new RangeError(`intermediate path step ${soFar} holds a value where the trail needs a container`);
  }
  const child: Record<string, unknown> | unknown[] = isIndex(nextKey) ? [] : {};

  return child;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

/**
 * Array.isArray's own predicate (`value is any[]`) cannot narrow a `readonly unknown[]` out of a union, because a readonly array is not assignable to a mutable one; this guard can, which is all childContainer needs (it only reads the array it is handed).
 */
function isReadonlyArray(value: Record<string, unknown> | readonly unknown[]): value is readonly unknown[] {
  return Array.isArray(value);
}

function isIndex(key: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(key);
}

function arrayIndex(key: string): number {
  if (!isIndex(key)) {
    throw new RangeError(`expected an array index, found: ${key}`);
  }

  return Number(key);
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

import { type ComputedValue, type PredicateNode, type Resolution, createSyncEvaluator, type SyncResolvers } from "trilean";
import { getOwn } from "./own";
import { bindLocus, type Locus, parsePathMemo, readLocus, readTrail, wildcardCount } from "./paths";

/**
 * One element of a collection a `when` predicate quantifies over (`some`/`every`), wrapped in an unexported class so only this module's own `resolveCollection` can mint the contexts `resolveValue` treats as items: a record-rooted resolver pair can never mistake a hand-built value for an item.
 */
class WhenItem {
  constructor(readonly values: Record<string, unknown>) {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Wraps a scalar leaf of the governing document as a trilean ComputedValue. A non-scalar (record or array) resolves to not-found rather than a value: a predicate that needs it becomes indeterminate, and an indeterminate `when` skips its rule (the Kleene reading: the data needed to decide is absent). */
function scalarResolution(value: unknown): Resolution {
  if (typeof value === "number") {
    return { found: true, value: { kind: "number", value } satisfies ComputedValue };
  }
  if (typeof value === "string") {
    return { found: true, value: { kind: "text", value } satisfies ComputedValue };
  }
  if (typeof value === "boolean") {
    return { found: true, value: { kind: "boolean", value } satisfies ComputedValue };
  }

  return { found: false };
}

/**
 * The element a wildcard rule is visiting, for a `when` whose references carry wildcards: the index tuple of the current match, and the governing side's array for each of the rule's wildcards. A reference such as `rows[].kind` is written against the rule's `from` side (validateCrosswalk requires its part through its last wildcard to be the `from` path's part through that wildcard), so while decoding that part is replaced by the `to` path's array at the same depth, and the reference reads the element being visited in whichever document governs.
 */
export interface WhenElement {
  /** The current match's index at each of the rule's wildcards that the gate covers, outermost first. */
  readonly indexes: readonly number[];
  /**
   * The governing side's locus prefix through one of its wildcards: the array that wildcard iterates.
   * @param wildcard - The wildcard's ordinal, from zero.
   * @returns The locus prefix, ending in that wildcard step.
   */
  readonly arrayAt: (wildcard: number) => Locus;
}

/**
 * Resolves a reference path to the one value it names: a wildcard-free path as written (exactly one match, else not found), and a wildcard path rebased onto the visited element's array and bound to its indexes.
 * @throws Error for a wildcard reference with no element to bind to, or more wildcards than the element has indexes, which validateCrosswalk rules out before execution.
 */
function locate(doc: unknown, path: string, element: WhenElement | undefined): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  const locus = parsePathMemo(path);
  const wildcards = wildcardCount(locus);
  if (wildcards === 0) {
    const matches = readLocus(doc, locus)?.matches;
    const match = matches?.[0];
    if (matches?.length !== 1 || match === undefined) {
      return { found: false };
    }

    return { found: true, value: match.value };
  }
  if (element === undefined || wildcards > element.indexes.length) {
    throw new Error(`a when reference with wildcards has no visited element to bind to: ${path}`);
  }
  const lastWildcard = locus.findLastIndex((step) => step.kind === "wildcard");
  const rebased: Locus = [...element.arrayAt(wildcards - 1), ...locus.slice(lastWildcard + 1)];

  return readTrail(doc, bindLocus(rebased, element.indexes));
}

/**
 * Builds the record-rooted resolvers for one governing document: the source document while encoding, the target document while decoding.
 *
 * `resolveValue` takes a path string against the document root (the same grammar as rule paths) and resolves only scalar leaves. A path with wildcards names a field of the element the rule is visiting (see {@link WhenElement}). Inside a `some`/`every`/`fold`, the context is one item and the key is that item's field name.
 *
 * `resolveCollection` takes a path string resolving to an array of records, bound to the visited element in the same way, and throws for a missing array or a non-record element: an absent list silently changing a quantifier's meaning is a crosswalk error, not an empty collection.
 *
 * `resolveLookup` throws: crosswalks carry no lookup tables, so a `lookup` node inside a `when` is a documented unsupported reference, surfaced loudly rather than evaluated as indeterminate.
 * @param doc - The governing document.
 * @param element - The element a wildcard rule is visiting, for a per-element gate; omitted for a gate on the whole rule.
 */
export function createWhenResolvers(doc: unknown, element?: WhenElement): Readonly<SyncResolvers> {
  return {
    resolveValue: (key, context): Resolution => {
      if (typeof key !== "string") {
        return { found: false };
      }
      if (context instanceof WhenItem) {
        return scalarResolution(getOwn(context.values, key));
      }
      const located = locate(doc, key, element);

      return located.found ? scalarResolution(located.value) : { found: false };
    },
    resolveLookup: (table) => {
      throw new Error(`lookup tables are not supported in a crosswalk when predicate (table: ${JSON.stringify(table)})`);
    },
    resolveCollection: (collection) => {
      if (typeof collection !== "string") {
        throw new Error(`a when collection reference must be a path string, found: ${JSON.stringify(collection)}`);
      }
      const located = locate(doc, collection, element);
      if (!located.found) {
        throw new Error(`a when collection reference resolved to nothing in the governing document: ${collection}`);
      }
      const array = located.value;
      if (!Array.isArray(array)) {
        throw new Error(`a when collection reference resolved to a non-array value: ${collection}`);
      }

      return array.map((item: unknown): WhenItem => {
        if (!isRecord(item)) {
          throw new Error(`a when collection resolved to a non-record element under ${collection}`);
        }

        return new WhenItem(item);
      });
    },
  };
}

/**
 * Visits every string a predicate tree uses as a reference key or collection name, without enumerating trilean node kinds: an object with a `key`/`collection` string field is a reference the resolvers will receive. Field references inside a `some`/`every` item are visited too; they are plain field names, which the path grammar also accepts.
 * @param node - A predicate tree (already accepted by trilean's PredicateNodeSchema) or any part of one.
 * @param visit - Called once per reference, with the value found (a string for a well-formed tree).
 */
export function visitReferences(node: unknown, visit: (reference: unknown) => void): void {
  if (Array.isArray(node)) {
    node.forEach((element) => {
      visitReferences(element, visit);
    });

    return;
  }
  if (!isRecord(node)) {
    return;
  }
  if (typeof node["key"] === "string") {
    visit(node["key"]);
  }
  if (typeof node["collection"] === "string") {
    visit(node["collection"]);
  }
  for (const value of Object.values(node)) {
    if (typeof value === "object" && value !== null) {
      visitReferences(value, visit);
    }
  }
}

/**
 * The most wildcards any reference in a `when` carries: zero for a gate on the whole rule, and otherwise the number of the visited element's indexes the gate needs, so the executor evaluates it once per element at that depth.
 * @param when - A predicate tree whose references validateCrosswalk has accepted as paths.
 * @returns The largest wildcard count over the tree's references.
 */
export function whenArity(when: PredicateNode): number {
  let arity = 0;
  visitReferences(when, (reference) => {
    if (typeof reference === "string") {
      arity = Math.max(arity, wildcardCount(parsePathMemo(reference)));
    }
  });

  return arity;
}

const evaluator = createSyncEvaluator({});

/**
 * Decides whether a rule's `when` predicate lets it apply to a governing document, or to one element of it.
 * @param when - The predicate tree (trilean grammar; reference keys are paths into `doc`, and a path with wildcards names a field of the visited element).
 * @param doc - The governing document: the source document for encode, the target document for decode.
 * @param element - The element being visited, required when the tree has wildcard references.
 * @returns `true` only for a definite `true`; a definite `false` or an indeterminate evaluation (a reference the document cannot resolve) returns `false`, skipping the rule or the element.
 */
export function evaluateWhen(when: PredicateNode, doc: unknown, element?: WhenElement): boolean {
  const result = evaluator.evaluatePredicate(when, doc, createWhenResolvers(doc, element));

  return result.status === "definite" && result.value;
}

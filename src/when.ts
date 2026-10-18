import { type ComputedValue, type PredicateNode, type Resolution, createSyncEvaluator, type SyncResolvers } from "trilean";
import { parsePathMemo, readLocus } from "./paths";

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
 * Builds the record-rooted resolvers for one governing document: the source document while encoding, the target document while decoding.
 *
 * `resolveValue` takes a path string against the document root (the same grammar as rule paths; validateCrosswalk rejects wildcard paths inside `when` before execution) and resolves only scalar leaves. Inside a `some`/`every`/`fold`, the context is one item and the key is that item's field name.
 *
 * `resolveCollection` takes a path string resolving to an array of records, and throws for a missing array or a non-record element: an absent list silently changing a quantifier's meaning is a crosswalk error, not an empty collection.
 *
 * `resolveLookup` throws: v1 crosswalks carry no lookup tables, so a `lookup` node inside a `when` is a documented unsupported reference, surfaced loudly rather than evaluated as indeterminate.
 */
export function createWhenResolvers(doc: unknown): Readonly<SyncResolvers> {
  return {
    resolveValue: (key, context): Resolution => {
      if (typeof key !== "string") {
        return { found: false };
      }
      if (context instanceof WhenItem) {
        return scalarResolution(context.values[key]);
      }
      const matches = readLocus(doc, parsePathMemo(key));
      const match = matches?.[0];
      if (matches?.length !== 1 || match === undefined) {
        return { found: false };
      }

      return scalarResolution(match.value);
    },
    resolveLookup: (table) => {
      throw new Error(`lookup tables are not supported in a crosswalk when predicate (table: ${JSON.stringify(table)})`);
    },
    resolveCollection: (collection) => {
      if (typeof collection !== "string") {
        throw new Error(`a when collection reference must be a path string, found: ${JSON.stringify(collection)}`);
      }
      const matches = readLocus(doc, parsePathMemo(collection));
      const match = matches?.[0];
      if (matches === undefined || match === undefined || matches.length !== 1) {
        throw new Error(`a when collection reference resolved to nothing in the governing document: ${collection}`);
      }
      const array = match.value;
      if (!Array.isArray(array)) {
        throw new Error(`a when collection reference resolved to a non-array value: ${collection}`);
      }

      return array.map((element: unknown): WhenItem => {
        if (!isRecord(element)) {
          throw new Error(`a when collection resolved to a non-record element under ${collection}`);
        }

        return new WhenItem(element);
      });
    },
  };
}

const evaluator = createSyncEvaluator({});

/**
 * Decides whether a rule's `when` predicate lets it apply to a governing document.
 * @param when - The predicate tree (trilean grammar; reference keys are paths into `doc`, wildcards forbidden by structural validation).
 * @param doc - The governing document: the source document for encode, the target document for decode.
 * @returns `true` only for a definite `true`; a definite `false` or an indeterminate evaluation (a reference the document cannot resolve) returns `false`, skipping the rule.
 */
export function evaluateWhen(when: PredicateNode, doc: unknown): boolean {
  const result = evaluator.evaluatePredicate(when, doc, createWhenResolvers(doc));

  return result.status === "definite" && result.value;
}

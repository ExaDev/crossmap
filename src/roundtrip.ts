import { type Crosswalk } from "./crosswalk";
import { RoundTripMismatchError } from "./errors";
import { formatPath, type Locus, type PathStep, parsePathMemo, type TrailStep } from "./paths";
import { compileCrosswalk } from "./executor";
import { setOwn } from "./own";

/**
 * Checks that decode inverts encode over every sample, on the paths the crosswalk promises to preserve. The paths one-way rules touch are excluded by construction (a dropped path cannot survive; a decode-direction default or aggregate inserts a path the sample never had), then each sample's round trip is deep-compared with Object.is at the leaves; the first difference throws.
 *
 * What it proves and what it cannot: a `scale` rule with a non-integer factor may fail bit-identity under multiply-then-divide (integer or power-of-two factors are exact), a `when` must be written against fields the rule does not itself move (this check is the empirical test of that, static validation cannot decide it), and a sample that populates an encode-side default's `to` path will differ from its round trip (the default only inserts into an absent target), so samples leave those paths unset.
 * @param crosswalk - The parsed crosswalk.
 * @param samples - Documents drawn from the native shape.
 * @throws CrosswalkStructureError when the crosswalk fails structural validation.
 * @throws RoundTripMismatchError naming the sample and path of the first difference.
 */
export function assertRoundTrip(crosswalk: Crosswalk, samples: readonly unknown[]): void {
  const codec = compileCrosswalk(crosswalk);
  const excluded = crosswalk.oneWay.flatMap((rule): readonly string[] => {
    if (rule.op === "drop") {
      return [rule.from];
    }

    return rule.direction === "decode" ? [rule.to] : [];
  });
  const excludedLoci = excluded.map(parsePathMemo);
  samples.forEach((sample, sampleIndex) => {
    const roundTripped = codec.decode(codec.encode(sample));
    const left = prunePaths(sample, excludedLoci);
    const right = prunePaths(roundTripped, excludedLoci);
    compare(left, right, [], sampleIndex);
  });
}

/** Applies every excluded locus to the document in turn, so the comparison sees the correspondence subset rather than the paths one-way rules legitimately change. */
function prunePaths(doc: unknown, loci: readonly Locus[]): unknown {
  let pruned = doc;
  for (const locus of loci) {
    pruned = pruneLocus(pruned, locus);
  }

  return pruned;
}

/** What a pruned array element is replaced by on both sides of the comparison: removing the element would shift every later index, so the slot is kept and filled with one value that compares equal only to itself. */
const PRUNED = Symbol("pruned");

/**
 * Rebuilds the document with one locus's locations absent: a wildcard step rebuilds every element, a key step rebuilds the record without that key when the locus ends there or recursed otherwise, and an index step rebuilds that one element (replacing it with {@link PRUNED} when the locus ends there). Nothing is mutated, and absence along the way is fine (the path may simply not exist in this document).
 */
function pruneLocus(value: unknown, locus: readonly PathStep[]): unknown {
  const first = locus[0];
  if (first === undefined) {
    return value;
  }
  const rest = locus.slice(1);
  if (first.kind === "wildcard") {
    if (!Array.isArray(value)) {
      return value;
    }

    return value.map((element) => pruneLocus(element, rest));
  }
  if (first.kind === "index") {
    if (!Array.isArray(value) || first.index >= value.length) {
      return value;
    }

    return value.map((element: unknown, index): unknown => {
      if (index !== first.index) {
        return element;
      }

      return rest.length === 0 ? PRUNED : pruneLocus(element, rest);
    });
  }
  if (!isRecord(value)) {
    return value;
  }
  const rebuilt: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== first.key) {
      setOwn(rebuilt, key, child);
      continue;
    }
    if (rest.length === 0) {
      continue;
    }
    setOwn(rebuilt, key, pruneLocus(child, rest));
  }

  return rebuilt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep comparison over the correspondence subset: leaves compare with Object.is, arrays by length then element, records by key set then value. The first difference throws, naming the location in the path grammar (canonical spelling, `[n]` for an element), or the empty string for the root. */
function compare(left: unknown, right: unknown, trail: readonly TrailStep[], sampleIndex: number): void {
  const path = formatPath(trail);
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      throw new RoundTripMismatchError(sampleIndex, path, `arrays differ in length: ${String(left.length)} against ${String(right.length)}`);
    }
    left.forEach((element, index) => {
      compare(element, right[index], [...trail, { kind: "index", index }], sampleIndex);
    });

    return;
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.join(",") !== rightKeys.join(",")) {
      throw new RoundTripMismatchError(sampleIndex, path, `records differ in keys: ${leftKeys.join(",")} against ${rightKeys.join(",")}`);
    }
    for (const key of leftKeys) {
      const leftValue: unknown = left[key];
      const rightValue: unknown = right[key];
      compare(leftValue, rightValue, [...trail, { kind: "key", key }], sampleIndex);
    }

    return;
  }
  if (Array.isArray(left) !== Array.isArray(right) || isRecord(left) !== isRecord(right)) {
    throw new RoundTripMismatchError(sampleIndex, path, `values differ in kind: ${kindOf(left)} against ${kindOf(right)}`);
  }
  if (!Object.is(left, right)) {
    throw new RoundTripMismatchError(sampleIndex, path, `values differ: ${describe(left)} against ${describe(right)}`);
  }
}

/** A leaf for a mismatch message: String() for ordinary values, and a name for the pruned marker (String of a symbol would print its description, which reads like a value). */
function describe(value: unknown): string {
  return value === PRUNED ? "(a pruned element)" : String(value);
}

function kindOf(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (isRecord(value)) {
    return "record";
  }

  return typeof value;
}

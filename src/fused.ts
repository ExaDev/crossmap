import type { JsonValue, PredicateNode } from "trilean";
import type { TwoWayRule } from "./crosswalk";
import { singlePathOp } from "./ops/single-path";
import { isExactJson } from "./exact-json";
import { type Locus, markPlaced, parsePathMemo } from "./paths";
import { evaluateWhen, whenArity } from "./when";

/**
 * A single-path rule in one direction as the fused executor needs it: its index, its `when`, its read and write paths parsed, and its operation, or `undefined` for a `move`, whose value is carried as it is.
 */
interface FusableRule {
  readonly index: number;
  readonly when: PredicateNode | undefined;
  readonly read: Locus;
  readonly write: Locus;
  readonly op: ((value: unknown) => unknown) | undefined;
}

/** One rule of a group: the keys it reads below the element and writes below the output element, and its operation. */
interface Field {
  readonly index: number;
  readonly when: PredicateNode | undefined;
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly op: ((value: unknown) => unknown) | undefined;
}

/** Rules that iterate one source array into one output array, each element of which is walked once for all of them. */
interface Group {
  readonly kind: "group";
  readonly arrayRead: readonly string[];
  readonly arrayWrite: readonly string[];
  readonly fields: readonly Field[];
}

/** A rule with no wildcard: one value read and written. */
interface Single extends Field {
  readonly kind: "single";
}

/** A crosswalk's two-way rules in one direction, arranged so that each source array is walked once. */
export interface FusedPlan {
  readonly items: readonly (Group | Single)[];
}

/**
 * Arranges a crosswalk's two-way rules in one direction for fused execution, when every rule has the shape it needs: a single-path operation (not `template` or `copy`), a `when` that is absent or decided once for the whole rule, keys on both sides with at most one wildcard among them, write paths none of which runs through another (no write path is a prefix of another, and no location is both an array one rule iterates and a record another writes into), and each output array fed by one source array. Under these conditions every write lands on a location no other write touches, so the writes need no conflict checks and their order changes nothing but the order keys are created in, which the run keeps.
 * @param crosswalkRules - The crosswalk's two-way rules, in rule order.
 * @param direction - The direction the plan runs in: decode reads each rule's `to` and writes its `from`.
 * @returns The plan, or `undefined` when some rule needs the general executor.
 */
export function fusedPlan(crosswalkRules: readonly TwoWayRule[], direction: "encode" | "decode"): FusedPlan | undefined {
  const rules: FusableRule[] = [];
  for (const [index, rule] of crosswalkRules.entries()) {
    if (rule.op === "template" || rule.op === "copy") {
      return undefined;
    }
    const [read, write] = direction === "encode" ? [rule.from, rule.to] : [rule.to, rule.from];
    rules.push({ index, when: rule.when, read: parsePathMemo(read), write: parsePathMemo(write), op: rule.op === "move" ? undefined : singlePathOp(rule, direction) });
  }
  if (!rules.every((rule) => isKeyed(rule.read) && isKeyed(rule.write) && (rule.when === undefined || whenArity(rule.when) === 0)) || !writesAreDisjoint(rules.map((rule) => rule.write))) {
    return undefined;
  }
  const items: (Group | Single)[] = [];
  const groups = new Map<string, { readonly group: Group; readonly fields: Field[] }>();
  for (const rule of rules) {
    const read = splitAtWildcard(rule.read);
    const write = splitAtWildcard(rule.write);
    if (read === undefined || write === undefined) {
      items.push({ kind: "single", index: rule.index, when: rule.when, read: keysOf(rule.read), write: keysOf(rule.write), op: rule.op });
      continue;
    }
    const field: Field = { index: rule.index, when: rule.when, read: read.after, write: write.after, op: rule.op };
    // The output array's key list as JSON, in which every key is quoted and escaped, so two arrays share a map key only when they share every step.
    const arrayKey = JSON.stringify(write.before);
    const existing = groups.get(arrayKey);
    if (existing === undefined) {
      const fields = [field];
      const group: Group = { kind: "group", arrayRead: read.before, arrayWrite: write.before, fields };
      groups.set(arrayKey, { group, fields });
      items.push(group);
      continue;
    }
    if (!sameKeys(existing.group.arrayRead, read.before)) {
      // Two source arrays feeding one output array (which validation allows on the decode side): their elements would be written by separate walks, so the general executor keeps the key order exact.
      return undefined;
    }
    existing.fields.push(field);
  }

  return { items };
}

/** Whether a locus is only keys and at most one wildcard. */
function isKeyed(locus: Locus): boolean {
  return locus.every((step) => step.kind !== "index") && locus.filter((step) => step.kind === "wildcard").length <= 1;
}

function keysOf(locus: Locus): readonly string[] {
  return locus.flatMap((step) => (step.kind === "key" ? [step.key] : []));
}

/** The keys before and after a keyed locus's wildcard, or `undefined` when it has none. */
function splitAtWildcard(locus: Locus): { readonly before: readonly string[]; readonly after: readonly string[] } | undefined {
  const at = locus.findIndex((step) => step.kind === "wildcard");
  if (at < 0) {
    return undefined;
  }

  return { before: keysOf(locus.slice(0, at)), after: keysOf(locus.slice(at + 1)) };
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, position) => key === right[position]);
}

/** A node of the tree the write paths spell, step by step: a wildcard child, key children, and whether a path ends here. */
interface WriteNode {
  ends: boolean;
  wildcard: WriteNode | undefined;
  readonly keys: Map<string, WriteNode>;
}

/** Whether no write path runs through another: none ends where another ends or continues, and no location is continued both by a wildcard and by a key. A fixed index is not something the fused plan writes, so a path with one is not disjoint for it. */
function writesAreDisjoint(writes: readonly Locus[]): boolean {
  const root = writeNode();
  for (const write of writes) {
    let node = root;
    for (const step of write) {
      if (node.ends) {
        return false;
      }
      if (step.kind === "wildcard") {
        node.wildcard ??= writeNode();
        node = node.wildcard;
        continue;
      }
      if (step.kind === "index") {
        return false;
      }
      const child = node.keys.get(step.key) ?? writeNode();
      node.keys.set(step.key, child);
      node = child;
    }
    if (node.ends || node.wildcard !== undefined || node.keys.size > 0) {
      return false;
    }
    node.ends = true;
  }

  return continuedOneWay(root);
}

function writeNode(): WriteNode {
  return { ends: false, wildcard: undefined, keys: new Map() };
}

/** Whether no node of the write tree is continued both by a wildcard and by a key. */
function continuedOneWay(node: WriteNode): boolean {
  if (node.wildcard !== undefined && node.keys.size > 0) {
    return false;
  }

  return [...node.keys.values(), ...(node.wildcard === undefined ? [] : [node.wildcard])].every(continuedOneWay);
}

/** Thrown to stop a fused run that meets a value or shape it does not decide for itself; nothing about the reason is kept, since the general executor that runs next decides the outcome and reports it exactly. */
const DECLINED = new Error("the fused executor gives way to the general one");

/** A record of the output a fused run builds. */
type JsonRecord = Record<string, JsonValue>;

/**
 * Runs a fused plan over a document: each source array is walked once, every rule of its group read from each element and written into one output element, and each value a `move` carries stored as it is (a record or array moved whole is shared with the input, and marked as a stored value so later writes cannot merge into it). Every value stored is checked to be exact JSON ({@link isExactJson}) as it is stored, and the records and arrays the run builds are exact JSON by construction, so a completed run's output needs no further check, gap search or copy.
 * @param plan - The plan for this direction.
 * @param doc - The input document.
 * @returns The output document, or `undefined` when anything is absent, the wrong shape, rejected by an operation or not exact JSON, or a `when` cannot be evaluated: the general executor then runs the crosswalk from the start and gives the exact error or result.
 */
export function runFused(plan: FusedPlan, doc: unknown): JsonRecord | undefined {
  const target: JsonRecord = {};
  try {
    for (const { item, fields } of activeItems(plan, doc)) {
      if (item.kind === "single") {
        place(target, item.write, carried(item, readKeys(doc, item.read)));
        continue;
      }
      runGroup(item, fields, doc, target);
    }
  } catch {
    // Whatever stopped the run (a decline above, an operation rejecting a value, a `when` that throws), the general executor runs next and raises it with the rule and path it belongs to, or gives the result; the tests require that a run the general executor completes is never declined.
    return undefined;
  }

  return target;
}

/** The items a run applies, in the order the general executor would first write each one, with each group's fields narrowed to those whose `when` admits them. */
function activeItems(plan: FusedPlan, doc: unknown): readonly { readonly item: Group | Single; readonly fields: readonly Field[] }[] {
  const active: { readonly item: Group | Single; readonly fields: readonly Field[]; readonly first: number }[] = [];
  for (const item of plan.items) {
    const fields = (item.kind === "single" ? [item] : item.fields).filter((field) => field.when === undefined || evaluateWhen(field.when, doc));
    const [first] = fields;
    if (first !== undefined) {
      active.push({ item, fields, first: first.index });
    }
  }

  return active.sort((left, right) => left.first - right.first);
}

function runGroup(group: Group, fields: readonly Field[], doc: unknown, target: JsonRecord): void {
  const source = readKeys(doc, group.arrayRead);
  if (!Array.isArray(source)) {
    throw DECLINED;
  }
  const output: JsonValue[] = [];
  place(target, group.arrayWrite, output);
  const [only] = fields;
  if (fields.length === 1 && only?.write.length === 0) {
    for (const element of source) {
      output.push(carried(only, readElement(element, only.read)));
    }

    return;
  }
  for (const element of source) {
    const row: JsonRecord = {};
    for (const field of fields) {
      place(row, field.write, carried(field, readElement(element, field.read)));
    }
    output.push(row);
  }
}

/** Applies a field's operation to the value read, declines the run unless the result is exact JSON, and marks a record or array the field stores as a value. */
function carried(field: Field, value: unknown): JsonValue {
  const result = field.op === undefined ? value : field.op(value);
  if (!isExactJson(result)) {
    throw DECLINED;
  }
  if (typeof result === "object" && result !== null) {
    markPlaced(result);
  }

  return result;
}

/** Reads below one array element; an element that is not there (a hole, which the general executor skips) declines the run. */
function readElement(element: unknown, keys: readonly string[]): unknown {
  if (element === undefined) {
    throw DECLINED;
  }

  return readKeys(element, keys);
}

/** Reads a value by own keys, declining the run when any key is absent or meets a value that is not a record. */
function readKeys(from: unknown, keys: readonly string[]): unknown {
  let value = from;
  for (const key of keys) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) {
      throw DECLINED;
    }
    value = value[key];
  }

  return value;
}

/** Stores a value at keys below a record of the output, creating the records on the way: the plan's write paths are disjoint, so every record met was created by this run and the final key is free. */
function place(into: JsonRecord, keys: readonly string[], value: JsonValue): void {
  let node = into;
  const last = keys.length - 1;
  for (let position = 0; position < last; position += 1) {
    const key = stepAt(keys, position);
    const existing = node[key];
    if (existing === undefined) {
      const created: JsonRecord = {};
      node[key] = created;
      node = created;
      continue;
    }
    // Unreachable while the plan's writes are disjoint, as fusedPlan requires; declining leaves the general executor to report whatever the conflict is.
    if (!isJsonRecord(existing)) {
      throw DECLINED;
    }
    node = existing;
  }
  node[stepAt(keys, last)] = value;
}

/** The key at a position the caller's loop bounds keep inside the list. */
function stepAt(keys: readonly string[], position: number): string {
  const key = keys[position];
  if (key === undefined) {
    throw new Error("a write path with no key at a position inside its length: a fused write path always has at least one key");
  }

  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: JsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

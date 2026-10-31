import { type Crosswalk, type OneWayRule, type TwoWayRule } from "./crosswalk";
import { CrosswalkStructureError, RuleApplicationError } from "./errors";
import { applyOneWayRule } from "./ops/one-way";
import { type JsonValue, JsonValueSchema, type PredicateNode } from "trilean";
import { bindLocus, type ElementGate, type EmptySite, ensureArray, findHole, formatPath, type Locus, parsePathMemo, readTrail, walkLocus, wildcardIndexes, writeMatches } from "./paths";
import { ruleSides } from "./sides";
import { copyDecode, copyEncode } from "./ops/copy";
import { parseTemplateMemo, renderTemplate, splitTemplate } from "./ops/template";
import { validateCrosswalk } from "./validate";
import { evaluateWhen, whenArity } from "./when";
import { type FusedPlan, fusedPlan, runFused } from "./fused";
import { singlePathOp } from "./ops/single-path";

/** The two directions a crosswalk runs in. */
type Direction = "encode" | "decode";

/**
 * A crosswalk validated and prepared once, for running any number of times: every path parsed, every rule's sides and operation resolved for each direction. Running it has exactly the semantics of {@link encode} and {@link decode} on the crosswalk it was compiled from.
 */
export interface CompiledCrosswalk {
  /** The crosswalk this was compiled from. */
  readonly crosswalk: Crosswalk;
  /**
   * Encodes a native document into the shared shape, as {@link encode} does.
   * @throws RuleApplicationError as {@link encode} does.
   */
  readonly encode: (doc: unknown) => JsonValue;
  /**
   * Decodes a shared document back into the native shape, as {@link decode} does.
   * @throws RuleApplicationError as {@link decode} does.
   */
  readonly decode: (doc: unknown) => JsonValue;
}

/** Every crosswalk compiled so far, keyed by the crosswalk object, so a caller passing the same crosswalk again pays for validation and preparation once. Weakly held, so a crosswalk no longer in use is not kept alive by its compiled form. */
const compiledCrosswalks = new WeakMap<Crosswalk, CompiledCrosswalk>();

/**
 * Validates and prepares a crosswalk once, for encoding and decoding any number of documents. The result is kept for the crosswalk object, so compiling the same object again (as {@link encode} and {@link decode} do on every call) returns it at no cost; a crosswalk is read when it is first compiled, so an object changed afterwards keeps the behaviour it was first compiled with.
 * @param crosswalk - The parsed crosswalk.
 * @returns The compiled crosswalk.
 * @throws CrosswalkStructureError when the crosswalk fails structural validation.
 */
export function compileCrosswalk(crosswalk: Crosswalk): CompiledCrosswalk {
  const cached = compiledCrosswalks.get(crosswalk);
  if (cached !== undefined) {
    return cached;
  }
  const issues = validateCrosswalk(crosswalk);
  if (issues.length > 0) {
    throw new CrosswalkStructureError(issues);
  }
  const encodePlan = planFor(crosswalk, "encode");
  const decodePlan = planFor(crosswalk, "decode");
  const compiled: CompiledCrosswalk = {
    crosswalk,
    encode: (doc) => run(encodePlan, doc),
    decode: (doc) => run(decodePlan, doc),
  };
  compiledCrosswalks.set(crosswalk, compiled);

  return compiled;
}

/**
 * Encodes a native document into the shared shape. Every rule's `from` is read from `doc` exactly as given and every `to` is written into a fresh output, so the input is never mutated and rule order carries no meaning (validateCrosswalk, run when the crosswalk is first compiled, enforces the path uniqueness that makes this safe). A rule's `when` is evaluated against `doc`: definite true applies, definite false or indeterminate skips. Two-way rules write first, then the output's absent paths gain any due `default` values. The crosswalk is compiled on its first use and the compiled form reused ({@link compileCrosswalk}).
 * @param crosswalk - The parsed crosswalk.
 * @param doc - The native (source-side) document.
 * @returns The shared (target-side) document.
 * @throws CrosswalkStructureError when the crosswalk fails structural validation.
 * @throws RuleApplicationError when a rule's `from` path is absent, a value does not fit the operation, two rules claim one output location, or an output array is left with an element no rule wrote (ruleIndex -1, since that gap belongs to no single rule).
 */
export function encode(crosswalk: Crosswalk, doc: unknown): JsonValue {
  return compileCrosswalk(crosswalk).encode(doc);
}

/**
 * Decodes a shared document back into the native shape: the same executor with every two-way rule's paths swapped and each operation's inverse applied, so decode is a true inverse of encode over the paths the crosswalk maps. A rule's `when` is evaluated against `doc` (the target document, the decode input). The crosswalk is compiled on its first use and the compiled form reused ({@link compileCrosswalk}).
 * @param crosswalk - The parsed crosswalk.
 * @param doc - The shared (target-side) document.
 * @returns The native (source-side) document.
 * @throws CrosswalkStructureError when the crosswalk fails structural validation.
 * @throws RuleApplicationError when a rule's `to` path (the decode read side) is absent, a value does not fit the inverse operation, two rules claim one output location, or an output array is left with a gap (ruleIndex -1).
 */
export function decode(crosswalk: Crosswalk, doc: unknown): JsonValue {
  return compileCrosswalk(crosswalk).decode(doc);
}

/** The rule index a RuleApplicationError carries when the failure belongs to the rule list as a whole: a gap in an output array is the absence of a write, which no one rule owns. */
const NO_SINGLE_RULE = -1;

/** One read path of a rule in one direction, parsed. */
interface ReadSide {
  readonly path: string;
  readonly locus: Locus;
}

/** One two-way rule prepared for one direction: its read and write paths parsed, the strings its errors name, and its operation resolved. */
interface RulePlan {
  readonly index: number;
  readonly when: PredicateNode | undefined;
  /** The read path the rule walks, which every other read path must pair with element by element. */
  readonly governing: ReadSide;
  readonly otherReads: readonly ReadSide[];
  readonly writeLoci: readonly Locus[];
  /** Every read path, as an operation's failure names them. */
  readonly readPath: string;
  /** Every write path, as a write's failure names them. */
  readonly writePath: string;
  /** The operation in this direction: one value per read path in, one per write path out. */
  readonly transform: (values: readonly unknown[]) => readonly unknown[];
}

/** One one-way rule with the index its failures carry. */
interface OneWayPlan {
  readonly index: number;
  readonly rule: OneWayRule;
}

/** A crosswalk prepared for one direction. */
interface Plan {
  readonly direction: Direction;
  readonly rules: readonly RulePlan[];
  readonly oneWay: readonly OneWayPlan[];
  /** The two-way rules arranged to walk each source array once, when every rule has the shape that allows it. */
  readonly fused: FusedPlan | undefined;
  /** Whether a one-way rule writes in this direction, which can leave a gap in an output array the fused run built without one. */
  readonly oneWayWrites: boolean;
}

function planFor(crosswalk: Crosswalk, direction: Direction): Plan {
  return {
    direction,
    rules: crosswalk.rules.map((rule, index) => rulePlan(rule, index, direction)),
    oneWay: crosswalk.oneWay.map((rule, index) => ({ index: crosswalk.rules.length + index, rule })),
    fused: fusedPlan(crosswalk.rules, direction),
    oneWayWrites: crosswalk.oneWay.some((rule) => rule.op !== "drop" && rule.direction === direction),
  };
}


function rulePlan(rule: TwoWayRule, index: number, direction: Direction): RulePlan {
  const sides = ruleSides(rule);
  const reads = direction === "encode" ? sides.from : sides.to;
  const writes = direction === "encode" ? sides.to : sides.from;
  const [governingPath, ...otherPaths] = reads;
  if (governingPath === undefined) {
    throw new Error("a rule with no read path: ruleSides always returns at least one");
  }
  const readSide = (path: string): ReadSide => ({ path, locus: parsePathMemo(path) });

  return {
    index,
    when: rule.when,
    governing: readSide(governingPath),
    otherReads: otherPaths.map(readSide),
    writeLoci: writes.map((path) => parsePathMemo(path)),
    readPath: reads.join(", "),
    writePath: writes.join(", "),
    transform: transformFor(rule, direction),
  };
}

/**
 * Runs a plan over a document: the fused plan first where there is one, and the rules one at a time when there is none or the fused run gives way (it gives way on anything it does not decide for itself, so every error comes from the rule-at-a-time run, exactly as that run reports it).
 */
function run(plan: Plan, doc: unknown): JsonValue {
  const fused = plan.fused === undefined ? undefined : runFused(plan.fused, doc);
  const target = fused === undefined ? runRules(plan, doc) : fused.target;
  for (const { index, rule } of plan.oneWay) {
    if (rule.when !== undefined && !evaluateWhen(rule.when, doc)) {
      continue;
    }
    try {
      applyOneWayRule(rule, plan.direction, doc, target);
    } catch (error) {
      throw new RuleApplicationError(index, rule.op === "default" ? rule.to : rule.from, errorMessage(error));
    }
  }
  // A fused run fills each output array it builds from the start, so the search can find something only in a value stored whole or after a one-way write.
  const hole = fused === undefined || fused.storedGap || plan.oneWayWrites ? findHole(target) : undefined;
  if (hole !== undefined) {
    throw new RuleApplicationError(NO_SINGLE_RULE, formatPath(hole), "no rule wrote this array element, so the array would have a gap");
  }

  return parseJsonValue(target);
}

/** Applies the two-way rules one at a time, each over the whole document, into a fresh output. */
function runRules(plan: Plan, doc: unknown): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const rule of plan.rules) {
    applyTwoWayRule(rule, doc, target);
  }

  return target;
}

/**
 * How a rule's `when` applies: a gate with no wildcard references is decided once for the whole rule (`false` skips it, `undefined` lets it run), and one whose references carry wildcards becomes a per-element gate over the read side, evaluated once per element at the depth its references reach. `governing` is the rule's read-side path in this direction, so the gate's references are rebased onto the arrays it iterates.
 */
function elementGate(when: PredicateNode, doc: unknown, governing: Locus): ElementGate | false | undefined {
  const arity = whenArity(when);
  if (arity === 0) {
    return evaluateWhen(when, doc) ? undefined : false;
  }
  const wildcardPositions = governing.flatMap((step, position) => (step.kind === "wildcard" ? [position] : []));
  const arrayAt = (wildcard: number): Locus => {
    const position = wildcardPositions[wildcard];
    if (position === undefined) {
      throw new Error(`the rule's path has no wildcard ${String(wildcard)}: validateCrosswalk bounds a reference's wildcards by the rule's`);
    }

    return governing.slice(0, position + 1);
  };

  return { arity, admit: (indexes) => evaluateWhen(when, doc, { indexes, arrayAt }) };
}

/**
 * Applies one two-way rule: walks the governing read path one element at a time, reads the other read paths at the same indexes, transforms each element's values with the operation in this direction, and writes the results to the write-side paths at those indexes as it goes, so nothing per element outlives the element. Empty arrays met on any read side are materialised on every write-side path.
 * @throws RuleApplicationError when a read path is absent, two read paths address different elements, the operation rejects a value, or a write conflicts.
 */
function applyTwoWayRule(rule: RulePlan, doc: unknown, target: Record<string, unknown>): void {
  const { index, governing, otherReads, writeLoci } = rule;
  const gate = rule.when === undefined ? undefined : elementGate(rule.when, doc, governing.locus);
  if (gate === false) {
    return;
  }
  const empties: { readonly locus: Locus; readonly empty: EmptySite }[] = [];
  const countWalk = (locus: Locus): { readonly empties: readonly EmptySite[] | undefined; readonly count: number } => {
    let count = 0;
    const walked = walkLocus(doc, locus, gate, () => {
      count += 1;
    });

    return { empties: walked, count };
  };
  const governingWalk = countWalk(governing.locus);
  if (governingWalk.empties === undefined) {
    throw new RuleApplicationError(index, governing.path, "the path is absent from the document");
  }
  const governingCount = governingWalk.count;
  for (const empty of governingWalk.empties) {
    empties.push({ locus: governing.locus, empty });
  }
  for (const read of otherReads) {
    const walked = countWalk(read.locus);
    if (walked.empties === undefined) {
      throw new RuleApplicationError(index, read.path, "the path is absent from the document");
    }
    if (walked.count !== governingCount) {
      throw new RuleApplicationError(index, read.path, `addresses different elements from ${governing.path}, so the paths cannot be paired element by element`);
    }
    for (const empty of walked.empties) {
      empties.push({ locus: read.locus, empty });
    }
  }
  walkLocus(doc, governing.locus, gate, (trail, value) => {
    const indexes = wildcardIndexes(governing.locus, trail);
    const values = [
      value,
      ...otherReads.map((read) => {
        const found = readTrail(doc, bindLocus(read.locus, indexes));
        if (!found.found) {
          throw new RuleApplicationError(index, read.path, `addresses different elements from ${governing.path}, so the paths cannot be paired element by element`);
        }

        return found.value;
      }),
    ];
    const results = transformed(rule, values);
    const outputs = writeLoci.map((locus, position) => ({ trail: bindLocus(locus, indexes), value: results[position] }));
    try {
      writeMatches(target, outputs);
    } catch (error) {
      throw new RuleApplicationError(index, rule.writePath, errorMessage(error));
    }
  });
  try {
    for (const { locus, empty } of empties) {
      // An existing empty source array yields no matches, so without this its counterpart would never come into being: decode would find the path absent, or an inner array would leave a gap or a shorter outer array.
      const emptyIndexes = wildcardIndexes(locus, empty.trail);
      for (const writeLocus of writeLoci) {
        ensureArray(target, bindLocus(writeLocus, emptyIndexes, empty.wildcard));
      }
    }
  } catch (error) {
    throw new RuleApplicationError(index, rule.writePath, errorMessage(error));
  }
}

/** Applies a rule's operation to one element's values, turning the operation's own thrown errors into RuleApplicationErrors that name the rule and its read paths. */
function transformed(rule: RulePlan, values: readonly unknown[]): readonly unknown[] {
  try {
    return rule.transform(values);
  } catch (error) {
    throw new RuleApplicationError(rule.index, rule.readPath, errorMessage(error));
  }
}

/** Resolves a two-way rule's operation in one direction, once, to a function from one value per read path to one value per write path. */
function transformFor(rule: TwoWayRule, direction: Direction): (values: readonly unknown[]) => readonly unknown[] {
  switch (rule.op) {
    case "template": {
      const pieces = parseTemplateMemo(rule.template);
      const names = Object.keys(rule.from);
      if (direction === "encode") {
        return (values) => [renderTemplate(pieces, new Map(names.map((name, position) => [name, values[position]])))];
      }

      return ([text]) => {
        if (typeof text !== "string") {
          throw new Error(`template decode applies to strings, found: ${JSON.stringify(text)}`);
        }
        const parts = splitTemplate(pieces, text);

        return names.map((name) => parts.get(name));
      };
    }
    case "copy":
      return direction === "encode" ? ([value]) => copyEncode(rule, value) : (values) => [copyDecode(values)];
    case "move":
    case "scale":
    case "enum":
    case "format":
    case "split": {
      const op = singlePathOp(rule, direction);

      return ([value]) => [op(value)];
    }
    default:
      return unhandledOp();
  }
}

/** Unreachable for any rule that passed the schema: the default arm exists so the switch is total, and reaching it means this package's schema and executor disagree. */
function unhandledOp(): never {
  throw new Error("no operation handler for the rule's op: the schema and the executor disagree");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/** The output document is only as JSON as the input document was (move passes values through untouched), so the declared JsonValue return type is earned at this boundary: a non-JSON value anywhere in the output fails loudly here rather than reaching a caller as a lie. */
function parseJsonValue(target: Record<string, unknown>): JsonValue {
  return JsonValueSchema.parse(target);
}

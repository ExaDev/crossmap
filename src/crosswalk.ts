import { z } from "zod";
import { JsonValueSchema, PredicateNodeSchema } from "trilean";
import { CrosswalkSyntaxError, type SyntaxIssue } from "./errors";
import { define } from "./define";
import { PATH_REGEX } from "./paths";
import { parseTemplate, PLACEHOLDER_NAME, templateProblems } from "./ops/template";

/** A path string as the crosswalk format accepts it: syntax only (the structural checks over sets of paths live in validateCrosswalk, which sees the whole rule list). */
const PathField = z.string().regex(PATH_REGEX, {
  message: `not a well-formed path (a key, then any of '.key', '["quoted key"]', '[n]' or '[]'; bare keys are [A-Za-z0-9_-]+, and no key may be __proto__)`,
});

/** A trilean predicate tree, the shape of every rule's optional `when`: evaluated against the governing document (source for encode, target for decode; wildcards forbidden, checked structurally in validateCrosswalk). Exported so consumers building crosswalks in TypeScript have the type without importing trilean separately. */
export type When = z.infer<typeof PredicateNodeSchema>;

export const MoveRuleSchema = z
  .object({
    op: z.literal("move"),
    from: PathField,
    to: PathField,
    when: PredicateNodeSchema.optional(),
  })
  .strict();
export type MoveRule = z.infer<typeof MoveRuleSchema>;

export const ScaleRuleSchema = z
  .object({
    op: z.literal("scale"),
    from: PathField,
    to: PathField,
    factor: z.number().refine((factor) => Number.isFinite(factor) && factor !== 0, {
      message: "factor must be a finite non-zero number: decode divides by it",
    }),
    when: PredicateNodeSchema.optional(),
  })
  .strict();
export type ScaleRule = z.infer<typeof ScaleRuleSchema>;

/** The enum op's pair of mappings is validated as one bijection: mapBack must be map's exact inverse (injective map, mapBack holding exactly map's image, every entry inverted), so decode is determined by encode's vocabulary and cannot drift from it. */
export const EnumRuleSchema = z
  .object({
    op: z.literal("enum"),
    from: PathField,
    to: PathField,
    map: z.record(z.string(), z.string()),
    mapBack: z.record(z.string(), z.string()),
    when: PredicateNodeSchema.optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const image = new Set(Object.values(rule.map));
    if (image.size !== Object.keys(rule.map).length) {
      ctx.addIssue({ code: "custom", path: ["map"], message: "map must be injective: two keys mapping to one value have no inverse" });
    }
    if (Object.keys(rule.mapBack).length !== image.size) {
      ctx.addIssue({ code: "custom", path: ["mapBack"], message: "mapBack must hold exactly the image of map: an entry map never produces, or a produced value it lacks, has no inverse" });
    }
    for (const [from, to] of Object.entries(rule.map)) {
      if (rule.mapBack[to] !== from) {
        ctx.addIssue({ code: "custom", path: ["mapBack"], message: `mapBack must invert map: map sends ${from} to ${to} but mapBack does not send ${to} back to ${from}` });
      }
    }
  });
export type EnumRule = z.infer<typeof EnumRuleSchema>;

export const FormatKindSchema = z.enum(["isoDateTime", "numberText"]);
export type FormatKind = z.infer<typeof FormatKindSchema>;

export const FormatRuleSchema = z
  .object({
    op: z.literal("format"),
    from: PathField,
    to: PathField,
    kind: FormatKindSchema,
    when: PredicateNodeSchema.optional(),
  })
  .strict();
export type FormatRule = z.infer<typeof FormatRuleSchema>;

export const SplitRuleSchema = z
  .object({
    op: z.literal("split"),
    from: PathField,
    to: PathField,
    separator: z.string().min(1, "separator must be non-empty: an empty separator makes decode's join ambiguous"),
    when: PredicateNodeSchema.optional(),
  })
  .strict();
export type SplitRule = z.infer<typeof SplitRuleSchema>;

/** Several fields rendered into one text through a template, and split back out of it. `from` maps each placeholder name to the path of its field; the template is validated as having a unique inverse (every field used exactly once, a literal between every two placeholders), and encode refuses a value that contains the literal after its placeholder, so decode always recovers the fields encode rendered. */
export const TemplateRuleSchema = z
  .object({
    op: z.literal("template"),
    from: z.record(z.string().regex(PLACEHOLDER_NAME, { message: "a template field name is [A-Za-z0-9_]+ other than __proto__" }), PathField),
    to: PathField,
    template: z.string(),
    when: PredicateNodeSchema.optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    let problems: readonly string[];
    try {
      problems = templateProblems(parseTemplate(rule.template), Object.keys(rule.from));
    } catch (error) {
      problems = [error instanceof Error ? error.message : String(error)];
    }
    for (const message of problems) {
      ctx.addIssue({ code: "custom", path: ["template"], message });
    }
  });
export type TemplateRule = z.infer<typeof TemplateRuleSchema>;

/** One value written to several places. Decode reads every copy and requires them to agree, so the inverse is the one value they share; at least two `to` paths, since one is a `move`. */
export const CopyRuleSchema = z
  .object({
    op: z.literal("copy"),
    from: PathField,
    to: z.array(PathField).min(2, "a copy writes at least two paths: one is a move"),
    when: PredicateNodeSchema.optional(),
  })
  .strict();
export type CopyRule = z.infer<typeof CopyRuleSchema>;

/** A two-way rule: closed under inversion, so encode and decode both derive from it. */
export const TwoWayRuleSchema = z.discriminatedUnion("op", [MoveRuleSchema, ScaleRuleSchema, EnumRuleSchema, FormatRuleSchema, SplitRuleSchema, TemplateRuleSchema, CopyRuleSchema]);
export type TwoWayRule = z.infer<typeof TwoWayRuleSchema>;

export const DropRuleSchema = z
  .object({
    op: z.literal("drop"),
    from: PathField,
    direction: z.literal("encode"),
    when: PredicateNodeSchema.optional(),
  })
  .strict();
export type DropRule = z.infer<typeof DropRuleSchema>;

export const DefaultRuleSchema = z
  .object({
    op: z.literal("default"),
    to: PathField,
    value: JsonValueSchema,
    direction: z.enum(["encode", "decode"]),
    when: PredicateNodeSchema.optional(),
  })
  .strict();
export type DefaultRule = z.infer<typeof DefaultRuleSchema>;

/** A one-way rule: explicitly lossy, applying in one direction only. */
export const OneWayRuleSchema = z.discriminatedUnion("op", [DropRuleSchema, DefaultRuleSchema]);
export type OneWayRule = z.infer<typeof OneWayRuleSchema>;

/**
 * The crosswalk document's schema: the rule list that derives both encode and decode. Schema-attached guard per the house pattern (`CrosswalkSchema.is(x)` narrows without a separate hand-written guard). The explicit annotation names the validation surface for declaration emit (the bare schema's inferred type is deeper than the compiler will serialise into a .d.ts); runtime validation is the full strict object below.
 */
export const CrosswalkSchema: z.ZodType<Crosswalk> & { is: (value: unknown) => value is Crosswalk } = define(
  z
    .object({
      source: z.string(),
      target: z.string(),
      rules: z.array(TwoWayRuleSchema).default([]),
      oneWay: z.array(OneWayRuleSchema).default([]),
    })
    .strict(),
);
export interface Crosswalk {
  readonly source: string;
  readonly target: string;
  readonly rules: readonly TwoWayRule[];
  readonly oneWay: readonly OneWayRule[];
}

/**
 * Parses an unknown value as a crosswalk document.
 * @param doc - The candidate crosswalk document.
 * @returns The validated crosswalk, with omitted rule arrays defaulted to empty.
 * @throws CrosswalkSyntaxError carrying every issue found, not just the first.
 */
export function parseCrosswalk(doc: unknown): Crosswalk {
  const result = CrosswalkSchema.safeParse(doc);
  if (!result.success) {
    throw new CrosswalkSyntaxError(
      result.error.issues.map((issue): SyntaxIssue => ({
        message: `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
      })),
    );
  }

  return result.data;
}

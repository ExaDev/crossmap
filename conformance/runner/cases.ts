import { z } from "zod";

/** What every case has; the kind-specific fields are read by the schema of the kind. */
export const BaseCaseSchema = z.looseObject({
  id: z.string(),
  from: z.string(),
  kind: z.string(),
  skip: z.enum(["ts", "rust"]).optional(),
  reason: z.string().optional(),
});

/** One corpus case as loaded: the fields every case has, with the rest left for the kind's own schema. */
export type Case = z.infer<typeof BaseCaseSchema>;

/** What a thrown error must carry; see `errorExpect` in case.schema.json. */
export const ErrorExpectSchema = z.object({
  class: z.string(),
  ruleIndex: z.number().optional(),
  path: z.string().optional(),
  sampleIndex: z.number().optional(),
  message: z.string().optional(),
  messageContains: z.array(z.string()).optional(),
  minIssues: z.number().optional(),
  issues: z.array(z.object({ message: z.string(), ruleIndex: z.number().optional() })).optional(),
});

const errorOutcome = z.object({ error: ErrorExpectSchema });
const issues = z.array(z.object({ message: z.string(), ruleIndex: z.number() }));
const cliText = z.union([z.string(), z.object({ contains: z.array(z.string()) })]);

/** One schema per case kind. A schema describes the fields the executor of that kind reads. */
export const KindSchemas = {
  "path-parse": z.object({ path: z.string(), expect: z.union([z.object({ steps: z.unknown() }), errorOutcome]) }),
  "path-format": z.object({ path: z.string(), expect: z.object({ canonical: z.string() }) }),
  "path-read": z.object({ document: z.unknown(), path: z.string(), expect: z.object({ found: z.boolean(), matches: z.unknown().optional(), empties: z.unknown().optional() }) }),
  parse: z.object({ crosswalk: z.unknown(), expect: z.union([z.object({ crosswalk: z.unknown() }), errorOutcome]) }),
  validate: z.object({ crosswalk: z.unknown(), expect: z.object({ issues }) }),
  "rule-sides": z.object({ rule: z.unknown(), expect: z.unknown() }),
  "error-message": z.object({ error: z.object({ class: z.string(), issues: z.array(z.object({ message: z.string(), ruleIndex: z.number().default(-1) })).default([]), ruleIndex: z.number().default(0), path: z.string().default(""), sampleIndex: z.number().default(0), message: z.string().default("") }), expect: z.object({ message: z.string() }) }),
  run: z.object({
    crosswalk: z.unknown(),
    direction: z.enum(["encode", "decode"]),
    document: z.unknown(),
    expect: z.union([z.object({ output: z.unknown(), outputText: z.string().optional() }), errorOutcome]),
  }),
  "round-trip": z.object({ crosswalk: z.unknown(), samples: z.array(z.unknown()), expect: z.union([z.object({ ok: z.literal(true) }), errorOutcome]) }),
  cli: z.object({
    args: z.array(z.string()),
    files: z.record(z.string(), z.string()).default({}),
    stdin: z.string().default(""),
    server: z.record(z.string(), z.object({ status: z.number(), body: z.string(), headers: z.record(z.string(), z.string()).optional() })).optional(),
    expect: z.object({
      status: z.number(),
      stdout: cliText.optional(),
      stdoutJson: z.unknown().optional(),
      stderr: z.object({ equals: z.string().optional(), startsWith: z.string().optional(), contains: z.array(z.string()).optional() }).optional(),
    }),
  }),
  "is-url": z.object({ argument: z.string(), expect: z.boolean() }),
  "schema-canonical": z.object({ expect: z.literal(true) }),
  "schema-when-ref": z.object({ expect: z.string() }),
  "schema-pointer": z.object({ pointer: z.string(), sorted: z.boolean().optional(), expect: z.unknown() }),
  "schema-rule-requires-to": z.object({ op: z.string(), expect: z.boolean() }),
  "schema-validates": z.object({ document: z.unknown(), expect: z.boolean() }),
} as const;

/** The kinds the corpus defines, which the case schema must also list. */
export type Kind = keyof typeof KindSchemas;

/**
 * Whether a case kind is one the runner executes.
 * @param kind - A case's `kind`.
 * @returns True for a kind with a schema above.
 */
export function isKind(kind: string): kind is Kind {
  return Object.hasOwn(KindSchemas, kind);
}

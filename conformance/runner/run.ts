/**
 * Runs the conformance corpus against the TypeScript implementation: `pnpm exec tsx conformance/runner/run.ts [corpus directory]`.
 * Exits 0 when every case conforms; 1 on any mismatch, any corpus problem (format, schema, manifest disagreement) or an empty corpus.
 */
import { join } from "node:path";
import { loadCorpus } from "./corpus";
import { executeCase } from "./execute";

/** The implementation this runner executes, which decides the skip list it honours. */
const IMPLEMENTATION = "ts";

/** The outcome of one run of the corpus. */
export interface Report {
  readonly executed: number;
  readonly skipped: number;
  readonly failures: readonly string[];
  readonly problems: readonly string[];
  readonly perArea: ReadonlyMap<string, number>;
}

/**
 * Loads and executes every case under `root`.
 * @param root - The conformance directory.
 * @returns The report; the run conforms exactly when `problems` and `failures` are both empty and `executed` is positive.
 */
export async function runCorpus(root: string): Promise<Report> {
  const loaded = loadCorpus(root);
  const { files } = loaded;
  const problems = [...loaded.problems];
  const failures: string[] = [];
  const perArea = new Map<string, number>();
  const registered = new Set<string>();
  const started = new Set<string>();
  let skipped = 0;
  const pending: { readonly area: string; readonly path: string; readonly id: string; readonly from: string; readonly run: Promise<string[]> }[] = [];
  for (const file of files) {
    const area = file.path.split("/").slice(1, 2).join("/");
    for (const entry of file.cases) {
      if (registered.has(entry.id)) {
        problems.push(`${entry.id}: registered twice`);
      }
      registered.add(entry.id);
      if (entry.skip === IMPLEMENTATION) {
        skipped += 1;
        continue;
      }
      started.add(entry.id);
      pending.push({ area, path: file.path, id: entry.id, from: entry.from, run: executeCase(entry) });
    }
  }
  const settled = await Promise.all(pending.map(async (item) => ({ ...item, found: await item.run })));
  for (const item of settled) {
    perArea.set(item.area, (perArea.get(item.area) ?? 0) + 1);
    for (const difference of item.found) {
      failures.push(`${item.id} (${item.path}) ${item.from}\n    ${difference}`);
    }
  }
  const total = files.reduce((count, file) => count + file.cases.length, 0);
  if (registered.size !== total || started.size + skipped !== total) {
    problems.push(`completeness: ${String(total)} cases on disk, ${String(registered.size)} registered, ${String(started.size)} started and ${String(skipped)} skipped`);
  }

  return { executed: settled.length, skipped, failures, problems, perArea };
}

/** Runs the corpus from the command line and sets the exit status. */
async function main(): Promise<void> {
  const report = await runCorpus(process.argv[2] ?? join(import.meta.dirname, ".."));
  for (const problem of report.problems) {
    console.error(`corpus problem: ${problem}`);
  }
  for (const failure of report.failures) {
    console.error(`FAIL ${failure}`);
  }
  const areas = [...report.perArea].sort(([left], [right]) => (left < right ? -1 : 1)).map(([area, count]) => `${area} ${String(count)}`).join(", ");
  console.log(`conformance (${IMPLEMENTATION}): ${String(report.executed)} executed, ${String(report.skipped)} skipped, ${String(report.failures.length)} failed, ${String(report.problems.length)} corpus problems (${areas})`);
  if (report.failures.length > 0 || report.problems.length > 0 || report.executed === 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === import.meta.filename) {
  await main();
}

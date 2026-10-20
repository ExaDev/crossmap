import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const root = join(import.meta.dirname, '..');

/** turbo.json is JSONC: its comments explain the task graph, and each one sits on a line of its own. */
function readJsonc(name: string): unknown {
  const text = readFileSync(join(root, name), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  return JSON.parse(text);
}

const TurboSchema = z.object({
  tasks: z.record(z.string(), z.object({ dependsOn: z.array(z.string()).optional() }).loose()),
});
const TsconfigSchema = z.object({ compilerOptions: z.object({ incremental: z.boolean().optional() }).loose() }).loose();
const PackageSchema = z.object({ scripts: z.record(z.string(), z.string()) });

const turbo = TurboSchema.parse(readJsonc('turbo.json'));
const { scripts } = PackageSchema.parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
const dependsOn = (task: string): readonly string[] => turbo.tasks[task]?.dependsOn ?? [];

describe('the task graph in turbo.json', () => {
  it('orders typecheck and test after the build, because the schema generation script imports the built dist and the JSON Schema suite reads the generated schema', () => {
    expect(dependsOn('_typecheck')).toContain('_build');
    expect(dependsOn('_test')).toContain('_build');
  });

  it('has the pre-push aggregate depend on the build, the typecheck and the tests, so the hook carries no order of its own', () => {
    expect([...dependsOn('_prepush')].sort()).toEqual(['_build', '_test', '_typecheck']);
  });

  it('has a task for every underscore script, and a public script that runs it through turbo', () => {
    const leaves = Object.keys(scripts).filter((name) => name.startsWith('_'));
    expect(leaves.length).toBeGreaterThan(0);
    for (const leaf of leaves) {
      expect(Object.keys(turbo.tasks), `${leaf} has no task`).toContain(leaf);
      expect(scripts[leaf.slice(1)], `${leaf.slice(1)} should wrap ${leaf}`).toBe(`turbo run ${leaf}`);
    }
  });

  it('has a script behind every task except the aggregate', () => {
    for (const task of Object.keys(turbo.tasks).filter((name) => name !== '_prepush')) {
      expect(Object.keys(scripts), `${task} has no script`).toContain(task);
    }
  });
});

describe('the pre-push hook', () => {
  it('runs the prepush aggregate and nothing that orders tasks itself', () => {
    const hook = readFileSync(join(root, '.husky/pre-push'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    expect(hook).toEqual(['pnpm run prepush']);
    expect(scripts['prepush']).toBe('turbo run _prepush');
  });
});

describe('the incremental caches', () => {
  it('has both lint scripts cache by content, because a fresh checkout gives every file a new mtime and the default strategy would never hit', () => {
    for (const name of ['_lint', '_lint:check']) {
      expect(scripts[name], `${name} should use the content strategy`).toContain('--cache-strategy content');
    }
  });

  it('has tsc keep incremental state and the typecheck job cache the file each program writes beside its config, because an uncached build info is lost with the runner', () => {
    expect(TsconfigSchema.parse(readJsonc('tsconfig.json')).compilerOptions.incremental).toBe(true);
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    for (const config of ['tsconfig.json', 'tsconfig.node.json']) {
      const buildInfo = config.replace(/\.json$/, '.tsbuildinfo');
      expect(workflow, `${buildInfo} is not cached in ci.yml`).toContain(buildInfo);
    }
  });
});

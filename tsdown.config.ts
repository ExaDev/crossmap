import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    root: 'src',
    format: ['esm'],
    dts: true,
    platform: 'neutral',
    clean: true,
  },
  {
    // The `twindex` command. Kept out of src/ and dist/ on purpose: it is the one shipped file allowed Node APIs, and dist/ holds the platform-neutral library. It bundles this package's own source and leaves its dependencies (trilean, zod) as the runtime dependencies they already are.
    entry: ['cli/twindex.ts'],
    format: ['esm'],
    dts: false,
    platform: 'node',
    outDir: 'dist-cli',
    clean: true,
  },
]);

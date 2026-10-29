import type { Options } from 'semantic-release';

type ReleaseLevel = 'major' | 'minor' | 'patch' | false;

interface CommitType {
  readonly type: string;
  readonly release: ReleaseLevel;
  /** The changelog and GitHub release notes section commits of this type render under. */
  readonly section: string;
}

/**
 * Single source of truth for the conventional-commit types this project uses. commitlint's allowed type-enum (commitlint.config.ts imports this), commit-analyzer's releaseRules below and the notes generator's sections all derive from it, so a type cannot trigger a release without also being accepted by commit-msg validation, or the reverse, and no type can release without its commits appearing in the notes: the early releases whose only commits were docs and chore entries shipped as empty sections because the notes preset hid them.
 */
export const commitTypes: readonly CommitType[] = [
  { type: 'feat', release: 'minor', section: 'Features' },
  { type: 'fix', release: 'patch', section: 'Bug Fixes' },
  { type: 'perf', release: 'patch', section: 'Performance Improvements' },
  { type: 'revert', release: 'patch', section: 'Reverts' },
  { type: 'refactor', release: 'patch', section: 'Code Refactoring' },
  { type: 'docs', release: 'patch', section: 'Documentation' },
  { type: 'style', release: 'patch', section: 'Styles' },
  { type: 'test', release: 'patch', section: 'Tests' },
  { type: 'build', release: 'patch', section: 'Build System' },
  { type: 'ci', release: 'patch', section: 'Continuous Integration' },
  { type: 'chore', release: 'patch', section: 'Chores' },
];

/**
 * Runs on `main`. Analyses commits since the last tag, bumps the version, publishes to npmjs.org through trusted OIDC publishing (no stored token, see .github/workflows/ci.yml), creates a versioned tag and GitHub Release with generated notes, and commits CHANGELOG.md and package.json back to main. The repository URL is the one in package.json, over https with the workflow's GITHUB_TOKEN: main has no ruleset, so that token can push the release commit. A ruleset on main would reject that push and need a bypass identity (json-compose's deploy key is the worked example).
 */
const config: Options = {
  branches: ['main'],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'conventionalcommits',
        releaseRules: [{ breaking: true, release: 'major' }, ...commitTypes.map((t) => ({ type: t.type, release: t.release }))],
      },
    ],
    [
      '@semantic-release/release-notes-generator',
      {
        // conventional-changelog-conventionalcommits is a direct dependency pinned to 9.x, not left to resolve through @commitlint/config-conventional: release-notes-generator loads conventional-changelog-writer 8, and the 10.x preset needs writer 9, so it renders a bare version header instead of notes. With 9.x, presetConfig.types lists every type in commitTypes under its section, which the angular preset cannot (it lists only feat, fix, perf and revert, and ignores a `types` option), so a release cut by a docs, ci or chore commit had a version header and nothing under it. The version header is always H2, so the file's only H1 stays the changelog title.
        preset: 'conventionalcommits',
        presetConfig: { types: commitTypes.map((t) => ({ type: t.type, section: t.section })) },
      },
    ],
    '@semantic-release/changelog',
    ['@semantic-release/npm', { npmPublish: true }],
    '@semantic-release/github',
    [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'package.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]',
      },
    ],
  ],
};

export default config;

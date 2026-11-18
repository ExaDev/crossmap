/** @typedef {'major' | 'minor' | 'patch' | false} ReleaseLevel */

/**
 * @typedef {object} CommitType
 * @property {string} type
 * @property {ReleaseLevel} release
 * @property {string} section The changelog and GitHub release notes section commits of this type render under.
 */

/**
 * Single source of truth for the conventional-commit types this project uses. commitlint's allowed type-enum (commitlint.config.js imports this), commit-analyzer's releaseRules below and the notes generator's sections all derive from it, so a type cannot trigger a release without also being accepted by commit-msg validation, or the reverse, and no type can release without its commits appearing in the notes: the early releases whose only commits were docs and chore entries shipped as empty sections because the notes preset hid them.
 */
/** @type {readonly CommitType[]} */
export const commitTypes = [
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
 * Runs on `main`. Analyses commits since the last tag and computes the one version every artefact is released at; scripts/semantic-release-version.mjs writes it into the Rust workspace, the lock file and the npm manifests and regenerates the schema whose `$id` names it. The release commit holds those files and CHANGELOG.md, and is tagged and given a GitHub Release with generated notes. semantic-release publishes nothing: the jobs after it in .github/workflows/ci.yml build the crates, the wheels and the npm package from the tagged commit and publish them to crates.io, PyPI and npm through trusted publishing (no stored token). The release commit and tag are pushed over SSH with the deploy key ci.yml provisions.
 */
/** @type {import('semantic-release').Options} */
const config = {
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
    './scripts/semantic-release-version.mjs',
    '@semantic-release/github',
    [
      '@semantic-release/git',
      {
        // Every file scripts/release-version.py and the schema generator write, beside the changelog.
        assets: ['CHANGELOG.md', 'package.json', 'packages/crossmap/package.json', 'rust/Cargo.toml', 'rust/Cargo.lock', 'schemas/crossmap.schema.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]',
      },
    ],
  ],
};

export default config;

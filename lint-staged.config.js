/** @type {import('lint-staged').Configuration} */
const config = {
  // rustfmt formats a staged file in place with the settings `cargo fmt` uses; the edition is the workspace's, which a lone rustfmt does not read from Cargo.toml.
  '*.rs': 'rustfmt --edition 2024',
};

export default config;

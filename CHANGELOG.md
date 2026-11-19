## [0.12.1](https://github.com/ExaDev/crossmap/compare/v0.12.0...v0.12.1) (2026-11-19)

### Documentation

* move the worked examples and the format reference out of the README ([35c7fb4](https://github.com/ExaDev/crossmap/commit/35c7fb4ee977af4be8a30b7899fb9ead732bba15))

## [0.12.0](https://github.com/ExaDev/crossmap/compare/v0.11.1...v0.12.0) (2026-11-19)

### Features

* **npm:** build the crossmap package from the wasm binding ([f08586d](https://github.com/ExaDev/crossmap/commit/f08586d8ae741cb63a1039a447d8b322096aa37b)), closes [#init](https://github.com/ExaDev/crossmap/issues/init)
* **python:** add the crosswalk-codec Python package over the Rust codec ([af22bc5](https://github.com/ExaDev/crossmap/commit/af22bc537dcb25dc81d3ba28d3e3bd28c6360094))
* **python:** return the crosswalk JSON Schema from the wheel ([66116a9](https://github.com/ExaDev/crossmap/commit/66116a99515478da40bdcb5e0931b4fb22ec648b))
* **rust:** port the crosswalk codec and its command to Rust ([017dfe8](https://github.com/ExaDev/crossmap/commit/017dfe8852b5b4895cd71fe687e53e97fcd8cb50))
* **rust:** write the crosswalk JSON Schema from the core crate ([aa98796](https://github.com/ExaDev/crossmap/commit/aa987967a20015df0afc85b0a83192c4fa7ef5b8))
* **wasm:** bind the codec and the command's steps to wasm ([74beda1](https://github.com/ExaDev/crossmap/commit/74beda190d2151ba27fd23ef6e8a2ec65b3e93f4))

### Bug Fixes

* **ci:** leave the packaged crates where the schema and version checks read them ([bbfadb2](https://github.com/ExaDev/crossmap/commit/bbfadb2955c3768ba721cefe001676bfba61d981))
* **ci:** route a public repository's jobs to Blacksmith instead of the fleet ([4df793f](https://github.com/ExaDev/crossmap/commit/4df793f533db45e412982e55ecad548d6938fc23))
* **cli:** read a file: URL on Windows as Node's fileURLToPath does ([1877f74](https://github.com/ExaDev/crossmap/commit/1877f74fa91cce3d9b624444c78267165093d907))

### Code Refactoring

* **cli:** share the command's standard-stream host with other hosts ([6eaa8b6](https://github.com/ExaDev/crossmap/commit/6eaa8b61d8f74d1a40d021799bf0110272cdf9e0))
* **cli:** split the command into pure plan and complete steps ([21be88c](https://github.com/ExaDev/crossmap/commit/21be88c2edb59b4263c5d64ff33bab6894cef7b6))
* remove the TypeScript implementation and its tooling ([2ffb809](https://github.com/ExaDev/crossmap/commit/2ffb8098be3416d14bf9a378f7b427316cebb5f5))

### Documentation

* **conformance:** name the Rust, npm and Python runners of the corpus ([e10f7af](https://github.com/ExaDev/crossmap/commit/e10f7afdaab80bddc773565f9332fa85f9ec063c))
* describe contributing and the security scope for the Rust codec ([8b83ab1](https://github.com/ExaDev/crossmap/commit/8b83ab192eefc1b2f0f9e7a61c0c723a99278979))
* describe the committed schema and the Rust generator that writes it ([6e622f3](https://github.com/ExaDev/crossmap/commit/6e622f39e794b489dd79262cb5d76491207c1364))
* describe the Rust codec and its three packages in the README ([618b663](https://github.com/ExaDev/crossmap/commit/618b663e34e8670daf00f7146af6c56cf3ff485d))
* **npm:** list the breaking changes from the TypeScript package ([d850f79](https://github.com/ExaDev/crossmap/commit/d850f790928b33c578b476a67dfc737edcf93271))
* state parity with the packages and the corpus, not a removed implementation ([f8f3252](https://github.com/ExaDev/crossmap/commit/f8f3252af44ee68269c31b88a82ee9e99acfdd1f))

### Styles

* **python:** format the binding's sources and README with the pinned ruff ([877f0e8](https://github.com/ExaDev/crossmap/commit/877f0e8e3b5511968826b2deedcaf21698e6679e))

### Tests

* add a language-neutral conformance corpus and its TypeScript runner ([ec2d563](https://github.com/ExaDev/crossmap/commit/ec2d5633f5ff760dd4ac92896ff1d4341a6fd62f))
* **bench:** measure encode and decode against hand-written copies in Rust ([8e303b6](https://github.com/ExaDev/crossmap/commit/8e303b64a9484c1e240572e426f114b33196fdaa))
* **conformance:** name a case directory's file: URL with {dirUrl} ([36df6cc](https://github.com/ExaDev/crossmap/commit/36df6ccd8085c1570af045d48e9a99db42b5308e))
* **python:** run the conformance corpus and API tests on the installed wheel ([9bb253e](https://github.com/ExaDev/crossmap/commit/9bb253ea88743fddc958c15ec9404f38be97efc5))
* **rust:** count the JSON Schema kinds as having no Rust executor ([528b6dd](https://github.com/ExaDev/crossmap/commit/528b6dd981475ba51498c014c3cea0fd139082e6))
* **rust:** execute the JSON Schema conformance cases ([5b26b53](https://github.com/ExaDev/crossmap/commit/5b26b53ad9749fe9ef87423cbab81b93fbdc4161))
* **rust:** hold the codec to the properties the corpus cannot state ([7f62525](https://github.com/ExaDev/crossmap/commit/7f625258c192ac8e1fa4492b18dd1b4d3e2105f9))
* **rust:** keep the pre-port JSON Schema and trilean's published schema ([62a1b52](https://github.com/ExaDev/crossmap/commit/62a1b52f153cc0c8789bfe787528ac1a50a0c6f1))
* **schema:** check the trilean pin against the pre-port schema ([7744815](https://github.com/ExaDev/crossmap/commit/7744815bfea0cbc4a8ef0c9265490cf001af1968))

### Build System

* read and write the one release version every artefact carries ([eb7e8f7](https://github.com/ExaDev/crossmap/commit/eb7e8f7bbfb51a6e0a214f1c9b2a883dfec01469))
* **rust:** allowlist the dependency graph and test the built command ([ad635cb](https://github.com/ExaDev/crossmap/commit/ad635cb016172252a6a7b43ddcbb309c31f1ffe8))
* **rust:** allowlist the wasm binding and its glue crates in cargo-deny ([c9fd256](https://github.com/ExaDev/crossmap/commit/c9fd2560ceaf4f408a40128687ccdafa907e4d39))
* **rust:** commit the generated JSON Schema and check it is current ([9be5077](https://github.com/ExaDev/crossmap/commit/9be50779e821db79049b27dda67448bd8817647b))
* **rust:** make crossmap and crossmap-cli publishable to crates.io ([1721690](https://github.com/ExaDev/crossmap/commit/1721690e87495f7336f1505d99b00f92ae321a1f)), closes [ExaDev/trilean#192](https://github.com/ExaDev/trilean/issues/192)
* **rust:** take trilean-eval and trilean-json-shape from crates.io ([f27cff4](https://github.com/ExaDev/crossmap/commit/f27cff4572270ae1429721f95712ed778253f698))
* **rust:** take trilean's crates from the trilean@3.0.0 release commit ([8f88481](https://github.com/ExaDev/crossmap/commit/8f884817d70fe50f169fac337da34ba34c2b04cc)), closes [ExaDev/trilean#192](https://github.com/ExaDev/trilean/issues/192)
* write the release and commitlint configurations in JavaScript ([2bff31d](https://github.com/ExaDev/crossmap/commit/2bff31d31973b5cba945f2007e9fd10a603f4386))

### Continuous Integration

* check the Rust workspace and its three artefacts in place of the TypeScript jobs ([b7164c5](https://github.com/ExaDev/crossmap/commit/b7164c50177d7cdf591c1bbf35accc0246cb303a))
* create the directory npm pack writes the tarball into ([c011a4f](https://github.com/ExaDev/crossmap/commit/c011a4fcf86d0dcb1162433a5bb01dfb7c87189d))
* dry-run an already published npm version as a pre-release of it ([6035e95](https://github.com/ExaDev/crossmap/commit/6035e959ae522f18b1af313cc5413cab0fe5a5f8))
* keep the build cache out of container wheel builds ([d10b3b9](https://github.com/ExaDev/crossmap/commit/d10b3b97ebfcd9bceea7a016eb6be5142ce70b96))
* let Dependabot update the Rust workspace's crates ([e773b38](https://github.com/ExaDev/crossmap/commit/e773b38a3129d317c193d830687a755d6d3526e4))
* release the crates, the wheels and the npm package at one version ([e89f47c](https://github.com/ExaDev/crossmap/commit/e89f47cc9f335762012d2cc9ffd8a56e0eca943a))
* run the crates dry run as its own job, naming an unpublished dependency ([2d3fe7c](https://github.com/ExaDev/crossmap/commit/2d3fe7c43c260e739203c7c07ccd5d4b684a174c))
* skip the Required Checks job in a cancelled run ([14c91fd](https://github.com/ExaDev/crossmap/commit/14c91fd0e2bde8e234b8d9b60253100542de49f4))

## [0.11.1](https://github.com/ExaDev/crossmap/compare/v0.11.0...v0.11.1) (2026-11-05)

### Bug Fixes

* **deps:** align zod with dependent consumers ([4eacdbc](https://github.com/ExaDev/crossmap/commit/4eacdbc6e837683fc72837cbedde0f30a8b8f94b))

## [0.11.0](https://github.com/ExaDev/crossmap/compare/v0.10.0...v0.11.0) (2026-11-01)

### Features

* export ruleSides and its RuleSides type ([a638bf0](https://github.com/ExaDev/crossmap/commit/a638bf0999af346627d88a8405bd3b407ec83ef0))

## [0.10.0](https://github.com/ExaDev/crossmap/compare/v0.9.0...v0.10.0) (2026-11-01)

### Features

* **crosswalk:** accept a $schema property naming the document's schema ([c06d765](https://github.com/ExaDev/crossmap/commit/c06d7652f54c913a6b11acd7c72daae5ce93ef40))

## [0.9.0](https://github.com/ExaDev/crossmap/compare/v0.8.3...v0.9.0) (2026-11-01)

### Features

* **crosswalk:** add a keep list of paths carried through unchanged ([64671de](https://github.com/ExaDev/crossmap/commit/64671def2857611931a80b2cfada33de0a15a8cd))
* **crosswalk:** let a single-path rule leave out a to that equals its from ([7a5272b](https://github.com/ExaDev/crossmap/commit/7a5272bd2f42b2e01ce51af778c4a9136a43c236))

### Performance Improvements

* **executor:** check the output is JSON without copying it ([7088e20](https://github.com/ExaDev/crossmap/commit/7088e20e24e9b71c59ac6ac1164bb002cd8ee4c8))
* **executor:** validate and prepare a crosswalk once per crosswalk object ([48b4366](https://github.com/ExaDev/crossmap/commit/48b4366195a2bb9f5c0735ff4662aa3cddbdee75))
* **executor:** walk each source array once for all the rules that read it ([f75bfff](https://github.com/ExaDev/crossmap/commit/f75bfff924efdb684d156edb925f161d2c0a4c5c))
* **paths:** find gaps with one trail and format a write's path only on failure ([fca33ac](https://github.com/ExaDev/crossmap/commit/fca33ac493b091f067366dd3d1ec160bf3cedfd2))

### Documentation

* **contributing:** keep the executor and its reference in step ([31fba57](https://github.com/ExaDev/crossmap/commit/31fba57e5f142489082bb19eab4de65ac345a4d3))

### Tests

* **exact-json:** refuse an array of a subclass, which the schema copies ([f6a468a](https://github.com/ExaDev/crossmap/commit/f6a468af24cdbc2904b99de86ff59a1ce94f3b7b))
* **executor:** compare the executor with a frozen reference copy of it ([f8b8af5](https://github.com/ExaDev/crossmap/commit/f8b8af53832a6b56c2549759c5d3bd4d4a089561))

### Chores

* **bench:** measure a crosswalk the rule-at-a-time executor runs ([8bd2eca](https://github.com/ExaDev/crossmap/commit/8bd2ecacd2b8a30a1c0915937d57503924e3899c))
* **bench:** measure encode and decode against a hand-written copy ([1bb1590](https://github.com/ExaDev/crossmap/commit/1bb15905803084d823e9a4db039d16f49bed7213))
* **bench:** measure the identity crosswalk written as a keep list ([db2a1e8](https://github.com/ExaDev/crossmap/commit/db2a1e85feb5a1c052ef8b73db88181e7e7a581a))

## [0.8.3](https://github.com/ExaDev/crossmap/compare/v0.8.2...v0.8.3) (2026-10-31)

### Continuous Integration

* push the release over SSH with a deploy key ([e8ba6d6](https://github.com/ExaDev/crossmap/commit/e8ba6d6e052b65ae36826c33ad14989482fe8c3b))

## [0.8.2](https://github.com/ExaDev/crossmap/compare/v0.8.1...v0.8.2) (2026-10-29)

### Bug Fixes

* list every commit type in the release notes ([8edf0e6](https://github.com/ExaDev/crossmap/commit/8edf0e610e0b78c42d195ba7a6b09b64d46d65d1))

### Documentation

* list the commits behind each release that had an empty changelog entry ([dc5c6cc](https://github.com/ExaDev/crossmap/commit/dc5c6cc7bbc54e9119098de909ffe53913e1d20f))

## [0.8.1](https://github.com/ExaDev/crossmap/compare/v0.8.0...v0.8.1) (2026-10-21)


### Performance Improvements

* **executor:** write each wildcard element as it is walked ([8d9c544](https://github.com/ExaDev/crossmap/commit/8d9c5448674bc74706874a7b2b9b8b93df957775))

# [0.8.0](https://github.com/ExaDev/crossmap/compare/v0.7.1...v0.8.0) (2026-10-21)


### Features

* **format:** add isoDate, booleanText and jsonText kinds ([39e374f](https://github.com/ExaDev/crossmap/commit/39e374f68e6b3fd3690b13d9529457c817d9dd99))

## [0.7.1](https://github.com/ExaDev/crossmap/compare/v0.7.0...v0.7.1) (2026-10-21)

### Documentation

* **changelog:** backfill every release section with all its commits ([b32b173](https://github.com/ExaDev/crossmap/commit/b32b1739f02a8bc23da4abda46028d705ce2422f))

### Chores

* **release:** render every commit type in the release notes ([a95189d](https://github.com/ExaDev/crossmap/commit/a95189da839004ab545ec091bbc35beaa44da165))

# [0.1.0](https://github.com/ExaDev/crossmap/compare/v0.0.0...v0.1.0) (2026-10-18)


### Bug Fixes

* build before typecheck and test in prepublishOnly ([817737f](https://github.com/ExaDev/crossmap/commit/817737fa9632e5eae4c2f18a2c8e7ea823d70555))
* refuse __proto__ path segments and read only own properties ([3b2d6c6](https://github.com/ExaDev/crossmap/commit/3b2d6c69e485e3375a32ca7d1d2ff64c1702b1bc))
* make scale decode a true division, not a reciprocal multiply ([782167d](https://github.com/ExaDev/crossmap/commit/782167d36c81f9f0f8096484271cfdc739bc0e83))

### Features

* export the public barrel and generate the JSON Schema ([eccae02](https://github.com/ExaDev/crossmap/commit/eccae024059170a6082d6b3b38de83e9426308ed))
* assert round trips over a deterministic corpus ([900cd95](https://github.com/ExaDev/crossmap/commit/900cd9509dc148a3f59f9b5de7e651e719921c72))
* encode and decode through one order-independent executor ([b138201](https://github.com/ExaDev/crossmap/commit/b1382011402888dae4e5ce561f5fd86525fd0e24))
* validate crosswalk structure over the whole rule list ([42962d2](https://github.com/ExaDev/crossmap/commit/42962d279519269b694eff2179906bd1f7790539))
* implement the two-way and one-way operations ([545e4e6](https://github.com/ExaDev/crossmap/commit/545e4e662f9daf074b1dfabb0ff2d2127e0ad946))
* evaluate when predicates through trilean against the governing document ([08c593d](https://github.com/ExaDev/crossmap/commit/08c593d1d0208db79c19276ae6f8036de309173c))
* define the crosswalk format schema and error taxonomy ([252d771](https://github.com/ExaDev/crossmap/commit/252d771cb957d723a04e48516a71cd5244772cb6))
* add the crosswalk path grammar with read and write loci ([cb47a40](https://github.com/ExaDev/crossmap/commit/cb47a40598e3bf9a3079ac0adc5fae87f8d19bef))

### Documentation

* add contributing and security policies ([cff37d4](https://github.com/ExaDev/crossmap/commit/cff37d4c8e9a74a19fe9ebaf3ebcb76493549937))
* write the README with a working logistics example ([870ec3b](https://github.com/ExaDev/crossmap/commit/870ec3b64e7a0d48be4a4d81422a69533804b6ae))

### Continuous Integration

* release from main through semantic-release with npm trusted publishing ([f5c0aa9](https://github.com/ExaDev/crossmap/commit/f5c0aa92ee70328ee26f1be26e9dc8adfdb6f6e0))
* build before typecheck and test, and read the installed schema by path ([af33908](https://github.com/ExaDev/crossmap/commit/af33908cfda8824b4dbac366d0c71c02f1e3d288))

### Chores

* **release:** 0.1.0 [skip ci] ([a250397](https://github.com/ExaDev/crossmap/commit/a250397057c9655c0062f1a5ab526013143c97de))
* scaffold repository from json-compose template ([2d97f0b](https://github.com/ExaDev/crossmap/commit/2d97f0bdf5bdb21bd5ea4b5b1cf7967bfab404c2))

## [0.1.1](https://github.com/ExaDev/crossmap/compare/v0.1.0...v0.1.1) (2026-10-18)


### Documentation

* use the house badge row in the README ([15942dc](https://github.com/ExaDev/crossmap/commit/15942dcb28cfb35d8ba90658af8b4ea2aa7cd20d))

### Chores

* **release:** 0.1.1 [skip ci] ([9cd724c](https://github.com/ExaDev/crossmap/commit/9cd724c3ef50b417ef89d3604d40f2833b2a07a5))

## [0.1.2](https://github.com/ExaDev/crossmap/compare/v0.1.1...v0.1.2) (2026-10-18)


### Chores

* **release:** 0.1.2 [skip ci] ([2054857](https://github.com/ExaDev/crossmap/commit/2054857433cdc0ea8da54222014139794c2145e5))
* **deps-dev:** bump the minor-and-patch group across 1 directory with 3 updates ([dbde821](https://github.com/ExaDev/crossmap/commit/dbde8214eecd329569726131508316b692a0f2fa))

## [0.1.3](https://github.com/ExaDev/crossmap/compare/v0.1.2...v0.1.3) (2026-10-18)


### Chores

* **release:** 0.1.3 [skip ci] ([b23ff9c](https://github.com/ExaDev/crossmap/commit/b23ff9ca144bfd2f1d13cd70e6f18abf3e91d497))
* **deps:** bump the minor-and-patch group across 1 directory with 3 updates ([b4265db](https://github.com/ExaDev/crossmap/commit/b4265db0b69cf69a21cb8e463a1367ec9608b1c3))

## [0.1.4](https://github.com/ExaDev/crossmap/compare/v0.1.3...v0.1.4) (2026-10-19)


### Chores

* **release:** 0.1.4 [skip ci] ([8f79d2b](https://github.com/ExaDev/crossmap/commit/8f79d2bd67fbad6e08965d0f4af9f7b9dc038c18))
* **deps:** bump zod from 4.6.5 to 4.6.6 in the minor-and-patch group ([b048528](https://github.com/ExaDev/crossmap/commit/b04852812733513d34ae22e5685fdb9d8f865ad3))

## [0.1.5](https://github.com/ExaDev/crossmap/compare/v0.1.4...v0.1.5) (2026-10-20)


### Documentation

* **readme:** show a table, a graph and a nested record in the usage examples ([0ff5562](https://github.com/ExaDev/crossmap/commit/0ff556210a10dafbbb7b8907a5362b415773cbbc))

### Tests

* **tasks:** pin the turbo task graph, wrapper scripts and pre-push hook together ([74e75c9](https://github.com/ExaDev/crossmap/commit/74e75c982e9ec9561f762079a305c93909570652))

### Build System

* **hooks:** pre-push runs the turbo prepush task instead of encoding an order ([92f9e32](https://github.com/ExaDev/crossmap/commit/92f9e32e5751b270db9af3764f752ca7fdaf88e1))
* **tasks:** run tasks through turbo so task order and caching live in one graph ([8f74dd7](https://github.com/ExaDev/crossmap/commit/8f74dd77ddfcf04638af077673c54c34ad2db338))

### Continuous Integration

* restore turbo's cache and let turbo order the build before typecheck and test ([0d10252](https://github.com/ExaDev/crossmap/commit/0d10252d68aa051499073260ed9a69b7a25f3404))

### Chores

* **release:** 0.1.5 [skip ci] ([a96c496](https://github.com/ExaDev/crossmap/commit/a96c496bdbec5052abac5d64e8f04e255d961f4b))

# [0.2.0](https://github.com/ExaDev/crossmap/compare/v0.1.5...v0.2.0) (2026-10-20)


### Bug Fixes

* **errors:** leave a between-rule structure issue unnumbered instead of printing rule -1 ([3747091](https://github.com/ExaDev/crossmap/commit/37470917cba5dae5fc4256cf193085f35431ac60))

### Features

* **cli:** add the twindex command for encode, decode, validate and round-trip ([22b0d3d](https://github.com/ExaDev/crossmap/commit/22b0d3d8913bad2a6d9cffe4945647d9eddc78ad))

### Code Refactoring

* rename the package, command and error class from twindex to crossmap ([b107542](https://github.com/ExaDev/crossmap/commit/b107542e7d0914d51a28bb2e565a0fa952f69d07))

### Documentation

* **contributing:** note where incremental lint and typecheck state is kept ([5a5f94d](https://github.com/ExaDev/crossmap/commit/5a5f94d19338766e8a3a7a8e653fd38118ca818e))
* **readme:** document the command line ([843b7fc](https://github.com/ExaDev/crossmap/commit/843b7fc8db7b87825c44595c6a8b7fd1e105aa8a))

### Tests

* **caches:** pin the content lint strategy and the cached tsc build info files ([58ae58e](https://github.com/ExaDev/crossmap/commit/58ae58e9fc0d9be1d70e3205d2dc34956fdc3588))

### Build System

* **typecheck:** keep tsc's incremental build info between CI runs ([ac22329](https://github.com/ExaDev/crossmap/commit/ac22329ef06a18aed5197c91e64998e55ef7efcd))
* **lint:** cache eslint results by content and save a fresh cache entry on every run ([b89b70c](https://github.com/ExaDev/crossmap/commit/b89b70c296ca4170f65109f9d399726c7c39f8cd))

### Continuous Integration

* run the installed twindex command in the consumer job ([a2073b1](https://github.com/ExaDev/crossmap/commit/a2073b12fecf189e5da2a9fa27f9f56c87739604))

### Chores

* **release:** 0.2.0 [skip ci] ([02d9361](https://github.com/ExaDev/crossmap/commit/02d9361dfc3f4cec58a80733593e16f78935aa41))

# [0.3.0](https://github.com/ExaDev/crossmap/compare/v0.2.0...v0.3.0) (2026-10-20)


### Features

* **cli:** read http, https, data and file URLs for the crosswalk, document and samples arguments ([11e8228](https://github.com/ExaDev/crossmap/commit/11e822853d39b3e93f4be4fa3891772fc2e6cc83))

### Documentation

* **readme:** document URL arguments for the command and the fetch equivalent for callers ([ad69895](https://github.com/ExaDev/crossmap/commit/ad6989584479c515175f875f186dd4a73e9fc2eb))

### Tests

* **cli:** start the independent child processes of one URL test together ([34ada93](https://github.com/ExaDev/crossmap/commit/34ada939734e2e34bf71e41ab50733143bb39fc5))
* **neutral:** fail when the shipped library imports a Node module ([df650f1](https://github.com/ExaDev/crossmap/commit/df650f1a89f22c10296d2bc0991ad522dc795c99))

### Chores

* **release:** 0.3.0 [skip ci] ([37f0534](https://github.com/ExaDev/crossmap/commit/37f0534549b114d85f78a41a256dbf54b6f989f7))

# [0.4.0](https://github.com/ExaDev/crossmap/compare/v0.3.0...v0.4.0) (2026-10-21)


### Features

* **paths:** add quoted keys, fixed indices and correct arrays of arrays ([c2c75dd](https://github.com/ExaDev/crossmap/commit/c2c75dd309889b16cd85d9c088875898ead32e2a))

### Documentation

* document quoted keys, fixed indices and nesting with move ([5e92a00](https://github.com/ExaDev/crossmap/commit/5e92a00e8dd9c67df835067ab7b4484dd2a3a46b))

### Chores

* **release:** 0.4.0 [skip ci] ([eab38a1](https://github.com/ExaDev/crossmap/commit/eab38a1aeaefdc0e84d21f7c47bc5a5777f0a12b))

# [0.5.0](https://github.com/ExaDev/crossmap/compare/v0.4.0...v0.5.0) (2026-10-21)


### Features

* **when:** gate a wildcard rule per element ([7799680](https://github.com/ExaDev/crossmap/commit/7799680a52ffa62383711cbcdfaba3a87181184e))

### Documentation

* **readme:** document per-element when gating ([0b9c6f8](https://github.com/ExaDev/crossmap/commit/0b9c6f8b0fd79f1e199ee3d4cb998c790ce2bac7))

### Chores

* **release:** 0.5.0 [skip ci] ([a0fd1e6](https://github.com/ExaDev/crossmap/commit/a0fd1e69656c06f217c5b10a4d2d669ef5f2cb2e))

# [0.6.0](https://github.com/ExaDev/crossmap/compare/v0.5.0...v0.6.0) (2026-10-21)


### Features

* **rules:** add template and copy rules over several paths ([7657eb8](https://github.com/ExaDev/crossmap/commit/7657eb862aed6f69f15a995c25148b898314bdba))

### Documentation

* **readme:** document the template and copy rules ([1958a9e](https://github.com/ExaDev/crossmap/commit/1958a9ef97a381d07986cb8c8b84876748a5a22f))

### Chores

* **release:** 0.6.0 [skip ci] ([6f280b0](https://github.com/ExaDev/crossmap/commit/6f280b0b60f7d5124d6b10bfd1ce099e3be48e29))

# [0.7.0](https://github.com/ExaDev/crossmap/compare/v0.6.0...v0.7.0) (2026-10-21)


### Features

* **rules:** add a one-way aggregate rule ([eede091](https://github.com/ExaDev/crossmap/commit/eede0916821b8d38ae05033000a9cbc46da478ae))

### Documentation

* **readme:** document the aggregate rule ([38ae3af](https://github.com/ExaDev/crossmap/commit/38ae3af278669b467aac2803fe5aeb75c48f2920))

### Chores

* **release:** 0.7.0 [skip ci] ([f0a3a62](https://github.com/ExaDev/crossmap/commit/f0a3a6210afc83ce57318593ef8eca5330b61294))

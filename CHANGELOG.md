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

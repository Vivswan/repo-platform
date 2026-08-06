# Changelog

## 0.0.1 (2026-08-06)


### ⚠ BREAKING CHANGES

* copier can no longer consume main directly - use --vcs-ref templates/vX.Y.Z or staging. Answer schema gains the channel question (fine: zero adopters).
* copier answer schema replaces stack/profile with modules; _min_copier_version is now 9.8.0 (serialized multiselect answers). CI smoke matrix covers five module combos plus a copier-floor row and lints rendered workflows; upgrade-path now exercises the no-flags update and asserts module preservation.

### Features

* actionable workflow errors and the repo-settings-as-code rename ([591caf3](https://github.com/Vivswan/repo-platform/commit/591caf3149b0530af87af7fc68f29f5e57957687))
* add fuzzer module and fuzz-issue composite action ([56bbc6c](https://github.com/Vivswan/repo-platform/commit/56bbc6ce90e6b79541a8e69efe14bafbc1557252))
* add LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, dependency-review, and secret scanning fleet-wide ([#32](https://github.com/Vivswan/repo-platform/issues/32)) ([dfc7f71](https://github.com/Vivswan/repo-platform/commit/dfc7f7148c57874c495cc3dd9d5a224b861703df))
* add upstream bun gitignore and splice toolchain sections as fragments ([36f460c](https://github.com/Vivswan/repo-platform/commit/36f460c058a4a4c04697750a29d433b7d7efe058))
* assign a dispatched issue number in reusable auto-assign ([#12](https://github.com/Vivswan/repo-platform/issues/12)) ([cf1c554](https://github.com/Vivswan/repo-platform/commit/cf1c55480860c54da190582205f5bb2523a70474))
* auto-fix Dependabot bun lockfiles on their PRs ([#26](https://github.com/Vivswan/repo-platform/issues/26)) ([89a3362](https://github.com/Vivswan/repo-platform/commit/89a33627baf498e3aa4981782ab7409e574f0981))
* **ci:** gate every repo on gitleaks secret scanning ([bd2674a](https://github.com/Vivswan/repo-platform/commit/bd2674a6f740db877bc33a5146cd5f988950e947))
* **ci:** gate release-please PRs on containing main's tip ([5758eac](https://github.com/Vivswan/repo-platform/commit/5758eace07bd4c61b4c22bd4bfaa2719da010297))
* CODEOWNERS decides auto-assignment, minimum permissions everywhere ([9c4268e](https://github.com/Vivswan/repo-platform/commit/9c4268e5931e68d1a2b8c908c8236f1da5a961fa))
* copier template, reusable workflows, and composite actions for repo standards ([1541a81](https://github.com/Vivswan/repo-platform/commit/1541a813d8755ca9b75a133861869309904fa70b))
* discovery enrolls only repos the fleet PAT can write to ([a8babcb](https://github.com/Vivswan/repo-platform/commit/a8babcbc4caf368b3dc9f86023ab211763df63cf))
* enable allow_update_branch in repo settings ([4f694d4](https://github.com/Vivswan/repo-platform/commit/4f694d4ef5ce170be630bd7e5674174b44407886))
* **fleet:** hide private repos behind name hints in public run logs ([bc316b5](https://github.com/Vivswan/repo-platform/commit/bc316b5b822d3969465ffd063d5284a7d9841e96))
* **gitignore:** ignore bare .worktrees and Codex worktree directories ([a9901dd](https://github.com/Vivswan/repo-platform/commit/a9901dda00b2cadce6638560aaf3410a3cceb6b1))
* **gitignore:** ship Claude Code local state ignores in the managed section ([8e9bde6](https://github.com/Vivswan/repo-platform/commit/8e9bde610e4671f88ecc234a25607a4a0482e673))
* in-repo settings.yml is a first-class home, no module needed ([76bcf0d](https://github.com/Vivswan/repo-platform/commit/76bcf0d9a65539a7798dd3e9d2a7c10b56e618e2))
* per-module templates/ source tree with composer + agents module ([64bb692](https://github.com/Vivswan/repo-platform/commit/64bb692bbe87784e3141a72f85d504eb7ea11d03))
* permission-adaptive sync, strict settings, and squash auto-merge ([e5896eb](https://github.com/Vivswan/repo-platform/commit/e5896eb800ca4721e7a947fc9f546d1ba58a687c))
* pin settings-as-code to a commit and pass new inputs through ([9465869](https://github.com/Vivswan/repo-platform/commit/94658691fb890529c49e98e1b67aef53a661c027))
* protect release tags and pin squash subjects to PR titles ([4231777](https://github.com/Vivswan/repo-platform/commit/4231777dd743105b4d18c48fea30d216b3d1e45e))
* push propagation via template-sync dispatch ([0cd63d7](https://github.com/Vivswan/repo-platform/commit/0cd63d76d0f59664c9f51141f56d75b6a3315b3d))
* push-only fleet, central settings, and TypeScript tooling ([49b8715](https://github.com/Vivswan/repo-platform/commit/49b87151b7845de1b63fb31be1b2d36af493cb61))
* recover=recopy regenerates a repo whose update base is lost ([367668d](https://github.com/Vivswan/repo-platform/commit/367668d4da1e9325f3252e4f5357caa0577e0eb3))
* **release:** cut releases as drafts and publish once the pipeline is done ([c004278](https://github.com/Vivswan/repo-platform/commit/c00427892829ac0d6b2aaa47da5cfab1b7961e93))
* repo-owned .typography-allow.local exemptions ([e0c6b1f](https://github.com/Vivswan/repo-platform/commit/e0c6b1f04a46cecc9fa4ae4e87e3a229f90fec46))
* repo-owned issue forms after first generation, plus chooser config ([787abe8](https://github.com/Vivswan/repo-platform/commit/787abe873e987a68d47896374a40f21e9321caa0))
* resolve sync conflicts toward the template and guard workflow pushes ([b042ee3](https://github.com/Vivswan/repo-platform/commit/b042ee394500fb533f791d6dbf61b33c90aed924))
* run the pr-title and CodeQL checks inside the all-green gate ([5886f33](https://github.com/Vivswan/repo-platform/commit/5886f33e12c7e07d39fead5fe11290f7f48ebf5d))
* rust module, conventional dependabot titles, richer doc baselines ([f0ce532](https://github.com/Vivswan/repo-platform/commit/f0ce53223d1d186bb87fcb23131fbf2ddaca6d1a))
* seed a repo-owned .gitleaks.toml fleet-wide ([b54e5a6](https://github.com/Vivswan/repo-platform/commit/b54e5a6d91260aa8af4b3cd99c3f219f1a97e5c9))
* serve copier from generated staging/latest build branches ([04a4269](https://github.com/Vivswan/repo-platform/commit/04a4269939e12d0825d426dfdf5fa5705a06831a))
* settings-sync module applies settings.yml via settings-as-code ([49c6850](https://github.com/Vivswan/repo-platform/commit/49c68501a38f43ffa191c434ea5c4709cf29deb9))
* **settings:** apply repository settings per repo in a fail-fast-free matrix ([3e9de94](https://github.com/Vivswan/repo-platform/commit/3e9de94d406ce9a6ed3f8d61e883a41b4225adf4))
* **settings:** deliver private-target reports as issues on the target repo ([86db153](https://github.com/Vivswan/repo-platform/commit/86db1537445417ec3d9d6e735669aa089d9deb37))
* **settings:** validate central settings files against target modules before apply ([a99a79a](https://github.com/Vivswan/repo-platform/commit/a99a79a54b331e0c29986b1681a7577567764f4b))
* **sync:** deliver hidden failure diagnostics to a target-repo issue ([07837e2](https://github.com/Vivswan/repo-platform/commit/07837e23e5124744e1ba8d1ae34ad9cdf955fa2d))
* **sync:** move dropped local doc hunks below the local-section sentinel ([5a16db1](https://github.com/Vivswan/repo-platform/commit/5a16db14ec542dd18cfaeb6a0372ad00b8ec1c18))
* template-managed all-green CI with repo-owned extension points ([62653b6](https://github.com/Vivswan/repo-platform/commit/62653b669d40d3c88b6a0c713942d7e80ac4032d))
* validate-template is informational in managed repos ([35b24dc](https://github.com/Vivswan/repo-platform/commit/35b24dccae6e7bb0acce228154acb2a794fd1404))


### Bug Fixes

* bootstrap first release as v0.0.1 via initial-version ([1d24454](https://github.com/Vivswan/repo-platform/commit/1d24454219792271767c960e40b9ae33a313f055))
* **build:** fail the release build when a version tag already exists wrongly ([16597a9](https://github.com/Vivswan/repo-platform/commit/16597a9ddcc48f0d5244cf242ddc3dcb27026ede))
* **check-typography:** cover shell profiles, PowerShell, Rust, and plists ([95cb9df](https://github.com/Vivswan/repo-platform/commit/95cb9df98445d49fd5586c5dba3d7b7933040cb5))
* **codeql:** fail loudly when the repository is private at runtime ([849da3e](https://github.com/Vivswan/repo-platform/commit/849da3effa75132f58e21ad1e52ad6a49256ec27))
* commit the _src_path normalization before copier runs ([c0f1bfd](https://github.com/Vivswan/repo-platform/commit/c0f1bfd7d3a4f091949361fd62e8980c6f7d4427))
* dependabot commit prefixes, label docs, and check-chain parity ([38307ec](https://github.com/Vivswan/repo-platform/commit/38307ec8775d926062d92d291d9c259459c22165))
* **fleet:** derive the redaction key without the PAT on argv ([296dc41](https://github.com/Vivswan/repo-platform/commit/296dc41f27b2c8c6163b46c62fe144dd51023819))
* **fleet:** keep the typed dispatch repo out of public logs ([95b64b0](https://github.com/Vivswan/repo-platform/commit/95b64b09142bef7939a416998b10166ee5d5bf32))
* **fleet:** notice when an enrollment probe drops a repo ([8bae182](https://github.com/Vivswan/repo-platform/commit/8bae182ec46b8769dbc1e277632eaf077e3f26b3))
* **fleet:** retry then skip a repo whose probes flake instead of failing the heal ([66754e5](https://github.com/Vivswan/repo-platform/commit/66754e50d96aade8d6d1a550c75b062158be2976))
* **fleet:** surface repos whose sync pause also paused the heal ([37bd7cd](https://github.com/Vivswan/repo-platform/commit/37bd7cd764cb148633af3e91b836ac3b3b94841a))
* **fleet:** warn when a managed repo has no settings home ([4b45974](https://github.com/Vivswan/repo-platform/commit/4b45974b4af8a8a8184a8db196202c1e6bf1f1d5))
* ignore gh api error body when no release exists ([5838d75](https://github.com/Vivswan/repo-platform/commit/5838d75114acac87897ec9628017bc08eaeba483))
* keep template symlinks valid in git ([60205f3](https://github.com/Vivswan/repo-platform/commit/60205f3107b69fbdd5a4f7c6c38a40a0777e0fbe))
* **migrations:** run all migrations when the version span cannot be parsed ([66aa8aa](https://github.com/Vivswan/repo-platform/commit/66aa8aa687cb0d900e0e506e809a9c6690dcad7c))
* normalize recorded _src_path to the canonical template source ([163282c](https://github.com/Vivswan/repo-platform/commit/163282c55d1edb4303c339de46ef3c1150ee79ab))
* probe the token's actual push grant during repo selection ([04b4ea2](https://github.com/Vivswan/repo-platform/commit/04b4ea229b5ce75a3766f8bf4876bb77195d2846))
* re-stamp build branches after a main history rewrite ([6e6a46c](https://github.com/Vivswan/repo-platform/commit/6e6a46ce7ff854e947b6c2807631448b91fa899f))
* rendered ci.yml pointed at a doc that only exists here ([6e8bc0a](https://github.com/Vivswan/repo-platform/commit/6e8bc0ad827f900f203ff580dac2ac5635196c3a))
* repair verified single-source-of-truth drifts ([c492b1e](https://github.com/Vivswan/repo-platform/commit/c492b1e0f1daae49398fcae722095ef2930ac8ea))
* replace stack/profile with composable feature modules ([761f0fd](https://github.com/Vivswan/repo-platform/commit/761f0fd6e324e99544242a2f690c65b73e3ed47d))
* resolve pre-architecture _commit shas in the push sync ([34d9e63](https://github.com/Vivswan/repo-platform/commit/34d9e63b6b6d75142ae6eaa9ac06efa61da411c2))
* run the alert-suppression query pack in reusable CodeQL ([6404b13](https://github.com/Vivswan/repo-platform/commit/6404b13e11c1e2f5f057b9c6e076ba518f831d30))
* **settings-sync:** declare dependabot default labels per toolchain ([3d855e7](https://github.com/Vivswan/repo-platform/commit/3d855e713887fd07aafadb68cc727b9bb6a4f1ad))
* **settings-sync:** render homepage and topics unconditionally ([4593750](https://github.com/Vivswan/repo-platform/commit/4593750008783616233275a7757cd5a70ee26650))
* **settings-sync:** render the private key unconditionally ([#27](https://github.com/Vivswan/repo-platform/issues/27)) ([9e32918](https://github.com/Vivswan/repo-platform/commit/9e32918a93a5a34f75e316717eb90f9ee928a45d))
* **settings:** survive transient fetch failures in the central-file preflight ([99b3422](https://github.com/Vivswan/repo-platform/commit/99b3422f74cd9049ac52d6c729e7df36ba990a22)), closes [#29](https://github.com/Vivswan/repo-platform/issues/29)
* shellcheck-clean registry check and non-masking actionlint script ([4207e6a](https://github.com/Vivswan/repo-platform/commit/4207e6ab90ea3d14cadf46b3b78743e9ff56b54c))
* **ssot:** compare template-only repository keys and match real gating assertions ([1fdc9cf](https://github.com/Vivswan/repo-platform/commit/1fdc9cf7c0487928e3f385ed84905472ef7810ba))
* **sync:** flag out-of-band visibility or description drift and disable auto-merge ([26b7964](https://github.com/Vivswan/repo-platform/commit/26b7964c500d5834f2ce6be092b66ae9a4961577))
* **sync:** verify latest-channel tags the same way staging tips are verified ([321978d](https://github.com/Vivswan/repo-platform/commit/321978dc0269e5765a449f604066720a2a284673))
* **sync:** verify staging tip provenance by rebuilding the stamped source tree ([671b14a](https://github.com/Vivswan/repo-platform/commit/671b14af93d356cdd365efadf76bd26769e830ba))
* **validate-template:** keep duplicate-key strictness on managed files only ([8d95fa9](https://github.com/Vivswan/repo-platform/commit/8d95fa9ed9e3045d90d14e26f90f7e61622c22ba)), closes [#28](https://github.com/Vivswan/repo-platform/issues/28)
* **validate-template:** reject duplicate YAML keys in generated files ([18a61be](https://github.com/Vivswan/repo-platform/commit/18a61be4c7d385f4d2cae2e6c92996e2262ef1bf))

## Changelog

Managed by [release-please](https://github.com/googleapis/release-please);
entries are generated from Conventional Commit subjects when each release PR
merges.

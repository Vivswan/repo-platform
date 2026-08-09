# Changelog

## 0.0.1 (2026-08-09)


### ⚠ BREAKING CHANGES

* rename the fleet license to LICENSE.md
* private repositories receive SECURITY.md on their next sync; it is no longer retired on a flip to private.
* **license:** the fleet license replaces the previous one in every repo that does not select the custom-license module; registry manifests claiming old identifiers are flagged by the sync.
* **release:** the release_auto_publish copier question no longer exists; release.yml is repo-owned, so existing repositories keep their generated pipeline until they adopt the new starter.
* sync now overwrites a divergent LICENSE unless the repository selects the custom-license module.
* copier can no longer consume main directly - use --vcs-ref templates/vX.Y.Z or staging. Answer schema gains the channel question (fine: zero adopters).
* copier answer schema replaces stack/profile with modules; _min_copier_version is now 9.8.0 (serialized multiselect answers). CI smoke matrix covers five module combos plus a copier-floor row and lints rendered workflows; upgrade-path now exercises the no-flags update and asserts module preservation.

### Features

* actionable workflow errors and the repo-settings-as-code rename ([7fa87ac](https://github.com/Vivswan/repo-platform/commit/7fa87ac67ed196ec0e195449d154b9cbf6364586))
* add fuzzer module and fuzz-issue composite action ([4b0d005](https://github.com/Vivswan/repo-platform/commit/4b0d005c8be0c6114f2ec1d2d9adaa0539ca9d8b))
* add LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, dependency-review, and secret scanning fleet-wide ([#32](https://github.com/Vivswan/repo-platform/issues/32)) ([4c99cf5](https://github.com/Vivswan/repo-platform/commit/4c99cf511bb6d269cf5e5bbd103c42d78c7bf4d0))
* add upstream bun gitignore and splice toolchain sections as fragments ([e4dadd3](https://github.com/Vivswan/repo-platform/commit/e4dadd3fe098db3e066da3196dd15e8ac8148add))
* assign a dispatched issue number in reusable auto-assign ([#12](https://github.com/Vivswan/repo-platform/issues/12)) ([a08b537](https://github.com/Vivswan/repo-platform/commit/a08b537fc69889c3e4eac4d048d58f5f5d2a37be))
* auto-fix Dependabot bun lockfiles on their PRs ([#26](https://github.com/Vivswan/repo-platform/issues/26)) ([09cd052](https://github.com/Vivswan/repo-platform/commit/09cd05246b99599e52219b6aa6ec51903b5190f3))
* **ci:** gate every repo on gitleaks secret scanning ([b8ab69f](https://github.com/Vivswan/repo-platform/commit/b8ab69f3997681db1f891426915f4ff8203918a6))
* **ci:** gate release-please PRs on containing main's tip ([ba655a2](https://github.com/Vivswan/repo-platform/commit/ba655a238da8ff349e047b42c5e304da47c6215e))
* **ci:** pick up a repo-owned CodeQL config automatically ([5424a6d](https://github.com/Vivswan/repo-platform/commit/5424a6dd427e9c3c0bde37eda91cbaa622b9e4f5))
* CODEOWNERS decides auto-assignment, minimum permissions everywhere ([ff57685](https://github.com/Vivswan/repo-platform/commit/ff5768513b9eb52517b0223e1f2edfe7f0441190))
* copier template, reusable workflows, and composite actions for repo standards ([9d4ef07](https://github.com/Vivswan/repo-platform/commit/9d4ef07f99d925ad0f9fb20a99d75531fbd0b319))
* discovery enrolls only repos the fleet PAT can write to ([4f30090](https://github.com/Vivswan/repo-platform/commit/4f30090e94934a13e952d887a1a26b20dd69a1d1))
* enable allow_update_branch in repo settings ([dab9f74](https://github.com/Vivswan/repo-platform/commit/dab9f741a1a131f2b34d269b68f6ad346dd8b803))
* **fleet:** hide private repos behind name hints in public run logs ([2406b38](https://github.com/Vivswan/repo-platform/commit/2406b387c83672db15537eecc1a1eca68dd15294))
* **gitignore:** ignore bare .worktrees and Codex worktree directories ([983352c](https://github.com/Vivswan/repo-platform/commit/983352c1ea5a158001438cbc83f655b882856064))
* **gitignore:** ship Claude Code local state ignores in the managed section ([3617cd2](https://github.com/Vivswan/repo-platform/commit/3617cd2d2340cbda072d4915931af319ef6de325))
* in-repo settings.yml is a first-class home, no module needed ([cb253fd](https://github.com/Vivswan/repo-platform/commit/cb253fdf1b903bfc756fe148421c5508c46b181f))
* **license:** adopt the Individual and Small Organization License ([a6f414e](https://github.com/Vivswan/repo-platform/commit/a6f414e987c081677dac84d573bf1d9668c9f602))
* per-module templates/ source tree with composer + agents module ([180f26a](https://github.com/Vivswan/repo-platform/commit/180f26a06063dd53061dc20973746be75a77ffc5))
* permission-adaptive sync, strict settings, and squash auto-merge ([6b3851e](https://github.com/Vivswan/repo-platform/commit/6b3851eecc1bfd319294a2609cbfac0fb60c9fc9))
* pin settings-as-code to a commit and pass new inputs through ([64d4dab](https://github.com/Vivswan/repo-platform/commit/64d4dab53489f3cbadd664cbc24711e8fcd03b12))
* protect release tags and pin squash subjects to PR titles ([08aca9b](https://github.com/Vivswan/repo-platform/commit/08aca9b68275526d4ec8b816df00ca3b7f3fa848))
* push propagation via template-sync dispatch ([9d38bf4](https://github.com/Vivswan/repo-platform/commit/9d38bf450404478112f48faececdba3e5fe4efc9))
* push-only fleet, central settings, and TypeScript tooling ([893611e](https://github.com/Vivswan/repo-platform/commit/893611e9b3ec15ec77df4b81f22a1803188e421d))
* recover=recopy regenerates a repo whose update base is lost ([21fedae](https://github.com/Vivswan/repo-platform/commit/21fedae23d85f48d99cf798c8df59c06896f9e83))
* **release:** cut releases as drafts and publish once the pipeline is done ([54e8a94](https://github.com/Vivswan/repo-platform/commit/54e8a944e60f9deb7e64c9bfc65d08f1103969f8))
* **release:** make every release a three-step draft flow ([1715cfa](https://github.com/Vivswan/repo-platform/commit/1715cfa2c36da70a1a6d759dcd1e6e78723448ac))
* relicense the fleet to PolyForm Noncommercial 1.0.0 ([b427de5](https://github.com/Vivswan/repo-platform/commit/b427de5d8200797435d937efb75c93bbc8883624))
* rename the fleet license to LICENSE.md ([4a248fc](https://github.com/Vivswan/repo-platform/commit/4a248fc1916533e23ab3b7d1962092dd6f13507c))
* render SECURITY.md for private repositories too ([e24b49c](https://github.com/Vivswan/repo-platform/commit/e24b49c1ac3456a8b19563c6daa1a98f5d037f93))
* repo-owned .typography-allow.local exemptions ([4e1d546](https://github.com/Vivswan/repo-platform/commit/4e1d546e273136e07f8e6d5e6d18c53004d9310c))
* repo-owned issue forms after first generation, plus chooser config ([5b2762b](https://github.com/Vivswan/repo-platform/commit/5b2762bdcd509c709d3ec0b6fb27e699fd3ab088))
* resolve sync conflicts toward the template and guard workflow pushes ([1ffae6f](https://github.com/Vivswan/repo-platform/commit/1ffae6f516a41bb26a66feab90276ba88ac478a2))
* run the pr-title and CodeQL checks inside the all-green gate ([a9fba08](https://github.com/Vivswan/repo-platform/commit/a9fba086922ed9bbf253350dc41d2791902c895c))
* rust module, conventional dependabot titles, richer doc baselines ([d89f58c](https://github.com/Vivswan/repo-platform/commit/d89f58c9c21174f2abde742f0fc1827aec59ec36))
* seed a repo-owned .gitleaks.toml fleet-wide ([6f053ea](https://github.com/Vivswan/repo-platform/commit/6f053eab762d952595e3167f3f5244c62c442f41))
* serve copier from generated staging/latest build branches ([c8bf9be](https://github.com/Vivswan/repo-platform/commit/c8bf9be74984b5d5c10d6f4d00cbda7855f1fe43))
* settings-sync module applies settings.yml via settings-as-code ([77eb14c](https://github.com/Vivswan/repo-platform/commit/77eb14c0b2fa06d649725c28fa72b2566c22f39a))
* **settings:** apply repository settings per repo in a fail-fast-free matrix ([5c8568c](https://github.com/Vivswan/repo-platform/commit/5c8568c3d318fdcb01e03991e4310f0c80b27d7a))
* **settings:** deliver private-target reports as issues on the target repo ([75a1e81](https://github.com/Vivswan/repo-platform/commit/75a1e819d936c847a6c688b7ec3c6417a4bd0cf7))
* **settings:** heal a single repository on dispatch ([319907e](https://github.com/Vivswan/repo-platform/commit/319907e12c8ae170945d3ed97278e6940fff6a1e))
* **settings:** let admins bypass the release-tags ruleset ([705910d](https://github.com/Vivswan/repo-platform/commit/705910dc2297a7a9aa701634e1a2ef75042d96c2))
* **settings:** let admins bypass this repo's build-tags ruleset ([e455079](https://github.com/Vivswan/repo-platform/commit/e4550796d9cbd4510e558933b5bc613759c4ddf0))
* **settings:** validate central settings files against target modules before apply ([1d9b53a](https://github.com/Vivswan/repo-platform/commit/1d9b53abaa889869223879192ee2d875ec5581ca))
* **sync:** deliver hidden failure diagnostics to a target-repo issue ([22df70d](https://github.com/Vivswan/repo-platform/commit/22df70d21e7ff784465ec06290d332388ab571a4))
* **sync:** flag manifest license claims conflicting with the fleet LICENSE ([61f629d](https://github.com/Vivswan/repo-platform/commit/61f629d04841237607cefaf4fa52f7e041a10e13))
* **sync:** give .gitattributes a repository-local section ([f506798](https://github.com/Vivswan/repo-platform/commit/f5067987a05bc4f565cd0afe60d584fb2dca12c1))
* **sync:** hold PRs for human review on manual dispatch or a license deletion ([c808361](https://github.com/Vivswan/repo-platform/commit/c808361c6ef3e6ab2e76e62683098555c10b04ac))
* **sync:** move dropped local doc hunks below the local-section sentinel ([7bc46ad](https://github.com/Vivswan/repo-platform/commit/7bc46ad5cab0a0faef14a2fba2dba77334405b83))
* template-managed all-green CI with repo-owned extension points ([1daea47](https://github.com/Vivswan/repo-platform/commit/1daea47542ac9d615b343df13d304eba0359e656))
* validate-template is informational in managed repos ([4465fa1](https://github.com/Vivswan/repo-platform/commit/4465fa104aaa2e971272f85fc0e97a80dba1628f))
* **validate:** reject a tree carrying both LICENSE and LICENSE.md ([6a60ced](https://github.com/Vivswan/repo-platform/commit/6a60ced2b8a577f0b5236981642f78965328d6d2))
* wrap dependency-review in a repo-owned composite action ([cd771ea](https://github.com/Vivswan/repo-platform/commit/cd771eaab25085dba8c5d3dac7a7d644e935e90b))


### Bug Fixes

* **agents:** keep the escape-hatches bullet under 100 columns ([0873d8e](https://github.com/Vivswan/repo-platform/commit/0873d8e8b8e7b5eb48d02b3330c5262ddeef7aef))
* align biome.json schema with the 2.5.6 dependabot bump ([83b86d4](https://github.com/Vivswan/repo-platform/commit/83b86d45d8a290ddd95b38edcaaeebb0f110ef2a))
* bootstrap first release as v0.0.1 via initial-version ([2887c3a](https://github.com/Vivswan/repo-platform/commit/2887c3a29b42f4c16430c8cce2cf7ca36b5bba2c))
* **build:** fail the release build when a version tag already exists wrongly ([3053b66](https://github.com/Vivswan/repo-platform/commit/3053b6654f7305f24aeb8d94051962af4cf45e1a))
* **check-typography:** cover shell profiles, PowerShell, Rust, and plists ([6344330](https://github.com/Vivswan/repo-platform/commit/634433065bd06a4f78609b02fc5ee9100c332532))
* **codeql:** fail loudly when the repository is private at runtime ([93c5b25](https://github.com/Vivswan/repo-platform/commit/93c5b25450bb7ed3be7e9f7443e4839dabe14378))
* commit the _src_path normalization before copier runs ([f550747](https://github.com/Vivswan/repo-platform/commit/f550747975d3f50e06ef76b5018d2db50ca35a5d))
* dependabot commit prefixes, label docs, and check-chain parity ([f0e5cd8](https://github.com/Vivswan/repo-platform/commit/f0e5cd818e82917741fc4c2d79ba3d74b0b9f2e2))
* **fleet:** derive the redaction key without the PAT on argv ([e60196c](https://github.com/Vivswan/repo-platform/commit/e60196c939c49be896dd362b72d0c69e3f358f38))
* **fleet:** keep the typed dispatch repo out of public logs ([18c1997](https://github.com/Vivswan/repo-platform/commit/18c1997fbcbdd7835d42acb2d8f330f6f29f6523))
* **fleet:** notice when an enrollment probe drops a repo ([2eebd0b](https://github.com/Vivswan/repo-platform/commit/2eebd0b5b6dfd35a331239211429e1cbe0494b26))
* **fleet:** retry then skip a repo whose probes flake instead of failing the heal ([be04f73](https://github.com/Vivswan/repo-platform/commit/be04f737c0d0fef3008818370a810af0b3bfe4e7))
* **fleet:** surface repos whose sync pause also paused the heal ([92afd49](https://github.com/Vivswan/repo-platform/commit/92afd4982e94df962d5ad732af74edf17110438b))
* **fleet:** warn when a managed repo has no settings home ([5aaf03d](https://github.com/Vivswan/repo-platform/commit/5aaf03d1239ec9d74d6f4aeb7aec8d82c7061615))
* gate the LICENSE Markdown hint on the fleet license ([c811928](https://github.com/Vivswan/repo-platform/commit/c811928d3a7e327f4538d0832ec15a594b07f02d))
* ignore gh api error body when no release exists ([ed7fc15](https://github.com/Vivswan/repo-platform/commit/ed7fc158406c36e3bb6453f82817cec01d3a39c9))
* keep rendered files clean for downstream whitespace linters ([223d869](https://github.com/Vivswan/repo-platform/commit/223d8694808dda77632844391e501e475c78c124))
* keep template symlinks valid in git ([c8c5cea](https://github.com/Vivswan/repo-platform/commit/c8c5cea5e1c287b10bcb998c11457198a05abd78))
* **migrations:** run all migrations when the version span cannot be parsed ([60c35d1](https://github.com/Vivswan/repo-platform/commit/60c35d1a610949a9d74097ff08534e7ac9583948))
* normalize recorded _src_path to the canonical template source ([268f5d2](https://github.com/Vivswan/repo-platform/commit/268f5d2e9c553dc9064048b6c309240c6c9f0d03))
* probe the token's actual push grant during repo selection ([c37a060](https://github.com/Vivswan/repo-platform/commit/c37a06051924393e4d6a417c2d0de7f3626ec004))
* re-stamp build branches after a main history rewrite ([ac0e5df](https://github.com/Vivswan/repo-platform/commit/ac0e5dfae3b181702bb6f58dcc1904e0232c2163))
* rendered ci.yml pointed at a doc that only exists here ([2269a88](https://github.com/Vivswan/repo-platform/commit/2269a88558e41b396af8b6bc0e96a07576d7f97e))
* repair verified single-source-of-truth drifts ([f4691e5](https://github.com/Vivswan/repo-platform/commit/f4691e541bd859a8464c4778cfdafc46a85e1332))
* replace stack/profile with composable feature modules ([defeee7](https://github.com/Vivswan/repo-platform/commit/defeee7a6ff9c75cbb2ef3bbb1c7589fe20fbbbb))
* resolve pre-architecture _commit shas in the push sync ([7da93b5](https://github.com/Vivswan/repo-platform/commit/7da93b52dc18e96054a1016e4c71b7847373951d))
* run the alert-suppression query pack in reusable CodeQL ([aec7ddf](https://github.com/Vivswan/repo-platform/commit/aec7ddf9d0280555e48158f106b7b6858a37cde4))
* **security:** give private repos a working vulnerability-report channel ([205a5b5](https://github.com/Vivswan/repo-platform/commit/205a5b59591f89cb4c2acb0fea43d7ac93728274))
* **settings-sync:** declare dependabot default labels per toolchain ([9b69991](https://github.com/Vivswan/repo-platform/commit/9b69991322309fdf2f64554ecdff785cf03904c2))
* **settings-sync:** render homepage and topics unconditionally ([636f03f](https://github.com/Vivswan/repo-platform/commit/636f03fdc1232d387278019c8fe6592bf286cca6))
* **settings-sync:** render the private key unconditionally ([#27](https://github.com/Vivswan/repo-platform/issues/27)) ([9aa11c7](https://github.com/Vivswan/repo-platform/commit/9aa11c707602f77a95e4f2ab43f363382bb442a9))
* **settings:** survive transient fetch failures in the central-file preflight ([77c1789](https://github.com/Vivswan/repo-platform/commit/77c178953a698b911501cebf8142a664cfd2485e)), closes [#29](https://github.com/Vivswan/repo-platform/issues/29)
* shellcheck-clean registry check and non-masking actionlint script ([0b4e3dd](https://github.com/Vivswan/repo-platform/commit/0b4e3dd1bda70df11255ffa1b89905ab5e67ea21))
* **ssot:** compare template-only repository keys and match real gating assertions ([582480f](https://github.com/Vivswan/repo-platform/commit/582480f86f08f1ac26fe49797ac24bdce0fe35d6))
* **ssot:** model jinja whitespace-control tags in normalizeJinja ([5f0a604](https://github.com/Vivswan/repo-platform/commit/5f0a6046ce6e8f72072e3df1c7dd0ece0096558d))
* **sync:** flag out-of-band visibility or description drift and disable auto-merge ([573766f](https://github.com/Vivswan/repo-platform/commit/573766f70e3e050f93b3410b6aaf28861fc2fa24))
* **sync:** verify latest-channel tags the same way staging tips are verified ([6f062a1](https://github.com/Vivswan/repo-platform/commit/6f062a1e1449fa4a844f645f8f461883de15bc24))
* **sync:** verify staging tip provenance by rebuilding the stamped source tree ([72f1c49](https://github.com/Vivswan/repo-platform/commit/72f1c4903a257f7a87bd24e1f9c04af8aaffd40e))
* **validate-template:** keep duplicate-key strictness on managed files only ([eb6a3a5](https://github.com/Vivswan/repo-platform/commit/eb6a3a5413a22140d12d8df872a760ecd2f72970)), closes [#28](https://github.com/Vivswan/repo-platform/issues/28)
* **validate-template:** reject duplicate YAML keys in generated files ([42eebee](https://github.com/Vivswan/repo-platform/commit/42eebee6239a6df92d957f6aebcdb15fc27dfff7))

## Changelog

Managed by [release-please](https://github.com/googleapis/release-please);
entries are generated from Conventional Commit subjects when each release PR
merges.

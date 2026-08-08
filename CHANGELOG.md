# Changelog

## 0.0.1 (2026-08-08)


### ⚠ BREAKING CHANGES

* sync now overwrites a divergent LICENSE unless the repository selects the custom-license module.
* copier can no longer consume main directly - use --vcs-ref templates/vX.Y.Z or staging. Answer schema gains the channel question (fine: zero adopters).
* copier answer schema replaces stack/profile with modules; _min_copier_version is now 9.8.0 (serialized multiselect answers). CI smoke matrix covers five module combos plus a copier-floor row and lints rendered workflows; upgrade-path now exercises the no-flags update and asserts module preservation.

### Features

* actionable workflow errors and the repo-settings-as-code rename ([88377d7](https://github.com/Vivswan/repo-platform/commit/88377d7dcb48b34fac3ade20de128f8e79052d6d))
* add fuzzer module and fuzz-issue composite action ([ba5387c](https://github.com/Vivswan/repo-platform/commit/ba5387cbe355df6b5706d3b9a73342329cfe932a))
* add LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, dependency-review, and secret scanning fleet-wide ([#32](https://github.com/Vivswan/repo-platform/issues/32)) ([3d5661c](https://github.com/Vivswan/repo-platform/commit/3d5661c24a8deda5cc3c87c2873ee7dc6aec506f))
* add upstream bun gitignore and splice toolchain sections as fragments ([86d16db](https://github.com/Vivswan/repo-platform/commit/86d16db4adf6bd872a7abc34c7b782dd7a5bb765))
* assign a dispatched issue number in reusable auto-assign ([#12](https://github.com/Vivswan/repo-platform/issues/12)) ([9889efc](https://github.com/Vivswan/repo-platform/commit/9889efcb1f2b1404836af29824842ede8fbf6a8d))
* auto-fix Dependabot bun lockfiles on their PRs ([#26](https://github.com/Vivswan/repo-platform/issues/26)) ([27988d1](https://github.com/Vivswan/repo-platform/commit/27988d1cf478933c2247b2d612c03cf8651971e4))
* **ci:** gate every repo on gitleaks secret scanning ([1d56d72](https://github.com/Vivswan/repo-platform/commit/1d56d72f595a88e67bcd6d3aa8fce91dd7729f3f))
* **ci:** gate release-please PRs on containing main's tip ([036b530](https://github.com/Vivswan/repo-platform/commit/036b5308841b709251abca5039a7f566f0af2639))
* CODEOWNERS decides auto-assignment, minimum permissions everywhere ([947c9d1](https://github.com/Vivswan/repo-platform/commit/947c9d100f2030582b39a13a8caea9b0d956605c))
* copier template, reusable workflows, and composite actions for repo standards ([2b0c532](https://github.com/Vivswan/repo-platform/commit/2b0c5327abc2a222283414721dc20be2d5e05af7))
* discovery enrolls only repos the fleet PAT can write to ([5826279](https://github.com/Vivswan/repo-platform/commit/58262793e78796eda1a90d4b8bb98319b9c2abc9))
* enable allow_update_branch in repo settings ([b72810b](https://github.com/Vivswan/repo-platform/commit/b72810b9baf2772d4032098b2cc62dfa48cec7fd))
* **fleet:** hide private repos behind name hints in public run logs ([f9171c5](https://github.com/Vivswan/repo-platform/commit/f9171c5eb09336e7c186417932d3b873615ea386))
* **gitignore:** ignore bare .worktrees and Codex worktree directories ([39f5bf5](https://github.com/Vivswan/repo-platform/commit/39f5bf59215f65eb90c6086bca42cf05003b6fbd))
* **gitignore:** ship Claude Code local state ignores in the managed section ([105b1f7](https://github.com/Vivswan/repo-platform/commit/105b1f701ab6950e785f01b05cb3aa2074a7b887))
* in-repo settings.yml is a first-class home, no module needed ([8a149b1](https://github.com/Vivswan/repo-platform/commit/8a149b1cf3324128ae2b68e50071e1e260864c4b))
* per-module templates/ source tree with composer + agents module ([0266b3a](https://github.com/Vivswan/repo-platform/commit/0266b3a2bbe16e0c2c6ef22a3bd94561e80bf13e))
* permission-adaptive sync, strict settings, and squash auto-merge ([7df6c2b](https://github.com/Vivswan/repo-platform/commit/7df6c2b3891be21b907b39c9c96520bf015ef1aa))
* pin settings-as-code to a commit and pass new inputs through ([36f0484](https://github.com/Vivswan/repo-platform/commit/36f0484c0daca9018144a8564b70a1d9507ba053))
* protect release tags and pin squash subjects to PR titles ([eddedbd](https://github.com/Vivswan/repo-platform/commit/eddedbdeca7a44b685c0f26cd8b79465ee4e4738))
* push propagation via template-sync dispatch ([fe6906a](https://github.com/Vivswan/repo-platform/commit/fe6906a617971cd788dec3fb8d502c85ed787005))
* push-only fleet, central settings, and TypeScript tooling ([3285f5b](https://github.com/Vivswan/repo-platform/commit/3285f5bf0a49170c093070eb643753485f88dacb))
* recover=recopy regenerates a repo whose update base is lost ([c5d813b](https://github.com/Vivswan/repo-platform/commit/c5d813bdf0ad865bc5b88d927cb042ac775123b4))
* **release:** cut releases as drafts and publish once the pipeline is done ([a02f78a](https://github.com/Vivswan/repo-platform/commit/a02f78a1da010d6a0334f11dfa5ca2fe886e7253))
* relicense the fleet to PolyForm Noncommercial 1.0.0 ([72aaee9](https://github.com/Vivswan/repo-platform/commit/72aaee91e331014e3c60af1ac2c392c02124a40b))
* repo-owned .typography-allow.local exemptions ([4a6f51a](https://github.com/Vivswan/repo-platform/commit/4a6f51a10ce869c884183999a25463d3f698849f))
* repo-owned issue forms after first generation, plus chooser config ([b1dcb87](https://github.com/Vivswan/repo-platform/commit/b1dcb87a8ccf83398775323f52bc192dee637ad2))
* resolve sync conflicts toward the template and guard workflow pushes ([cfdc59e](https://github.com/Vivswan/repo-platform/commit/cfdc59ec310894c8ef5d5c51114ce1d4b5f6fb55))
* run the pr-title and CodeQL checks inside the all-green gate ([26501ae](https://github.com/Vivswan/repo-platform/commit/26501ae67e369cda1a226f9f28e08e88d55635a0))
* rust module, conventional dependabot titles, richer doc baselines ([d80ea4c](https://github.com/Vivswan/repo-platform/commit/d80ea4c59ed18ad9ff8c1de9e82b8b2bd65a0d22))
* seed a repo-owned .gitleaks.toml fleet-wide ([65267b2](https://github.com/Vivswan/repo-platform/commit/65267b2f56a05ac49c4ccc15012fe88850359b22))
* serve copier from generated staging/latest build branches ([e1f10bb](https://github.com/Vivswan/repo-platform/commit/e1f10bbe2edbaaac15015701d470d3128dfda34a))
* settings-sync module applies settings.yml via settings-as-code ([3078e9f](https://github.com/Vivswan/repo-platform/commit/3078e9f71a69664d986531d166815f301b2abbf5))
* **settings:** apply repository settings per repo in a fail-fast-free matrix ([475e072](https://github.com/Vivswan/repo-platform/commit/475e0729055ce0a66b238ecdb51aaaf32313cf16))
* **settings:** deliver private-target reports as issues on the target repo ([f38a330](https://github.com/Vivswan/repo-platform/commit/f38a330b9e51ad2e747bd38e96f5254032fb94be))
* **settings:** validate central settings files against target modules before apply ([695ffae](https://github.com/Vivswan/repo-platform/commit/695ffaedde99492f2c5e06ee68910d5f83d2d5f1))
* **sync:** deliver hidden failure diagnostics to a target-repo issue ([c6e059d](https://github.com/Vivswan/repo-platform/commit/c6e059dc8379979c80dd93e19335fb68d989fadd))
* **sync:** move dropped local doc hunks below the local-section sentinel ([27068f9](https://github.com/Vivswan/repo-platform/commit/27068f958aa9a9f4e9c6b962a7bd563c2469ca1f))
* template-managed all-green CI with repo-owned extension points ([1cb275c](https://github.com/Vivswan/repo-platform/commit/1cb275c286f9a7b57803ddd2b928914cb4fa142e))
* validate-template is informational in managed repos ([f2f7a96](https://github.com/Vivswan/repo-platform/commit/f2f7a961192e5a45edf8b6b4f03b123517df5aae))


### Bug Fixes

* bootstrap first release as v0.0.1 via initial-version ([2e166e4](https://github.com/Vivswan/repo-platform/commit/2e166e4e582eb2ade6de3c53e1273b646b5da9e8))
* **build:** fail the release build when a version tag already exists wrongly ([eff9289](https://github.com/Vivswan/repo-platform/commit/eff9289dbd74925e1abb911ded374a752cd7105c))
* **check-typography:** cover shell profiles, PowerShell, Rust, and plists ([9815d52](https://github.com/Vivswan/repo-platform/commit/9815d52d5c113ae7e16c8fb91fa61f7a79309cf0))
* **codeql:** fail loudly when the repository is private at runtime ([fa1374b](https://github.com/Vivswan/repo-platform/commit/fa1374bbf0a0b652a304cced93034decc4da59d1))
* commit the _src_path normalization before copier runs ([35d79c4](https://github.com/Vivswan/repo-platform/commit/35d79c44d2b11f5df160aa196dbf2393d2c6167f))
* dependabot commit prefixes, label docs, and check-chain parity ([6c63405](https://github.com/Vivswan/repo-platform/commit/6c634054f5311e36ce9376010e1b296e6b411247))
* **fleet:** derive the redaction key without the PAT on argv ([45184b4](https://github.com/Vivswan/repo-platform/commit/45184b47ace4d2baca377197c1733243e8018357))
* **fleet:** keep the typed dispatch repo out of public logs ([b85d55e](https://github.com/Vivswan/repo-platform/commit/b85d55e33a6ef3d7752d26ff71b47890d645aae9))
* **fleet:** notice when an enrollment probe drops a repo ([d25e43f](https://github.com/Vivswan/repo-platform/commit/d25e43f80f8de4599aef60fe54c8239cf86b6140))
* **fleet:** retry then skip a repo whose probes flake instead of failing the heal ([e3f4318](https://github.com/Vivswan/repo-platform/commit/e3f4318b581ab5203f188f52a31294f883100b09))
* **fleet:** surface repos whose sync pause also paused the heal ([f881a52](https://github.com/Vivswan/repo-platform/commit/f881a52e6be7b20eab2bc772632dd91b94459896))
* **fleet:** warn when a managed repo has no settings home ([30bc443](https://github.com/Vivswan/repo-platform/commit/30bc44306c5fc9de2bec3d37412924cdb47b037a))
* ignore gh api error body when no release exists ([694f44f](https://github.com/Vivswan/repo-platform/commit/694f44f3fa27dfe0ba6b25179d310ed2c571bc07))
* keep template symlinks valid in git ([a674582](https://github.com/Vivswan/repo-platform/commit/a6745822ce117dfa9c3fe8951e1c2c0aa7932525))
* **migrations:** run all migrations when the version span cannot be parsed ([b97a42d](https://github.com/Vivswan/repo-platform/commit/b97a42df8da87394a0b9ed21cd39b3c7c0d59331))
* normalize recorded _src_path to the canonical template source ([8089024](https://github.com/Vivswan/repo-platform/commit/80890244fc607ee749d12b73967aac8b12d2fa08))
* probe the token's actual push grant during repo selection ([48becb8](https://github.com/Vivswan/repo-platform/commit/48becb826b0798c0cec9bfe14f5b72d60c7a022b))
* re-stamp build branches after a main history rewrite ([7654265](https://github.com/Vivswan/repo-platform/commit/765426581e83b5c105c754aaf5254f09ecb857a3))
* rendered ci.yml pointed at a doc that only exists here ([8783c90](https://github.com/Vivswan/repo-platform/commit/8783c90a513195af4fb1f2ecd2a8f3bcd280e412))
* repair verified single-source-of-truth drifts ([51aec29](https://github.com/Vivswan/repo-platform/commit/51aec29c2d9b5d403da97b0e985cd9b3c5f1f040))
* replace stack/profile with composable feature modules ([76a7486](https://github.com/Vivswan/repo-platform/commit/76a7486108516d5e7cf5b2908cebada1b1fad5d5))
* resolve pre-architecture _commit shas in the push sync ([08329d4](https://github.com/Vivswan/repo-platform/commit/08329d4952d8d4c46463c23bcb8e2844582095ce))
* run the alert-suppression query pack in reusable CodeQL ([295267b](https://github.com/Vivswan/repo-platform/commit/295267b259e1ee1861f2fb648d418cc628963664))
* **settings-sync:** declare dependabot default labels per toolchain ([2866c81](https://github.com/Vivswan/repo-platform/commit/2866c81833c69406e305378b2ee33f7f5f7e4ef2))
* **settings-sync:** render homepage and topics unconditionally ([10cffad](https://github.com/Vivswan/repo-platform/commit/10cffadfd40f9699ccea79ee980e6fb0d090a640))
* **settings-sync:** render the private key unconditionally ([#27](https://github.com/Vivswan/repo-platform/issues/27)) ([142613a](https://github.com/Vivswan/repo-platform/commit/142613ab229736009fcaab00949b17ad14d278ca))
* **settings:** survive transient fetch failures in the central-file preflight ([d3fa7db](https://github.com/Vivswan/repo-platform/commit/d3fa7dbdaf799ab6f44b3bef88554415e8f8daa0)), closes [#29](https://github.com/Vivswan/repo-platform/issues/29)
* shellcheck-clean registry check and non-masking actionlint script ([d015777](https://github.com/Vivswan/repo-platform/commit/d0157775cbd4ad688bf277323e3a580475a31723))
* **ssot:** compare template-only repository keys and match real gating assertions ([c11ce6d](https://github.com/Vivswan/repo-platform/commit/c11ce6d6682a282344b902163087d8d8cdcdf846))
* **sync:** flag out-of-band visibility or description drift and disable auto-merge ([4993a5b](https://github.com/Vivswan/repo-platform/commit/4993a5b6f49611fdc29e27aa77162ecbebaf3d9b))
* **sync:** verify latest-channel tags the same way staging tips are verified ([65b3788](https://github.com/Vivswan/repo-platform/commit/65b378842a4a21e53af9f55e8b183a48dc1574e0))
* **sync:** verify staging tip provenance by rebuilding the stamped source tree ([199330e](https://github.com/Vivswan/repo-platform/commit/199330e60418bae8c21bedb4a0b0da67f78fec56))
* **validate-template:** keep duplicate-key strictness on managed files only ([5d58b3f](https://github.com/Vivswan/repo-platform/commit/5d58b3f0795db43b8b1d024b92219e15135e7d56)), closes [#28](https://github.com/Vivswan/repo-platform/issues/28)
* **validate-template:** reject duplicate YAML keys in generated files ([8fcaed0](https://github.com/Vivswan/repo-platform/commit/8fcaed025202c2f91184e14662a96dd8e46f80c8))

## Changelog

Managed by [release-please](https://github.com/googleapis/release-please);
entries are generated from Conventional Commit subjects when each release PR
merges.

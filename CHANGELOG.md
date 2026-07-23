# Changelog

## 0.0.1 (2026-07-23)


### ⚠ BREAKING CHANGES

* copier can no longer consume main directly - use --vcs-ref templates/vX.Y.Z or staging. Answer schema gains the channel question (fine: zero adopters).
* copier answer schema replaces stack/profile with modules; _min_copier_version is now 9.8.0 (serialized multiselect answers). CI smoke matrix covers five module combos plus a copier-floor row and lints rendered workflows; upgrade-path now exercises the no-flags update and asserts module preservation.

### Features

* actionable workflow errors and the repo-settings-as-code rename ([591caf3](https://github.com/Vivswan/repo-platform/commit/591caf3149b0530af87af7fc68f29f5e57957687))
* assign a dispatched issue number in reusable auto-assign ([#12](https://github.com/Vivswan/repo-platform/issues/12)) ([cf1c554](https://github.com/Vivswan/repo-platform/commit/cf1c55480860c54da190582205f5bb2523a70474))
* CODEOWNERS decides auto-assignment, minimum permissions everywhere ([9c4268e](https://github.com/Vivswan/repo-platform/commit/9c4268e5931e68d1a2b8c908c8236f1da5a961fa))
* copier template, reusable workflows, and composite actions for repo standards ([1541a81](https://github.com/Vivswan/repo-platform/commit/1541a813d8755ca9b75a133861869309904fa70b))
* discovery enrolls only repos the fleet PAT can write to ([a8babcb](https://github.com/Vivswan/repo-platform/commit/a8babcbc4caf368b3dc9f86023ab211763df63cf))
* enable allow_update_branch in repo settings ([4f694d4](https://github.com/Vivswan/repo-platform/commit/4f694d4ef5ce170be630bd7e5674174b44407886))
* in-repo settings.yml is a first-class home, no module needed ([76bcf0d](https://github.com/Vivswan/repo-platform/commit/76bcf0d9a65539a7798dd3e9d2a7c10b56e618e2))
* per-module templates/ source tree with composer + agents module ([64bb692](https://github.com/Vivswan/repo-platform/commit/64bb692bbe87784e3141a72f85d504eb7ea11d03))
* permission-adaptive sync, strict settings, and squash auto-merge ([e5896eb](https://github.com/Vivswan/repo-platform/commit/e5896eb800ca4721e7a947fc9f546d1ba58a687c))
* pin settings-as-code to a commit and pass new inputs through ([9465869](https://github.com/Vivswan/repo-platform/commit/94658691fb890529c49e98e1b67aef53a661c027))
* protect release tags and pin squash subjects to PR titles ([4231777](https://github.com/Vivswan/repo-platform/commit/4231777dd743105b4d18c48fea30d216b3d1e45e))
* push propagation via template-sync dispatch ([0cd63d7](https://github.com/Vivswan/repo-platform/commit/0cd63d76d0f59664c9f51141f56d75b6a3315b3d))
* push-only fleet, central settings, and TypeScript tooling ([49b8715](https://github.com/Vivswan/repo-platform/commit/49b87151b7845de1b63fb31be1b2d36af493cb61))
* recover=recopy regenerates a repo whose update base is lost ([367668d](https://github.com/Vivswan/repo-platform/commit/367668d4da1e9325f3252e4f5357caa0577e0eb3))
* repo-owned .typography-allow.local exemptions ([e0c6b1f](https://github.com/Vivswan/repo-platform/commit/e0c6b1f04a46cecc9fa4ae4e87e3a229f90fec46))
* resolve sync conflicts toward the template and guard workflow pushes ([b042ee3](https://github.com/Vivswan/repo-platform/commit/b042ee394500fb533f791d6dbf61b33c90aed924))
* run the pr-title and CodeQL checks inside the all-green gate ([5886f33](https://github.com/Vivswan/repo-platform/commit/5886f33e12c7e07d39fead5fe11290f7f48ebf5d))
* serve copier from generated staging/latest build branches ([04a4269](https://github.com/Vivswan/repo-platform/commit/04a4269939e12d0825d426dfdf5fa5705a06831a))
* settings-sync module applies settings.yml via settings-as-code ([49c6850](https://github.com/Vivswan/repo-platform/commit/49c68501a38f43ffa191c434ea5c4709cf29deb9))
* template-managed all-green CI with repo-owned extension points ([62653b6](https://github.com/Vivswan/repo-platform/commit/62653b669d40d3c88b6a0c713942d7e80ac4032d))
* validate-template is informational in managed repos ([35b24dc](https://github.com/Vivswan/repo-platform/commit/35b24dccae6e7bb0acce228154acb2a794fd1404))


### Bug Fixes

* bootstrap first release as v0.0.1 via initial-version ([1d24454](https://github.com/Vivswan/repo-platform/commit/1d24454219792271767c960e40b9ae33a313f055))
* commit the _src_path normalization before copier runs ([c0f1bfd](https://github.com/Vivswan/repo-platform/commit/c0f1bfd7d3a4f091949361fd62e8980c6f7d4427))
* ignore gh api error body when no release exists ([5838d75](https://github.com/Vivswan/repo-platform/commit/5838d75114acac87897ec9628017bc08eaeba483))
* keep template symlinks valid in git ([60205f3](https://github.com/Vivswan/repo-platform/commit/60205f3107b69fbdd5a4f7c6c38a40a0777e0fbe))
* normalize recorded _src_path to the canonical template source ([163282c](https://github.com/Vivswan/repo-platform/commit/163282c55d1edb4303c339de46ef3c1150ee79ab))
* probe the token's actual push grant during repo selection ([04b4ea2](https://github.com/Vivswan/repo-platform/commit/04b4ea229b5ce75a3766f8bf4876bb77195d2846))
* re-stamp build branches after a main history rewrite ([6e6a46c](https://github.com/Vivswan/repo-platform/commit/6e6a46ce7ff854e947b6c2807631448b91fa899f))
* rendered ci.yml pointed at a doc that only exists here ([6e8bc0a](https://github.com/Vivswan/repo-platform/commit/6e8bc0ad827f900f203ff580dac2ac5635196c3a))
* replace stack/profile with composable feature modules ([761f0fd](https://github.com/Vivswan/repo-platform/commit/761f0fd6e324e99544242a2f690c65b73e3ed47d))
* resolve pre-architecture _commit shas in the push sync ([34d9e63](https://github.com/Vivswan/repo-platform/commit/34d9e63b6b6d75142ae6eaa9ac06efa61da411c2))
* shellcheck-clean registry check and non-masking actionlint script ([4207e6a](https://github.com/Vivswan/repo-platform/commit/4207e6ab90ea3d14cadf46b3b78743e9ff56b54c))

## Changelog

Managed by [release-please](https://github.com/googleapis/release-please);
entries are generated from Conventional Commit subjects when each release PR
merges.

# Per-module reference: files, keys, companion steps, removal

The roster and every file are in repo-platform's `files.yml`; the module docs (`docs/<module>.md` where one exists) are the depth. Managed files are rewritten on every sync, starters are written once and then repo-owned, split files carry the module's block inside their managed region.

## Base (every managed repo, no module needed)

- Managed: `.github/workflows/ci.yml` (the same file everywhere), `.github/workflows/auto-assign.yml`, `.github/instructions/review.instructions.md`, `.yamllint`, `.typography-allow`, `.github/repo-platform-manifest.json` (the record of what the platform wrote).
- Split: `.editorconfig`, `.gitattributes`, `.gitignore`, `.github/CODEOWNERS`, `AGENTS.md`, `LICENSE.md`. Managed with per-module blocks: `.github/dependabot.yml` (the github-actions ecosystem always).
- Starters: `checks.yml` (your CI jobs, called inside the all-green gate), `post-green.yml` (your green-gated work on a push to main), `update-release.yml` and `update-release-pr.yml` (the release hooks, called only with release-please), `copilot-setup-steps.yml`, `.gitleaks.toml`, `.github/actionlint.yaml`, `.github/settings.yml` (the repo's own settings over the fleet baseline).
- Settings are applied from repo-platform for every registered repo; the labels a module needs come with its selection.

## Toolchains: bun / node / deno / uv / rust

- Managed: the version dotfile for bun/node/deno (`.bun-version`, `.node-version`, `.dvmrc`, fleet-pinned), `dependabot-bun-lockfile.yml` (bun), `deno-audit.yml` (deno). Public repos with bun/node/deno/uv get the CodeQL variant of `auto-assign.yml`; fleet CI runs CodeQL for their language.
- Blocks: a gitignore section and a Toolchain section in `AGENTS.md` (split files), and a Dependabot ecosystem entry (the managed `.github/dependabot.yml`).
- Starter: `auto-format.yml` for every toolchain but rust, written only when absent. An existing `auto-format.yml`, `checks.yml`, `.gitleaks.toml`, or `copilot-setup-steps.yml` does not gain a later toolchain's piece; add it by hand.
- Companion, bun only: `gh secret set REPO_PLATFORM_TOKEN --app dependabot` with a repo-scoped Contents:RW PAT. Without it the lockfile fix lands but cannot re-trigger checks.
- Removal: the dotfile and module workflow are retired; the blocks leave the split regions and the managed `.github/dependabot.yml`. `auto-format.yml` stays. The Dependabot label leaves the baseline once no selected toolchain carries it.

## pages

- Managed: `pages.yml` (the nightly rebuild and the dispatch). The deploy itself is the `pages` leg of `ci.yml`, which runs on a push to main once the module is selected.
- Keys: `pages.setup` (comma-separated toolchain tokens or `none`; default: the selected toolchains, `none` when there is no toolchain), `pages.install` and `pages.build` (default: the commands of the first `pages.setup` toolchain in roster order, not in the order typed; empty with `none`, and `pages.build` must be nonempty), `pages.dist` (default `dist`). repo-platform's `docs/pages.md` has the build contract.
- Companion: enable Pages with Source: GitHub Actions before the first deploy.
- With `docs-site` also selected, the site build serves the docs as a mount at `/<docs_site.path>/` and the `docs-site` leg stands down.
- Removal: `pages.yml` is retired; the leg skips; the live site stays until you turn Pages off.

## docs-site

- Managed: `docs-site.yml` (the PR check on `docs/` changes and the nightly link-rot run). The deploy is the `docs-site` leg of `ci.yml`.
- Keys: `docs_site.path` (URL mount under a `pages` site; default `docs`), `docs_site.include` (extra trees rendered into the site: `{path, mount, page?}`), `labels.docs_site` (link-rot tracking label; default `docs-link-rot`).
- Conventions: `docs/README.md` is the landing page and must exist; titles, order, and groups come from frontmatter and the landing's link table; links resolve inside `docs/` or are absolute. Details: repo-platform's `docs/docs-site.md`.
- Companion: the same Pages enablement as `pages`.
- Removal: the workflow is retired; the leg skips; the site stays until you turn Pages off.

## release-please

- Starters: `release-please-config.json`, `.release-please-manifest.json`. The hooks `update-release.yml` and `update-release-pr.yml` are base starters and run only when this module is selected.
- Managed: the release variant of `.typography-allow`. The `release`, `update-release`, `publish-release`, and `update-release-pr` legs of `ci.yml` run on a push to main once selected.
- Pipeline: `release` cuts a draft through release-please (repo-platform's fleet-release workflow) -> the repo-owned `update-release.yml` hook, a placeholder until you add assets or notes -> `publish-release` (fleet-release-publish) attaches one `attestation.json` per release for a public repo with assets, publishes others unattested, and flips the draft live. `update-release-pr` calls the repo-owned hook for files that ride in the release commit.
- Gates: fleet CI's `release-freshness` and `release-health` jobs run on release-please PRs (branches `release-please--*`). Freshness requires the PR to contain the tip of its base branch. Health fails on an open tracking issue of a selected stream (`fuzzer`, `nightly`, `docs-site`) or the fleet `security-nightly` stream, an open `release-blocker` issue, or an open Dependabot alert at or above the threshold (default `high`; alerts the token cannot read skip that gate); the cut re-runs the same gate, and `release-override` on the release PR bypasses it.
- Labels (`autorelease: pending`, `autorelease: tagged`, `release-blocker`, `release-override`) and the tag-immutability ruleset come with the settings apply.
- Forcing a version: an empty commit with a `Release-As: x.y.z` footer, never a `release-as` key in the config.
- Removal: the legs skip; the starters stay.

## issue-templates

- No files: the account's `.github` repository serves the forms to every repo without its own. Selecting the module records the choice; removing it changes nothing in the repo.

## skills

- Managed: `validate-skills.yml` (advisory CLI discovery). Fleet CI's `validate-skills` job gates the catalog structure through all-green.
- Starters: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, seeded from `project.name` and `project.slug` with an empty `skills` catalog. Existing manifests are kept.
- Key: `skills.dir` (default `skills`). Fleet CI's `validate-skills` job reads it through the plan, and the managed `validate-skills.yml` is written with it (its `paths` filter and `skills-dir` input), so both checks watch the same directory.
- Companion: list each published skill in `plugin.json`'s `skills` array as `./<skills.dir>/<name>`; an unlisted folder validates and never ships. A skills tree can also become part of the docs site through `docs_site.include`.
- Removal: `validate-skills.yml` is retired; the manifests and the skills directory stay.

## fuzzer / nightly

- Starters: `nightly-fuzz.yml` (fuzzer) / `nightly.yml` (nightly). The placeholder step is a green no-op until customized.
- Keys: `labels.fuzzer` (default `fuzz-nightly`) / `labels.nightly` (default `nightly-failure`). The two must differ when both are selected: both streams dedup and auto-close by label.
- A custom label goes in two places: the registration key (read by fleet CI's plan and by the settings apply, which declares it) and the starter's two `label:` inputs (the starter is repo-owned; the sync never edits it).
- Removal: remove `labels.<key>` together with the module (a leftover key fails the plan). The label leaves the baseline and the next apply deletes it. The starter keeps running; delete it yourself or declare its label in `.github/settings.yml` first.
- Depth: repo-platform's `docs/fuzzer.md` and `docs/nightly.md`.

## pr-title

- Managed: `pr-title.yml`, whose `pr-title` check the module's ruleset requires. Removal retires the workflow and the next settings apply drops the requirement.

## custom-license

- Effect: `LICENSE.md` is not written; the repo's own license is repo-owned.
- Adding it: the fleet `LICENSE.md` is retired on that sync: `deleted` when it still held only the platform's region, `held` when the repo had written outside the region. Commit the repo's own `LICENSE.md` after that PR merges.
- Removing it: the next sync writes the fleet license region into `LICENSE.md`; a file without markers gets the region above its existing content (reported `region added`, which holds the PR), so delete the old text in the sync PR (third-party notices go below the END marker).

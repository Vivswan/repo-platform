# Per-module reference: files, keys, companion steps, removal

The roster and every file are in the platform's `files.yml`; the module docs (`docs/<module>.md` where one exists) are the depth. Managed files are rewritten on every sync, starters are written once and then repo-owned, split files carry the module's block inside their managed region.

## Base (every managed repo, no module needed)

- Managed: `.github/workflows/ci.yml` (the same file everywhere), `.github/workflows/auto-assign.yml`, `.github/instructions/review.instructions.md`, `.yamllint`, `.typography-allow`, `.github/settings.yml` (rendered from the fleet settings layers, the selected modules' layers, and the repo's overlay), `.github/repo-platform-manifest.json` (the record of what the platform wrote).
- Split: `.editorconfig`, `.gitattributes`, `.gitignore`, `.github/CODEOWNERS`, `AGENTS.md`, `LICENSE.md`. Managed with per-module blocks: `.github/dependabot.yml` (the github-actions ecosystem always).
- Starters: `checks.yml` (your CI jobs, called inside the all-green gate), `post-green.yml` (your green-gated work on a push to main), `update-release.yml` and `update-release-pr.yml` (the release hooks, called only with release-please), `copilot-setup-steps.yml`, `.gitleaks.toml`, `.github/actionlint.yaml`, `.github/settings.local.yml` (the repo's own settings overlay; edit it, never the rendered `.github/settings.yml`), `.github/actions/site-build/action.yml` (the site-build hook the `site` leg runs; a no-op until filled in).
- Settings are rendered into `.github/settings.yml` by the sync and applied by the platform for every registered repo; the labels a module needs land in the render with its selection.

## Toolchains: bun / deno / uv / rust

- Managed: the version dotfile for bun/deno (`.bun-version`, `.dvmrc`, fleet-pinned) and `deno-audit.yml` (deno). Public repos with bun/deno/uv: fleet CI runs CodeQL for their language.
- Blocks: a gitignore section and a Toolchain section in `AGENTS.md` (split files), and a Dependabot ecosystem entry (the managed `.github/dependabot.yml`).
- Starter: `auto-format.yml` for every toolchain but rust, written only when absent. An existing `auto-format.yml`, `checks.yml`, `.gitleaks.toml`, or `copilot-setup-steps.yml` does not gain a later toolchain's piece; add it by hand.
- Removal: the version dotfile is retired, and deno also retires `deno-audit.yml`; the blocks leave the split regions and the managed `.github/dependabot.yml`. `auto-format.yml` stays. The Dependabot label leaves the rendered `.github/settings.yml` once no selected toolchain carries it.

## site

- No file of its own. The deploy is the `site` leg of `ci.yml`: every main run whose gate passed (a push, the nightly schedule, a dispatch) builds ONE Pages site from the repo-owned `.github/actions/site-build/action.yml` hook's output (the repository's website, at the root) and `docs/` (rendered under the fleet theme, at `/<site.path>/` beside a website, else at the root). Fleet CI's `docs-check` job builds `docs/` strictly on every PR of a repo that has one, unless `site.path: null` turns the docs half off.
- The hook is a base starter every repository carries, seeded as a no-op (output `dist` empty: only the docs directory publishes, when there is one). Fill it in with the website's build: inputs `base-path` and `origin`, output `dist` naming the built directory. repo-platform's `docs/site.md` has the contract and examples.
- Keys: `site.path` (URL segment the docs mount under beside a website; default `docs`; `null` turns the docs half off, for a website that renders `docs/` itself), `site.include` (extra trees rendered into the docs: `{path, mount, page}`, every entry naming its page file), `labels.site` (link-rot tracking label; default `docs-link-rot`).
- Conventions: `docs/README.md` is the landing page and must exist when the repo has `docs/`; titles, order, and groups come from frontmatter and the landing's link table; links resolve inside `docs/` or are absolute.
- Companion: Pages is enabled by the module's settings layer on the next settings apply; before it, enable Pages with Source: GitHub Actions by hand.
- Removal: the leg skips; the hook stays (a starter); the live site stays until you turn Pages off.

## release-please

- Starters: `release-please-config.json`, `.release-please-manifest.json`. The hooks `update-release.yml` and `update-release-pr.yml` are base starters and run only when this module is selected.
- Managed: the release variant of `.typography-allow`. The `release`, `update-release`, `publish-release`, and `update-release-pr` legs of `ci.yml` run on a push to main once selected.
- Pipeline: `release` cuts a draft through release-please (the fleet-release workflow) -> the repo-owned `update-release.yml` hook, a placeholder until you add assets or notes -> `publish-release` (fleet-release-publish) attaches one `attestation.json` per release for a public repo with assets, publishes others unattested, and flips the draft live. `update-release-pr` calls the repo-owned hook for files that ride in the release commit.
- Gates: fleet CI's `release-freshness` and `release-health` jobs run on release-please PRs (branches `release-please--*`). Freshness requires the PR to contain the tip of its base branch. Health fails on an open tracking issue of a selected stream (`fuzzer`, `nightly`, `site`) or the fleet `security-nightly` stream, an open `release-blocker` issue, or an open Dependabot alert at or above the threshold (default `high`; alerts the token cannot read skip that gate); the cut re-runs the same gate, and `release-override` on the release PR bypasses it.
- Labels (`autorelease: pending`, `autorelease: tagged`, `release-blocker`, `release-override`) and the tag-immutability ruleset come from the module's settings layer: the sync renders them into `.github/settings.yml`, the settings apply declares them.
- Forcing a version: an empty commit with a `Release-As: x.y.z` footer, never a `release-as` key in the config.
- Removal: the legs skip; the starters stay.

## fuzzer / nightly

- Starters: `nightly-fuzz.yml` (fuzzer) / `nightly.yml` (nightly). The placeholder step is a green no-op until customized.
- Keys: `labels.fuzzer` (default `fuzz-nightly`) / `labels.nightly` (default `nightly-failure`). The two must differ when both are selected: both streams dedup and auto-close by label.
- A custom label goes in two places: the registration key (read by fleet CI's plan and by the sync, which renders it into `.github/settings.yml` for the settings apply to declare) and the starter's two `label:` inputs (the starter is repo-owned; the sync never edits it).
- Removal: remove `labels.<key>` together with the module (a leftover key fails the plan). The label leaves the rendered settings on that sync and the next apply deletes it. The starter keeps running; delete it yourself or declare its label in `.github/settings.local.yml` first.
- Depth: the platform's `docs/fuzzer.md` and `docs/nightly.md`.

## pr-title

- Managed: `pr-title.yml`, whose `pr-title` check the module's ruleset requires; the module's settings layer activates the ruleset in the rendered `.github/settings.yml`, so the workflow and the requirement ride one sync PR. Removal retires the workflow and renders the ruleset disabled in the same sync PR; the still-active check can wedge that PR until an admin merges it, and the apply after the merge drops the requirement.

## custom-license

- Effect: `LICENSE.md` is not written; the repo's own license is repo-owned.
- Adding it: the fleet `LICENSE.md` is retired on that sync: `deleted` when it still held only the platform's region, `region removed` when the repo had written outside the region (that text stays as a plain file), `held` when the region itself was edited. Commit the repo's own `LICENSE.md` after that PR merges.
- Removing it: the next sync writes the fleet license region into `LICENSE.md`; a file without markers gets the region above its existing content (reported `region added`, which holds the PR), so delete the old text in the sync PR (third-party notices go below the END marker).

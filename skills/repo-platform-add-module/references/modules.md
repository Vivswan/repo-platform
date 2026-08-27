# Per-module reference: files, parameters, companion steps, removal

The authoritative roster is the `modules` question in repo-platform's `copier.yml`; the module docs (`docs/<module>.md` where one exists) are the depth. This table is the working summary.

"Managed" files keep updating on every sync; "starter" files are generated once (`_skip_if_exists`) and then repo-owned.

## Base (every managed repo, no module needed)

Managed: `ci.yml` and its standard jobs, `dependabot.yml` (github-actions ecosystem always), `.gitignore` managed sections, `SECURITY.md`, `.copier-answers.yml`, `.repo-platform.yml` (shape). Starters: `checks.yml` (your CI jobs, called inside the all-green gate), `.gitleaks.toml`, `.github/actionlint.yaml`.

## Toolchains: bun / node / deno / uv / rust

- Managed: dependabot ecosystem entry, gitignore section, CodeQL job in ci.yml (public repos; not rust), and for bun/node/deno the toolchain version dotfile (`.bun-version` / `.node-version` / `.dvmrc`, fleet-pinned; uv and rust carry none) plus, bun only, the `dependabot-bun-lockfile.yml` lockfile fixer.
- Starter: `auto-format.yml` prefilled per selected formatter toolchain (all but rust) - only when the file does not exist yet. The same applies to every composite starter a toolchain contributes fragments to: an existing `auto-format.yml`, `checks.yml` (example jobs), `.gitleaks.toml` (lockfile allowlists), or `copilot-setup-steps.yml` (agents module) does NOT gain a newly added toolchain's fragment - add the toolchain's piece to the existing file by hand.
- Companion steps:
  - Settings labels are automatic: the fleet baseline declares `dependencies` (`0366d6`) and `github_actions` (`000000`) always, and each toolchain module's own `templates/<module>/settings.yml` layer declares its label - `javascript` (`168700`) for bun/node, `deno` (`70ffaf`), `python:uv` (`2b67c6`), `rust` (`000000`). An SSOT rule pins each of those against the manifest's `dependabot` tuple, so the two cannot drift. A NEW toolchain's layer files must also be declared in its `module.yml` under `settings_layers` - the render selects layers from that declaration, and the manifest loader refuses an undeclared or missing file.
  - bun only: `gh secret set REPO_PLATFORM_TOKEN --app dependabot` with a repo-scoped Contents:RW PAT (human-only). Without it the lockfile fix lands but cannot re-trigger checks; each fixed Dependabot PR then needs a close/reopen.
- Removal: the dependabot entry, gitignore section, and CodeQL job leave - except outputs another selected toolchain still contributes: bun/node/deno share the `codeql-javascript` job, and bun and node share the Node gitignore section, so those stay while any contributor remains selected. The auto-format starter stays (edit it yourself). The toolchain label leaves the managed baseline once nothing carries it, and the next apply deletes it from the repo.

## agents

- Managed: the AGENTS.md managed half (repo-specific content goes below the `repo-platform:local-section` marker) and the agent-file symlinks (`CLAUDE.md`, `.github/copilot-instructions.md`, `.github/agents.md`), all pointing at AGENTS.md.
- Starter: `copilot-setup-steps.yml` (Copilot coding agent environment setup), prefilled with installs for the toolchains selected at generation time; adding a toolchain later does not update an existing copy.
- Removal: the managed half and symlinks leave the render and are deleted; the starter stays.

## pages

- Managed: `pages.yml` caller (deploys through repo-platform's `reusable-pages.yml`).
- Parameters (asked when selected; defaults derived from the selected toolchains): `pages_setup`, `pages_install_command`, `pages_build_command` (must be nonempty), `pages_dist_dir`, `pages_production` (release or main), `pages_staging`. Details and the build contract (`PAGES_BASE_PATH`, `PAGES_ORIGIN`, `PAGES_STAGING`): repo-platform's `docs/pages.md`.
- Companion steps (one-time, needs repo settings access):
  1. Settings -> Pages -> Source: GitHub Actions.
  2. Settings -> Environments -> `github-pages` -> add a `v*` tag rule to deployment branches (release-triggered deploys run on the tag ref and are rejected without it).
- Before the first release only `/staging/` publishes (with the default `pages_production: release`); the root 404 is expected, not a failure. `pages_production: main` builds the root from main HEAD, so it has no such window.
- Removal: the caller leaves the render and is deleted; the live Pages site and settings stay until you turn Pages off in the repo.

## release-please

- Managed: `release.yml` (the full pipeline: draft cut -> repo-owned update hook -> attested publish with a single `attestation.jsonl` per release), the `release` job on top of all-green, and the `release-freshness` and `release-health` gate jobs in ci.yml.
- Starters: `update-release.yml` (the update hook release.yml calls between draft and publish), `update-release-pr.yml` (the hook release.yml calls on release-PR refreshes), `release-please-config.json`, `.release-please-manifest.json`.
- Settings labels are automatic: the module's own `templates/release-please/settings.yml` layer (declared in the manifest's `settings_layers`, like every module layer file) declares `autorelease: pending`, `autorelease: tagged`, `release-blocker` (`B60205`), `release-override` (`FBCA04`), plus the `release-tags` tag-immutability ruleset.
- With `fuzzer` also selected, the release-health gate ties releases to fuzz health (an open fuzz tracking issue blocks cuts).
- Removal: managed pieces leave; the starters stay (delete them yourself if the repo stops releasing this way).

## issue-templates

- Starters only: bug/feature issue forms and the chooser config - generic on first render, then tailored by the repo.
- Removal: the forms stay (repo-owned); delete what you no longer want.

## skills

- Managed: `validate-skills.yml` (advisory CLI-discovery workflow) and a `validate-skills` structure job inside ci.yml, gating through all-green.
- Starters: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, seeded from the repo identity with an empty `skills` catalog. A repo adopting the module with existing manifests keeps them untouched.
- Parameter: `skills_dir` (default `skills`) - conservative charset because the value lands in the discovery workflow's `paths` filter and the gate job's action input.
- Companion step: each published skill must be listed in `plugin.json`'s `skills` array (`./skills/<name>`, or `./<skills_dir>/<name>`). Structure validation checks every direct child folder of the skills directory, listed or not - an invalid unlisted folder fails the gate, and a valid unlisted folder passes and silently never ships (installers and the discovery check read the manifest, not the disk).
- Removal: both validation workflows leave; the manifests and the skills directory stay (repo-owned).

## fuzzer / nightly

Twin nightly issue streams backed by the same `fuzz-issue` action; `fuzzer` adds the failure-report/replay-artifact contract and release gating, `nightly` is the plain-CI stream.

- Starters: `nightly-fuzz.yml` (fuzzer, cron 09:11 UTC) / `nightly.yml` (nightly, cron 06:59 UTC). Placeholder step is a green no-op until customized. The action pin inside a starter is never updated by sync (it pins `main` and floats).
- Parameters: `fuzzer_label` (default `fuzz-nightly`) / `nightly_label` (default `nightly-failure`). The two must differ (case-insensitive) when both modules are selected - both streams dedup AND auto-close by label, so a shared label lets one stream's green night close the other's open issue. The copier validator and the settings assembly both reject the collision.
- Settings labels are automatic: the managed baseline declares the tracking label - `fuzz-nightly` (`B60205`) / `nightly-failure` (`D93F0B`) or the repo's recorded answer, read from `.copier-answers.yml` at apply time. A tracking issue stripped of its label is invisible to dedup and auto-close.
- Renaming a label: update the recorded answer AND the starter's two `label:` inputs in the same PR (the starter is repo-owned; sync never fixes it). The managed baseline picks the renamed value up on the next apply.
- Removal: the label leaves the managed baseline and the next apply deletes it. The starter workflow keeps running - delete it yourself, or declare its label in the repo's own `.github/settings.yml` first.
- Depth: repo-platform's `docs/fuzzer.md` and `docs/nightly.md` (failure-report contract, sharding, issue lifecycle, release gating).

## pr-title / auto-assign

- pr-title: a managed job in ci.yml, nothing else. Removal deletes it.
- auto-assign: a managed `auto-assign.yml` caller. Removal deletes it.

## settings-sync

- Selecting the module IS the opt-in to centrally managed settings: the nightly heal assembles the repo's baseline (policy block, module labels, fleet rulesets) and merges the repo's own `.github/settings.yml` over it.
- Managed: `settings-sync.yml` caller (push-time self-apply of the same merge).
- Starter, never deleted: `.github/settings.yml` - the identity keys plus local overrides, rendered once and repo-owned (a same-name label there replaces the fleet one wholesale, a same-name ruleset merges into it; a key set to `null` opts out of that part of the fleet defaults, except where the override layer declares it).
- Parameters: `homepage`, `topics` (seeded into the starter; declared-empty clears the live value, so copy UI-set values into the file before they get healed away).
- Companion step (optional): a repo-scoped PAT with Administration + Issues RW as the repo's own `REPO_PLATFORM_TOKEN` Actions secret buys apply-on-push immediacy; without it self-apply skips with a warning and the central nightly run still applies the repo.
- Removal: the caller is deleted; `settings.yml` stays as inert documentation - nothing enforces the repo's settings afterwards.

## custom-license

- Effect: the fleet LICENSE.md is not rendered; the repo's LICENSE.md is its own license, repo-owned, and the `copyright_holder` question is skipped.
- Adding it: the existing fleet LICENSE.md file is preserved in place (not deleted) - replace its content with the repo's own license.
- Removing it is guarded: the sync fails with instructions while the repo's own license file exists. Delete the old license in the same commit that removes the module from `.repo-platform.yml`, then re-run the sync; the fleet LICENSE.md arrives in that PR (prior licensing stays in git history; third-party notices go below the local-section marker).

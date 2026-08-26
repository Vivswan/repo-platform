# Repository settings

Managed repos get their settings (repository fields, topics, labels, rulesets) applied through [github-settings-as-code](https://github.com/Vivswan/github-settings-as-code), the replacement for the [Probot Settings app](https://github.com/repository-settings/app). Every apply is a visible workflow run whose problems surface as loud warnings and errors; no more silent drift.

Selecting the `settings-sync` module in a repo's `.repo-platform.yml` is the whole opt-in. The nightly `settings-repos.yml` run in repo-platform discovers every enrolled, adopted repo with the module, and for each one applies a document built from two layers.

## Two layers

| Layer | Home | Contents |
|---|---|---|
| Managed baseline | computed per repo at apply time by `.github/scripts/fleet/render_managed_settings.ts` | the shared `repository:` policy block, `security_and_analysis` (public repos only), the full label roster the repo's module selection requires, the fleet rulesets (`main`, `non-bypassable`, `release-tags` with release-please) |
| Repo layer | the repo's own `.github/settings.yml` | identity keys (`description`, `homepage`, `topics`, `private`) plus the repo's own labels, rulesets, and overrides |

The baseline is NEVER synced into client repos as a file: repo-platform computes it from the repo's facts - module selection from its `.repo-platform.yml`, live visibility, tracking-label answers from its `.copier-answers.yml` - and `merge_settings_layers.ts` deep-merges the repo layer OVER it. The settings-sync module renders `.github/settings.yml` ONCE as an identity starter (`_skip_if_exists`); template sync never rewrites or deletes it, so a settings edit is an ordinary PR in the repo itself.

The merge dialect (one implementation, `merge_settings_layers.ts`):

- The repo layer wins; objects merge key by key.
- An explicit `null` in the repo layer opts that key out entirely - the apply never touches that section (or nested key) on this repository.
- `labels` and `rulesets` are NAME-KEYED UNIONS: a repo entry replaces the same-name baseline entry wholesale (never a field-merge), and both sides' other entries are kept. Plain array-replace would freeze the baseline roster the moment a repo declared one extra label; the union keeps repo additions and baseline evolution both live. Label names match case-insensitively (GitHub deduplicates them that way); ruleset names match exactly.
- Every other array, and every scalar, replaces wholesale.

Repo-platform itself is always a target: it is not generated from the template (no `.repo-platform.yml`), so its baseline facts come from `.repo-platform-answers.yml`, and its own `.github/settings.yml` carries its identity keys plus its repo-specific rulesets (`build-branches`, `build-tags`, `non-bypassable`).

`settings-repos.yml` runs on three triggers:

- Push to main touching the baseline's inputs (this repo's own settings.yml, the generator or merge script, a module manifest): merging a policy change applies it fleet-wide.
- Nightly heal cron: reverts out-of-band drift.
- Manual dispatch: a plain dispatch applies; pass `-f check_only=true` for a drift report without settings writes, and `-f repo=owner/name` (or a bare name, same owner) to heal a single target instead of the whole fleet - the run fails loudly when that repo is not a settings target. A private target's report issue is still delivered even then, and the very first check on a private target can flag the report's marker label itself as drift - the label does not exist until that same run's delivery creates it, so the next run is clean.

Each target is one fail-fast-free matrix job: the generator renders the baseline, the merge script fetches the repo's settings.yml from its default branch and layers it over, and the pinned action applies the merged document in single-repo mode (`repository:` + `settings-file:`). Repos heal independently: a failed apply is that repo's own red `apply (<repo>)` job and never blocks the others, and a repo whose selection probes keep failing (after retries) is skipped for the run with a warning and picked up again the next night. A private target shows up as a name hint (`apply (h**-s**r)`) rather than its slug, and its details stay out of the public log - see [docs/private-repos.md](private-repos.md). The hidden details are not lost: for a redacted target the action's visibility probe proves private or internal, and the full failure/drift report is delivered as a marker-labelled issue on that repository itself (`private-report: issue`). The issue exists for every such target and is reused forever: open means the apply failed or drifted, closed means healthy with the latest report inside (prior reports stay in the body's edit history). Delivery is best-effort: a target whose visibility the probe cannot prove stays redacted without an issue, and a failed delivery warns without changing the run's result.

## What the baseline contains

The `repository:` policy block every repo shares (merge policy, squash-title enforcement, feature toggles) lives in the generator's unconditional base; a repo opts out of any key by declaring its own value (or `null`). Visibility-dependent blocks follow the repo's LIVE visibility: `security_and_analysis` (secret scanning + push protection) is rejected with a 422 by private repos without Advanced Security, so the generator emits it only for public repos, and the `main` ruleset's `code_scanning` rule renders only where CodeQL analyzes (public plus an analyzable toolchain).

The label roster is generated from the module manifests, so it cannot drift from what the modules need: `dependencies` (`0366d6`) and `github_actions` (`000000`) always (dependabot recreates its labels when missing, so an undeclared one would loop delete/recreate nightly), the per-ecosystem dependabot labels for the selected toolchain modules -<!-- BEGIN GENERATED: dependabot-labels (scripts/generate.ts - edit module.yml manifests, not this block) --> `javascript` (`168700`) for bun and npm, `deno` (`70ffaf`) for deno, `python:uv` (`2b67c6`) for uv, `rust` (`000000`) for cargo.<!-- END GENERATED: dependabot-labels --> The triage trio (`bug`, `enhancement`, `fix-lint`) is unconditional. With the release-please module the roster adds the `autorelease: *` pair and release-health's gate labels, `release-blocker` (`B60205`) and `release-override` (`FBCA04`) - stripping one un-blocks or un-overrides a release mid-flight. Repos with the fuzzer or nightly module get their tracking labels (the `fuzzer_label` / `nightly_label` answers, default `fuzz-nightly` at `B60205` and `nightly-failure` at `D93F0B`): the label is the tracking-issue stream's identity, so losing it breaks the auto-close and the release-health gate stops seeing the open issue. Private repos carry one more: the `settings-as-code-report` marker label (`0e2a47`) that private reporting pins its report issue with - the central apply injects it automatically for redacted targets, but the module's self-apply runs unredacted and injects nothing, so the baseline declares it.

## Apply semantics

Stateless, declared-keys-only, upsert-by-name - on the MERGED document:

- Labels: declared labels are synced; undeclared labels are deleted (loudly). The merged roster always contains the baseline labels, so deletion only ever hits labels neither layer declares.
- Rulesets: upserted by name (branch and tag targets); never deleted when undeclared, since removing protection stays a human action. A repo overriding a baseline ruleset replaces the entry wholesale - partial ruleset edits are not a thing.
- Repository fields, topics, and security toggles are applied only when declared; omitting a key leaves the live value alone. The starter therefore seeds `homepage:` and `topics:` unconditionally, like `private:`: an empty value declares-and-clears (empty topics normalize to no topics) instead of leaving the field unmanaged. A homepage or topics set only in the GitHub UI is cleared by the next heal - put values you want to keep in the settings file.
- Visibility is managed like any other declared field: the starter seeds `private:` (false included), so the nightly heal reverts an out-of-band flip in either direction - a repo made private in the GitHub UI is public again by the next morning. To change visibility on purpose, edit `private:` in the settings file and let the apply flip the repo; the baseline's visibility-gated blocks follow the live state on the next run, and template sync separately detects the answers drift (the PR arrives review-required with the drift called out). The heal of an out-of-band private flip dodges the 422 only because the pinned github-settings-as-code applies the repository field block before rulesets (SECTION_KEYS order in its schema.ts): the repo is public again before any code_scanning rule is upserted. Check a pin bump keeps that order.
- Short ref names in ruleset conditions are auto-prefixed (`staging` -> `refs/heads/staging`, `templates/*` -> `refs/tags/templates/*`); `~DEFAULT_BRANCH` passes through.
- The default branch carries two rulesets on purpose: `main` (status checks, PR gates - a CODEOWNER review, every review thread resolved before merge, squash-only - force-push and deletion protection) grants admins a bypass so direct pushes keep working, while `non-bypassable` (deletion, linear history) declares `bypass_actors: []` - GitHub then binds everyone, repository owner included, and the explicit empty list (unlike an omitted key) lets the nightly heal detect and clear an out-of-band bypass actor. The owner can still edit or disable the ruleset itself, but the nightly apply re-asserts it. Two knock-ons: renaming the default branch is blocked for everyone (a rename deletes the old ref - disable the ruleset first, and the next heal restores it), and merge commits cannot be pushed directly even by admins (`git pull --rebase`). Both rulesets are generator data with unit tests pinning the empty bypass list.

## The starter and the one-time transition

The settings-sync module renders `.github/settings.yml` once: the four identity keys seeded from the copier answers, plus commented examples for local labels and rulesets. It is repo-owned from then on (`_skip_if_exists`), and the module also renders a managed `settings-sync.yml` workflow (push on that file + manual dispatch) that self-applies through `reusable-apply-settings.yml` - the reusable workflow checks out repo-platform at the calling ref's commit and computes the same baseline + merge, so a partial repo document can never delete baseline labels.

Repos generated before the two-layer model carry the full old baseline in their settings.yml (the file still carries the retired `# repo-platform:mergeable` marker). The first template sync after this model REPLACES that file with the identity starter, seeded from the repo's live values (description and visibility from the freshly recorded answers, homepage and topics from the old file's own declarations). The sync PR stays manual-review and its `settings.yml layering` section lists every old declaration that differed from the computed baseline - deliberate overrides being dropped - so the reviewer re-adds the wanted ones to the new file before merging. Baseline-equal declarations need no action: the managed layer supplies them.

Self-apply needs the repo's OWN `REPO_PLATFORM_TOKEN` Actions secret: a fine-grained PAT with Administration (read and write) and Issues (read and write) on that repository. Without the secret, self-apply runs skip with a warning - the module stays safe to enable before any token exists, and the central `settings-repos.yml` run applies the repo's settings regardless. The per-repo PAT only buys apply-on-push immediacy.

## Opting out

Remove `settings-sync` from the repo's `.repo-platform.yml`: the next sync PR deletes the `settings-sync.yml` caller, the nightly heal stops managing the repo, and the repo's `settings.yml` stays (sync never deletes it) as inert documentation or for hand use. Excluding a repo in `repos.yml` also pauses its nightly heal - the settings run warns when an excluded repo still opts in.

## Token

The fleet-level token model lives in the [README's Credentials section](../README.md#credentials): one PAT stored only in repo-platform drives sync and central settings, and it is required there - the central runs fail without it. Settings applies are strict about permissions: a token that cannot reach a declared section fails that repository's apply job (`on-missing-permission: fail`), so drift never hides behind a green run. Administration and Issues write are required wherever settings are applied.

A per-repo PAT is only needed for the module's self-apply-on-push, and only needs Administration and Issues on that one repository ([create a module-only PAT with those pre-selected](https://github.com/settings/personal-access-tokens/new?name=REPO_PLATFORM_TOKEN&description=settings-sync+self-apply&administration=write&issues=write)); the fleet link's extra scopes (Contents, Pull requests, Workflows) are for push sync and are not needed here.

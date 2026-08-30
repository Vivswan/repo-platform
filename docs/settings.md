# Repository settings

Managed repos get their settings (repository fields, topics, labels, rulesets) applied through [github-settings-as-code](https://github.com/Vivswan/github-settings-as-code), the replacement for the [Probot Settings app](https://github.com/repository-settings/app). Every apply is a visible workflow run whose problems surface as loud warnings and errors.

Selecting the `settings-sync` module in a repo's `.repo-platform.yml` is the whole opt-in. Each apply builds one document from six layers, merged low to high:

| # | Layer | Home | Contents |
|---|---|---|---|
| 1 | Fleet baseline | `.github/settings-baseline.yml` | the overridable fleet defaults: repository feature toggles, default branch, the unconditional labels |
| 2 | Fleet visibility overlay | `.github/settings-public.yml` or `.github/settings-private.yml` | `security_and_analysis` and the `main` ruleset's `code_quality` and `copilot_code_review` rules for public repos; the `settings-as-code-report` marker label for private ones |
| 3 | Module layer | `templates/<module>/settings.yml` | what selecting that module adds: a toolchain module's dependabot label, release-please's four labels and its `release-tags` ruleset |
| 4 | Module visibility overlay | `templates/<module>/settings-public.yml` or `settings-private.yml` | the analyzable toolchains' `code_scanning` rule, which GitHub rejects on private repos |
| 5 | Repo layer | the repo's own `.github/settings.yml` | identity keys (`description`, `homepage`, `topics`, `private`) plus the repo's own labels, rulesets, and overrides |
| 6 | Fleet override | `.github/settings-override.yml` | the invariants no repo may weaken: the squash-only merge policy, `allow_auto_merge`, `enable_vulnerability_alerts`, and the `main` and `non-bypassable` protection rulesets |

Every layer is a plain settings-as-code YAML document a human can read on its own; no settings content derives from code. The mechanics:

- Layers 1-4 are selected by the repo's facts and merged by `.github/scripts/fleet/render_managed_settings.ts`: module selection from its `.repo-platform.yml`, effective visibility, tracking-label answers from its `.copier-answers.yml`. `merge_settings_layers.ts` owns the dialect and adds layers 5 and 6.
- Which layer files a module ships is DECLARED (`settings_layers` in its `module.yml`), never discovered from the tree: the manifest loader checks each declaration against the tree in both directions on every load, so a deleted layer file is a hard error instead of a silently shorter stack whose missing labels the apply would then delete fleet-wide.
- None of these files is ever synced into a client repo; only the repo's own settings.yml lives there, rendered ONCE as an identity starter (`_skip_if_exists`), so a settings edit is an ordinary PR in the repo itself.
- Layer 6 is the only layer a repository cannot beat. Fleet defaults a repo may tune belong in layer 1.
- Tracking labels are the one non-file input: the label NAME is the repo's `fuzzer_label` / `nightly_label` answer, its color and description live in the module manifest, and the assembly appends it after merging the layers (an unreadable answer fails that repo's apply rather than guessing).

## The merge dialect

One implementation (`merge_settings_layers.ts`), applied identically at every layer boundary:

- The higher layer wins; objects merge key by key.
- An explicit `null` opts that key out entirely - the apply never touches that section (or nested key) on this repository. It strips the key from the layers BELOW it only, so a repo cannot null away an override: layer 6 puts it straight back.
- `labels` and `rulesets` are NAME-KEYED UNIONS: both sides' other entries are kept, so a plain array-replace can never freeze the fleet roster the moment a repo declares one extra label. Label names match case-insensitively (GitHub deduplicates them that way); ruleset names match exactly.
- A same-name LABEL is replaced wholesale by the higher layer.
- A same-name RULESET merges key by key, and its `rules` list APPENDS keyed by rule `type`: the lower layer's rules in order, each REPLACED IN PLACE by a higher-layer rule of the same type, then new types appended. That is what lets a module's visibility overlay (layer 4) add `code_scanning` to the `main` ruleset the override (layer 6) declares. Two consequences: a higher layer can add new rule types, and a higher-layer rule of the SAME type replaces the lower one - which can weaken it. Only the override layer is immune: its rules merge in last, so nothing below can replace or remove them.
- The dialect refuses shapes it cannot merge safely, at the parse boundary and with the file named: a `labels` or `rulesets` section that is not a list of mappings (it would fall out of the union and replace the managed roster wholesale - the apply would then delete every managed label, or upsert rulesets missing the modules' protection rules, green either way), and a ruleset rule without a string `type`.
- Every other array, and every scalar, replaces wholesale.

## When it runs

`settings-repos.yml` runs on three triggers:

| Trigger | Effect |
|---|---|
| Push to main touching the merged documents' inputs (the fleet and module layer files, the fleet scripts and their imports, the module manifests, the recorded answers - the workflow's `paths:` block is the authoritative list) | merging a policy change applies it fleet-wide |
| Nightly cron | heals out-of-band drift, from the tip when it is green and from the newest green commit behind it when not |
| Manual dispatch | plain dispatch applies; `-f check_only=true` reports drift without writes; `-f repo=owner/name` (or a bare name, same owner) heals one target and fails loudly when that repo is not a settings target |

Targets are the enrolled, adopted repos whose `.repo-platform.yml` selects the settings-sync module, plus repo-platform itself. A private target's report issue is delivered even under `check_only`, and the very first check on a private target can flag the report's marker label itself as drift - the label does not exist until that same run's delivery creates it, so the next run is clean.

Every run, on all three triggers, is gated on applying only from a GREEN commit (`fleet/require_green_commit.ts`, the same all-green predicate the template publisher and the sync enforce): this workflow is the one fleet-wide settings writer, so it never writes from a commit CI has not vouched for. What an ungreen tip means differs by trigger. A push-triggered run waits - bounded - for its own commit's CI verdict and fails closed on red or no verdict, instead of applying a broken layer change fleet-wide concurrently with the CI run that would have caught it; a dispatch is gated the same way, since applying the checked-out commit is both runs' point. The SCHEDULED heal instead falls back: when the tip is not green, `fleet/newest_green_commit.ts` walks main's first-parent history for the newest commit with a completed, successful all-green verdict - the fallback commit passes the same predicate as the tip - and the run re-checks out at that commit, so scripts, dependencies, and layer files are one vouched revision and the heal keeps re-asserting the last vouched state through a red-main window instead of halting. The walk is bounded (50 commits and 14 days; exhausting either bound refuses and the heal stays halted, the pre-fallback behavior as the floor), and an apply-from-behind is always loud: the gate emits a warning and a step-summary line naming the commit healed from and the red tip it stands in for. Two residuals: the workflow file itself always executes from the tip (GitHub loads a scheduled workflow from the default branch head, so the fallback pins scripts and data, not the orchestration around them - CI gating every workflow change is the counterweight), and `check_only` reports are dispatch runs and stay tip-gated, so the drift diagnostic is unavailable exactly while main is red.

## How each target is applied

Each target is one fail-fast-free matrix job (`apply (<repo>)`); repos heal independently, so one repo's red apply never blocks the others.

1. Resolve the target's default-branch head to a COMMIT. Every content read pins to it: the assembly renders the layers from facts read at that commit, and the merge fetches the repo's settings.yml at the SAME commit (the operator repository reads its own checkout instead, already one revision).
2. Recheck the opt-in at that commit rather than trusting the selection job: a repo that dropped the settings-sync module in between writes no baseline and is skipped, because applying one would reconcile - and delete - labels on a repository that turned central settings off.
3. Immediately before the apply, re-resolve the target's head once more and skip if it moved - the next run reads the new revision. This narrows the race window rather than closing it: there is no compare-and-swap on "still opted in", so a push inside the remaining window still applies.
4. Apply the merged document with the pinned action in single-repo mode (`repository:` + `settings-file:`).

Edge cases, all deliberate:

- Visibility has the same narrowed-not-closed window, one fact deeper: when the target declares no `repository.private`, the render falls back to a live probe that nothing pins, so an out-of-band visibility flip landing mid-run applies the wrong overlay. Flipped private-to-public, the merged document is missing `security_and_analysis` and the `code_scanning`/`code_quality` rules until the next nightly heal reads the new visibility.
- A MOVED target keeps any open failure report open, since that run never checked its settings; the two deliberate skips (opted out, not yet onboarded) are terminal and do close it.
- A target that selects the module but has no `.github/settings.yml` yet is SKIPPED with a warning: absence of the repo layer means not-yet-onboarded, never an empty layer, and applying the baseline alone would delete every label that repo declares for itself. The starter seeds the file on the repo's next template sync; the apply after that picks it up.
- A repo whose selection probes keep failing (after retries) is skipped for the run with a warning and picked up again the next night.
- A private target shows up as a name hint (`apply (h**-s**r)`), and its details stay out of the public log - see [docs/private-repos.md](private-repos.md). The full failure/drift report is delivered as a marker-labelled issue on that repository itself (`private-report: issue`), reused forever: open means the apply failed or drifted, closed means healthy with the latest report inside (prior reports stay in the body's edit history). Delivery is best-effort: a target whose visibility the probe cannot prove stays redacted without an issue, and a failed delivery warns without changing the run's result.

## What the baseline contains

- The shared `repository:` feature toggles live in the fleet baseline; a repo opts out of any of them by declaring its own value (or `null`). The exceptions live in the override layer, where no repo can opt out: the merge policy (squash-only, with the squash-title enforcement the pr-title check and release-please rely on), `allow_auto_merge`, and `enable_vulnerability_alerts`.
- Visibility-dependent blocks follow the repo's EFFECTIVE visibility - the `private:` its settings.yml declares, live-probed when undeclared - so a deliberate flip and its visibility-gated blocks land in one apply. `security_and_analysis` (secret scanning + push protection) is rejected with a 422 by private repos without Advanced Security, so only the public overlay carries it. The `main` ruleset's `code_scanning` rule renders only where CodeQL analyzes (public plus an analyzable toolchain). Its `code_quality` rule follows visibility alone: it gates on GitHub Code Quality's own analysis and, on current evidence, stands down where that feature is not enabled, so every public repo carries it regardless of toolchain (the evidence and reasoning are in `.github/settings-public.yml`).

The label roster is the union of every selected layer's `labels`, so it cannot drift from what the modules need:

- always: `dependencies` (`0366d6`) and `github_actions` (`000000`) - dependabot recreates its labels when missing, so an undeclared one would loop delete/recreate nightly - plus the triage trio `bug`, `enhancement`, `fix-lint`
- per selected toolchain, the dependabot ecosystem labels:<!-- BEGIN GENERATED: dependabot-labels (scripts/generate.ts - edit module.yml manifests, not this block) --> `javascript` (`168700`) for bun and npm, `deno` (`70ffaf`) for deno, `python:uv` (`2b67c6`) for uv, `rust` (`000000`) for cargo.<!-- END GENERATED: dependabot-labels -->
- with release-please: the `autorelease: *` pair and release-health's gate labels, `release-blocker` (`B60205`) and `release-override` (`FBCA04`) - stripping one un-blocks or un-overrides a release mid-flight
- with the fuzzer or nightly module: the tracking labels (the `fuzzer_label` / `nightly_label` answers, default `fuzz-nightly` at `B60205` and `nightly-failure` at `D93F0B`) - the label is the tracking-issue stream's identity, so losing it breaks the auto-close and the release-health gate stops seeing the open issue
- private repos only: the `settings-as-code-report` marker label (`0e2a47`) that private reporting pins its report issue with, declared in the private visibility overlay - the central apply injects it automatically for redacted targets, but the module's self-apply runs unredacted and injects nothing, so the overlay declares it

## Apply semantics

Stateless, declared-keys-only, upsert-by-name - on the MERGED document:

- Labels: declared labels are synced; undeclared labels are deleted (loudly). Unless the repo opts the whole section out with `labels: null` (the apply then never touches labels), the merged roster contains the baseline labels, so deletion only ever hits labels neither layer declares.
- Rulesets: upserted by name (branch and tag targets) with a FULL-PAYLOAD PUT, so the live rules array becomes exactly the merged document's - a rule type no layer declares any more is removed from the live ruleset on the next apply. The dialect's rule append runs between LAYERS, never against live state, so it cannot hold a dropped rule alive; a rule that outlives its removal from the fleet layers is one the repo's own settings.yml still declares. Whole RULESETS are never deleted when undeclared, since removing protection stays a human action. A repo declaring a same-name ruleset merges into it key by key, with its rules appended by type per the dialect above - a new type is added, and a repo rule repeating a module-declared type replaces that rule (the override layer's own rules merge in above and survive). The one way to remove inherited rules wholesale is `rules: null`, which drops what the LOWER layers contributed - a module's `code_scanning`, say, or the release-tags module's rules - but cannot touch the override layer's rules, so the fleet's mandatory protection survives it either way.
- Repository fields, topics, and security toggles are applied only when declared; omitting a key leaves the live value alone. The starter therefore seeds `homepage:` and `topics:` unconditionally, like `private:`: an empty value declares-and-clears (empty topics normalize to no topics) instead of leaving the field unmanaged. A homepage or topics set only in the GitHub UI is cleared by the next heal - put values you want to keep in the settings file.
- Visibility is managed like any other declared field: the starter seeds `private:` (false included), so the nightly heal reverts an out-of-band flip in either direction. To change visibility on purpose, edit `private:` in the settings file; the visibility-gated blocks follow the declared value in the same apply, and template sync separately detects the answers drift (the PR arrives review-required with the drift called out). The heal of an out-of-band private flip dodges the 422 only because the pinned action applies the repository block before rulesets (SECTION_KEYS order in its schema.ts): the repo is public again before any `code_scanning` or `code_quality` rule is upserted. Check a pin bump keeps that order.
- Short ref names in ruleset conditions are auto-prefixed (`build` -> `refs/heads/build`); `~DEFAULT_BRANCH` passes through.

## Label preflight

Labels a repo's own files reference must be in the merged roster, or the label reconciliation above would delete them out from under those files:

- Apply side, fail-closed: before the action reconciles labels, a preflight fails that repo's apply when a label referenced by its issue forms (`.github/ISSUE_TEMPLATE/*.yml` `labels:` keys) or its own workflows is LIVE on the repo but missing from the merged roster - the failure names the label and the referencing files. When the merged document manages no labels, the guard stands down with a public notice.
- Sync side, warn-only: the sync PR gains a forces-review body section naming referenced-but-undeclared labels; an extraction failure writes a could-not-verify section instead of failing the sync.

## The two default-branch rulesets

Both live in `.github/settings-override.yml` - the layer no repo can beat - with `loadOverrideLayer` refusing an override that drops the required check or its Actions pin, and unit tests pinning the empty bypass list and the rest of the protection policy.

| Ruleset | Rules | Bypass |
|---|---|---|
| `main` | ONE required status check, `all-green` (pinned to the GitHub Actions app by `integration_id`; the Copilot review expectation lives inside the verdict - the managed wrapper renders `require-copilot-review` from the repo's visibility, see [docs/all-green.md](all-green.md)); PR gates: a CODEOWNER review, every review thread resolved, squash-only; deletion, force-push, and linear-history protection | admins, so direct pushes keep working |
| `non-bypassable` | deletion, linear history | `bypass_actors: []` - GitHub binds everyone, repository owner included |

- The explicit empty bypass list (unlike an omitted key) lets the nightly heal detect and clear an out-of-band bypass actor. The owner can still edit or disable the ruleset itself, but the nightly apply re-asserts it.
- Two knock-ons: renaming the default branch is blocked for everyone (a rename deletes the old ref - disable the ruleset first, and the next heal restores it), and merge commits cannot be pushed directly even by admins (`git pull --rebase`).
- `copilot_code_review` REQUESTS a Copilot code review on every pull request to the default branch (new pushes and drafts included) - on PUBLIC repositories only: the rule lives in the fleet's public visibility overlay, because Copilot reviews are disabled on the fleet's private repos, where a request could never be answered (and the managed wrapper renders `require-copilot-review: false` there, so no verdict waits on one). Each review executes as a dynamic Actions workflow that creates a completed `copilot-pull-request-reviewer` check run on the reviewed head sha - the check the all-green VERDICT waits for, and the review's submission is the wake that re-judges a pending verdict - so this rule is what keeps the merge box moving on its own. Verified gaps where no automatic run fires: new pushes to DRAFT PRs (request the review from the reviewers panel, one click), and bot-authored PRs such as Dependabot's (the verdict stands its expectation down for bot authors once any review is submitted after CI completes). [docs/all-green.md](all-green.md) has the full semantics and evidence.

## repo-platform itself is a target

- It is not generated from the template (no `.repo-platform.yml`), so its layer facts come from `.repo-platform-answers.yml`.
- Its own `.github/settings.yml` carries its identity keys plus its repo-specific `build-branches` ruleset, which keeps the generated `build` branch append-only for everyone, the publisher included. (The retired `template` and `actions` refs were deleted 2026-08-29, in the same change that dropped them from the ruleset.)
- A stricter publish-only ruleset over the executable ref is not expressible: GitHub rejects an Integration bypass actor on a user-owned repository's ruleset (422 "Actor GitHub Actions integration must be part of the ruleset source or owner organization"). So `build` consumption keeps its sync-side provenance verify (`verify_build_provenance.ts`, which rejects any tip the builder did not produce), the executable `uses: ...@build` channel has no publisher-identity enforcement beyond push access plus the append-only rules, and `tests/fleet/repo_settings.test.ts` pins that no settings layer declares an Integration bypass actor.
- It does NOT redeclare `main` or `non-bypassable`: the override layer supplies them and wins, so a copy here would be silently overridden.

## The starter and the one-time transition

The settings-sync module renders `.github/settings.yml` once: the four identity keys seeded from the copier answers, plus commented examples for local labels and rulesets. It is repo-owned from then on (`_skip_if_exists`).

The module also renders a managed `settings-sync.yml` workflow (push to main touching that file, plus manual dispatch) that self-applies through `reusable-apply-settings.yml`: the reusable workflow checks out repo-platform at the calling ref's commit and computes the same baseline + merge, so a partial repo document can never delete baseline labels. It runs the same two rechecks the central apply does - the module selection in the checkout, and the default-branch head immediately before the apply - so a self-apply queued behind a later push cannot write a stale document.

Repos generated before the two-layer model carry the full old baseline in their settings.yml (the file still carries the retired `# repo-platform:mergeable` marker). The first template sync after this model REPLACES that file with the identity starter:

- description, homepage, topics, and visibility are seeded from the old file's own declarations - the state the nightly heal enforced - with the freshly recorded answers as the fallback for anything it left undeclared
- an identity key neither source declares is OMITTED rather than seeded empty (an empty value would declare-and-clear a live value nothing ever managed)
- a section the old file declared as `repository: null` stays null: all four keys drop, preserving the do-not-manage-this the repo had declared
- what the next apply would TAKE AWAY is CARRIED into the starter rather than left to a PR-body warning: the repo-local LABELS no fleet layer supplies (the apply deletes labels the merged document does not declare, and a name no layer ever rendered can only be the repository's own), plus every explicit `null` in the `labels` and `rulesets` sections - the dialect's "do not manage this", which dropping would re-arm. A label name the fleet already supplies is never copied: the fleet entry keeps it alive and a copy would only shadow it, so a restyle of a fleet label stays a reported drop.
- RULESET RULES are reported, not carried, even though a declared ruleset is PUT whole. A legacy settings.yml is a rendered copy of the OLD fleet baseline, so a rule type the fleet no longer supplies is almost always fleet policy the fleet retired - carrying it would resurrect what the layers dropped, such as a private repo's `copilot_code_review`. Labels have no such ambiguity, because the fleet's are all still in the layers. Re-declaring a genuine repo rule in the new file appends it back. A repo-only RULESET is untouched either way: the apply never deletes an undeclared ruleset.
- the one opt-out class that is REPORTED rather than carried is a `repository:` key's, because the starter renders that block itself and a carried copy would emit a second `repository:`; the report names it as an opt-out so the reviewer re-adds the deliberate ones
- the sync PR stays manual-review, and its `settings.yml layering` section lists what was carried plus every old declaration that differed from the computed baseline - deliberate overrides being dropped - so the reviewer re-adds the wanted ones to the new file before merging; baseline-equal declarations need no action (the managed layer supplies them), and declarations the override layer owns are skipped, since re-adding them could not take effect
- a transition that fails is also reported in that section and holds the PR for review, because the legacy file is still in place and still shadowing the managed layer until a later sync retries successfully

Self-apply needs the repo's OWN `REPO_PLATFORM_TOKEN` Actions secret: a fine-grained PAT with Administration (read and write) and Issues (read and write) on that repository. Without the secret, self-apply runs skip with a warning - the module stays safe to enable before any token exists, and the central `settings-repos.yml` run applies the repo's settings regardless. The per-repo PAT only buys apply-on-push immediacy.

## Opting out

Remove `settings-sync` from the repo's `.repo-platform.yml`: the next sync PR deletes the `settings-sync.yml` caller, the nightly heal stops managing the repo, and the repo's `settings.yml` stays (sync never deletes it) as inert documentation or for hand use. Excluding a repo in `repos.yml` also pauses its nightly heal - the settings run warns when an excluded repo still opts in.

## Token

The fleet-level token model lives in the [README's Credentials section](../README.md#credentials): one PAT stored only in repo-platform drives sync and central settings, and it is required there - the central runs fail without it. Settings applies are strict about permissions: a token that cannot reach a declared section fails that repository's apply job (`on-missing-permission: fail` on the central path; the self-apply reusable takes it as an input that defaults to fail), so drift never hides behind a green run. Administration and Issues write are required wherever settings are applied.

A per-repo PAT is only needed for the module's self-apply-on-push, and only needs Administration and Issues on that one repository ([create a module-only PAT with those pre-selected](https://github.com/settings/personal-access-tokens/new?name=REPO_PLATFORM_TOKEN&description=settings-sync+self-apply&administration=write&issues=write)); the fleet link's extra scopes (Contents, Pull requests, Workflows) are for push sync and are not needed here.

---
order: 40
group: Start here
---

# Repository settings

This page is the settings model of a managed repository: the layers the sync renders, the dialect that folds them, when the result is applied, and what the apply does to it; the central run itself is [platform/settings-apply.md](platform/settings-apply.md), and the sync writer is [platform/sync/writer.md](platform/sync/writer.md)'s.

- **The rendered document:** every managed repository carries `.github/settings.yml`, a managed file the sync writes from six plain YAML layers. It is the one document [github-settings-as-code](https://github.com/Vivswan/github-settings-as-code) applies.
- **The edit rule:** the repository edits `.github/settings.local.yml`, its own layer, never the rendered file ([editing your settings](#editing-your-settings)).

| #   | Layer                    | Home                                                                                                      | Contents                                                                                                                                                      |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fleet baseline           | [files/settings/baseline.yml](../files/settings/baseline.yml)                                             | the overridable fleet defaults: repository feature toggles, default branch, the unconditional labels                                                          |
| 2   | Fleet visibility overlay | [files/settings/public.yml](../files/settings/public.yml) or [private.yml](../files/settings/private.yml) | public: `security_and_analysis`, and the `main` ruleset's `code_quality` and `copilot_code_review` rules; private: the `settings-as-code-report` marker label |
| 3   | Module layer             | `files/<module>/settings.yml` and, for site, [settings.public.yml](../files/site/settings.public.yml)     | what selecting that module adds, as its layer file says                                                                                                       |
| 4   | CodeQL layer             | [files/settings/codeql-public.yml](../files/settings/codeql-public.yml)                                   | the `code_scanning` rule, for public repos with a CodeQL toolchain                                                                                            |
| 5   | Repo overlay             | the repo's own `.github/settings.local.yml`                                                               | identity keys (`description`, `topics`, `private`) plus the repo's own labels, rulesets, and overrides                                                        |
| 6   | Fleet override           | [files/settings/override.yml](../files/settings/override.yml)                                             | the invariants no repo may weaken (the list below)                                                                                                            |

What a module layer adds is the layer file itself (`files/<module>/settings.yml`).

Two layers of the table need a note:

- **Why layer 4 is gated:** GitHub rejects the `code_scanning` rule on private repos, and a repo with no CodeQL run would block every merge on it.
- **Layer 6 holds:** the squash-only merge policy (the PR title as the squash subject, a blank squash body: `squash_merge_commit_message: BLANK`), `allow_auto_merge`, `enable_vulnerability_alerts`, the `main` and `non-bypassable` protection rulesets, and the rulesets' `_undeclared: delete` policy.

Every layer is a plain settings-as-code YAML document a human can read on its own. No settings content derives from code. The mechanics:

- **The render** is the writer's settings entry ([sync/writer/settings_entry.ts](../.github/scripts/sync/writer/settings_entry.ts)). `files.yml`'s `settings` block names the baseline, the override, and every layer between them with the `when` that selects it (the `source` and `when` of a `files` entry).

- **Layers 1 to 4 are selected by the repository's facts:** the module selection from its `.repo-platform.yml`, and the visibility the overlay's `repository.private` declares.

- **Which layer files exist is DECLARED, never discovered from the tree,** and a declaration and the tree that disagree fail the run: so nothing shrinks the stack and lets the apply delete its labels fleet-wide.

- **Layer 6 is the only layer a repository cannot beat.** Fleet defaults a repo may tune belong in layer 1.

- **Tracking labels are the one non-file input.** The label NAME is the registration's `labels.fuzzer` / `labels.nightly` / `labels.site` key (the module's default when unset). Its color and description are the module's `tracking_label` data in `files.yml`, and the render folds them in as the top layer ([apply semantics](#apply-semantics)).


## The merge dialect

The fold is [github-settings-as-code](https://github.com/Vivswan/github-settings-as-code)'s own `mode: render`, run as its npm library from [sync/writer/settings_layers.ts](../.github/scripts/sync/writer/settings_layers.ts); the render and the apply read one dialect, the library's [layering guide](https://github.com/Vivswan/github-settings-as-code/blob/main/docs/operate/layering.md). What the fleet relies on:

- **The higher layer wins;** mappings merge key by key, and a repo cannot null away an override, since layer 6 puts its value straight back.

- **`null` is the empty state on GitHub, never an opt-out:** `pages: null` turns Pages off, `protection: null` strips a branch's protection.

- **`labels` and `rulesets` are NAME-KEYED UNIONS,** same-name entries merging field by field with the higher layer's fields winning, so a repo declaring one extra label can never freeze the fleet roster, and the CodeQL layer can add its `code_scanning` rule to the `main` ruleset the override declares.

- **An overlay may set** `_undeclared` (`labels: {_undeclared: keep, entries: [...]}` keeps that repository's undeclared labels) and `_remove: true` on a keyed entry, which drops the fleet's entry under the same key; the library's `_layering` directive is refused, since it would replace the fleet roster wholesale.

- **Every layer is validated on its own** before it may contribute, and the folded document once more as the apply will read it.

## Editing your settings

- **Edit `.github/settings.local.yml`, never the rendered `.github/settings.yml`.** The next sync re-renders the managed file from the new overlay and replaces a hand edit of it ([the rendered file](#the-starter-and-the-rendered-file)). Before that, the [managed files check](new-repo.md#the-managed-files-check) reds the PR that edits it.

- **An overlay edit is one PR with the branch sync.** The managed files check reds the overlay PR while the rendered file is stale. The `repo-platform:sync` label or the branch dispatch ([platform/sync/operator.md](platform/sync/operator.md#syncing-a-branch)) re-renders `.github/settings.yml` onto the PR's branch as one commit, so the PR merges green.

- **The apply follows the merge:** the nightly cron plus every green main run ([below](#when-it-runs)) applies the new render once it is on main.

What re-renders on main without a PR of the repository's own:

- **The Tuesday cron:** weekly.
- **A `fleet-sync:public` or `fleet-sync:all` label on a merged platform PR:** from that merge's green run ([all-green.md](all-green.md#opting-a-pr-into-an-immediate-fleet-sync)).
- **A manual dispatch (below):** at once.

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<name> -f manual=true
```

## When it runs

[settings-repos.yml](../.github/workflows/settings-repos.yml) has three ways in ([post-green.md](platform/post-green.md#the-run-leg-by-leg) owns why no push is one):

| Entry                                                  | Effect                                                                                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The post-green call, in a green main push's own CI run | the scope [the `settings-fleet` leg](platform/post-green.md#the-run-leg-by-leg) owns                                                                                                                                                 |
| Nightly cron                                           | heals out-of-band drift                                                                                                                                                                                                              |
| Manual dispatch                                        | plain dispatch applies; `-f check_only=true` reports drift and changes no settings ([check mode](platform/settings-apply.md#check-mode)); `-f repo=` scopes it ([the dispatch scope](platform/settings-apply.md#the-dispatch-scope)) |

The run itself is [platform/settings-apply.md](platform/settings-apply.md): its dispatch scope, the green-commit gate, newest wins, selection, private targets, and check mode.

## What the baseline contains

- **The shared `repository:` feature toggles** live in the fleet baseline; a repo overrides any of them by declaring its own value in its overlay.

- **The exceptions live in the override layer** (layer 6 above), where no repo can opt out.

- **Why the squash body is blank:** a PR body's tables and fences never reach the changelog, so release-please footers travel in a `BEGIN_COMMIT_OVERRIDE` block.

- **Visibility-dependent blocks** follow the `private:` the overlay declares, so a deliberate flip and its visibility-gated blocks land in one render.

- **Why only the public overlay carries `security_and_analysis`** (secret scanning + push protection): private repos without Advanced Security reject it with a 422.

- **The `code_scanning` rule blocks at the fleet's high-or-critical bar,** the same bar as the other [security scans](modules/security-scans.md), so a non-security warning or a medium security alert never blocks a merge.

**The label roster** is the union of every selected layer's `labels`, less any fleet-layer entry the overlay drops with `_remove: true`. The tracking labels fold in above the overlay, so a removal naming one holds the row instead.

Which labels each layer declares is the layer file's; the owner's two PR-flow labels and the dependabot labels carry rules of their own:

- **Why the dependabot labels are declared:** dependabot recreates its labels when missing, so an undeclared one would loop delete/recreate nightly.

- **`merge-when-green`** is applied by the owner alone. Whoever runs the landing verifies the labeling actor is the repository owner and that no push followed the labeling, then merges once every check is green; a later push voids it.

- **`parked`** is applied by the owner alone. It says the PR is complete and kept open on purpose: whoever lands never merges it and never removes the label. A parked PR stays ready: non-draft, rebased on main, green.

- **The tracking label** is the [tracking-issue stream's identity](modules/tracking-issues.md#the-label-is-the-stream), so losing it breaks the auto-close and the release-health gate stops seeing the open issue.

## Apply semantics

The apply is stateless, touches only declared keys, and upserts by name, all on the RENDERED document:

- **Labels:** declared labels are synced; undeclared labels are deleted (loudly) unless the overlay chooses `_undeclared: keep` for that repository.

- **What deletion can hit:** only labels no layer declares or the repository removed on purpose, since every other label is on [the label roster](#what-the-baseline-contains).

- **Rulesets:** upserted by name (branch and tag targets) with the rendered payload, so the live rules array becomes exactly the document's. A rule type no layer declares any more leaves the live ruleset on the next apply. The dialect's rule append runs between LAYERS, never against live state, so it cannot hold a dropped rule alive.

- **A whole ruleset no layer declares any more** is deleted on the next apply too: the override declares `_undeclared: delete` above every overlay, so no repository can keep one alive.

- **`_remove: true` on a rule** in the overlay's `main` entry drops the rule a LOWER layer contributed (`rules: [{type: copilot_code_review, _remove: true}]`). It cannot touch the override layer's rules, so the fleet's mandatory protection survives it either way.

- **Repository fields, topics, and security toggles** are applied only when declared; omitting a key leaves the live value alone. The overlay starter therefore seeds `topics: []` unconditionally, like `private:`: the empty list declares-and-clears instead of leaving the field unmanaged.

- **Topics set only in the GitHub UI** are cleared by the first apply after the render lands. Put values you want to keep in the overlay.

- **The homepage is unmanaged:** the starter seeds no `homepage` key, so the apply never touches the field and a homepage set on GitHub stays. To have the apply manage a real website, add `homepage:` to the overlay by hand.

- **An empty `homepage` clears it:** the apply reads a declared empty value as "clear it" and wipes a homepage set on GitHub on every apply, so to leave the field alone the key is absent, never empty.

- **Visibility** is managed like any other declared field: the starter seeds `private:` (false included), so the nightly heal reverts an out-of-band flip in either direction. To change visibility on purpose, edit `private:` in the overlay; the visibility-gated layers follow the declared value in the same render.

## The default-branch rulesets

The two protection rulesets live in [files/settings/override.yml](../files/settings/override.yml), the layer no repo can beat: `main` requires the one `all-green` check and the PR gates, with admins bypassing so direct pushes keep working; `non-bypassable` protects deletion and linear history with an explicit empty bypass list, so GitHub binds everyone, repository owner included.

- **The explicit empty bypass list** (unlike an omitted key) lets the nightly heal detect and clear an out-of-band bypass actor. The owner can still edit or disable the ruleset itself, but the nightly apply re-asserts it.

- **Renaming the default branch is blocked for everyone:** a rename deletes the old ref. Disable the ruleset first, and the next heal restores it.

- **Merge commits cannot be pushed directly,** even by admins (`git pull --rebase`).

### The pr-title ruleset

A third default-branch ruleset, `pr-title`, requires the managed [pr-title.yml](../files/pr-title/.github/workflows/pr-title.yml) workflow's own `pr-title` check (Actions-pinned, like `all-green`) on repos selecting the pr-title module. The module's layer ([files/pr-title/settings.yml](../files/pr-title/settings.yml)) carries the whole ruleset, so selecting the module declares it and deselecting drops it from the render.

**Why a separate ruleset** rather than a rule in `main`: a `required_status_checks` rule merged into `main` from a lower layer meets the override's rule of that type. That rule's `required_status_checks` array is a plain list and replaces the lower one, so the lower check is lost. Active rulesets on one branch union their required checks.

**Selecting:** the workflow and the ruleset ride one sync PR, so selecting the module never requires a check nothing creates.

**Deselecting keeps a bounded window:** the sync PR that deletes `pr-title.yml` also drops the ruleset from the render. The still-live requirement wedges that PR on its own head until an admin bypass merges it; the apply after the merge deletes the ruleset.

### Copilot code review

`copilot_code_review` REQUESTS a Copilot code review on every pull request to the default branch (new pushes and drafts included), on PUBLIC repositories only. The rule lives in the fleet's public visibility overlay by fleet policy, not platform limit: private repos can run Copilot reviews, and the fleet chooses not to request them there.

**The reviews are ADVISORY:** each executes as a dynamic Actions workflow and posts a `copilot-pull-request-reviewer` check run on the reviewed head, but nothing blocks on it.

**Known gaps** where no automatic run fires: new pushes to DRAFT PRs, and bot-authored PRs such as Dependabot's. Re-request from the reviewers panel if a review is wanted.

## repo-platform itself is a target

- **Its registration:** it carries its own [.repo-platform.yml](../.repo-platform.yml) (modules and project facts) like any managed repository. The sync writes its rendered [.github/settings.yml](../.github/settings.yml) from the same layers, this registration, and its overlay ([platform/sync/operator.md](platform/sync/operator.md#this-repository-as-a-target)), and the selector picks it up like any other target.

- **Its overlay,** [.github/settings.local.yml](../.github/settings.local.yml), carries its identity keys plus its two repo-specific rulesets:

| Ruleset           | What it does                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `stable-tag`      | only blocks deleting the `stable` tag ([build-provenance.md](platform/build-provenance.md#who-can-write-refstagsstable)) |
| `main-up-to-date` | requires a pull request branch to be up to date before merging; admins may bypass, as on `main`                          |

- **Why `stable-tag` blocks only deletion** is [build-provenance.md's](platform/build-provenance.md#who-can-write-refstagsstable).

- **What `main-up-to-date` refuses:** a stale merge (`gh pr update-branch` first), and a direct push to main unless the commit already carries a passing `all-green` run ([all-green.md](all-green.md)). Admins may bypass both, by the owner's decision: with no bypass actor here, GitHub hid the merge box's bypass checkbox while this ruleset's strict check was pending. The fleet does not carry it: sync and Dependabot pull requests would stall behind every merge.

- **A stricter mover-only ruleset over the executable ref is not expressible:** GitHub rejects an Integration bypass actor on a user-owned repository's ruleset (422 "Actor GitHub Actions integration must be part of the ruleset source or owner organization").

- **What follows:** `stable` consumption keeps its sync-side [re-verification](platform/build-provenance.md#provenance-is-the-commit-itself). The executable `uses: ...@stable` channel has no mover-identity enforcement beyond push access plus the deletion-only rule.

- **It does NOT redeclare `main` or `non-bypassable` in its overlay:** an entry named like a fleet ruleset merges into it, the override's rules winning on conflict, so a copy there adds nothing. That is why the up-to-date requirement is a ruleset of its own.

## The starter and the rendered file

**The starter:** every repository receives `.github/settings.local.yml` once ([files/base/.github/settings.local.yml](../files/base/.github/settings.local.yml)). It carries the three identity keys (`description` from the registration, `topics` declared empty, `private` from the writer's `--private` flag), plus commented examples for local labels and rulesets. It is repo-owned from then on (a starter: written only when absent).

**The rendered file** `.github/settings.yml` is written right after it, on every sync, under the managed rules ([platform/sync/writer.md](platform/sync/writer.md#classes)): a hand-written or edited one is replaced with its diff holding the PR; move what it declared into the overlay by hand, since the writer copies nothing across.

**Nothing in the repository applies its settings:** [settings-repos.yml](../.github/workflows/settings-repos.yml) applies them centrally, on [its own entries](#when-it-runs). A managed repository carries no apply workflow and no token ([the token](platform/settings-apply.md#token)).

## Opting out

Leaving management is the only opt-out ([eject.md](eject.md#pause-instead-of-eject)); the rendered `.github/settings.yml` and the overlay stay either way, since the sync never deletes them.

# Tracking-issue streams

The [fuzzer](fuzzer.md) and [nightly](nightly.md) modules each keep one open GitHub issue per failure stream: a red night files or updates it, a green night closes it, and while it is open the stream [blocks releases](#release-gating). This page is the machinery the two modules share; the module pages cover what each starter runs.

## The action

Filing and closing come from the `fuzz-issue` composite action ([actions/fuzz-issue](../actions/fuzz-issue/action.yml); it serves any nightly stream), pinned at the green-gated `build` delivery branch like every other managed action. It needs `gh` on the runner: GitHub-hosted runners preinstall it, self-hosted runners must provide it.

Because the starters are repo-owned, template sync never re-renders them, so the `fuzz-issue` pin inside a starter stays whatever was last written. New renders pin `@build`; repos rendered when the pin was `@main` or the retired `@actions` had it ported in place by a one-run sync-side rewrite (`starter_pin_rollout.ts` - exact retired pins only; a hand-changed pin is left alone and listed as skipped). A breaking change to the action's inputs still needs a manual edit in each repo, announced loudly in the change's PR.

## The label is the stream

Each stream is identified by a label, set as a copier question (`fuzzer_label`, `nightly_label`) rather than a starter edit, because two more places must agree on it:

- The report and resolve steps: both dedup and auto-close by the label.
- The repository's settings labels: settings applies delete undeclared labels, and a tracking issue stripped of its label is invisible to both the dedup and the auto-close. The managed settings baseline declares the label automatically - repo-platform resolves the recorded answer at apply time, and an unreadable answer fails that repo's apply rather than guessing ([settings.md](settings.md)).

The question's validator (it runs on `copier update` too) enforces:

- No label name the fleet layers already manage (the settings baseline, the release labels, the dependabot labels; GitHub label names are case-insensitive). Reusing one would let a green night close unrelated issues carrying it and make every settings apply fight over the label's color and description.
- `nightly_label` must differ from `fuzzer_label` when both modules are selected: both streams dedup AND auto-close by label, so a shared label would let either stream's green night close the other's active failure issue.
- A repo whose recorded label later becomes reserved fails its next sync until the value in `.copier-answers.yml` changes (see [Renaming the label](#renaming-the-label)).

## Issue lifecycle

- One open issue per label. A failing night comments on the open issue if one exists, otherwise creates it - creating the label too when it is missing, with the color and description the module manifest declares (`tracking_label` in `templates/<module>/module.yml`, the same source the settings layer reads).
- A green night comments on and closes every open issue carrying the label, so hand-labeling an issue into the stream makes the next green night close it. To block a release deliberately, use the `release-blocker` label instead ([all-green.md](all-green.md)).
- A manual green dispatch also closes the issue; the close comment links the run, so the provenance is visible.
- The action assigns the repository owner at creation - issues created with `GITHUB_TOKEN` fire no `issues: opened` event, so the auto-assign module cannot catch them - and a comment on a still-unassigned open issue picks the owner up too. Assignment is best-effort (an org owner is not assignable) and never fails the filing; the dispatched auto-assign workflow (when that module is selected) still layers the CODEOWNERS policy on top.

## Release gating

With the release-please module also selected, an open tracking issue blocks releases twice over: the release PR's `release-health` CI job fails early and visibly, and the release pipeline's authoritative pre-flight blocks the cut itself. The rendered workflows pass every selected stream's label in the [release-health action's](../actions/release-health/action.yml) `tracking-labels` input, and the gate blocks while ANY issue carrying one of them is open. It self-scopes to release-cut pushes, so release-PR refreshes and ordinary main runs are never blocked.

To unblock:

- Fix the failure and let the next green night close the issue, or hand-close it once fixed. Closing re-triggers nothing: re-run the release PR's failed `release-health` job afterwards (the pre-flight reads issue state fresh at release time).
- To ship despite the open issue, apply the `release-override` label to the release PR: it waves through EVERY release-health gate at once, open Dependabot alerts and blocker issues included, turning all failures into loud warnings ([all-green.md](all-green.md)).

## Renaming the label

The starter is repo-owned while the label reaches settings from the recorded copier answer, read fresh on every apply. Renaming the answer therefore changes the label the NEXT settings apply declares (no sync needed) - but never the repo-owned workflow. The rename is one default-branch PR that:

1. edits the answer's value key in `.copier-answers.yml` (the sync loads recorded values from there; the underscore keys stay untouched)
2. updates the workflow's two `label:` inputs in the same change - or it keeps filing under the old name while the settings apply deletes it

## Deselecting the module

Deselecting removes the label declaration, but `_skip_if_exists` files are never deleted by sync: the workflow keeps running. When you drop the module, also delete its workflow file (`.github/workflows/nightly-fuzz.yml` or `nightly.yml`), or keep the label declared in your own settings if you keep the workflow.

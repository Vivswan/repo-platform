# The nightly module

Selecting the `nightly` module gives a repository a `nightly.yml` starter workflow: a nightly CI stream for the checks too slow (or too dependent on the outside world) to run on every PR, with automatic issue filing. Like the fuzzer module's starter, it is generated once and then repo-owned (`_skip_if_exists`): the checks are repo-specific, so the starter carries the shared machinery and leaves the check steps to you.

The starter is two jobs - `checks` (yours) and `report` (the machinery, `needs: [checks]` with `if: always()`). What the machinery does:

- runs on a nightly cron (06:59 UTC, overnight US-Eastern, offset from the fuzzer starter's 09:11 UTC) plus a bare `workflow_dispatch` for on-demand re-runs
- on a red night, files (or updates) a label-deduplicated tracking issue - a generic nightly-failure report naming the workflow, the date, the failing commit, and the run - then dispatches auto-assign at it (when that module is selected)
- on a green night, comments on and closes every open issue carrying the tracking label

Red means the checks job failed OR was cancelled - which is what a job hitting its `timeout-minutes` becomes, so a hang still counts as red. A human cancelling an in-flight run also counts as red and files an issue (the report job runs `if: always()` and cannot tell a timeout from a hand cancel). That trade is deliberate: a spurious issue the next green night closes beats a hang going silent.

The issue filing and closing come from the same `fuzz-issue` composite action the fuzzer module uses (`actions/fuzz-issue`; it serves any nightly stream), pinned at the green-gated `build` delivery branch. Because this stream passes no `artifacts-dir`, the action never looks for failure reports: the issue body always points at the run log. A stream that DOES write per-failure reports wants the fuzzer module's contract instead ([docs/fuzzer.md](fuzzer.md)).

## Module parameter (copier question)

| Question | Meaning | Default |
|---|---|---|
| `nightly_label` | Label identifying the tracking-issue stream; one open issue per label. A single label, no commas. | `nightly-failure` |

The label is a copier question, not a starter edit, because two more places must agree on it:

- The report and resolve steps: both dedup and auto-close by the label.
- The repository's settings labels: settings applies delete undeclared labels, and a tracking issue stripped of its label is invisible to both the dedup and the auto-close. The managed settings baseline declares it automatically - repo-platform resolves the recorded `nightly_label` answer at apply time, and an unreadable answer fails that repo's apply rather than guessing ([docs/settings.md](settings.md)).

The validator's rules:

- `nightly_label` must differ from `fuzzer_label` when the fuzzer module is also selected: both streams dedup AND auto-close by label, so a shared label would let either stream's green night close the other's active failure issue (and lift the release-health hold keyed on it).
- It also rejects any label name the fleet layers already manage (the baseline labels, the release labels, the toolchain dependabot labels). There is no separate settings preflight: the apply resolves the recorded answer itself and fails that repository's run rather than guessing.
- The validator runs on `copier update` too, so a repo whose recorded label later becomes reserved fails its next sync until the recorded `nightly_label` value in `.copier-answers.yml` is changed (and the starter's `label:` inputs with it, per the renaming section below).

## Customizing the starter

- Replace the placeholder in the `checks` job with the repository's own nightly checks. Until you do, the step is a green no-op that prints a warning; an uncustomized starter never files issues.
- Everything the managed ci.yml does NOT run per-PR is a candidate: for a repo like litellm, the existing nightly suite and docker test jobs move in as-is - port their setup and run steps into the `checks` job, or add them as sibling jobs and extend the `report` job's `needs` list and red/green conditions to fold in each result.
- The report job already runs `if: always()` and decides red or green from the `needs` results, so one green job cannot close an issue another job just filed.
- Keep sibling jobs unconditional: a sibling skipped by its own `if:` reports `result == 'skipped'`, which matches neither the red nor the green condition, and the report job silently does nothing that night. If a sibling must be conditional, fold its `skipped` state into one side explicitly.
- Because the file is repo-owned, template sync never re-renders it, so the `fuzz-issue` pin inside it stays whatever was last written. New renders pin `@build`; repos rendered when the pin was `@main` or the retired `@actions` had it ported in place by a one-run sync-side rewrite (`starter_pin_rollout.ts` - exact retired pins only, listed in the sync PR's transition note; a hand-changed pin is left alone and listed as skipped). A breaking change to the action's inputs still needs a manual edit here, announced loudly in the change's PR.

## Issue lifecycle

- One open issue per label. A failing night comments on the open issue if one exists, otherwise creates it (creating the label too when it is missing, with the same color/description the settings-sync fragment declares).
- A green night comments on and closes every open issue carrying the label, and the release gate blocks while ANY of them is open - so hand-labeling an issue into the stream makes the next green night close it; to block a release deliberately, use the `release-blocker` label instead ([docs/all-green.md](all-green.md)). When no issue is open, the resolve step does nothing.
- A manual green dispatch also closes the issue; the close comment links the run, so the provenance is visible.
- The action assigns the repository owner at creation - issues created with `GITHUB_TOKEN` fire no `issues: opened` event, so the auto-assign module cannot catch them - and a comment on a still-unassigned open issue picks the owner up too. Assignment is best-effort (an org owner is not assignable) and never fails the filing; the dispatched auto-assign workflow (when that module is selected) still layers the CODEOWNERS policy on top.

## Release gating

Like the fuzzer stream, the nightly tracking issue gates releases when the release-please module is also selected: while it is open, the release PR's `release-health` CI job fails early and visibly, and the release pipeline's authoritative pre-flight blocks the cut itself ([docs/all-green.md](all-green.md)).

Closing the issue lifts the block - the next green nightly run closes it automatically, or hand-close it once the failure is fixed - but closing re-triggers no check either way: the release PR goes green when you re-run its failed release-health job, or when the next push to main refreshes the release PR and its CI with it. To ship despite the open issue, apply the `release-override` label to the release PR - it waves through EVERY release-health gate at once, open Dependabot alerts and blocker issues included, turning all failures into loud warnings.

## Renaming the label, deselecting the module

The same two lifecycle edges as the fuzzer module, because the starter is repo-owned while the label reaches settings from the recorded answer, read fresh on every apply:

- Renaming `nightly_label` changes the label the NEXT settings apply declares (no sync needed) - but never the repo-owned `nightly.yml`. The rename is a default-branch PR editing the `nightly_label` value key in `.copier-answers.yml` (the sync loads recorded values from there; the underscore keys stay untouched). Update the workflow's two `label:` inputs in the same change, or it keeps filing under the old name while the settings apply deletes it.
- Deselecting the module removes the label declaration, but `_skip_if_exists` files are never deleted by sync: the nightly workflow keeps running. When you drop the module, also delete `.github/workflows/nightly.yml` (or keep the label declared in your settings if you keep the workflow).

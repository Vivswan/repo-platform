# The nightly module

Selecting the `nightly` module gives a repository a `nightly.yml` starter workflow ([the template](https://github.com/Vivswan/repo-platform/blob/main/templates/nightly/.github/workflows/nightly.yml.jinja)): a nightly CI stream for the checks too slow (or too dependent on the outside world) to run on every PR, with automatic [tracking-issue](tracking-issues.md) filing. Like the fuzzer starter it is generated once and then repo-owned (`_skip_if_exists`): the checks are repo-specific, so the starter carries the shared machinery and leaves the check steps to you.

The starter is two jobs - `checks` (yours) and `report` (the machinery, `needs: [checks]` with `if: always()`). It runs on a nightly cron (06:59 UTC, offset from the fuzzer starter's 09:11 UTC) plus a bare `workflow_dispatch`; a red night files or updates the tracking issue - a generic nightly-failure report naming the workflow, the date, the failing commit, and the run - and a green night closes it.

Red means the `checks` job failed OR was cancelled, which is what a job hitting its `timeout-minutes` becomes, so a hang still counts as red. A human cancelling an in-flight run files an issue too (the report job cannot tell a timeout from a hand cancel); that trade is deliberate, because a spurious issue the next green night closes beats a hang going silent.

This stream passes no `artifacts-dir`, so the [fuzz-issue action](tracking-issues.md#the-action) never looks for failure reports: the issue body always points at the run log. A stream that DOES write per-failure reports wants the fuzzer module's [failure-report contract](fuzzer.md#the-failure-report-contract-v1) instead.

## Module parameter (copier question)

| Question | Meaning | Default |
|---|---|---|
| `nightly_label` | Label identifying the tracking-issue stream; one open issue per label. A single label, no commas. | `nightly-failure` |

The label is a copier question rather than a starter edit; [Tracking issues: the label is the stream](tracking-issues.md#the-label-is-the-stream) has the reasoning, the reserved-name rules, and why `nightly_label` must differ from `fuzzer_label`.

## Customizing the starter

- Replace the placeholder in the `checks` job with the repository's own nightly checks. Until you do, the step is a green no-op that prints a warning; an uncustomized starter never files issues.
- Everything the managed ci.yml does NOT run per-PR is a candidate: port the setup and run steps into the `checks` job, or add them as sibling jobs and extend the `report` job's `needs` list and red/green conditions to fold in each result. The report job already decides red or green from the `needs` results, so one green job cannot close an issue another job just filed.
- Keep sibling jobs unconditional: a sibling skipped by its own `if:` reports `result == 'skipped'`, which matches neither the red nor the green condition, and the report job silently does nothing that night. If a sibling must be conditional, fold its `skipped` state into one side explicitly.

## Lifecycle, gating, renaming

Issue lifecycle, release gating, renaming `nightly_label`, and deselecting the module are shared machinery: [Tracking issues](tracking-issues.md).

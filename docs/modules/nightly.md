---
order: 140
---

# Nightly

Selecting the `nightly` module gives a repository a `nightly.yml` starter workflow ([the source](https://github.com/Vivswan/repo-platform/blob/main/files/nightly/.github/workflows/nightly.yml)): a nightly CI stream for the checks too slow (or too dependent on the outside world) to run on every PR, with automatic [tracking-issue](tracking-issues.md) filing. Issue lifecycle and release gating are shared machinery, owned by [Tracking issues](tracking-issues.md); renaming `labels.nightly` and deselecting the module are [the add-module skill's](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-add-module/SKILL.md#module-keys).

Like the fuzzer starter it is written once and then repo-owned: the checks are repo-specific, so the starter carries the shared machinery and leaves the check steps to you.

| Part of the starter | What it is |
|---|---|
| `checks` job | yours |
| `release-gate` job | calls the repo-owned release-gate.yml, the release acceptance tier ci.yml runs on the release PR ([its contract](../all-green.md#the-release-gate-hook-in-every-managed-repository)) |
| `report` job | the machinery: `needs: [checks, release-gate]` with `if: always()` |
| Triggers | a nightly cron (06:59 UTC, offset from the fuzzer starter's 09:11 UTC) plus a bare `workflow_dispatch` |

**What a night does:**

- **A red night** files or updates the tracking issue: a generic nightly-failure report naming the workflow, the date, the failing commit, and the run.
- **A green night** closes it.

**What red means:** the `checks` or `release-gate` job failed OR was cancelled. A job hitting its `timeout-minutes` becomes cancelled, so a hang still counts as red.

A human cancelling an in-flight run files an issue too, because the report job cannot tell a timeout from a hand cancel. That trade is deliberate: a spurious issue the next green night closes beats a hang going silent.

**No failure reports:** this stream passes no `artifacts-dir`, so the [fuzz-issue action](tracking-issues.md#the-action) never looks for failure reports: the issue body always points at the run log. A stream that DOES write per-failure reports wants the fuzzer module's [failure-report contract](fuzzer.md#the-failure-report-contract-v1) instead.

**The `labels.nightly` key** names the stream's label ([the registration reference](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-new-project/references/registration.md#keys) has the key and its default). Why it is a registration key rather than a starter edit alone, the reserved-name rules, and why it must differ from `labels.fuzzer` are [Tracking issues: the label is the stream](tracking-issues.md#the-label-is-the-stream).

## Customizing the starter

- **Replace the placeholder** in the `checks` job with the repository's own nightly checks. Until you do, the step is a green no-op that prints a warning; an uncustomized starter never files issues.

- **Moving real checks in,** as steps of `checks` or as sibling jobs the `report` job folds in, is [the add-module skill's worked example](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-add-module/references/worked-examples.md#adding-nightly-to-a-repo-that-already-has-fuzzer). A sibling that must be conditional folds its `skipped` state into one side of the report job's conditions explicitly, or the report job does nothing that night.

- **A nightly.yml seeded before the release-gate hook existed** adds the `release-gate` sibling job itself (`uses: ./.github/workflows/release-gate.yml`), lists it in the report job's `needs`, and folds its result into both conditions as the current starter spells them. A starter is never rewritten, so no sync brings it.

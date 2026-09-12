# Worked examples

One end-to-end module addition, with the checks that matter at each step.

## Adding `nightly` to a repo that already has `fuzzer`

Goal: the repo's slow suites move off the PR path into a nightly stream with automatic issue filing, next to the existing fuzz stream.

### Label distinctness first

Both streams dedup and auto-close their tracking issue by label, so the nightly label must differ from the fuzzer label (case-insensitively). The defaults already differ (`nightly-failure` vs `fuzz-nightly`); a custom label goes under `labels.nightly`.

### The edit

```bash
git checkout -b add-nightly
# .repo-platform.yml: add "nightly" to modules; a custom label only if wanted:
#   labels:
#     nightly: slow-suite-failure
git commit -am "chore: add the nightly module"
gh pr create
# the plan job validates the file; merge when green, then:
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f manual=true
```

### The sync PR

The run's job log ends `row 0: PR opened`. In the report:

- Written: `.github/workflows/nightly.yml` as `starter`, `created`; `.github/settings.yml` as `managed`, `updated`: the render gains the `nightly-failure` label (or your `labels.nightly`) from the registration. Every other row `unchanged`.
- Review: `Hold for review: no`; `manual=true` keeps it waiting for you.
- No edit of your own in `.github/settings.local.yml` is needed for the label: the registration key is its home, and the settings apply after the merge declares it.

### The starter, and moving real checks in

Two jobs: `checks` (yours; the placeholder is a green no-op that never files issues) and `report` (the machinery: `needs: [checks]`, `if: always()`, a cancelled checks job counts as red). Pick the repo's own cron minute.

- Port the slow suites' steps into `checks`, or add them as sibling jobs, list every one in `report`'s `needs`, and fold each result into the red/green conditions. Keep siblings unconditional: a job skipped by its own `if:` matches neither condition and the report does nothing that night.
- With a custom label, change the two `label:` inputs in the starter to match `labels.nightly`.

### Verify

- The first scheduled run is green, or files one issue carrying the label.
- The label exists on the repo: `gh label list -R Vivswan/<repo>`. It arrives with the first settings apply after the sync PR merges; before that, create it with `gh label create`.

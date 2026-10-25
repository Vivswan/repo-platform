# Worked examples

One end-to-end module addition, with the checks that matter at each step.

## Adding `nightly` to a repo that already has `fuzzer`

Goal: the repo's slow suites move off the PR path into a nightly stream with automatic issue filing, next to the existing fuzz stream.

**1. Label distinctness first.** The defaults already differ (`nightly-failure` vs `fuzz-nightly`); a custom label goes under `labels.nightly` and must differ from every other selected stream's label ([the rule](../../../docs/modules/tracking-issues.md#the-label-is-the-stream)).

**2. The edit.**

```bash
git checkout -b add-nightly
# .repo-platform.yml: add "nightly" to modules; a custom label only if wanted:
#   labels:
#     nightly: slow-suite-failure
git commit -am "chore: add the nightly module"
gh pr create
# fleet CI's plan step validates the file; validate-managed-files stays red until the files land, so:
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f branch=add-nightly
# (not the repo-platform:sync label: nightly.yml is a workflow file, which the repository token cannot push)
```

**3. The branch sync.**

The run's job log ends `row 0: branch pushed`, and one commit lands on `add-nightly`. In the report (the run's job summary, for a public repository):

- Written: `.github/workflows/nightly.yml` as `starter`, `created`; `.github/settings.yml` as `managed`, `updated`: the render gains the `nightly-failure` label (or your `labels.nightly`) from the registration. Every other row `unchanged`.
- Review: `Hold for review: no`.
- No edit of your own in `.github/settings.local.yml` is needed for the label: the registration key is its home, and the settings apply after the merge declares it.

The fleet PAT's push gives the PR an ordinary run (only a label push's run is held for approval); merge when green.

**4. The starter, and moving real checks in.**

Three jobs: `checks` (yours; the placeholder is a green no-op that never files issues), `release-gate` (calls the repo-owned `release-gate.yml`, the release acceptance tier), and `report` (the machinery: `needs: [checks, release-gate]`, `if: always()`, a cancelled job counts as red). Pick the repo's own cron minute.

- Port the slow suites' steps into `checks`, or add them as sibling jobs, list every one in `report`'s `needs`, and fold each result into the red/green conditions. Keep siblings unconditional: a job skipped by its own `if:` matches neither condition and the report does nothing that night.
- With a custom label, change the two `label:` inputs in the starter to match `labels.nightly`.

**5. Verify.**

- The first scheduled run is green, or files one issue carrying the label.
- The label exists on the repo: `gh label list -R Vivswan/<repo>`. It arrives with the first settings apply after the sync PR merges; before that, create it with `gh label create`.

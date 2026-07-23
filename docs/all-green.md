# The all-green convention

Every managed repository's `.github/workflows/ci.yml` defines a single
aggregate job named `all-green` that `needs:` every other job in the
workflow. Branch protection (via `.github/settings.yml`) requires exactly one
status check: `all-green`. The required-checks list never changes when CI
jobs are added, renamed, or turned into matrices.

The template generates ci.yml with this shape and keeps managing it: sync
updates the standard jobs and the gate. Repo-specific jobs live in the
repo-owned `.github/workflows/checks.yml` (`_skip_if_exists`), which the
managed ci.yml calls inside the gate through its `checks` job. all-green
sees only that job's aggregate result, so the skipped-is-failure rule below
does not reach inside checks.yml: keep its jobs free of job-level `if:`
skips (exit successfully with a message instead), and put checks that need
secrets or more than the caller's `contents: read` permissions in their own
workflow.

## Canonical job

```yaml
  all-green:
    name: all-green
    if: always()
    needs: [typography, actionlint, yamllint, commit-names, test]  # every other job
    runs-on: ubuntu-latest
    steps:
      - name: All jobs green
        env:
          RESULTS: ${{ join(needs.*.result, ' ') }}
        run: |
          echo "results: $RESULTS"
          for result in $RESULTS; do
            if [ "$result" != "success" ]; then
              echo "::error::a required job did not succeed"
              exit 1
            fi
          done
```

Notes:

- `if: always()` makes all-green run (and fail) even when a dependency
  failed or was skipped. Without it a failed dependency leaves all-green
  skipped, and a skipped check does not block the merge.
- The strict `join(needs.*.result)` gate treats `skipped` as failure. If a
  job may legitimately skip, make it exit successfully with a message
  instead of using a job-level `if:`.
- Jobs that must run only after CI passes should `needs: all-green`; the
  validator exempts them from the needs-list check. The release-please module
  ships one: a thin ci.yml `release` job gated this way that calls the
  repo-owned release.yml pipeline (which runs the managed release-please.yml
  machinery plus any repo pre/post-release jobs), so a release only ever
  happens once the whole gate is green on main.
- `Vivswan/repo-platform/actions/validate-template` enforces this shape:
  all-green must exist and `needs:` every other job, and a `typography` job
  must exist.

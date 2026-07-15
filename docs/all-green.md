# The all-green convention

Every managed repository's `.github/workflows/ci.yml` defines a single
aggregate job named `all-green` that `needs:` every other job in the
workflow. Branch protection (via `.github/settings.yml`) requires exactly one
status check: `all-green`. The required-checks list never changes when CI
jobs are added, renamed, or turned into matrices.

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
- Jobs that must run only after CI passes (e.g. release-please) should
  `needs: all-green`; the validator exempts them from the needs-list check.
- `Vivswan/repo-platform/actions/validate-template` enforces this shape:
  all-green must exist and `needs:` every other job, and a `typography` job
  must exist.

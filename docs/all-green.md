# The all-green convention

Every managed repository's `.github/workflows/ci.yml` defines a single
aggregate job named `all-green` that `needs:` every gating job in the
workflow (release jobs run on top of the gate instead - see the notes).
Branch protection (applied from the repo's settings home, central
or in-repo - see docs/settings.md) requires exactly one status check:
`all-green`. The required-checks list never changes when CI jobs are added,
renamed, or turned into matrices.

The template generates ci.yml with this shape and keeps managing it: sync
updates the standard jobs and the gate. Module checks run inside the gate
too: the pr-title module contributes a `pr-title` job (Conventional Commit
title check), and public repos with a toolchain get per-language `codeql-*`
jobs calling the reusable CodeQL analysis - so branch protection blocks on
both without any extra required checks. Repo-specific jobs live in the
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
  job may legitimately skip, keep the job itself unconditional and put the
  `if:` on its steps: a job whose steps all skip still counts as `success`.
  The managed `pr-title` job works this way - ci.yml also runs on push,
  dispatch, and (with CodeQL) schedule events, so its validation step
  carries `if: github.event_name == 'pull_request'` instead of a job-level
  skip. In the repo-owned checks.yml, exit successfully with a message
  instead.
- A job that calls a reusable workflow gates on every job in it: the managed
  `codeql-javascript` / `codeql-python` jobs each call repo-platform's
  reusable CodeQL analysis, and all-green sees each call's result. The
  caller job grants the permissions the scan needs (`security-events:
  write`); a caller job's permissions are the ceiling for the called
  workflow.
- Jobs that must run only after CI passes should `needs: all-green`; the
  validator exempts them from the needs-list check. The release-please module
  ships one: a thin ci.yml `release` job gated this way that calls the
  repo-owned release.yml pipeline (which runs the managed release-please.yml
  machinery plus any repo pre/post-release jobs), so a release only ever
  happens once the whole gate is green on main.
- One job is informational by design: `validate-template` runs in every
  managed repo's ci.yml but is deliberately NOT in all-green's needs. A red
  run flags template-convention drift without blocking the repo's merges;
  the next sync PR heals the drift.
- `Vivswan/repo-platform/actions/validate-template` enforces this shape:
  all-green must exist and `needs:` every gating job (downstream and
  informational jobs exempt), and a `typography` job must exist.

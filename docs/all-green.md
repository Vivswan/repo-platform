# The all-green convention

Every repository in the fleet - repo-platform included - gates merges on a required status check named `all-green`. It is the check run of an ordinary CI JOB: ci.yml's `all-green` job needs every gating job, runs on `if: always()`, and judges the results through one shared composite action (`actions/all-green`, pinned `@build` by rendered repos, called by local path here).

```yaml
all-green:
  needs: [checks, ci]        # every gating job (repo-platform lists ~20)
  if: always()               # a failed dependency must FAIL the gate, not skip it
  steps:
    - uses: Vivswan/repo-platform/actions/all-green@build
      with:
        needs: ${{ toJSON(needs) }}
```

The judgment, whole: every needed result must be `success` or `skipped` (a module- or visibility-conditioned job stands down by skipping), with at least one `success` - an all-skipped or empty run vouches for nothing. Anything else (`failure`, `cancelled`) fails the gate.

## Quick triage: why is my PR red or waiting?

| Symptom | Cause | Fix |
| --- | --- | --- |
| `all-green` failed naming a job | That job's result was not success/skipped | Open the run, fix or re-run the failed job - the re-run re-judges. |
| `all-green` shows "Expected" and never arrives | The CI run was cancelled or superseded before the gate ran | Push again or re-run the newest CI run at the head. |
| `all-green` failed with "no gating job actually succeeded" | Everything the gate needs skipped | A run that verified nothing must not merge; check why the callers skipped. |
| `pr-title` waiting (repos with the pr-title module) | Its own required check, outside this gate | See docs/settings.md - the pr-title workflow re-runs on open/edit/reopen/push. |

## What gates what

- A managed repository's ci.yml carries three managed jobs: `checks` (calls the repo-owned checks.yml), `ci` (calls fleet-ci.yml@build with the module selection), and `all-green` needing both. THE MEMBERSHIP RULE: what gates a managed repository is being a job in fleet-ci.yml or checks.yml - the caller jobs' results aggregate every job of the workflows they call.
- Inside fleet-ci.yml, module- and visibility-conditioned jobs carry job-level `if:` and skip when they do not apply; a skipped job leaves the called run green. Repo-platform's own ci.yml has no callers to hide behind: its gating jobs are the needs list itself.
- A job that FAILS anywhere in a called workflow fails its caller and so the gate. The retired `info-*` opt-out died with the verdict: a repo-owned advisory check now opts out with `continue-on-error: true` on its job in checks.yml.
- Downstream of the gate, in the same run: repo-platform's `post-green` job (the build publish) and, on release-please repos, the `release` leg - `needs: [all-green]`, released only by `needs.all-green.result == 'success'` on a push to main, holding the `post-green-release` lane and passing `github.sha` (same-run, so it IS the judged commit) into release.yml, whose head gate skips when main has moved on.

## The rosters (how a deleted gate stays loud)

The run-time gate judges only what its `needs` list names, so a job deleted from ci.yml AND from the needs list would stop gating silently. Authored rosters in `scripts/check_ssot.ts` close that at authoring time:

| Roster | What it pins | The rule |
| --- | --- | --- |
| `ALL_GREEN_ROSTER` | repo-platform's ci.yml: the gating job set, the all-green job's needs list, and the roster held together in every direction; `if:`/`name:` banned on gating jobs; the gate's `if: always()`, its action step, and the toJSON(needs) wiring. | `all-green-roster` |
| `FLEET_CI_ROSTER` | fleet-ci.yml's job set, both directions - deleting `dependency-review` or `codeql` there would drop the gate for every managed repository at once. | `fleet-ci-roster` |
| (template pins) | The rendered ci.yml's shape at the source: exactly the `checks`/`ci`/`all-green` jobs, the gate's exact needs/always()/action lines, and the release leg's condition block, judged-sha pass, and concurrency lane. | `fleet-ci-render-roster` |

The check NAME is pinned once as data by the `all-green-name` rule: the ruleset's required context (`.github/settings-override.yml`, Actions-pinned via integration_id 15368), the `all-green` job id at both sources, the green gates' lookup (`shared/all_green.ts` CHECK_NAME), and the name this document quotes must all be the same `all-green`, provably, at authoring time.

## Consuming the gate

Anything that asks "is this commit green" reads the CHECK RUN, never the CI run's conclusion (a run whose gating job was skipped still concludes success). `shared/all_green.ts` is the one implementation, shared by the build publisher and the sync's stamped-source gate:

- It lists the sha's `all-green` check runs by name (`filter=latest`), accepts only github-actions-app checks, and passes on any completed success. Checks posted by the RETIRED verdict workflow and the pre-inversion aggregate job satisfy the same read, so history stays green; the verdict era's `external_id` event blocklist still rejects its pull_request verdicts.
- Consumers that wake on their own (the schedule/dispatch build self-heal, the sync) can race a fresh check, so the read polls briefly under `ALL_GREEN_WAIT_MS` before failing closed. The unwedge for a missing check is re-running the sha's CI run - the gate job posts the check; no dispatchable verdict exists any more.
- publish.ts re-verifies the check at the source commit before any mutation: the same-run needs edge guards entry, the in-code gate guards the world the leg reads.

## Post-green: what runs after the gate

`post-green.yml` (workflow_call only) is the home for everything that runs after green on a main push; ci.yml's `post-green` job - `needs: [all-green]`, gated on the spelled-out result plus push-to-main - is the sole caller, passing `sha: github.sha` (same-run, the judged commit by construction; the old workflow_run staleness hazard is gone). Its publish job holds the repo-scoped `build-branches-publish` lane it shares by name with Build Branches' self-heal legs; the caller holds no lane at all (a caller must never hold the resource its called workflow requires). Every leg there must stay STATE-shaped - the file's header has the coalescing contract.

## Residuals, stated

- A PR can still gut a called workflow's content (checks.yml is repo-owned) or hand-condition the managed `ci` caller away; the sync-time validator errors on a conditioned caller and integrity validate-template blocks managed-file edits, and review owns the rest - the same same-repo residual every check has.
- Any workflow in this repository could mint a look-alike `all-green` check run (the Actions app pin does not distinguish jobs). The repo is its own sole workflow author; the roster rules and review own that surface.
- Copilot code review is ADVISORY now: the `copilot_code_review` settings rule still requests a review on every public-repo PR, but nothing blocks on it - the verdict machinery that owed it is retired.

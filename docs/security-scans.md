---
order: 225
group: Fleet operations
---

# Security scans

Every managed repository is scanned by [Trivy](https://trivy.dev) through fleet-ci.yml, with zero Trivy files in the repository: the configuration lives in the [trivy action](../actions/trivy/action.yml), and the jobs live in [fleet-ci.yml](../.github/workflows/fleet-ci.yml). Two halves:

| Half | fleet-ci job | Runs on | Scans | Blocking? | Findings go to |
|---|---|---|---|---|---|
| Blocking | `trivy` | every push and pull request | lockfiles, Dockerfiles, infrastructure files (`vuln,misconfig` scanners), CRITICAL severity, fixable only | yes: the job fails, so `all-green` fails | the job log |
| Nightly | `trivy-nightly` | the `schedule` trigger | the same plus secrets, every severity | no: the job is green whatever it finds | one `security-nightly` tracking issue per repository, plus code scanning (public repositories) |

## The blocking half

- The gate is `trivy fs .` with `--severity CRITICAL --ignore-unfixed --exit-code 1`. A vulnerability blocks only when the advisory is CRITICAL and a fixed version exists, so its fix is a dependency bump; `--ignore-unfixed` filters vulnerabilities only, so a CRITICAL misconfiguration (a Dockerfile, an infrastructure file) blocks too, and its fix is the file or a bypass entry.
- Unfixed CRITICAL vulnerabilities and everything HIGH or below never block; they surface in the nightly issue.
- The same job runs in repo-platform's own CI (`trivy` in [ci.yml](../.github/workflows/ci.yml), a gating job), so a lockfile here is held to the same bar.

## Bypassing a finding: `.trivyignore.yaml`

A repository silences a finding only through Trivy's own YAML ignore file at its root. Every entry MUST carry a `statement` (why the risk is accepted) and an `expired_at` date; Trivy drops an entry once the date passes, so a bypass undoes itself and the finding blocks again. The action fails the job when the file exists with an entry lacking either field, and refuses the plain `.trivyignore` format outright (it has no expiry).

```yaml
vulnerabilities:
  - id: CVE-2026-65898
    paths:
      - actions/pages-site/bun.lock
    statement: dompurify only ever sanitizes markdown this repository authored
    expired_at: 2026-12-01
misconfigurations:
  - id: DS-0002
    statement: the image is a build tool, never served
    expired_at: 2027-01-15
```

- Sections: `vulnerabilities`, `misconfigurations`, `secrets`, `licenses`. Entry keys: `id`, `paths`, `purls`, `statement`, `expired_at` (the [Trivy filtering reference](https://trivy.dev/latest/docs/configuration/filtering/) has the semantics).
- An expired entry is a warning, not a failure: Trivy already ignores it, so fix the finding or delete the entry. The zero date `0001-01-01` is a failure: Trivy's expiry prune skips it, so that entry would never expire.
- The file also applies to the nightly scan: a bypassed finding stays out of the tracking issue until its date passes. Each report's replay command passes the file too, so the replay sees what the scan saw (Trivy skips a missing ignore file).

## The nightly half

- Trigger: the managed ci.yml's `schedule` event, on which fleet-ci runs `trivy-nightly` in place of `trivy`. The cron's cadence, and which other jobs stand down on it, belong to the skeleton ci.yml and fleet-ci's per-job conditions, not to the scan.
- Findings: the action writes one report per scanned target in the [fuzz-issue action's](../actions/fuzz-issue/action.yml) report-directory contract ([fuzzer.md](fuzzer.md#the-failure-report-contract-v1)), and the job files or updates the one open issue labeled `security-nightly`; a clean night closes it ([tracking-issues.md](tracking-issues.md)). The full JSON rides the run's artifact.
- Code scanning: the SARIF is uploaded under the `trivy` category when the repository is public (personal-account code scanning is public-only).
- Release gating: `security-nightly` is fleet data, not a module answer. The [settings baseline](../.github/settings-baseline.yml) declares the label on every repository, [actions/plan](../actions/plan/plan.ts) appends it to every repository's `tracking-labels`, and `release-health` refuses to release while the issue is open ([tracking-issues.md](tracking-issues.md#release-gating)).

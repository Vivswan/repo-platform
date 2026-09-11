---
order: 225
group: Fleet operations
---

# Security scans

Every managed repository is scanned by [Trivy](https://trivy.dev) through the skeleton ci.yml's fleet callers, with zero Trivy files in the repository (public repositories also run [semgrep](#semgrep)): the configuration lives in the [trivy action](../actions/trivy/action.yml), the blocking job in [fleet-ci.yml](../.github/workflows/fleet-ci.yml), and the nightly job in [fleet-nightly.yml](../.github/workflows/fleet-nightly.yml). Two halves:

| Half | Job | Runs on | Scans | Blocking? | Findings go to |
|---|---|---|---|---|---|
| Blocking | `trivy` in fleet-ci.yml | every push and pull request | lockfiles, Dockerfiles, infrastructure files (`vuln,misconfig` scanners), HIGH and CRITICAL severity; fixable vulnerabilities only, every misconfiguration | yes: the job fails, so `all-green` fails | the job log |
| Nightly | `trivy-nightly` in fleet-nightly.yml | the `schedule` trigger | the same plus secrets, HIGH and CRITICAL severity | no: the job is green whatever it finds | one `security-nightly` tracking issue per repository, plus code scanning (public repositories) |

## The blocking half

- The gate is `trivy fs .` with `--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1`. A vulnerability blocks only when the advisory is HIGH or CRITICAL and a fixed version exists, so its fix is a dependency bump; `--ignore-unfixed` filters vulnerabilities only, so a HIGH or CRITICAL misconfiguration (a Dockerfile, an infrastructure file) blocks too, and its fix is the file or a bypass entry.
- Unfixed HIGH and CRITICAL vulnerabilities never block; they surface in the nightly issue. MEDIUM and below neither block nor surface: both scans run at `--severity HIGH,CRITICAL`.
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

- Trigger: the managed ci.yml's `schedule` event, on which its `nightly` job calls fleet-nightly.yml and fleet-ci's `trivy` stands down. The nightly job lives in its own reusable workflow because it files an issue: `issues: write` exceeds the `ci` caller's permission ceiling, and GitHub checks a called job's grant before its condition runs, so a job asking for more inside fleet-ci.yml would fail every fleet run. The `nightly` caller carries exactly the scan's grant and is not in all-green's needs. The cron's cadence, and which other jobs stand down on it, belong to the skeleton ci.yml and the per-job conditions, not to the scan.
- Findings: the action writes one report per scanned target in the [fuzz-issue action's](../actions/fuzz-issue/action.yml) report-directory contract ([fuzzer.md](fuzzer.md#the-failure-report-contract-v1)), and the job files or updates the one open issue labeled `security-nightly`; a clean night closes it ([tracking-issues.md](tracking-issues.md)). The full JSON rides the run's artifact.
- Code scanning: the SARIF is uploaded under the `trivy` category when the repository is public (personal-account code scanning is public-only).
- Release gating: `security-nightly` is fleet data, not a module answer. The [settings baseline](../files/settings/baseline.yml) declares the label on every repository, [actions/plan](../actions/plan/plan.ts) appends it to every repository's `tracking-labels`, and `release-health` refuses to release while the issue is open ([tracking-issues.md](tracking-issues.md#release-gating)).

## Semgrep

Public repositories also run [semgrep](https://semgrep.dev) as fleet-ci.yml's `semgrep` job, through the [semgrep action](../actions/semgrep/action.yml): the registry needs no token, but code scanning needs a public repository.

- Rules: the registry's `p/default` set at `--severity ERROR`, with two rules excluded:

| Excluded rule | Why | Until |
|---|---|---|
| `github-actions-mutable-action-tag` | zizmor's `unpinned-uses` owns action pinning: one tool per finding class | permanent |
| `secrets-inherit` | managed repositories still run the old ci.yml and release.yml, whose `secrets: inherit` lines carry no marker, so the rule would fail every fleet repository; the writer's ci.yml marks each of its three lines with its reason (the called workflows are the repository's own) | the fleet cutover, once the writer has replaced them |

- Verdict: a scan that did not exit 0 fails first, naming its exit status, because there is no verdict without a completed scan. Then the JSON copy is judged: ERROR findings and fatal analysis errors fail the job; partial parses and timeouts only annotate. WARNING and INFO rules do not run, so their findings appear nowhere, neither in the verdict nor in code scanning.
- Bypass: semgrep's own marker on the finding's line or the line above it, `// nosemgrep: <rule-id>` (`# nosemgrep: <rule-id>` in YAML), with the reason beside it. The marker applies to an ERROR finding; whether to mark one is the repository's own call.
- Upload: unmarked ERROR findings go to code scanning as SARIF under the `semgrep` category, and marked ones do not. A marked finding stays in semgrep's SARIF as a suppressed result, and code scanning ignores the suppressions field and would show it as an open alert, so the action drops suppressed results from the SARIF before the upload. A scan that wrote no SARIF leaves nothing to filter, and the upload fails on the missing file. An earlier upload may have opened lower-severity alerts; code scanning marks them fixed once a later upload for the same category and branch lacks them.

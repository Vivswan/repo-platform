---
order: 225
---

# Security scans

This page covers the fleet's Trivy and semgrep scans; every other check fleet.yml runs has its row in [fleet-guidelines.md](../fleet-guidelines.md#how-to-bypass-a-check).

Every managed repository is scanned by [Trivy](https://trivy.dev) on every push and pull request, through the skeleton ci.yml's `platform` call, with zero Trivy files in the repository (public repositories also run [semgrep](#semgrep)). The configuration lives in the [trivy action](../../actions/trivy/action.yml), and the scan is the `trivy` step of [fleet.yml](../../.github/workflows/fleet.yml)'s `standard-checks` job.

## The Trivy scan

- **Advisory:** a finding is one `warning` annotation on its target, naming the id, the package and its fix, and the advisory link. The step stays green; a scan error is its one red.

- **The scan** is `trivy fs .` with `--scanners vuln,misconfig --severity HIGH,CRITICAL --ignore-unfixed --exit-code 0` over lockfiles, Dockerfiles, and infrastructure files. A vulnerability surfaces only when the advisory is HIGH or CRITICAL and a fixed version exists, so its fix is a dependency bump.

- **Misconfigurations surface too:** `--ignore-unfixed` filters vulnerabilities only, so a HIGH or CRITICAL misconfiguration (a Dockerfile, an infrastructure file) is annotated too, and its fix is the file.

- **What appears nowhere:** a MEDIUM or LOW finding, and an unfixed HIGH or CRITICAL vulnerability.

- **No bypass:** the exit code and the ignore file are explicit, which Trivy otherwise reads from the repository: a `trivy.yaml` cannot turn a finding red, and a `.trivyignore` or `.trivyignore.yaml` is not read, since the ignore file is `/dev/null`.

- **Where the findings go:** the step's annotations and log, nowhere else; Trivy uploads nothing to code scanning and files no issue.

- **The same scan runs in repo-platform's own CI** (`trivy` in [ci.yml](../../.github/workflows/ci.yml)), so a lockfile here gets the same annotations.

## Semgrep

Public repositories also run [semgrep](https://semgrep.dev) as fleet.yml's `semgrep` job, through the [semgrep action](../../actions/semgrep/action.yml): the registry needs no token, but code scanning needs a public repository.

- **Rules:** the registry's `p/default` set at `--severity ERROR`, with one rule excluded permanently: `github-actions-mutable-action-tag`, because zizmor's `unpinned-uses` owns action pinning (one tool per finding class).

**Verdict:** semgrep's own exit code, through two of its flags.

| Flag               | What it carries                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `--severity ERROR` | only ERROR rules run, so WARNING and INFO findings appear nowhere, neither in the verdict nor in code scanning |
| `--error`          | exit 1 on a finding, so the scan step fails the job; a scan that failed exits 2 or higher and fails it too     |

Partial parses and timeouts are warn-level: semgrep's summary names them in the step log, and the step stays green. One gap, reported upstream as [semgrep/semgrep#11960](https://github.com/semgrep/semgrep/issues/11960) and not guarded here: the exit reads the last structured error alone, so a scan with no findings whose error-level scan error is followed by a warn-level one exits 0.

- **Bypass:** semgrep's own marker on the finding's line or the line above it, `// nosemgrep: <rule-id>` (`# nosemgrep: <rule-id>` in YAML), with the reason beside it. The marker applies to an ERROR finding; whether to mark one is the repository's own call.

- **Bypass in a Dockerfile:** an instruction takes no trailing comment, so the marker is a `# nosemgrep: <rule-id>` line directly above the instruction, nothing between them.

- **Upload:** unmarked ERROR findings go to code scanning as SARIF under the `semgrep` category, and marked ones do not. A marked finding stays in semgrep's SARIF as a suppressed result, and code scanning reads no `suppressions` property ([its SARIF support](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning)) and would show it as an open alert, so the action drops suppressed results from the SARIF before the upload.

- **Upload edge cases:** a scan that wrote no SARIF leaves nothing to filter, and the upload fails on the missing file. An earlier upload may have opened lower-severity alerts; code scanning marks them fixed once a later upload for the same category and branch lacks them.

- **Merge gate:** the `main` ruleset's `code_scanning` rule lists CodeQL alone, at the same high-or-critical bar (`alerts_threshold: errors`, `security_alerts_threshold: high_or_higher`, [settings.md](../settings.md)), so a semgrep alert blocks through this job's verdict, never through the ruleset.

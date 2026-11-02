---
order: 225
---

# Security scans

This page covers what the fleet's two code-security scans cannot say for themselves. Each scan's behavior, severities, and bypass are its action's description ([trivy](../../actions/trivy/action.yml), [semgrep](../../actions/semgrep/action.yml)); every other check's bypass is its action description's, under the rule in [fleet-guidelines.md](../fleet-guidelines.md#how-to-bypass-a-check).

| Scan    | Runs                                                                     |
| ------- | ------------------------------------------------------------------------ |
| Trivy   | the `trivy` step of fleet.yml's `standard-checks` job, every repository  |
| semgrep | fleet.yml's `semgrep` job, public repositories (code scanning needs one) |

## Semgrep

- **One upstream gap,** reported as [semgrep/semgrep#11960](https://github.com/semgrep/semgrep/issues/11960) and not guarded here: the exit reads the last structured error alone, so a scan with no findings whose error-level scan error is followed by a warn-level one exits 0.

- **Merge gate:** the `main` ruleset's `code_scanning` rule lists CodeQL alone ([settings.md](../settings.md)), so a semgrep alert blocks through this job's verdict, never through the ruleset.

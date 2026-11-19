---
order: 170
---

# TypeScript

Selecting the `bun` module gives a repository the fleet's TypeScript lint floor as a managed `biome.json` ([the source](https://github.com/Vivswan/repo-platform/blob/main/files/bun/biome.json)), a repo-owned `biome.local.jsonc` to build on it ([the starter](https://github.com/Vivswan/repo-platform/blob/main/files/bun/biome.local.jsonc)), and two fleet steps: `biome` ([the action](../../actions/biome/action.yml)), the gate, and `member-shape` ([the action](../../actions/check-member-shape/action.yml)), advisory. The files say what they hold; this page says how the two layers combine and what a repository may do underneath.

## The two layers

Biome merges `extends` left to right and applies the extending file last. Measured under the shipped pair:

| `biome.local.jsonc` carries                    | Result                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `linter.enabled: false`                        | nothing changes: the managed `enabled: true` applies last                                                      |
| a floor rule's threshold (`useMaxParams` at 3) | overwritten by the managed file's: the floor's thresholds are fixed both ways                                  |
| an additional rule, a preset, a plugin         | applies beneath the floor                                                                                      |
| the formatter, `vcs`, exclusions               | stand: the managed file's one formatter entry keeps the sync's generated files and every `LICENSE.md` verbatim |
| a per-path `overrides` entry                   | honored for its paths, the one relaxation                                                                      |

## Building on the floor

- **The three thresholds warn** (`noExcessiveCognitiveComplexity`, `noExcessiveLinesPerFunction`, `useMaxParams`) because a threshold is a hint about readability, and a forced split can read worse. A known case stays visible as a warning, or goes quiet under a per-path `overrides` entry with its reason beside it.
- **A finding is split, or folded:** two nameable concepts become named steps; a step called from one place that is no concept of its own folds back into its caller.
- **The `fix-lint` label commits what biome can fix,** with the [autofix](autofix.md) module: the repository's autofix hook runs its own biome script. biome exits non-zero on a finding with no safe fix, after writing the rest, so the hook swallows that exit and reports it as `findings`; the finding stays for the `biome` gate to report.
- **A repository that already has a `biome.jsonc`:** move its content into `biome.local.jsonc` and delete it. Biome reads `biome.json` and silently ignores a `biome.jsonc` beside it, so the old file would be dead configuration.
- **A repository that already has a `biome.json`:** the sync replaces it and reports the diff under Replaced local edits; its content moves into `biome.local.jsonc` the same way.
- **The `knip` step's verdict, locally:** the fleet runs the knip version pinned in [the action's manifest](../../actions/knip/package.json), as `knip --treat-config-hints-as-errors` ([the action](../../actions/knip/action.yml)), under bun, so a stale `ignore` entry fails the step. A repository's own `knip` script runs the same flag on the same version (`bun node_modules/.bin/knip` for the same runtime); another version, or no flag, can pass locally and fail the step.

## The member-shape rules

The [action's description](../../actions/check-member-shape/action.yml) states the rules and the bypass. What it cannot say: `.astro` frontmatter is outside the check today.

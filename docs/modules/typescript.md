---
order: 170
---

# TypeScript

Selecting the `bun` module gives a repository the fleet's TypeScript lint floor as a managed `biome.json` ([the source](https://github.com/Vivswan/repo-platform/blob/main/files/bun/biome.json)), a repo-owned `biome.local.jsonc` to build on it ([the starter](https://github.com/Vivswan/repo-platform/blob/main/files/bun/biome.local.jsonc)), and two fleet steps: `biome` ([the action](../../actions/biome/action.yml)), the gate, and `member-shape` ([the action](../../actions/check-member-shape/action.yml)), advisory. The files say what they hold; this page says how the two layers combine and what a repository may do underneath.

## The two layers

Biome merges `extends` left to right and applies the extending file last. Measured at biome 2.5.11 under the shipped pair:

| `biome.local.jsonc` carries | Result |
| --- | --- |
| `linter.enabled: false` | nothing changes: the managed `enabled: true` applies last |
| a floor rule's threshold (`useMaxParams` at 3) | overwritten by the managed file's: the floor's thresholds are fixed both ways |
| an additional rule, a preset, a plugin | applies beneath the floor |
| the formatter, `vcs`, exclusions | stand: the managed file carries none of those blocks |
| a per-path `overrides` entry | honored for its paths, the one relaxation |

## Building on the floor

- **The three thresholds warn** (`noExcessiveCognitiveComplexity`, `noExcessiveLinesPerFunction`, `useMaxParams`): a threshold is a hint about readability, and a forced split can read worse, so `biome lint` exits 0 on them alone. The mechanical rules keep blocking. A known case stays visible as a warning, or goes quiet under a per-path `overrides` entry with its reason beside it.
- **A finding is split, or folded:** two nameable concepts become named steps; a step called from one place that is no concept of its own folds back into its caller.
- **A repository that already has a `biome.jsonc`:** move its content into `biome.local.jsonc` and delete it. Biome reads `biome.json` and silently ignores a `biome.jsonc` beside it, so the old file would be dead configuration.
- **A repository that already has a `biome.json`:** the sync replaces it and reports the diff under Replaced local edits; its content moves into `biome.local.jsonc` the same way.

## The member-shape rules

The action's description states the four rules, the methods exemption, the `.member-shape-allow.local` bypass, and that the check is advisory: a finding is a warning annotation, never a red job. What it cannot say: `.astro` frontmatter is outside the check today.

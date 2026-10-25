---
order: 170
---

# TypeScript

Selecting the `bun` module gives a repository the fleet's TypeScript lint floor as a managed `biome.json` ([the source](https://github.com/Vivswan/repo-platform/blob/main/files/bun/biome.json)), a repo-owned `biome.local.jsonc` to build on it, and the two fleet steps that make the floor a gate: `biome` and `member-shape`. This page is the floor's contract.

## The two files

| File | Class | Holds |
| --- | --- | --- |
| `biome.json` | managed, rewritten every sync | the floor below, `linter.enabled: true`, `extends: ["./biome.local.jsonc"]`, and one override turning the formatter and the assist actions off for `biome.json` itself; no `files`, `vcs`, or `formatter` block |
| `biome.local.jsonc` | starter, written once, then yours | exclusions, `vcs`, the formatter, extra rules, plugins, and per-path `overrides` with their reasons |

Biome merges `extends` left to right and applies the extending file last. The managed file extends the local one, so on a conflict the floor wins and the local layer's additions apply beneath it. A local `linter.enabled: false` or a rule turned off at the top level changes nothing.

## The floor

Every rule is `error`. The thresholds are the [code-standards TypeScript page](https://github.com/Vivswan/skills/blob/main/skills/code-standards/references/languages/typescript.md)'s, and a tighter one is a defect there too.

| Rule | What it refuses |
| --- | --- |
| `complexity/noExcessiveCognitiveComplexity`, 15 | a function too branched to read as a list of steps |
| `complexity/noExcessiveLinesPerFunction`, 80 lines | a function holding more than one concept |
| `complexity/useMaxParams`, 6 | a signature wanting an options object |
| `style/noNestedTernary` | `a ? b : c ? d : e` |
| `style/noUselessElse` | a guard's body wrapped in `else` |
| `style/noNegationElse` | an `if (!x) {...} else {...}` read backwards |
| `style/noParameterAssign` | a function assigning to its own parameter |
| `suspicious/noAssignInExpressions` | `if ((n = rows.length) > 3)` |
| `suspicious/noUnusedExpressions` | `ok && doThing()` as control flow |
| `performance/noBarrelFile`, `performance/noReExportAll` | a module whose job is re-exporting other modules (an `index.ts` of `export { x } from` lines), an `export * from` shim |
| `correctness/noInvalidUseBeforeDeclaration` | a value read above its declaration |

## Building on the floor

The local layer adds; it never loosens. What goes where:

| You want | Where it goes |
| --- | --- |
| an additional rule, a preset, a plugin | `linter.rules` or `plugins` in `biome.local.jsonc`; a floor rule's threshold set there (`useMaxParams` at 3, say) is overwritten by the managed file's, so the floor's own thresholds are fixed both ways |
| the formatter, `vcs`, exclusions | their blocks in `biome.local.jsonc`; the managed file carries none, so yours stand |
| one file the floor cannot fit | an `overrides` entry in `biome.local.jsonc` naming that path, the reason in a comment above it |
| a looser threshold for the whole repository | nowhere: the floor is the fleet's |

The one exception, as the local layer spells it:

```jsonc
{
  "overrides": [
    // hasDuplicateKey is a character-level token walk; a split threads five locals through a record for no gain.
    {
      "includes": ["src/manifest.ts"],
      "linter": { "rules": { "complexity": { "noExcessiveCognitiveComplexity": { "level": "error", "options": { "maxAllowedComplexity": 35 } } } } }
    }
  ]
}
```

- **A finding is split, or folded:** two nameable concepts become named steps; a step called from one place that is no concept of its own folds back into its caller.
- **Never an inline `biome-ignore`:** the per-path override above is the one bypass, and it is visible in the diff with its reason.
- **A repository that already has a `biome.jsonc`:** move its content into `biome.local.jsonc` and delete it. Biome 2.5.11 reads `biome.json` and silently ignores a `biome.jsonc` beside it, so the old file would be dead configuration.
- **A repository that already has a `biome.json`:** the sync replaces it and reports the diff under Replaced local edits; its content moves into `biome.local.jsonc` the same way.

## The member-shape rules

[actions/check-member-shape](../../actions/check-member-shape/action.yml) reads every tracked `.ts`, `.tsx`, `.mts`, and `.cts` file with oxc-parser and judges commented records and constants. A record or block where no item carries a comment is never asked for structure.

| Rule | Flags | Passes |
| --- | --- | --- |
| `blank-line-between-members` | two adjacent members of an interface, class, type literal, or enum with no blank line, or more than one, between them, once any member carries a comment | exactly one blank line between every pair |
| `one-line-comment` | a field's or module constant's comment that is stacked, a multi-line block, parted from the item by a blank line, below its `export` or decorators, or trailing the item on its line | one `//` line or one-line `/** ... */` directly above the item |
| `all-or-none` | a bare field in a record, or a bare constant in a block of adjacent `const` declarations, where another item carries a comment | every item commented, or none |
| `constant-spacing` | a commented module constant without a blank line (or the file edge) before its comment and after its declaration | the constant standing alone |

- **Methods are outside the comment rules:** a method's doc comment may run longer; `blank-line-between-members` still counts it as a member.
- **The bypass:** a path in the repo-owned `.member-shape-allow.local`, one per line with a `# reason`; an entry whose file is clean fails the check as stale.
- **Skipped and counted:** a file carrying the platform's managed header, a file whose header says it is generated, `node_modules`, `vendor`, `third_party`, `goldens`, `__snapshots__`.
- **`.astro` frontmatter** is outside the check today.

## The gates

Both steps run in fleet.yml's `standard-checks` job ([all-green.md](../all-green.md#what-gates-what)), on every push and pull request of a `bun` repository.

| Step | Runs when | Stands down |
| --- | --- | --- |
| `biome` | the checkout holds a `biome.json` | with a notice before the first sync writes it; once recorded, a deleted `biome.json` is validate-managed-files' red |
| `member-shape` | always | never: the action brings its own parser, so no `package.json` is needed |

- **Lint only:** the `biome` step judges format nowhere; the repo-owned `auto-format.yml` starter runs `biome check --write` on the `fix-lint` label at the same pin ([toolchains.md](../toolchains.md#the-biome-pin)).
- **The managed bytes survive `check --write`:** without its own override, biome 2.5.11 rewrites `biome.json` to tabs under an empty local layer (932 to 880 bytes), and a local `useSortedKeys` assist reorders its keys; the next sync or validate-managed-files run reports either. The override keeps the formatter and the assists, yours or the starter's, off that one file.
- **One biome for the fleet:** the action's own, pinned in its manifest, never the repository's install.

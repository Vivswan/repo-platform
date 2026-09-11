---
order: 235
group: Fleet operations
---

# Composition

`templates/` is the source of truth for everything the template renders: `base/` plus one folder per module, each with a `module.yml` manifest. [scripts/compose/compose.ts](https://github.com/Vivswan/repo-platform/blob/main/scripts/compose/compose.ts) composes them into the flat `template/` tree Copier renders: a gitignored local copy from `bun run compose`, and the copy published on the `build` branch. This page is the contract the composer enforces; the code owns the details.

## Sources

| Source | What the composer does with it |
|---|---|
| `templates/base/` | Passed through verbatim. A conditional base file declares its gate in its source filename (CONTRIBUTING.md's `not private`, LICENSE.md's custom-license opt-out); the composer strips the gate from the emitted name and records it as gate data. |
| `templates/<module>/` | Whole files owned by that module, emitted at their plain paths, each recorded with the module's gate (the manifest `gate:` override, else plain membership). |
| `templates/<module>/fragments/<anchor>.jinja` | An additive contribution to a shared file, spliced at the anchor of the same name. |
| `templates/<module>/fragments/toolchain-setup.jinja` | No anchor's fragment: the module's toolchain setup steps, prepended to the module's own auto-format and copilot-setup-steps contributions so the two spliced copies can never drift apart. |
| Manifest data | Fills the data anchors below; no fragment files involved. |

The composed tree carries only plain filenames because a `uses:` ref downloads the whole build branch as a tarball, and extraction dies on jinja-expression path segments.

## Conditional landing

- Landing conditions live in copier.yml, not in filenames. Its generated `_exclude` region carries one jinja-templated pattern per gated landed path, rendering to the literal path exactly when the file's gates do NOT hold; copier then never renders the file, on copy and update alike, byte-identical to the retired filename-gate behavior.
- A directory whose every landed file is gated gets a pattern of its own, or copier would render it as an empty directory.
- `build()` errors when copier.yml's committed region is stale, so a build branch can never ship a tree whose excludes disagree with its content.
- Source filenames are validated fail-closed: after the recognized gates are stripped no jinja syntax may remain, a gate's inner name may not end in `.jinja`, and no landed segment may carry edge whitespace. Each would make copier's destination differ from the path the manifest records, or leave the path unexcludable.

## Anchors and fragments

- A skeleton file carries a marker line starting with `{# compose:<anchor> #}`. Text after the closing tag is appended verbatim after the last contribution, for inline `{% endif %}<text>` junctions.
- The composer replaces the marker line with every contribution in `MODULE_ORDER`, each fragment wrapped in its module's gate. Fragments own all whitespace between the tags; the composer adds none.
- Every anchor needs at least one contribution and every contribution needs its anchor. Anchors live in skeleton files only: a marker inside a contribution is an error, since it would splice through verbatim and render to nothing.
- A `-#}` closer makes the anchor TIGHT: the marker line's newline is consumed too, so every contribution must end with a newline inside its own gate and the junction to the next line stays tight whichever gates render false. With a plain `#}` the skeleton newline terminates the block, so an all-conditional line list would leave it dangling when the last gate is off.
- On a plain anchor whose contributions all carry a gate, the marker line's newline is wrapped in an any-gate guard (splice.ts's `collapseGuard`). With every gate false the whole line collapses instead of rendering as a stray blank line; with any gate true the guard re-emits the same newline, byte-identical to an unguarded splice.
- The guard is skipped where the newline is already spoken for: an anchor with trailing text keeps its newline (the literal would otherwise fuse onto the next line), the file's last segment has no newline to guard, a contribution with no gate always renders, and a lexical trim (a `-%}`-style closer ending the splice, or a trimming opener right after it) already owns the run of whitespace.
- Every non-last contribution must end with a newline once its closing tags are stripped, or two selected contributions render onto one line: adjacent `{% if %}...{% endif %}` wrappers emit no separator of their own.

## Data anchors

Data anchors (`DATA_ANCHORS` in data_anchors.ts) are filled from manifest data instead of fragment files, so the composed output carries no marker comments and list-shaped content (dependabot ecosystems, gitleaks lockfiles) cannot drift from the manifests.

- Sharing rule: a manifest value declared by several modules is grouped BY VALUE, emitted ONCE, and gated on the or-chain of the contributing modules in `MODULE_ORDER`. Never per-module duplicates, never precedence guards.
- A fragment file for a data anchor is an error, with one exception: agents-toolchain consumes its fragments as generator input.

## Gitignore fragments

`scripts/generate/build_gitignore.ts` generates the `gitignore` anchor's fragments from each manifest's `gitignore_sources` (github/gitignore template names, uv mapping to Python.gitignore since upstream has no standalone uv template), plus the base skeleton's OS sections, the sync writer's copies (`files/base/.gitignore` is the skeleton's region body; `files/<module>/.block.<Source>.gitignore` is one section each, once per declaring module), and this repository's own `.gitignore`. The region body opens with two sections that have no upstream source: `Agent local state` (worktree directories, the machine-local settings file) and `CI workspace paths` (only what a fleet workflow step creates inside the caller's checked-out workspace, `/results.sarif` and `/.fuzz-failures/`, because only those can collide with a committed path; a job that never checks the repository out lists nothing; root-anchored so a nested source folder of the same name is not swallowed). A path only this repository's workflows create goes in its `.gitignore` outside the managed region.

- A source declared by several modules is emitted plain in the first declaring module's fragment; each later one carries the whole chunk wrapped in the negation of the earlier declarers' gates, so a repo selecting both gets the section once and a suppressed chunk renders as nothing.
- There is no pinned upstream SHA and no offline regeneration mode: every run fetches github/gitignore's current HEAD and nothing generated records the SHA, so the outputs change only when consumed upstream content changes. That is what makes the refresh-gitignore workflow's PR diff worth reading, and that workflow is the only caller of the networked path.
- `--topology` is the offline gate `bun run check` and CI run: every fragment must exist and encode exactly the manifests' declared sources and gate guards, and the `files/` side must match the templates side (`files.yml`'s `gitignore_sources` are the manifests' sources by block name, every block file is its fragment's section, `files/base/.gitignore` is the template's region body). A stale guard would make the next build emit duplicate shared sections; a stray fragment or block file would abort the refresh workflow with no way to self-heal; a refresh that regenerated one side only cannot land.
- Content drift inside a managed block is ungated until the next refresh regenerates over it.

## Collisions

Collisions are errors, never silent merges. The same logical path provided by two folders, or a module file colliding with base, is resolved by hoisting the file to `base/` with an explicit gate or by adding an anchor.

## Determinism and bytes

- All I/O is bytes: source files are copied verbatim, never re-encoded, and symlinks are copied as symlinks.
- Output is deterministic: sorted walks plus the fixed `MODULE_ORDER`. CI builds twice and diffs to prove it.

## Ownership contract

Every file the template lands carries a DECLARED ownership class: `templates/base/ownership.yml` covers the base tree and each `module.yml`'s `ownership:` list covers its module's files (schema: scripts/ownership/declarations.ts).

| Class | Meaning |
|---|---|
| managed | sync overwrites the whole file; local edits are replaced |
| split | sync owns the BEGIN/END-bounded managed region; the repository owns everything outside it (the one grammar, managed-region) |
| starter | rendered once, repo-owned from then on (`_skip_if_exists`) |

- Ownership is declared as data, never inferred from file text. Managed headers and split marker lines are validated DECORATION: a source whose text contradicts its declared class is an error, but text never classifies. Inferring from a missing header would let deleting the header silently downgrade a file's enforcement, the exact bypass the header guards against.
- Composition errors on: a landed file with no declaration, a declaration whose path never lands, same-path declarations that disagree across sources, starter declarations out of step with copier.yml's `_skip_if_exists` (both directions, dead skip patterns included), and a symlink declared anything but managed (sync re-renders links whole).
- The composed tree ships the ownership manifest (`.github/repo-platform-manifest.json`). Its entry lines come from the shared `entryLine` in actions/shared/manifest.ts, the same module the stamp hook, the sync legs, and validate-template read the manifest back through, so the wire layout cannot fork. validate-template's ownership tables are generated from the same declarations.
- Per-grammar behavior (owned markers, wire fields) is the grammar descriptor table in actions/shared/grammar.ts; the declaration schema's grammar union is welded to that table's key set at compile time, so no consumer can meet a grammar the table has no row for.

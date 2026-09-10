---
order: 232
group: Fleet operations
---

# Sync writer

The sync writer copies the platform's files into a managed repository. It reads one data file, `files.yml`, and one tree of plain files, `files/`. There is no template language and no merge: managed content is copied whole, split regions are copied between the repository-owned halves, starters are copied once, and links are relative symlinks the writer places and repairs. Code is the source of truth; this page is the map.

| Question | Owner |
| --- | --- |
| What does `files.yml` look like, and what does the loader refuse? | [actions/plan/files_config.ts](../actions/plan/files_config.ts), the grammar every reader shares (the writer, the fleet plan, the checks); the writer's own checks against the `files/` tree and the placeholder defaults are in [sync/writer/files_config.ts](../.github/scripts/sync/writer/files_config.ts) |
| Which placeholder tokens exist? | `PLACEHOLDER_NAMES` in [sync/writer/placeholders.ts](../.github/scripts/sync/writer/placeholders.ts) |
| How are the values derived from `.repo-platform.yml`? | [sync/writer/registration.ts](../.github/scripts/sync/writer/registration.ts) |
| Which entries apply to one repository? | [sync/writer/select.ts](../.github/scripts/sync/writer/select.ts) |
| How is each class written? | [sync/writer/write_managed.ts](../.github/scripts/sync/writer/write_managed.ts), [write_split.ts](../.github/scripts/sync/writer/write_split.ts), [write_starter.ts](../.github/scripts/sync/writer/write_starter.ts), [write_link.ts](../.github/scripts/sync/writer/write_link.ts) |
| Where do blocks land, and what may a value contain? | `spliceBlocks` and `substitute` in [sync/writer/placeholders.ts](../.github/scripts/sync/writer/placeholders.ts) |
| What happens when an entry's class differs from its record? | `writeEntry` in [sync/writer/sync.ts](../.github/scripts/sync/writer/sync.ts) |
| When does a retired file leave? | [sync/writer/retire.ts](../.github/scripts/sync/writer/retire.ts) |
| What does the manifest record? | [sync/writer/manifest.ts](../.github/scripts/sync/writer/manifest.ts) |
| What holds a PR for review? | `holdReasons` in [sync/writer/report.ts](../.github/scripts/sync/writer/report.ts) |
| The whole run, as a CLI | [sync/writer/sync.ts](../.github/scripts/sync/writer/sync.ts) |

## The command

```text
bun .github/scripts/sync/writer/sync.ts \
  --files files.yml --tree files \
  --target <checkout> --build <sha> \
  --repository <owner/name> --private <true|false> \
  [--previous-files <files.yml of the build being replaced>] \
  [--summary <path for the JSON summary>]
```

- `--tree` is the `files/` directory itself; every `source` in `files.yml` starts with `files/` and resolves under it.
- `--repository` names the GitHub repository; the owner is the `github_username` placeholder and the name is the fallback project name and slug.
- `--previous-files` turns on the retirement check (below).
- The Markdown report goes to stdout. The JSON summary carries the same rows plus `hold` and `holdReasons`.
- Exit 0 whether or not the report holds the PR. A nonzero exit is a data or environment error: a bad `files.yml`, an unreadable registration, a directory or a symlinked ancestor at a path the writer touches, a symlink at the manifest or registration path, a split file whose marker text is duplicated or buried mid-line, a placeholder value carrying a double quote, backslash, or control character.

## files.yml

```yaml
placeholders: [project_name, project_slug, description, github_username, github_username_lower, copyright_holder, year, skills_dir, fuzzer_label]
modules:
  bun: {codeql_language: javascript-typescript, gitignore_sources: [Node, Bun], dependabot_ecosystems: [bun]}
  node: {gitignore_sources: [Node], dependabot_ecosystems: [npm]}
  fuzzer: {tracking_label: {key: fuzzer, default: fuzz-nightly}}
  skills: {skills_dir: {default: skills}}
  pages: {}
  docs-site: {}
files:
  - {path: .github/workflows/ci.yml, class: managed}
  - {path: .gitignore, class: split, region: hash, blocks: gitignore_sources}
  - {path: .github/dependabot.yml, class: managed, blocks: dependabot_ecosystems}
  - {path: CLAUDE.md, class: link, target: AGENTS.md}
  - {path: .github/agents.md, class: link, target: ../AGENTS.md}
  - {path: .github/workflows/docs-site.yml, class: managed, when: {modules: [docs-site], without: [pages]}, source: files/docs-site/docs-site.standalone.yml}
  - {path: .github/workflows/docs-site.yml, class: managed, when: {modules: [docs-site, pages]}, source: files/docs-site/docs-site.with-pages.yml}
  - {path: .github/workflows/nightly-fuzz.yml, class: starter, when: {modules: [fuzzer]}}
retired:
  - {path: .github/.copier-answers.yml}
  - {path: SECURITY.md, moved_to: .github/SECURITY.md}
```

| Key | Meaning |
| --- | --- |
| `placeholders` | The placeholder names sources may use, each spelled as the name inside double braces. Each must be one the writer derives (`PLACEHOLDER_NAMES`). |
| `modules.<name>` | A module and its data, the keys in canonical module order: the same names as the module manifests, in the same order (the `files-modules` ssot rule). Any key is allowed; `blocks` entries name one of these keys. Two keys carry placeholder defaults: `tracking_label: {key, default, ...}` backs the `<key>_label` placeholder and `skills_dir: {default}` backs `skills_dir` (below). |
| `files[].path` | The repository-relative path written. Clean paths only: no `..`, no empty segment, no `.git`. |
| `files[].class` | `managed`, `split`, `starter`, or `link` (below). |
| `files[].source` | The source file, under `files/`. Default: `files/<first when.modules entry, or base>/<path>`. Not for links. |
| `files[].when` | The selection condition (below). Absent means always. |
| `files[].region` | Split entries only: `hash` for `#` comment markers, `html` for `<!-- -->` markers. |
| `files[].blocks` | Managed, split, and starter entries: a module-data key. For each selected module carrying it, in `modules` order, each listed value names the block file `files/<module>/<path>.block.<value>`. Byte-identical block files land once, from the first selected module declaring them (a gitignore source three toolchains share); files that differ are each their module's own block even under one value name (each toolchain's `AGENTS.md` bullets). |
| `files[].target` | Link entries only: the symlink target, relative to the link's own directory (`../AGENTS.md` from `.github/`). It must resolve to a clean repository path other than the link itself. |
| `retired[].path` | A path the platform no longer writes. |
| `retired[].moved_to` | The path the file moves to (`git mv`) when that path is absent. |

Blocks land at the anchor line: the word `blocks` inside double braces, alone on its line, spelled like a placeholder. A source without one gets them appended at the end. Every piece is newline-terminated first, so the seams never merge two lines. The anchor appears at most once and only as a whole line, in sources of entries that declare `blocks` (for a split entry, inside the region body). A starter's blocks are rendered once, at creation.

The loader refuses, all problems at once:

- a placeholder the writer cannot derive, or a source file using a token outside `placeholders`
- a `when` naming a module absent from `modules`
- a `split` without `region`; `region` on a non-split entry; `target` on a non-link entry; a link with a `source` or `blocks`, without a `target`, or with a target that is absolute, leaves the repository, or is the link itself
- a `source` outside `files/`, or one missing from the tree (block files included)
- a `blocks` anchor mentioned twice or mid-line, in a source whose entries do not all declare `blocks`, or inside a block file
- a listed `skills_dir` or `<key>_label` placeholder no module declares a default for; a default declared by two modules; a `tracking_label` without `key` and `default`
- two entries for one `path` whose conditions can both hold (below)
- a path listed under both `files` and `retired`
- a `files` entry at `.github/repo-platform-manifest.json`, the manifest the writer itself writes last
- with `--previous-files`: a path the previous `files.yml` wrote or retired that the current one neither writes nor retires

## files.yml reference

What the committed `files.yml` uses today, so a reader knows which forms are live. The loader accepts more (above); the file table itself is in [new-repo.md](new-repo.md#what-the-sync-writes), generated by `scripts/files_table.ts`.

| Entry class | Used for |
| --- | --- |
| `managed` | the workflows the fleet runs unchanged (`ci.yml`, `auto-assign.yml`, the module workflows), `.github/dependabot.yml`, `.yamllint`, `.typography-allow`, the review instructions, the toolchain pin files |
| `split` (region `hash`) | `.editorconfig`, `.gitattributes`, `.gitignore`, `.github/CODEOWNERS` |
| `split` (region `html`) | `AGENTS.md`, `LICENSE.md` |
| `starter` | `checks.yml`, `post-green.yml`, the release hooks, `auto-format.yml`, `copilot-setup-steps.yml`, `.gitleaks.toml`, `.github/actionlint.yaml`, `.github/settings.yml`, the release-please, skills, fuzzer, and nightly starters |
| `link` | `CLAUDE.md` (to `AGENTS.md`), `.github/agents.md` and `.github/copilot-instructions.md` (to `../AGENTS.md`) |

| `when` form | Used by |
| --- | --- |
| `modules: [x]` | every module-owned file |
| `any: [...]` | `auto-format.yml` and the CodeQL variant of `auto-assign.yml` (any toolchain with a formatter), the Toolchain variant of `AGENTS.md` (any toolchain) |
| `without: [...]` | `LICENSE.md` (not `custom-license`), the plain variants of `.typography-allow`, `AGENTS.md`, and `auto-assign.yml` |
| `private: true` / `false` | the two `.github/settings.yml` starters, the `auto-assign.yml` variants (code scanning exists on public repositories only) |

The three links carry no `when`: every repository gets them.

| `blocks` key | Entry | Block files |
| --- | --- | --- |
| `gitignore_sources` | `.gitignore` (split) | `files/<module>/.gitignore.block.<Source>`, one github/gitignore template each, written by `scripts/generate/build_gitignore.ts` beside the template fragments ([compose.md](compose.md)); the Node source three toolchains declare is byte-identical in each, so it lands once |
| `dependabot_ecosystems` | `.github/dependabot.yml` (managed) | `files/<module>/.github/dependabot.yml.block.<ecosystem>`, appended at the anchor line that ends the source |
| `agents_toolchain` | `AGENTS.md` (Toolchain variant, split) | `files/<module>/AGENTS.md.block.toolchain`, the module's Toolchain bullets, appended after the region body |
| `toolchain_steps` | `checks.yml`, `copilot-setup-steps.yml`, `auto-format.yml` (starters) | `files/<module>/.github/workflows/<file>.block.toolchain`: the example checks, the setup and install steps, the setup and format steps; each block opens with the blank line that separates it from the step above, and the anchor sits after the checkout step (`copilot-setup-steps.yml` ends there; `checks.yml` and `auto-format.yml` keep one blank line below it before their closing steps) |

| Module data key | Meaning | Reader |
| --- | --- | --- |
| `description` | the module's one-line description | docs and the PR body |
| `codeql_language` | the CodeQL language the toolchain contributes | the fleet plan |
| `pin` | `{file, version}` of the toolchain's version dotfile; equal to the manifest's `toolchain.pin` (the `files-pins` ssot rule) and bumped with it by the toolchain refresh | the toolchain refresh |
| `pages` | `{install, build}`: the pages install and build commands a repository selecting this toolchain gets unless its registration names others; equal to the manifest's `pages` (the `files-pages` ssot rule) | the fleet plan and the registration cutover |
| `dependabot_ecosystems` | the Dependabot ecosystems the module adds (also its `blocks` list) | the writer |
| `dependabot_label` | `{name, color}` of the label its Dependabot PRs carry | the settings baseline |
| `gitignore_sources` | the github/gitignore templates the module adds (its `blocks` list) | the writer |
| `agents_toolchain` | the AGENTS.md block list (`[toolchain]`) | the writer |
| `toolchain_steps` | the block list (`[toolchain]`) of the three starter workflows that carry per-toolchain steps | the writer |
| `skills_dir` | `{default}`: the skills directory the `skills_dir` placeholder and the plan's `skills-dir` output fall back to when the registration sets no `skills.dir`; equal to copier.yml's `skills_dir` default (the `files-defaults` ssot rule) | the writer and the fleet plan |
| `dist` | the `pages` module only: the build output directory a pages repository publishes unless its registration sets `pages.dist`; equal to copier.yml's `pages_dist_dir` default (the `files-defaults` ssot rule) | the fleet plan and the registration cutover |
| `path` | the `docs-site` module only: the URL segment the docs mount under when the `pages` module also renders a website, unless the registration sets `docs_site.path`; equal to copier.yml's `docs_site_path` default (the `files-defaults` ssot rule) | the fleet plan and the registration cutover |
| `settings_layers` | the settings layer files the module contributes | the settings apply |
| `tracking_label` | `{key, default, color, description}` of the module's tracking-issue label; `key` is the registration's `labels` key and `default` backs the `<key>_label` placeholder | the fleet plan, the settings baseline, and the writer |

Placeholders in use beyond the project block: `skills_dir` in `validate-skills.yml` (its trigger paths and the action's `skills-dir`), `fuzzer_label` in `nightly-fuzz.yml`, `nightly_label` in `nightly.yml`. No committed source names `docs_site_label`: the docs-site and pages workflows do not pass the link-rot label (the plan action resolves it from the registration), so it is not listed.

A module with no files still appears under `modules` (`issue-templates`, `custom-license`) so a registration selecting it is known and a `when` can name it.

## Placeholders

| Name | Value |
| --- | --- |
| `project_name` | `project.name` from the registration, else the repository name |
| `project_slug` | `project.slug`, else the repository name |
| `description` | `project.description`, else empty |
| `github_username` | the repository owner |
| `github_username_lower` | the owner, lower-cased |
| `copyright_holder` | `project.copyright_holder`, else the owner |
| `year` | the current UTC year |
| `skills_dir` | `skills.dir` from the registration, else `modules.<m>.skills_dir.default` |
| `fuzzer_label`, `nightly_label`, `docs_site_label` | `labels.<key>` from the registration, else the `default` of the `modules.<m>.tracking_label` whose `key` is `fuzzer`, `nightly`, or `docs_site` |

- A token is the name inside double braces with no spaces; spaces inside the braces make it plain text.
- A `$` before the braces marks a GitHub Actions expression, left untouched.
- Substitution runs on source files only. A literal double brace in a repository-owned tail is never touched.
- A value lands inside quoted YAML scalars verbatim, so a value carrying a double quote, a backslash, or a control character is refused twice: the registration grammar (`actions/plan/registration.ts`) rejects such a `project.name` or `project.description`, and `substitute` fails the run on any such value.
- An absent or empty value is never written: an entry whose text needs it is `held` with `no value for <token>`, a Registration note names the registration key to set, and the PR holds. A registration carrying only `modules:` (no `project:` block) holds every entry that uses `description`.

## Selection

| Clause | Holds when |
| --- | --- |
| `modules: [a, b]` | every listed module is selected |
| `any: [a, b]` | at least one listed module is selected |
| `without: [a]` | none of the listed modules is selected |
| `private: true` | the repository's visibility matches |

- The selected modules are the registration's `modules` filtered to the names `files.yml` knows, in `files.yml` order. Unknown names are dropped and listed under Registration notes, which holds the PR.
- Two entries for one path must be provably exclusive: a module one requires and the other forbids, an `any` list the other forbids entirely, or opposite `private` values. Anything subtler is a loader error.

## Classes

| Class | Written | Existing local content | Manifest record |
| --- | --- | --- | --- |
| `managed` | whole file, every sync | replaced and reported (`replaced local edits`, with a diff), holds the PR | `hash` = sha256 of the file |
| `split` | the marker-bounded region, every sync | everything above BEGIN and below END is kept; a file that never mentions the markers gets the region above its content and the verdict `region added`, which holds the PR; marker text duplicated or buried mid-line fails the run | `hash` = sha256 of the region, marker lines included |
| `starter` | once, when the path is absent (a link there counts as present) | never touched again | no hash |
| `link` | a relative symlink, every sync | a link elsewhere is re-pointed and reported like a local edit (the old target is the replaced text); a regular file at the path is held | `hash` = sha256 of the target string, the hash the previous pipeline already recorded for its symlinks |

Change verdicts per written row: `created` (absent before), `updated` (was exactly the recorded content), `unchanged` (already the new content), `replaced local edits` (was neither), `region added` (a split region placed above repository-owned content), `held` (not written; the Detail column says why). A managed or split entry finding a symlink at its path is held: the writer never reads through a link and has no record of writing one there.

## Class flips

A path recorded under one writer class (`managed`, `split`, `starter`, `mirror`, `link`) that `files.yml` now declares under another is a class flip. The recorded content is the platform's own previous write, so:

| State | Outcome |
| --- | --- |
| the path already holds exactly what the entry writes | `unchanged`; the record takes the new class (how a symlink the previous pipeline recorded as managed becomes a `link` record) |
| what sits there is the recorded write (same rule as retirement: whole-file hash, clean region with nothing outside it, or link target) | removed and written whole under the new class: `updated` |
| anything else, a `starter` record or a record without a hash included | `held` with `class changed from <old> to <new>, and <reason>`; the file and its previous record stay, and no mirror copies the file |
| the new class is `starter` | a handover: the file is the repository's own, nothing is held |

Without the rule, a managed file that becomes split would have the region prepended above its old content and report `updated`.

## Retirement

Retirement runs before writing. Rows appear only for files present. A `moved_to` whose destination is written for this repository is moved or held whatever the record says; every other retirement of an unrecorded file produces no row, since the platform never wrote it and it is not its to retire.

| State of the retired file | Outcome |
| --- | --- |
| `managed`, content equals the recorded hash | `deleted` |
| `split`, region equals the recorded hash, nothing outside the region | `deleted` |
| `split`, region equals the recorded hash, repository-owned content outside it | `region removed`: the marker lines and the region go, the content above and below stays byte for byte as a plain file, and the record leaves; the PR holds this once. Next run the path is unrecorded and produces no row. |
| `split`, region differs from the recorded hash, or markers missing or malformed | `held` |
| a symlink whose target hashes to the recorded hash, whatever class the record names | `deleted` (the link goes; what it points at is never touched) |
| a symlink with another target; a regular file where a `link` was recorded | `held` |
| content differs, or a record without a hash | `held` |
| recorded as `starter` | `kept` (repo-owned) |
| `moved_to` given, new path absent | `moved` (`git mv`; the record travels, so the following write of the new path judges it as the platform's own) |
| `moved_to` given, new path present | `held` |
| `moved_to` given, new path not written for this repository (its entry is unselected) | treated as a plain retirement: the outcomes above apply |

A recorded `managed`, `split`, or `link` path that no selected entry writes and no `retired` entry names (a module was deselected) is retired the same way, with the detail `no longer selected`; a recorded path that is not a clean repository path is ignored and noted. A held or kept file, a held entry, and a refused mirror target keep their records in the new manifest every run (a record without a hash is carried as such), so the file is held again next time and never becomes an unrecorded orphan; a record whose class the writer does not know is dropped with a note, and so is a `mirror` record no declaration reaches any more (the copy stays as the repository's own; a mirror declared again adopts it while it still holds the source's content).

## Mirrors

The registration's `mirrors` list (`source`, `targets`) copies a file this sync wrote to each target. Single-segment `*` globs: a `*` directory segment matches directories, a final `*` matches existing files, a literal final segment lands in every matched directory. Literal targets are written before any glob expands, so a directory a literal creates is matched in the same run; a target a literal claims stays the literal's. A glob never creates a directory: a matched path whose directory is missing is refused. A symbolic link a glob meets is refused by name, never skipped and never listed through: a linked file, a linked directory, or a link resolving to nothing (the rest of the pattern rides along in the refused row, as in `skills/link/sub/*.md`); a link to a file in a directory segment is no directory and is passed over like a file.

| Outcome | When |
| --- | --- |
| `written` | the target was absent, or held exactly the previous mirror (the hash of its `mirror` record; a record of another class does not vouch for the bytes) |
| `current` | the target already holds the new content |
| `refused` | the source is not a file this sync wrote, or was held this run; the pattern uses `**`, matches nothing, or has a symlinked literal ancestor; a matched path sits under a symbolic link or in a directory that does not exist; the target is unsafe, sits under `.github/workflows/`, or is a path `files.yml` writes or retires (listed or stale); the target is a symbolic link; the target holds content that is not the previous mirror (only a `mirror` record vouches for the bytes) |

## The manifest

`.github/repo-platform-manifest.json`, the layout `actions/shared/manifest.ts` already parses: one entry per line, sorted by path. The manifest's own entry carries the build sha in `commit` and no hash. Classes recorded: `managed`, `split` (with `grammar`, `begin`, `end`), `starter`, `mirror`, `link` (hash of the target string). The record is how the next sync tells the platform's own previous write from a local edit, for replacement and for retirement.

## The report

| Section | Content |
| --- | --- |
| header | Build, Modules, Visibility |
| Written | path, class, change, detail for every selected entry (detail is the reason of a `held` row) |
| Replaced local edits | one unified diff per replaced file, capped at 40 lines |
| Retired | path, outcome, detail |
| Registration notes | dropped unknown modules; an unparsable manifest; a placeholder with no value and the key that sets it; a manifest record the writer cannot carry; a mirror record no declaration reaches |
| Mirrors | source, target, outcome, detail |
| Review | `Hold for review: yes` with the reasons, or `no` |

`hold` is true on any held or `region added` written row, any replaced local edit, any held or `region removed` retirement, any refused mirror, or any registration note. Table cells escape `|`, so a path or detail carrying one keeps the columns. Every cell, note, and code-formatted value (the replaced-file headings included) is printed on one line: a newline inside a registration value or a manifest path (the writer copies both into the report verbatim) cannot end the row and start a heading of its own. A replaced diff sits in a fence one backtick longer than any backtick run its lines open with, so the target's own content cannot close it.

The PR body stays under GitHub's 65,536-character limit (`BODY_CAP` in [sync/deliver.ts](../.github/scripts/sync/deliver.ts)): the header and the Review section take their room first, then the tables and notes, then the replaced-edit diffs; a section the room runs out on ends in a warning naming how many characters were cut, and one with no room left is dropped.

## The operator

[sync-repos.yml](../.github/workflows/sync-repos.yml) runs the writer against every managed repository: a `plan` job, then one `sync (row <i>)` job per row. The job shape is the redaction: the public log carries row indexes and the vocabulary below, nothing else, and every detail lands in the target repository ([private-repos.md](private-repos.md)).

| Step | Script | What it does |
| --- | --- | --- |
| plan: resolve the build | [sync/resolve_build.ts](../.github/scripts/sync/resolve_build.ts) | the build tip, proven the builder's output of a green main commit ([build-provenance.md](build-provenance.md)) and carrying `files.yml`; every row checks out exactly this commit |
| plan: discover and select | [fleet/discover_repos.ts](../.github/scripts/fleet/discover_repos.ts), [fleet/select_sync_repos.ts](../.github/scripts/fleet/select_sync_repos.ts) | the rows: the repositories the fleet token can push to that have adopted the platform, narrowed by the dispatch `repo` input or the called `repos` scope ([fleet/sync_scope.ts](../.github/scripts/fleet/sync_scope.ts)) |
| plan: print | [sync/verdict.ts](../.github/scripts/sync/verdict.ts) `plan` | `plan: <N> rows`; the matrix is the indexes `0..N-1` |
| row 1: check out | actions/checkout | repo-platform, then the build at the plan's commit under `build/` |
| row 2: resolve | [sync/resolve_row.ts](../.github/scripts/sync/resolve_row.ts) | discovery and selection re-run with the plan's inputs (their output in `$RUNNER_TEMP` files), the row count checked against the plan, the index mapped to a repository; every form of the name is registered with the masker before anything else prints, and the name rides `GITHUB_ENV` (which the runner never echoes) from here |
| row 3: check out the target | [sync/checkout_target.ts](../.github/scripts/sync/checkout_target.ts) | a captured `git clone` with the fleet token (actions/checkout echoes git's diagnostics, which can quote target file text); the token is stripped from the remote afterwards; `continue-on-error` |
| row 4: write | [sync/writer/sync.ts](../.github/scripts/sync/writer/sync.ts) `--cutover true` | the one writer step: report to `$RUNNER_TEMP/sync.log`, summary to `summary.json`, `continue-on-error` |
| row 5: deliver | [sync/deliver.ts](../.github/scripts/sync/deliver.ts) | a commit on `automation/repo-platform`, pushed with a lease, and a PR whose body is the report (auto-merge armed only when `hold` is false and the run's `manual` input is false); a tree that already matches the build closes any open sync PR as obsolete (disarmed, closed with a one-line comment, its branch deleted); a failed checkout, writer, or push files or refreshes one `[repo-platform] sync failed` issue in the target with the log tails; every line goes to `$RUNNER_TEMP/deliver.log` |
| row 6: print | [sync/verdict.ts](../.github/scripts/sync/verdict.ts) `row` | one verdict line |

The vocabulary, complete (`tests/fleet/verdict.test.ts` pins it):

```text
plan: <N> rows
row <i>: unchanged
row <i>: PR opened
row <i>: PR refreshed
row <i>: failed, report filed in the target repository
row <i>: failed before the target was resolved; re-run the workflow
```

- A row is red only when a step before or at the resolve failed (the install, the build checkout, the re-run selection, the resolve itself): the printer then prints the unresolved line, and the failed step's exit status is the whole public signal (its output sits in the runner's `$RUNNER_TEMP` file, gone with the runner); the plan job ran the same code moments earlier in the clear, so re-running the workflow is the remedy. From the checkout on, the steps continue on error and the failure is delivered to the target; the row stays green with its verdict line. The one exception is a target that cannot take the failure report (no Issues grant): that row prints nothing and is red.
- Where the detail is: a delivered row's PR body; a failed row's issue (the tails of the checkout, writer, and delivery logs).
- The `operator-verdict-only` rule (`scripts/check/ssot/sync_operator.ts`) pins the shape: an index-only matrix, every row `run:` step one bun command redirected to a `$RUNNER_TEMP` file except the resolver and the printer, only the checkout and setup-bun actions and never a checkout of another repository, no target name in a step's declared env, the target clone after the resolver, the row job's selector carrying the plan's exact env, and the row job's timeout at least the plan's (the row re-runs the plan's probe, whose hung calls must fail by their own bound).
- Rows are re-derived, not carried: a repository renamed, enrolled, or archived between the plan and a row shifts the indexes. The row count guard catches a changed count; a same-count change is the residual, and its worst case is one repository synced twice (two rows rewrite the same branch and PR, the later one winning) or once too few (the next run heals it).

### Cutover

A repository still registered the old way (`.repo-platform.yml` holding only `modules`, its render recorded in `.github/.copier-answers.yml`) is converted by the writer's `--cutover true` flag ([sync/writer/cutover.ts](../.github/scripts/sync/writer/cutover.ts)) before the registration is read, once:

| Written | From |
| --- | --- |
| `project.name`, `project.slug`, `project.description` | `project_name`, `project_slug`, `description`; when absent, the repository name, the repository name made kebab-case (lowercase, every run outside `[a-z0-9]` one dash, none at either end), and an empty description |
| `project.copyright_holder` | `copyright_holder`, only when it differs from the owner login |
| `pages.setup`, `pages.install`, `pages.build`, `pages.dist` | the `pages_*` answers, only where they differ from the defaults the plan action derives: the selected modules carrying `pages` data joined by commas (`none` when there are none); the `install` and `build` of the first module, in `files.yml` order, that the resolved setup names; `modules.pages.dist` (else `dist`) |
| `docs_site.path` | `docs_site_path`, when it differs from `modules.docs-site.path` (else `docs`) |
| `skills.dir` | `skills_dir`, when it differs from the `skills_dir` placeholder default the module data declares (`modules.<m>.skills_dir.default`, else `skills`) |
| `labels.<key>` | `<key>_label` for each selected module carrying `tracking_label: {key, default}`, when it differs from the default |
| `mirrors` | carried from the old file |

- The module list is the old file's selection in `files.yml` order (the order the writer selects in); an unknown name is dropped and noted.
- The derived document must pass the registration schema, or the writer fails (the row files its issue).
- The answers file leaves through the `retired` entry for `.github/.copier-answers.yml` that the files.yml conversion carries (files.yml retires it); the cutover notes hold the PR for review.
- A repository whose registration already carries `project`, or that has no answers file, is left alone.

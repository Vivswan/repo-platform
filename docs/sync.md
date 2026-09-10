---
order: 232
group: Fleet operations
---

# Sync writer

The sync writer copies the platform's files into a managed repository. It reads one data file, `files.yml`, and one tree of plain files, `files/`. There is no template language and no merge: managed content is copied whole, split regions are copied between the repository-owned halves, and starters are copied once. Code is the source of truth; this page is the map.

| Question | Owner |
| --- | --- |
| What does `files.yml` look like, and what does the loader refuse? | [sync/writer/files_config.ts](../.github/scripts/sync/writer/files_config.ts) |
| Which placeholder tokens exist? | `PLACEHOLDER_NAMES` in [sync/writer/placeholders.ts](../.github/scripts/sync/writer/placeholders.ts) |
| How are the values derived from `.repo-platform.yml`? | [sync/writer/registration.ts](../.github/scripts/sync/writer/registration.ts) |
| Which entries apply to one repository? | [sync/writer/select.ts](../.github/scripts/sync/writer/select.ts) |
| How is each class written? | [sync/writer/write_managed.ts](../.github/scripts/sync/writer/write_managed.ts), [write_split.ts](../.github/scripts/sync/writer/write_split.ts), [write_starter.ts](../.github/scripts/sync/writer/write_starter.ts) |
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
- Exit 0 whether or not the report holds the PR. A nonzero exit is a data or environment error: a bad `files.yml`, an unreadable registration, a directory, symlink, or symlinked ancestor at a path the writer touches, a split file whose marker text is duplicated or buried mid-line.

## files.yml

```yaml
placeholders: [project_name, project_slug, description, github_username, github_username_lower, copyright_holder, year]
modules:
  bun: {codeql_language: javascript-typescript, gitignore_sources: [Node, Bun]}
  fuzzer: {tracking_label: {key: fuzzer, default: fuzz-nightly}}
  pages: {}
  docs-site: {}
files:
  - {path: .github/workflows/ci.yml, class: managed}
  - {path: .gitignore, class: split, region: hash, blocks: gitignore_sources}
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
| `modules.<name>` | A module and its data. Any key is allowed; `blocks` entries name one of these keys. |
| `files[].path` | The repository-relative path written. Clean paths only: no `..`, no empty segment, no `.git`. |
| `files[].class` | `managed`, `split`, or `starter` (below). |
| `files[].source` | The source file, under `files/`. Default: `files/<first when.modules entry, or base>/<path>`. |
| `files[].when` | The selection condition (below). Absent means always. |
| `files[].region` | Split entries only: `hash` for `#` comment markers, `html` for `<!-- -->` markers. |
| `files[].blocks` | Split entries only: a module-data key. For each selected module carrying it, in `modules` order, each listed value names the block file `files/<module>/<path>.block.<value>`, appended to the region body. |
| `retired[].path` | A path the platform no longer writes. |
| `retired[].moved_to` | The path the file moves to (`git mv`) when that path is absent. |

The loader refuses, all problems at once:

- a placeholder the writer cannot derive, or a source file using a token outside `placeholders`
- a `when` naming a module absent from `modules`
- a `split` without `region`; `region` or `blocks` on a non-split entry
- a `source` outside `files/`, or one missing from the tree (block files included)
- two entries for one `path` whose conditions can both hold (below)
- a path listed under both `files` and `retired`
- with `--previous-files`: a path the previous `files.yml` wrote or retired that the current one neither writes nor retires

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

- A token is the name inside double braces with no spaces; spaces inside the braces make it plain text.
- A `$` before the braces marks a GitHub Actions expression, left untouched.
- Substitution runs on source files only. A literal double brace in a repository-owned tail is never touched.

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
| `split` | the marker-bounded region, every sync | everything above BEGIN and below END is kept; a file that never mentions the markers gets the region above its content; marker text duplicated or buried mid-line fails the run | `hash` = sha256 of the region, marker lines included |
| `starter` | once, when the path is absent | never touched again | no hash |

Change verdicts per written row: `created` (absent before), `updated` (was exactly the recorded content), `unchanged` (already the new content), `replaced local edits` (was neither).

## Retirement

Retirement runs before writing. Rows appear only for files present.

| State of the retired file | Outcome |
| --- | --- |
| `managed`, content equals the recorded hash | `deleted` |
| `split`, region equals the recorded hash, nothing outside the region | `deleted` |
| `split`, region equals the recorded hash, repository-owned content outside it | `held` |
| content differs, no record, or a record without a hash | `held` |
| recorded as `starter` | `kept` (repo-owned) |
| `moved_to` given, new path absent | `moved` (`git mv`; the record travels, so the following write of the new path judges it as the platform's own) |
| `moved_to` given, new path present | `held` |

A recorded `managed` or `split` path that no selected entry writes and no `retired` entry names (a module was deselected) is retired the same way, with the detail `no longer selected`; a recorded path that is not a clean repository path is ignored and noted. A held or kept file, and a refused mirror target, keep their records in the new manifest so a later sync can still match them.

## Mirrors

The registration's `mirrors` list (`source`, `targets`) copies a file this sync wrote to each target. Single-segment `*` globs: a `*` directory segment matches directories, a final `*` matches existing files, a literal final segment lands in every matched directory.

| Outcome | When |
| --- | --- |
| `written` | the target was absent, or held exactly the previous mirror (its recorded hash) |
| `current` | the target already holds the new content |
| `refused` | the source is not a file this sync wrote; the pattern uses `**`; the target is unsafe, sits under `.github/workflows/`, or is a path `files.yml` writes; the target holds content that is not the previous mirror |

## The manifest

`.github/repo-platform-manifest.json`, the layout `actions/shared/manifest.ts` already parses: one entry per line, sorted by path. The manifest's own entry carries the build sha in `commit` and no hash. Classes recorded: `managed`, `split` (with `grammar`, `begin`, `end`), `starter`, `mirror`. The record is how the next sync tells the platform's own previous write from a local edit, for replacement and for retirement.

## The report

| Section | Content |
| --- | --- |
| header | Build, Modules, Visibility |
| Written | path, class, change for every selected entry |
| Replaced local edits | one unified diff per replaced file, capped at 40 lines |
| Retired | path, outcome, detail |
| Registration notes | dropped unknown modules; an unparseable manifest |
| Mirrors | source, target, outcome, detail |
| Review | `Hold for review: yes` with the reasons, or `no` |

`hold` is true on any replaced local edit, any held retirement, any refused mirror, or any registration note.

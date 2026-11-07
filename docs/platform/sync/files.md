---
order: 1
---

# The file list

This page is the grammar of `files.yml`, the one data file the writer reads: what an entry may say, what a module's data may carry, what the loader refuses, which forms the committed file uses today, and which entries one repository selects. How a selected entry is written is [the writer page](writer.md).

## files.yml

The committed [files.yml](../../../files.yml) is the example: every form the loader accepts that the fleet uses today is in it.

| Key                                                         | Meaning                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `placeholders`                                              | The placeholder names sources may use, each spelled as the name inside double braces. Each must be one the writer derives (`PLACEHOLDER_NAMES`).                                                                                                                                                           |
| `modules.<name>`                                            | A module and its data; the keys ARE the module roster, in the order the writer selects and the fleet plan lists. What the data may carry: [Module data](#module-data).                                                                                                                                     |
| `files[].path`                                              | The repository-relative path written. Clean paths only: no `..`, no empty segment, no `.git`.                                                                                                                                                                                                              |
| `files[].class`                                             | `managed`, `split`, or `starter` ([Classes](writer.md#classes)).                                                                                                                                                                                                                                           |
| `files[].source`                                            | The source file, under `files/`, or an upstream ref `{repository, sha, path}` fetched at sync time ([Upstream refs](#upstream-refs)). Default: `files/<first when.modules entry, or base>/<path>`.                                                                                                         |
| `files[].when`                                              | The selection condition ([Selection](#selection)). Absent or empty means always.                                                                                                                                                                                                                           |
| `files[].region`                                            | Split entries only: `hash` for `#` comment markers, `html` for `<!-- -->` markers.                                                                                                                                                                                                                         |
| `files[].blocks`                                            | Managed, split, and starter entries: a module-data key. For each selected module carrying it, in `modules` order, each listed value names one block (below); a value listed twice lands once.                                                                                                              |
| `files[].always`                                            | Managed, split, and starter entries: the blocks taken outside module selection, before the modules' blocks: a bare value by every repository, `{value, when}` by the repositories its `when` selects ([Selection](#selection)); each needs a source in `sources`.                                          |
| `files[].sources`                                           | Managed, split, and starter entries: block value to its source, in the grammar of `files[].source`: a tree file under `files/`, spliced as it reads, or an upstream ref ([Upstream refs](#upstream-refs)). Every value `always` or a module lists has one, and every source is listed by one of them.      |
| `files[].replace`                                           | Entries fetching an upstream source or blocks: literal rewrites `{<from>: <to>}` applied to every fetched body of the entry, in order (`{"[\r]": "?"}` turns the macOS template's class holding a bare CR byte, which check-typography refuses, into a one-character glob). A tree file is edited instead. |
| `files[].render`                                            | Managed entries only, one value: `settings`. The entry has no source; the writer renders the settings document from the `settings` layers and the repository's overlay at `overlay` ([settings.md](../../settings.md)).                                                                                    |
| `files[].overlay`                                           | Rendered entries only, required: the repository-owned file the render folds in (`.github/settings.local.yml`). The path must be written by starter entries only, listed before this entry, and selected exactly when this entry is.                                                                        |
| `settings.baseline`, `settings.layers`, `settings.override` | The settings layers ([settings.md](../../settings.md)), clean paths under `files/`, present exactly when a `render: settings` entry exists: the baseline, then each `{source, when}` layer whose `when` holds (absent means always) in declared order, then the override above the repository's overlay.   |
| `mirrors`                                                   | The fleet's mirrors, in the registration's grammar; [Mirrors](mirrors.md) says how the fleet's list and the repository's are judged as one. A fleet mirror carries no `when`: every repository gets each target, save one its `except` names. Absent means none.                                           |

**Where blocks land:** at the anchor line, the word `blocks` inside double braces, alone on its line, spelled like a placeholder.

- A source without one gets them appended at the end.
- Every piece is newline-terminated first, so the seams never merge two lines.
- The anchor appears at most once and only as a whole line, in sources of entries that declare `blocks` or a non-empty `always` (for a split entry, inside the region body).
- A starter's blocks are rendered once, at creation.

### Module data

| Module data key         | Meaning                                                                                                                                                                                                                                                                      | Reader                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `description`           | the module's one-line description                                                                                                                                                                                                                                            | docs and the PR body                                                       |
| `codeql_languages`      | the CodeQL languages the toolchain contributes; the plan folds the selected modules' lists into one deduplicated matrix                                                                                                                                                      | the fleet plan                                                             |
| `dependabot_ecosystems` | the Dependabot ecosystems the module adds (also its `blocks` list)                                                                                                                                                                                                           | the writer                                                                 |
| `gitignore_sources`     | the github/gitignore templates and platform-authored blocks the module adds (its `blocks` list)                                                                                                                                                                              | the writer                                                                 |
| `agents_toolchain`      | the AGENTS.md block list, the module's own name                                                                                                                                                                                                                              | the writer                                                                 |
| `toolchain_steps`       | the block list, the module's own name, of the three starter workflows that carry per-toolchain steps                                                                                                                                                                         | the writer                                                                 |
| `path`                  | the `site` module only: the URL segment the docs mount under when the repository's site-build hook also builds a website, unless the registration sets `site.path`                                                                                                           | the fleet plan                                                             |
| `tracking_label`        | `{key, default, color, description}` of the module's tracking-issue label; `key` is the registration's `labels` key and `default` backs the `<key>_label` placeholder; `color` and `description` are the tuple the render writes the label with                              | the fleet plan, the writer's settings render, and the placeholder defaults |
| `pin`                   | `{file, repository, tag}`: the module's version dotfile under `files/`, the github.com repository whose latest release it follows, and that repository's release tag with `{version}` where the version stands ([toolchains.md](../../toolchains.md#keeping-the-pins-fresh)) | the refresh workflow                                                       |

- **The typed keys** are `description`, `path`, `tracking_label`, `codeql_languages`, and `pin`. Any other key is a list some entry's `blocks` or a `declaring` clause reads.
- **A module with no files** still appears under `modules` (`custom-license`), so a registration selecting it is known and a `when` can name it.

### What the loader refuses

A malformed file is refused whole, every problem at once, each naming its place and the condition ([files_config.ts](../../../actions/plan/files_config.ts)); the writer's own checks against the `files/` tree ride beside them ([sync/writer/files_config.ts](../../../.github/scripts/sync/writer/files_config.ts)).

## Upstream refs

An upstream ref is `{repository, sha, path}`: a file of a github.com repository at one pinned commit. It may stand where a tree source stands, as `files[].source` or a `files[].sources` value, and both read through one fetcher.

- **Fetched** from `https://raw.githubusercontent.com/<repository>/<sha>/<path>` (`--upstream` swaps the host), every ref once per sync and before any file is written.
- **The body is normalized** (CRLF to LF, trailing spaces and tabs stripped, surrounding blank lines dropped), then rewritten by the entry's `replace`. As a source it is the entry's text.
- **As a block** it is headed in the entry's region comment, `## <value> (<repository> <path>)` under `hash`, `<!-- <value> (<repository> <path>) -->` under `html`, bare on an entry without a region, and ends with a blank line.
- **Two syncs render the same bytes** until [refresh-upstream.yml](../../../.github/workflows/refresh-upstream.yml) moves the pin. Weekly, its `commit` leg moves every distinct `{repository, sha}` the data file spells to that repository's HEAD by one PR on `automation/refresh-commit-pins`, its body each fetched file's diff between the two commits. The next sync renders the change wherever the file lands.
- **A HEAD under which every fetched file's normalized body is unchanged** leaves the pin where it is, so no PR opens for it. The workflow's other leg moves the modules' release pins ([toolchains.md](../../toolchains.md#keeping-the-pins-fresh)) on a branch of their own.

## Placeholders

The names are `PLACEHOLDER_NAMES` in [placeholders.ts](../../../.github/scripts/sync/writer/placeholders.ts); each value comes from the registration, the repository, or the run ([registration.ts](../../../.github/scripts/sync/writer/registration.ts)).

- **A token** is the name inside double braces with no spaces; spaces inside the braces make it plain text.
- **A `$` before the braces** marks a GitHub Actions expression, left untouched.
- **Substitution runs on source files only.** A literal double brace in a repository-owned tail is never touched.
- **An absent or empty value is never written:** an entry whose text needs it is `held` with `no value for <token>`, a Registration note names the registration key to set, and the PR holds. An empty `project.description` holds every entry that uses `description`.

## Selection

| Clause            | Holds when                             |
| ----------------- | -------------------------------------- |
| `modules: [a, b]` | every listed module is selected        |
| `any: [a, b]`     | at least one listed module is selected |
| `without: [a]`    | none of the listed modules is selected |
| `private: true`   | the repository's visibility matches    |

**A list position may name a module-data key instead of the modules:** `any: {declaring: codeql_languages}` is the list of every module whose data carries `codeql_languages`, in `modules` order. The loader expands it, so a list spelled this way follows the modules block and a new module joins it by declaring the key; a key no module declares is a loader error.

- **The selected modules** are the registration's `modules` in `files.yml` order; a name `files.yml` does not offer fails the sync, and nothing is dropped.
- **Two entries for one path must be provably exclusive:** a module one requires and the other forbids, an `any` list the other forbids entirely, or opposite `private` values. Anything subtler is a loader error.
- **The registration's `except`** lists paths the repository keeps as its own: no entry at one is selected, whatever its `when`. A record an earlier sync left there is `released` ([Retirement](writer.md#retirement)).
- **`except` and mirrors:** [the mirrors page](mirrors.md) says what an excepted path does to a fleet target and to a repository target.

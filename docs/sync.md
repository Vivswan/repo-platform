---
order: 232
group: Fleet operations
---

# Sync writer

The sync writer copies the platform's files into a managed repository. It reads one data file, `files.yml`, and one tree of plain files, `files/`. There is no template language and no merge:

| Class | How it is written |
| --- | --- |
| managed content | copied whole |
| split regions | copied between the repository-owned halves |
| starters | copied once |
| mirrors | carry a written file to more paths as copies or relative symlinks |

The one file the writer renders instead of copying is `.github/settings.yml`, folded from the settings layers and the repository's own overlay ([settings.md](settings.md)). Code is the source of truth; this page is the map.

| Question | Owner |
| --- | --- |
| What does `files.yml` look like, and what does the loader refuse? | [actions/plan/files_config.ts](../actions/plan/files_config.ts), the grammar every reader shares (the writer, the fleet plan, the checks); the writer's own checks against the `files/` tree and the placeholder defaults are in [sync/writer/files_config.ts](../.github/scripts/sync/writer/files_config.ts) |
| Which placeholder tokens exist? | `PLACEHOLDER_NAMES` in [sync/writer/placeholders.ts](../.github/scripts/sync/writer/placeholders.ts) |
| How are the values derived from `.repo-platform.yml`? | [sync/writer/registration.ts](../.github/scripts/sync/writer/registration.ts) |
| Which entries apply to one repository? | `selects` in [actions/shared/selection.ts](../actions/shared/selection.ts), the one rule the writer, the fleet plan, and the validator select by; `selectEntries` in [actions/plan/files_config.ts](../actions/plan/files_config.ts) |
| How is each class written? | [sync/writer/write_managed.ts](../.github/scripts/sync/writer/write_managed.ts), [write_split.ts](../.github/scripts/sync/writer/write_split.ts), [write_starter.ts](../.github/scripts/sync/writer/write_starter.ts); the mirrors, the fleet's and the repository's, by [mirrors.ts](../.github/scripts/sync/writer/mirrors.ts) |
| Where do blocks land, and what may a value contain? | `spliceBlocks` and `substitute` in [sync/writer/placeholders.ts](../.github/scripts/sync/writer/placeholders.ts) |
| What happens when an entry's class differs from its record? | `writeEntry` in [sync/writer/sync.ts](../.github/scripts/sync/writer/sync.ts) |
| How is `.github/settings.yml` rendered? | [sync/writer/settings_entry.ts](../.github/scripts/sync/writer/settings_entry.ts) over [settings_layers.ts](../.github/scripts/sync/writer/settings_layers.ts), which folds with the github-settings-as-code library ([settings.md](settings.md)) |
| When does a file the platform stopped writing leave? | [sync/writer/retire.ts](../.github/scripts/sync/writer/retire.ts) |
| What does the manifest record? | [sync/writer/manifest.ts](../.github/scripts/sync/writer/manifest.ts) |
| What holds a PR for review? | `holdReasons` in [sync/writer/report.ts](../.github/scripts/sync/writer/report.ts) |
| The whole run, as a CLI | [sync/writer/sync.ts](../.github/scripts/sync/writer/sync.ts) |

## The command

```text
bun .github/scripts/sync/writer/sync.ts \
  --files files.yml --tree files \
  --target <checkout> --build <full sha> \
  --repository <owner/name> --private <true|false> \
  [--summary <path for the JSON summary>] [--upstream <raw-content host>]
```

- **`--tree`** is the `files/` directory itself; every tree `source` starts with `files/` and resolves under it; a ref source is fetched ([Upstream refs](#upstream-refs)).

- **`--build`** is the delivery commit's full sha, 40 lowercase hex characters (`git fetch origin +refs/tags/stable:refs/tags/stable` then `git rev-parse stable^{commit}`, the forced refspec so a local tag left by an earlier fetch is refreshed). A short or uppercase one is refused before anything is written.

  - Named in full in the PR body, by its first 12 characters in the sync commit's subject, and in the manifest's own entry under the stamp rule ([The manifest](#the-manifest)).

- **`--repository`** names the GitHub repository; the owner is the `github_username` placeholder and the default `copyright_holder`.

- **`--upstream`** is the host every upstream ref (below) is fetched from, `https://raw.githubusercontent.com` by default; the tests serve their fixture over loopback.

- **Output:** the Markdown report goes to stdout. The JSON summary carries the same rows plus `hold` and `holdReasons`.

- **Exit 0** whether or not the report holds the PR.

- **A nonzero exit** is a data or environment error:
  - a `--build` that is not a full sha
  - a bad `files.yml`
  - an unreadable registration
  - a registration naming a module `files.yml` does not offer
  - a manifest record the writer cannot read ([Retirement](#retirement))
  - a recorded commit the build checkout cannot fetch ([The manifest](#the-manifest))
  - a symlinked ancestor at a path the writer touches

  - a directory or a symlink at the manifest or registration path
  - a directory at a stale record's path
  - a split file whose marker text is duplicated or buried mid-line
  - a placeholder value carrying a double quote, backslash, or control character
  - a mirror declaration the writer cannot honour ([Mirrors](#mirrors))

## files.yml

```yaml
placeholders: [project_name, project_slug, description, github_username, github_username_lower, copyright_holder, year, private, fuzzer_label, fuzzer_label_color, fuzzer_label_description]
modules:
  bun: {codeql_languages: [javascript-typescript], gitignore_sources: [Node, bun], dependabot_ecosystems: [bun]}
  fuzzer: {gitignore_sources: [fuzzer], tracking_label: {key: fuzzer, default: fuzz-nightly, color: B60205, description: Automated nightly fuzz failure}}
  release-please: {}
settings:
  baseline: files/settings/baseline.yml
  layers:
    - {source: files/settings/public.yml, when: {private: false}}
    - {source: files/bun/settings.yml, when: {modules: [bun]}}
  override: files/settings/override.yml
files:
  - {path: .github/workflows/ci.yml, class: managed}
  - path: .gitignore
    class: split
    region: hash
    blocks: gitignore_sources
    replace: {"[\r]": "?"}
    always: [Windows, macOS, Linux]
    sources:
      Windows: {repository: github/gitignore, sha: 356fd7baab4c05e092194a41f64dbd5afc8817e4, path: Global/Windows.gitignore}
      macOS: {repository: github/gitignore, sha: 356fd7baab4c05e092194a41f64dbd5afc8817e4, path: Global/macOS.gitignore}
      Linux: {repository: github/gitignore, sha: 356fd7baab4c05e092194a41f64dbd5afc8817e4, path: Global/Linux.gitignore}
      Node: {repository: github/gitignore, sha: 356fd7baab4c05e092194a41f64dbd5afc8817e4, path: Node.gitignore}
      bun: {repository: github/gitignore, sha: 356fd7baab4c05e092194a41f64dbd5afc8817e4, path: bun.gitignore}
      fuzzer: files/fuzzer/fuzzer.gitignore
  - {path: .github/dependabot.yml, class: managed, blocks: dependabot_ecosystems, sources: {bun: files/bun/.github/dependabot.bun.yml}}
  - {path: .github/settings.local.yml, class: starter}
  - {path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.local.yml}
  - {path: AGENTS.md, class: split, region: html}
  - {path: .typography-allow, class: managed, when: {without: [release-please]}}
  - {path: .typography-allow, class: managed, when: {modules: [release-please]}}
  - {path: .github/actions/site-build/action.yml, class: starter}
  - {path: .github/workflows/nightly-fuzz.yml, class: starter, when: {modules: [fuzzer]}}
mirrors:
  - {source: AGENTS.md, kind: symlink, targets: [CLAUDE.md, .github/agents.md]}
```

| Key | Meaning |
| --- | --- |
| `placeholders` | The placeholder names sources may use, each spelled as the name inside double braces. Each must be one the writer derives (`PLACEHOLDER_NAMES`). |
| `modules.<name>` | A module and its data; the keys ARE the module roster, in the order the writer selects and the fleet plan lists. A key is a typed one (`description`, `path`, `tracking_label`, `codeql_languages`, `pin`) or a list some entry's `blocks` or a `declaring` clause reads; anything else is refused (the rule under the module data table). One key carries a placeholder default: `tracking_label: {key, default, ...}` backs the `<key>_label` placeholder (below). |
| `files[].path` | The repository-relative path written. Clean paths only: no `..`, no empty segment, no `.git`. |
| `files[].class` | `managed`, `split`, or `starter` (below). |
| `files[].source` | The source file, under `files/`, or an upstream ref `{repository, sha, path}` fetched at sync time ([Upstream refs](#upstream-refs)). Default: `files/<first when.modules entry, or base>/<path>`. |
| `files[].when` | The selection condition (below). Absent or empty means always. |
| `files[].region` | Split entries only: `hash` for `#` comment markers, `html` for `<!-- -->` markers. |
| `files[].blocks` | Managed, split, and starter entries: a module-data key. For each selected module carrying it, in `modules` order, each listed value names one block (below); a value listed twice lands once. |
| `files[].always` | Managed, split, and starter entries: block values every repository takes, before the modules' blocks; each needs a source in `sources`. |
| `files[].sources` | Managed, split, and starter entries: block value to its source, in the grammar of `files[].source`: a tree file under `files/`, spliced as it reads, or an upstream ref ([Upstream refs](#upstream-refs)). Every value `always` or a module lists has one, and every source is listed by one of them. |
| `files[].replace` | Entries fetching an upstream source or blocks: literal rewrites `{<from>: <to>}` applied to every fetched body of the entry, in order (`{"[\r]": "?"}` turns the macOS template's class holding a bare CR byte, which check-typography refuses, into a one-character glob). A tree file is edited instead. |
| `files[].render` | Managed entries only, one value: `settings`. The entry has no source; the writer renders the settings document from the `settings` layers and the repository's overlay at `overlay` ([settings.md](settings.md)). |
| `files[].overlay` | Rendered entries only, required: the repository-owned file the render folds in (`.github/settings.local.yml`). The path must be written by starter entries only, listed before this entry, and selected exactly when this entry is. |
| `settings.baseline`, `settings.layers`, `settings.override` | The settings layers ([settings.md](settings.md)), clean paths under `files/`, present exactly when a `render: settings` entry exists: the baseline, then each `{source, when}` layer whose `when` holds (absent means always) in declared order, then the override above the repository's overlay. |
| `mirrors` | The fleet's mirrors, in the registration's grammar (`source`, `targets`, `kind`; [Mirrors](#mirrors)), judged and written as one list with the repository's own, the fleet's first. Every repository gets each target, save one its `except` names. Absent means none. |

**Where blocks land:** at the anchor line, the word `blocks` inside double braces, alone on its line, spelled like a placeholder.

- A source without one gets them appended at the end.
- Every piece is newline-terminated first, so the seams never merge two lines.
- The anchor appears at most once and only as a whole line, in sources of entries that declare `blocks` (for a split entry, inside the region body).
- A starter's blocks are rendered once, at creation.

The loader refuses, all problems at once:

- a placeholder the writer cannot derive, or a source file using a token outside `placeholders`

- a `when` naming a module absent from `modules`, or declaring a key no module carries

- a `split` without `region`; `region` on a non-split entry

- a `source` or `sources` tree path outside `files/`, or one missing from the tree

- a `blocks` anchor mentioned twice or mid-line, in a source whose entries do not all declare `blocks`, or inside a block file

- a listed `<key>_label` placeholder no module declares a default for; a default declared by two modules; a `tracking_label` without `key` and `default`, or without `color` and `description` while the data file renders settings

- a `pin` whose `file` is not a clean path under `files/`, whose `repository` is not `owner/name`, or whose `tag` does not spell `{version}` exactly once

- `render` on an entry that is not managed; `overlay` on an entry that is not rendered; a rendered entry with a `source`, `blocks`, `always`, `sources`, or `replace`, or without `overlay`

- a block list that is not a list of names (letters, digits, `_`, `-`); a block value or `sources` key spelled `__proto__`, which the schema would drop

- an upstream ref (a `source` object, or a `sources` value) whose `repository` is not `owner/name`, whose `sha` is not 40 lowercase hex characters, or whose path is not a clean path of letters, digits, `. _ - /`; a value `always` or a module lists that `sources` does not name; a `sources` value neither `always` nor a module lists; `replace` on an entry fetching nothing

- an `overlay` path that is not clean, is the entry's own path, or the manifest; one that any non-starter entry writes or no entry writes; overlay starters listed after the rendered entry; overlay starters not selected exactly when the rendered entry is (an unconditional rendered entry needs one unconditional starter; a conditional one a starter with the same `when`)

- a `settings` block missing while a `render: settings` entry exists, or present with none; a layer path that is not a clean path under `files/`; a layer source declared twice; a layer `when` naming a module absent from `modules` or declaring a key no module carries

- a declared settings layer missing from the tree, not a YAML mapping, or naming one label (case-insensitively) or one ruleset twice

- two entries for one `path` whose conditions can both hold (below)

- a `files` entry at `.github/repo-platform-manifest.json`, the manifest the writer itself writes last

## Upstream refs

An upstream ref is `{repository, sha, path}`: a file of a github.com repository at one pinned commit. It may stand where a tree source stands, as `files[].source` or a `files[].sources` value, and both read through one fetcher.

- Fetched from `https://raw.githubusercontent.com/<repository>/<sha>/<path>` (`--upstream` swaps the host), every ref once per sync and before any file is written. A fetch that fails or answers anything but 200 fails the sync with one `::error::` line, nothing written.

- The body is normalized (CRLF to LF, trailing spaces and tabs stripped, surrounding blank lines dropped), then rewritten by the entry's `replace`. As a source it is the entry's text.

- As a block it is headed in the entry's region comment, `## <value> (<repository> <path>)` under `hash`, `<!-- <value> (<repository> <path>) -->` under `html`, bare on an entry without a region, and ends with a blank line.

- Two syncs render the same bytes until [refresh-upstream.yml](../.github/workflows/refresh-upstream.yml) moves the pin: weekly, its `commit` leg moves every distinct `{repository, sha}` the data file spells to that repository's HEAD by one PR on `automation/refresh-commit-pins`, its body each fetched file's diff between the two commits; the next sync renders the change wherever the file lands. The workflow's other leg moves the modules' release pins ([toolchains.md](toolchains.md#keeping-the-pins-fresh)) on a branch of their own.

## files.yml reference

What the committed `files.yml` uses today, so a reader knows which forms are live. The loader accepts more (above); the file list itself is `files.yml`.

| Entry class | Used for |
| --- | --- |
| `managed` | the workflows the fleet runs unchanged (`ci.yml`, `auto-assign.yml`, the module workflows), `.github/dependabot.yml`, `.yamllint`, `.typography-allow`, the review instructions, the toolchain pin files, and the rendered `.github/settings.yml` (`render: settings`, over the `.github/settings.local.yml` overlay starter) |
| `split` (region `hash`) | `.editorconfig`, `.gitattributes`, `.gitignore`, `.github/CODEOWNERS` |
| `split` (region `html`) | `AGENTS.md`, `LICENSE.md` |
| `starter` | `checks.yml`, `post-green.yml`, the release hooks, the site-build hook (`.github/actions/site-build/action.yml`), `auto-format.yml`, `copilot-setup-steps.yml`, `.gitleaks.toml`, `.github/actionlint.yaml`, `.github/settings.local.yml`, the release-please, fuzzer, and nightly starters |

| Fleet mirror | Targets |
| --- | --- |
| `AGENTS.md`, `kind: symlink` | `CLAUDE.md`, `.github/agents.md`, `.github/copilot-instructions.md` |

| `when` form | Used by |
| --- | --- |
| `modules: [x]` | every module-owned file |
| `any: {declaring: <key>}` | the CodeQL settings layer (`codeql_languages`), `auto-format.yml` (`toolchain_steps`), the Toolchain variant of `AGENTS.md` (`agents_toolchain`) |
| `without: [...]` | `LICENSE.md` (not `custom-license`), the plain variant of `.typography-allow` |
| `without: {declaring: <key>}` | the plain variant of `AGENTS.md` (`agents_toolchain`) |
| `private: true` / `false` | the public, private, and CodeQL settings layers |

A fleet mirror carries no `when`: every repository gets its targets, save one its `except` names.

| `blocks` key | Entry | Block sources |
| --- | --- | --- |
| `gitignore_sources` | `.gitignore` (split) | github/gitignore templates at one pinned sha, fetched by every sync (`Global/Windows.gitignore`, `Global/macOS.gitignore`, `Global/Linux.gitignore` on every repository through `always`; the Node template both JavaScript toolchains list lands once); the fuzzer's failure directory from `files/fuzzer/fuzzer.gitignore` |
| `dependabot_ecosystems` | `.github/dependabot.yml` (managed) | `files/<module>/.github/dependabot.<ecosystem>.yml`, appended at the anchor line that ends the source |
| `agents_toolchain` | `AGENTS.md` (Toolchain variant, split) | `files/<module>/AGENTS.toolchain.md`, the module's Toolchain bullets, appended after the region body |
| `toolchain_steps` | `checks.yml`, `copilot-setup-steps.yml`, `auto-format.yml` (starters) | `files/<module>/.github/workflows/<stem>.toolchain.yml`: the example checks, the setup and install steps, the setup and format steps; each block opens with the blank line that separates it from the step above, and the anchor sits after the checkout step (`copilot-setup-steps.yml` ends there; `checks.yml` and `auto-format.yml` keep one blank line below it before their closing steps) |

| Module data key | Meaning | Reader |
| --- | --- | --- |
| `description` | the module's one-line description | docs and the PR body |
| `codeql_languages` | the CodeQL languages the toolchain contributes; the plan folds the selected modules' lists into one deduplicated matrix | the fleet plan |
| `dependabot_ecosystems` | the Dependabot ecosystems the module adds (also its `blocks` list) | the writer |
| `gitignore_sources` | the github/gitignore templates and platform-authored blocks the module adds (its `blocks` list) | the writer |
| `agents_toolchain` | the AGENTS.md block list, the module's own name | the writer |
| `toolchain_steps` | the block list, the module's own name, of the three starter workflows that carry per-toolchain steps | the writer |
| `path` | the `site` module only: the URL segment the docs mount under when the repository's site-build hook also builds a website, unless the registration sets `site.path` | the fleet plan |
| `tracking_label` | `{key, default, color, description}` of the module's tracking-issue label; `key` is the registration's `labels` key and `default` backs the `<key>_label` placeholder; `color` and `description` are the tuple the render writes the label with | the fleet plan, the writer's settings render, and the placeholder defaults |
| `pin` | `{file, repository, tag}`: the module's version dotfile under `files/`, the github.com repository whose latest release it follows, and that repository's release tag with `{version}` where the version stands ([toolchains.md](toolchains.md#keeping-the-pins-fresh)) | the refresh workflow |

- **Every many-of key is a list,** `codeql_languages` and the block lists alike: a key outside `description`, `path`, `tracking_label`, and `pin` must hold a non-empty list of names, and one spelled as a single word is a loader error naming the module and key.

- **An untyped key no file entry's `blocks` and no `declaring` clause reads** is a loader error naming the module and key too: a typo'd or retired key is refused, never silently skipped.

**Placeholders in use beyond the project block:** `fuzzer_label`, `fuzzer_label_color`, and `fuzzer_label_description` in `nightly-fuzz.yml`; `nightly_label`, `nightly_label_color`, and `nightly_label_description` in `nightly.yml`. No committed source names `site_label`: the site leg does not pass the link-rot label (the plan action resolves it from the registration), so it is not listed.

A module with no files still appears under `modules` (`custom-license`) so a registration selecting it is known and a `when` can name it.

## Placeholders

| Name | Value |
| --- | --- |
| `project_name` | `project.name` from the registration |
| `project_slug` | `project.slug` |
| `description` | `project.description` |
| `github_username` | the repository owner |
| `github_username_lower` | the owner, lower-cased |
| `copyright_holder` | `project.copyright_holder`, else the owner |
| `year` | the current UTC year |
| `private` | the writer's `--private` flag, `true` or `false`; the `.github/settings.local.yml` starter declares the visibility with it |
| `fuzzer_label`, `nightly_label`, `site_label` | `labels.<key>` from the registration, else the `default` of the `modules.<m>.tracking_label` whose `key` is `fuzzer`, `nightly`, or `site` |
| `<key>_label_color`, `<key>_label_description` | the `color` and `description` of the same `tracking_label`: the tuple the starter's report step creates the label with, and the render declares it with |

- **A token** is the name inside double braces with no spaces; spaces inside the braces make it plain text.
- **A `$` before the braces** marks a GitHub Actions expression, left untouched.
- **Substitution runs on source files only.** A literal double brace in a repository-owned tail is never touched.

- **A value lands inside quoted YAML scalars verbatim,** so a value carrying a double quote, a backslash, or a control character is refused twice: the registration grammar (`actions/plan/registration.ts`) rejects such a `project.name`, `project.description`, or `project.copyright_holder`, and `substitute` fails the run on any such value.

- **An absent or empty value is never written:** an entry whose text needs it is `held` with `no value for <token>`, a Registration note names the registration key to set, and the PR holds. An empty `project.description` holds every entry that uses `description`.

## Selection

| Clause | Holds when |
| --- | --- |
| `modules: [a, b]` | every listed module is selected |
| `any: [a, b]` | at least one listed module is selected |
| `without: [a]` | none of the listed modules is selected |
| `private: true` | the repository's visibility matches |

**A list position may name a module-data key instead of the modules:** `any: {declaring: codeql_languages}` is the list of every module whose data carries `codeql_languages`, in `modules` order. The loader expands it, so a list spelled this way follows the modules block and a new module joins it by declaring the key; a key no module declares is a loader error.

- **The selected modules** are the registration's `modules` in `files.yml` order. A name `files.yml` does not offer fails the sync in the plan's words (the refusal the `plan` step of fleet CI gives the PR that introduces it); nothing is dropped.

- **Two entries for one path must be provably exclusive:** a module one requires and the other forbids, an `any` list the other forbids entirely, or opposite `private` values. Anything subtler is a loader error.

- **The registration's `except`** lists paths the repository keeps as its own: no entry at one is selected, whatever its `when`, and a record an earlier sync left there is `released` ([Retirement](#retirement)): the record leaves, the file is not touched.

- **`except` and mirrors:** a fleet [mirror](#mirrors) target at an excepted path is dropped from the fleet's list; a repository mirror target at, under, or above an excepted path is refused as one at a path `files.yml` writes is.

- **An `except` path no `files.yml` entry or fleet mirror writes** is a Registration note, which holds the PR.

## Classes

| Class | Written | Existing local content | Manifest record |
| --- | --- | --- | --- |
| `managed` | whole file, every sync; a `render: settings` entry writes the rendered settings document instead of a copy | replaced and reported (`replaced local edits`, with a diff), holds the PR | `hash` = sha256 of the file |
| `split` | the marker-bounded region, every sync | everything above BEGIN and below END is kept; a file that never mentions the markers gets the region above its content and the verdict `region added`, which holds the PR; marker text duplicated or buried mid-line fails the run | `hash` = sha256 of the region, marker lines included |
| `starter` | once, when the path is absent (a link there counts as present) | never touched again | no hash |

Change verdicts per written row:

| Verdict | Meaning |
| --- | --- |
| `created` | absent before |
| `updated` | was exactly the recorded content |
| `unchanged` | already the new content |
| `replaced local edits` | was neither |
| `region added` | a split region placed above repository-owned content |
| `held` | not written; the Detail column says why |

What holds an entry:

- **A symlink at a managed or split entry's path:** the writer never reads through a link and has no record of writing one there.

- **A directory** (or anything else that is neither a file nor a link) at the path of an entry of any class: held with `<what> sits at the path, and the writer will not replace it`.

- **A rendered entry's overlay path holding anything but a regular file:** held too, with the detail naming what sits there.

- **A rendered entry whose overlay is missing, does not parse, names one label twice,** or whose registration's tracking labels are refused ([settings.md](settings.md)).

## Class flips

A path recorded under one writer class (`managed`, `split`, `starter`, `mirror`) that `files.yml` now declares under another is a class flip. `files.yml` is the truth for a path's class, and the recorded content is the platform's own previous write, so:

| State | Outcome |
| --- | --- |
| the path already holds exactly what the entry writes | `unchanged`; the record takes the new class |
| what sits there is the recorded write (same rule as retirement: whole-file hash, clean region with nothing outside it, or link target) | removed and written whole under the new class: `updated` |
| anything else, a `starter` record included | the record is stale, and the file is written as an unrecorded one under the new class, with the detail `class changed from <old> to <new>; the record was stale, so the file was judged unrecorded` (the rows below) |
| the new class is `starter` | a handover: the file is the repository's own, nothing is held |

A stale record's file, judged unrecorded under the new class:

| The file | Written as |
| --- | --- |
| a `managed` entry | `replaced local edits` with the diff; the write's own record replaces the stale one and the PR holds once |
| a `split` entry | `region added` (or `replaced local edits` when the file already carries the markers); the write's own record replaces the stale one and the PR holds once |
| already the incoming content (a `split` region above a repository-owned tail, say) | `unchanged` with the same detail, the record restamped, no hold |
| held (a symlink where a file is declared) | the detail is the writer's refusal reason, the previous record is kept, and the path is held again next run |

Without the rule, a managed file that becomes split would have the region prepended above its old content and report `updated`.

## Retirement

A recorded `managed` or `split` path that no selected entry writes now (a module deselected, or an entry that left `files.yml`) is stale, and retirement runs over the stale records before writing, every row with the detail `no longer selected`.

Rows appear only for files present, save a `released` row, which reports a record; an unrecorded file produces no row, since no manifest record vouches for it and it is not the platform's to retire.

| State of the stale file | Outcome |
| --- | --- |
| `managed`, content equals the recorded hash | `deleted` |
| `split`, region equals the recorded hash, nothing outside the region | `deleted` |
| `split`, region equals the recorded hash, repository-owned content outside it | `region removed` (below) |
| `split`, region equals the recorded hash, only blank lines outside it | `deleted`, with the detail saying so |
| `split`, region differs from the recorded hash, or markers missing or malformed | `held` |
| a symlink where a `managed` or `split` file was recorded | `held` |
| content differs | `held` |
| a `managed`, `split`, or `starter` record at a path the registration's `except` names, whatever sits at the path | `released`: the record leaves, nothing at the path is probed or touched, and the PR does not hold; the row appears whether or not a file is present, since the manifest changed |

**`region removed`:** the marker lines and the region go, the content above and below stays byte for byte as a plain file, and the record leaves.

- The blank lines that framed the region become one when content stands on both sides and none when it stands on one side only, so a tail under a top region starts at its first content line, and blank lines away from the seam stay.

- The PR holds this once, with a detail asking the reader to complete the file (a heading and intro if it lost them) or delete it.

- Next run the path is unrecorded and produces no row.

- **A stale record at a path no `files.yml` entry declares at all** (a hand edit, or an entry that left `files.yml`) is retired the same way and, while a file sits at the path, noted (`manifest record for <path> had no writer: ...`), which holds the PR for the Retired row's outcome; a recorded path that is not a clean repository path is ignored and noted.

- **A held file and a held entry keep their records** in the new manifest every run, so the file is held again next time and never becomes an unrecorded orphan.

- **A `starter` record whose entry nothing selects** leaves the manifest; the file is the repository's own either way.

- **A `mirror` record no declaration reaches any more** (a fleet target the registration excepts included) is dropped with a note; the copy stays as the repository's own, and a mirror declared again adopts it while it still holds the source's content.

- **A record that is not exactly a shape the writer writes** (an unknown class, a field the class does not carry, a hash that is not a sha256 digest, a `mirror` kind other than `symlink`, a `split` without a known grammar or its markers) fails the run with a count before anything is written.

- **The fix for such a record:** the target's own `validate-managed-files` check shows the refusal, so the fix is a manifest edit (git history has the stamped original) and a new dispatch.

- **A file the platform stops writing needs no grammar of its own:** its entry leaves `files.yml`, and every target retires the recorded file as above on its next sync. A transition the sync cannot carry by itself is one rung in `migrations/` ([Migrations](#migrations)).

## Migrations

`migrations/` is the only home for transitional code ([fleet-guidelines.md](fleet-guidelines.md#no-backwards-compatibility-code)): the writer and the validator know the current shape alone, so a fleet transition the writer cannot carry by itself (a manifest record class that left, say) is one rung there.

- **A rung** is one self-contained bun script, `migrations/<NNNN>-<what>.ts <checkout>`, numbered in the order it was written, idempotent (a checkout it has already crossed is a no-op), and never retired: a target that missed a round crosses every rung on its next sync. Its stdout is the checkout-relative paths it wrote, one per line, and nothing else; anything it has to say goes to stderr.

- **The operator runs every rung** in the build's `migrations/` over the target checkout, in name order, before the writer reads it ([sync/migrate.ts](../.github/scripts/sync/migrate.ts)); nothing outside `migrations/` knows any rung. The runner writes the union of the reported paths to `$RUNNER_TEMP/migrated.txt`, NUL-separated, once every rung has finished.

- **A rung that exits nonzero fails the row:** the rungs after it and the writer do not run, nothing is delivered, and the failure is filed as the writer's with the rung's line in the log tail.

- **A rung ships with the PR that changes the shape** and rides the same fleet-sync round (`fleet-sync:all`), with one test seen red on the old shape and a no-op control.

- **A rung's edit is committed because the rung reported it:** the delivery stages the runner's list, the writer's paths, and the manifest, nothing else, so an edit at a path neither the rung printed nor the writer's report or the manifest names stays out of the commit.

| Rung | Transition |
| --- | --- |
| `0001-link-records-are-mirrors` | a `link` manifest record becomes `{"class": "mirror", "kind": "symlink"}` with its hash kept, the fleet's `AGENTS.md` symlinks having become mirrors the fleet declares |

## Mirrors

Two `mirrors` lists in one grammar (`source`, `targets`, `kind`) carry a file this sync wrote to each target: the fleet's in `files.yml`, then the repository's in its registration.

- **One pass judges and writes both as one list,** the fleet's declarations first, so a repository target meeting a fleet target is judged as any two claims on one path are (below): refused when it is another source's, another kind's, nested, or a literal spelled twice; a pattern of the same source and kind finds the fleet's literal current.

- **A fleet target the registration's `except` names** is dropped from the list, as an entry at that path would be.

- **A failure line names the document that declares the pair:** the registration when it does, `files.yml` otherwise.

- **`kind`** is how a target carries the source, and every reader judges the target through it: `copy` (the default) writes the source's bytes; `symlink` places a symbolic link to the source, relative to the target's directory (`skills/a/LICENSE.md -> ../../LICENSE.md`). A Windows checkout materializes a link only with `core.symlinks` on; no fleet runner is Windows today.

- **Single-segment `*` globs:** a `*` directory segment matches directories, a final `*` matches existing files, a literal final segment lands in every matched directory. A glob never creates a directory.

- **Literal targets are written before any glob expands,** so a directory a literal creates is matched in the same run; a target a literal claims stays the literal's.

- **A symbolic link above a target,** in a literal or a `*` directory segment, is never followed or listed through: a linked directory, or a link that cannot be looked through (resolving to nothing, to a name too long, or through a directory the runner may not read), fails the run by name, the rest of the pattern riding along (`skills/link/sub/*.md`).

- **A link that provably resolves to a file:** only such a link that provably resolves to a file is no directory and is passed over like a file.

- **A link a final segment matches** is the target itself, judged by the declared kind (the table below).

- **A matched path the grammar refuses** (one grown past 1024 bytes through long directory names) is never probed and fails by name the same way.

**Every declaration is either written or fails the run:** a copy the writer cannot make would leave the repository out of sync with only a hold row to show it. Two readers judge it.

**The `plan` step of fleet CI rejects,** on the PR that introduces it, what `files.yml` alone proves unwritable (the rules in [actions/plan/mirrors.ts](../actions/plan/mirrors.ts)):

| Refused on the PR | Detail |
| --- | --- |
| a source that is not a `managed` or `split` file `files.yml` writes for the repository | |
| a `**` | |
| a target or pattern that is unsafe | a control character, a segment over 255 bytes, or a path over 1024 bytes included |
| a target or pattern that is or sits under the registration itself, or sits under `.github/workflows/` | |
| a target or pattern that is, sits under, or is a path prefix of a path `files.yml` writes or the registration excepts | |
| a pattern that matches (segment for segment, as the writer expands it) the registration or a path `files.yml` writes or the registration excepts | the claim reserves the path, whether or not the file stands in the checkout that run |
| every path a declaration is certain to claim, judged as the writer judges a claim (the rows below) | over the literal targets and the directories they create: the only part of the tree the plan knows, since the literal pass writes them before any pattern expands |

A path a declaration is certain to claim is refused when it is:

| Certain claim refused | Detail |
| --- | --- |
| a literal target declared twice | |
| a path nested with another claimed path | both sides, whatever their sources; a pattern's own text counts as written, so `skills/*` nests under a literal `skills`, while two different pattern texts are nested as written, never by what they can match: `tests/*/foo` with `tests/a*/foo/bar` passes the plan and fails at sync time on any checkout with a `tests/a*` directory |
| a pattern's path that sits under or above a path `files.yml` writes or the registration excepts, or that the grammar refuses | |
| a path claimed by two sources or as a copy and as a symbolic link | one pattern text declared twice included, since both expand alike |

**The writer runs the same check,** with the stale manifest records it retires reserved alongside (`a path a stale manifest record retires`), then judges each pass's claims the same way with what only the checkout shows.

**A failure exits nonzero,** one `::error::` line per verdict for each declaration and path (`<.repo-platform.yml or files.yml>: mirrors: source '<s>', target '<t>': <reason>`, a pattern's reason naming the path it expanded to), before the pass writes anything: no PR is opened, the operator's row reads `failed, report filed in the target repository`, and the failure issue's writer log carries the lines.

| Outcome | When |
| --- | --- |
| `written` | the target was absent, or held exactly the previous mirror (the hash of its `mirror` record, of either kind: a copy where a link is declared now, or the reverse, is replaced without a diff; a record of another class does not vouch for the bytes) |
| `current` | the target already holds the new content: the bytes for a `copy`, a link to the source for a `symlink` |
| `replaced local edits` | the target held other content: a file with other bytes, a file where a link is declared, a link where a copy is declared, or a link elsewhere where a link is declared; the diff (of link targets where a link is declared; of the old link target against the new bytes where a copy is) is in the Replaced local edits section and holds the PR |
| `replaced` | a directory stood at the target (removed whole, the links inside unlinked and never followed) or a file stood where an ancestor directory must be (removed); the detail names which, and holds the PR |
| the run fails | the source was held this run; the pattern matches nothing, or reads through a symbolic link or a file in its literal prefix; a claimed path is unsafe, nests with a path `files.yml` writes, a stale record retires, or the registration excepts, sits under a symbolic link, or (a pattern's) sits under a file or in a directory that does not exist; a path is a prefix of or sits under another target (both sides; a target an earlier pass settled included); a path is claimed by more than one source, or as a copy and as a link. Every claim of a pass is judged before the pass writes |

Every row's target is recorded as class `mirror` with the copy's hash, or with `kind: symlink` and the hash of the link target string, so the next sync can tell its own previous write from a local edit ([docs/new-repo.md](new-repo.md#mirror-copies-of-platform-files)).

## The manifest

`.github/repo-platform-manifest.json`, the layout `actions/shared/manifest.ts` already parses: one entry per line, sorted by path.

- **The manifest's own entry** is `managed` with `hash: null` and `commit`, the repo-platform commit the repository is judged against:

```json
".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": "c07568b70e1f4b0a9d2c3e4f5a6b7c8d9e0f1a2b"}
```

- **The stamp rule** (`judgedCommit` in [sync/writer/judged_commit.ts](../.github/scripts/sync/writer/judged_commit.ts)): the entry moves to the build when the sync wrote a change or the checker changed, and stays otherwise. The manifest is written last, so the decision reads the run's own outcome.

| The manifest names | The build is | The sync | The entry after the sync |
| --- | --- | --- | --- |
| no commit the writer can read (a manifest from before the field, or a hand edit) | any | any | the build |
| commit C | C | any | C |
| commit C | N | wrote at least one byte differently: a managed, split, starter, or mirror write, a retirement, a replaced local edit, or a manifest record moved | N |
| commit C | N, with the checker different between C and N | wrote nothing | N |
| commit C | N, with the checker byte-identical between C and N | wrote nothing | C; no sync PR opens |

- **The checker surface** is `actions/validate-managed-files/check.ts`, `.github/scripts/sync/`, `.github/scripts/shared/`, `actions/plan/`, `actions/shared/`, and `actions/pages-site/.vitepress/conventions.ts`: the roots of check.ts's import closure (`CHECKER_SURFACE` in [sync/writer/judged_commit.ts](../.github/scripts/sync/writer/judged_commit.ts)), exactly the code that runs at the recorded commit. A change there can turn C's verdict away from N's with no byte written: N's registration parser accepts a `site.path` C's rejects, so C's check would stay red with no sync PR to move the stamp.

- **What runs at `stable` never restamps:** the action's `src/` and `validator/` reach every repository the moment the tag moves, and a theme file outside `conventions.ts` is off the surface too.

- **Why not every platform change:** a docs-theme change under `actions/pages-site/` once restamped nine repositories with one-line manifest PRs (copilot-env #279, after repo-platform #356); under this rule that sync writes nothing, moves nothing, and opens no PR.

- **The diff runs in the build checkout** under `build/`, which is one commit deep, so the writer fetches C by sha first, before anything is written; a C the remote cannot serve fails the run.

- **The delivery commit** is also named in full by the PR body and by its first 12 characters by the sync commit's subject.

### Judged at the synced commit

The fleet's `validate-managed-files` check judges a repository as [check.ts](../actions/validate-managed-files/check.ts) judges it at the commit the manifest records, byte to byte against what that platform tree writes, so a platform change reddens a repository only once it syncs.

- **The action reads the recorded commit first** ([shared/recorded_commit.ts](../actions/shared/recorded_commit.ts)), checks out repo-platform at it inside the tree at `.repo-platform-judge`, installs that checkout's dependencies, runs its `check.ts` over the repository, and removes the checkout before the hygiene checks walk the tree.

- **`check.ts` copies the repository to scratch** (what git lists when the target is a checkout's own root; every path but `.git` in any other tree), runs the tree's own writer over the copy with `--build` as the commit, and removes the copy.

- **Every reason the writer would hold** the sync PR for is printed first (a link or a directory where a file is declared, a placeholder with no value), then every path whose bytes differ, the manifest's own line included, with a unified diff under each changed file. A pending registration change is red until the sync that carries it lands.

- **Exit 0** when identical, 1 with findings, 2 when the writer refused (its message is the output).

| The action finds | The verdict |
| --- | --- |
| no `commit` on the manifest's own entry | not judged: `no synced commit recorded; merge the pending sync PR or dispatch a sync` |
| a `commit` that is not a full 40-hex sha, or a manifest that does not parse | not judged, the reason naming the manifest |
| a commit repo-platform's history lacks (the checkout fails) | not judged, the checkout step's outcome in the reason |
| a repository path at `.repo-platform-judge`, where the check places its checkout | not judged: move it |
| `check.ts` exit 1 or 2 with output | findings: its output fenced under `#### repo-platform at <commit>`, with the remedy |
| `check.ts` exit 1 or 2 with no output, any other exit, a signal, or the deadline | not judged: `ended without a verdict`, with the detail |
| `check.ts` exit 0 | clean, unless a hygiene check finds something |

- **Freshness informs and never fails:** the action compares the recorded commit with the `stable` tag in the platform checkout (git ancestry alone) and writes one line to the job summary and an annotation: up to date; `stable` moved N commits past it; or the commit is not on `stable`'s history. In both of the last two, a sync moves the judge under [the stamp rule](#the-manifest).

- **The hygiene checks** (YAML, conflict markers, `release-as`) read no platform data and run from the action at `stable` ([new-repo.md](new-repo.md#the-managed-files-check)). Their walk skips `.git` and what the repository's own `.yamllint` `ignore:` list names (gitignore-style patterns, as yamllint reads them), so the scan and the yamllint step judge one tree.

**Classes recorded:** `managed`, `split` (with `grammar`, `begin`, `end`), `starter`, `mirror` (with `kind: symlink` for a link, hash of the target string); a fleet mirror is recorded as a repository mirror is. The record is how the next sync tells the platform's own previous write from a local edit, for replacement and for retirement.

## The report

| Section | Content |
| --- | --- |
| header | Build, Modules, Visibility |
| Written | path, class, change, detail for every selected entry (detail is a held row's reason, or the stale-class explanation on a class-flip row) |
| Replaced local edits | one unified diff per replaced file, capped at 40 lines |
| Retired | path, outcome, detail |
| Registration notes | an unparsable manifest; a placeholder with no value and the key that sets it; a manifest record at a path that is not a clean repository path; a stale record no `files.yml` entry declares now, while a file sits at its path; a mirror record no declaration reaches; an `except` path no `files.yml` entry or fleet mirror writes |
| Mirrors | source, target, outcome, detail |
| Review | `Hold for review: yes` with the reasons, or `no` |

**`hold` is true on** any held or `region added` written row, any replaced local edit (a mirror's included), any held or `region removed` retirement, any `replaced` mirror, or any registration note.

**The report's shape defends itself:**

- Table cells escape `|`, so a path or detail carrying one keeps the columns.

- Every cell, note, and code-formatted value (the replaced-file headings included) is printed on one line: a newline inside a registration value or a manifest path (the writer copies both into the report verbatim) cannot end the row and start a heading of its own.

- A replaced diff sits in a fence one backtick longer than any backtick run its lines open with, so the target's own content cannot close it.

**The PR body stays under GitHub's 65,536-character limit** (`BODY_CAP` in [sync/deliver.ts](../.github/scripts/sync/deliver.ts)): the header and the Review section take their room first, then the tables and notes, then the replaced-edit diffs; a section the room runs out on ends in a warning naming how many characters were cut, and one with no room left is dropped.

## This repository as a target

The sync targets this repository like any other: its [.repo-platform.yml](../.repo-platform.yml) registers it, and the writer keeps its root copies of the files it ships (`.editorconfig`, the `.gitignore` region, `LICENSE.md`, the `AGENTS.md` region, the rendered `.github/settings.yml`, the links) by sync PR, recorded in its own manifest.

- **Its `except`:** the paths whose file is this repository's own and cannot be the fleet's (its `ci.yml`, `dependabot.yml`, `.yamllint`, and the starters it does not take).
- **Its CI** runs the [plan action](../actions/plan/action.yml) over the registration and then the [validate-managed-files action](../actions/validate-managed-files/action.yml) from the checkout, as fleet CI does: this checkout's action shell runs, the recorded commit's `check.ts` judges. A PR that changes `files/` stays green until this repository syncs itself.
- **Its `.yamllint`** ignores `files`, so the writer's templates (placeholder tokens, not YAML) are outside the hygiene scan as they are outside yamllint.

## The operator

[sync-repos.yml](../.github/workflows/sync-repos.yml) runs the writer against every managed repository: a `plan` job, then one `sync (row <i>)` job per row.

- **It wakes** on the Tuesday cron (the weekly heal), on a dispatch, or as the called leg of a merge's post-green run ([all-green.md](all-green.md#after-the-gate)).
- **The job shape is the redaction:** the public log carries row indexes and the vocabulary below, nothing else, and every detail lands in the target repository ([private repositories](#private-repositories)).

| Step | Script | What it does |
| --- | --- | --- |
| plan: resolve the build | [sync/resolve_build.ts](../.github/scripts/sync/resolve_build.ts) | the commit the `stable` tag names, re-verified main history with a green `all-green` check ([build-provenance.md](build-provenance.md)) and carrying `files.yml`; every row checks out exactly this commit |
| plan: discover and select | [fleet/discover_repos.ts](../.github/scripts/fleet/discover_repos.ts), [fleet/select_sync_repos.ts](../.github/scripts/fleet/select_sync_repos.ts) | the rows: the repositories the fleet token can push to that have adopted the platform, narrowed by the dispatch `repo` input or the called `repos` scope ([fleet/sync_scope.ts](../.github/scripts/fleet/sync_scope.ts)), written sorted to `$RUNNER_TEMP/rows.json`, and the matrix rows: one `{row, key}` per row, the key an HMAC of the slug under the fleet token and the run id in three-character groups (`edd~166~...`: opaque in the public log, so a private row is identified without being named, and spelling no four characters of a private name, since the runner drops a job output that carries a masked value); the log names the public slugs and counts the private ones |
| plan: print | [sync/verdict.ts](../.github/scripts/sync/verdict.ts) `plan` | `plan: <N> rows` |
| row 1: check out | actions/checkout | repo-platform, then the delivery commit the plan resolved under `build/`, whose dependencies are installed there (`bun install --cwd build`) so its writer renders with its own versions |
| row 2: resolve | [sync/resolve_row.ts](../.github/scripts/sync/resolve_row.ts) | one listing of the owner's writable repositories (the same call discovery makes, no re-selection), the row's key recomputed over it and the one repository carrying it taken (no such repository: the step refuses, naming no repository); every form of the name is registered with the masker before anything else prints; a dispatched branch is probed with one `git ls-remote` and a branch the repository does not have refuses too; the name and its visibility ride `GITHUB_ENV` from here (the next run step's preamble spells them under `env:`, masked by then) |
| row 3: check out the target | [sync/checkout_target.ts](../.github/scripts/sync/checkout_target.ts) | a captured `git clone` with the fleet token (actions/checkout echoes git's diagnostics, which can quote target file text), at the dispatched branch when there is one; the token is stripped from the remote afterwards; `continue-on-error` |
| row 4: migrate | the build's own [sync/migrate.ts](../.github/scripts/sync/migrate.ts), run from `build/` | every rung of the build's `migrations/` over the target, in name order ([Migrations](#migrations)); the paths the rungs reported to `$RUNNER_TEMP/migrated.txt`; its log is `sync.log` until the writer's report replaces it; `continue-on-error`, and a failed rung skips the writer |
| row 5: write | the build's own [sync/writer/sync.ts](../.github/scripts/sync/writer/sync.ts), run from `build/` | the one writer step, so the commit the manifest records is the code that wrote the tree: report to `$RUNNER_TEMP/sync.log`, summary to `summary.json`, `continue-on-error` |
| row 6: deliver | [sync/deliver.ts](../.github/scripts/sync/deliver.ts) | a commit on `automation/repo-platform` staging the manifest, the paths the writer's summary says it changed, and the paths the rungs reported, each a literal pathspec (a `[` in a name is that character, not a class) forced past the target's own `.gitignore` (nothing else is staged, and a path git cannot find fails the row), pushed with a lease, and a PR whose body is the report (auto-merge armed only when `hold` is false and the run's `manual` input is false); a refresh re-bases the PR onto the checkout's default branch, and a fork's PR from a same-named branch is never taken for the sync's; a tree that already matches the build closes any open sync PR as obsolete (disarmed, closed with a one-line comment, its branch deleted); a failed checkout, writer, or push files or refreshes one `[repo-platform] sync failed` issue in the target with the log tails; every line goes to `$RUNNER_TEMP/deliver.log`; on a branch dispatch the commit lands on the dispatched branch instead ([syncing a branch](#syncing-a-branch)) |
| row 7: print | [sync/verdict.ts](../.github/scripts/sync/verdict.ts) `row` | one verdict line |

The vocabulary, complete (`tests/sync/verdict.test.ts` pins it):

```text
plan: <N> rows
row <i>: unchanged
row <i>: PR opened
row <i>: PR refreshed
row <i>: branch pushed
row <i>: failed, report filed in the target repository
row <i>: failed before the target was resolved; re-run the workflow
```

- **A row is red only when a step before or at the resolve failed** (the install, the build checkout, the listing, the resolve itself): the printer then prints the unresolved line, and the failed step's exit status is the whole public signal; the plan job listed the same repositories moments earlier, so re-running the workflow is the remedy.

- **From the checkout on,** the steps continue on error and the failure is delivered to the target; the row stays green with its verdict line. The one exception is a target that cannot take the failure report (no Issues grant): that row prints nothing and is red.

- **Where the detail is:** a delivered row's PR body; a failed row's issue (the tails of the checkout, writer, and delivery logs).

- **`branch pushed`** is a branch dispatch's clean row ([syncing a branch](#syncing-a-branch)); the other lines mean the same on it.

- **A row is bound to its repository by the key of its slug,** not by index, and the listing is the check, not a re-selection. No count or order change moves a row onto another repository.

| A repository that, mid-run, ... | Its row |
| --- | --- |
| the listing no longer names (a private one revoked from the grant, any one renamed) | has no listed slug carrying the key, so the row refuses (red, `re-run the workflow`) |
| is a public one revoked | stays listed (the listing reports the user's permission, not the token's grant) and its row fails where the token first writes |
| un-adopted | is still listed, so its row runs and the writer's failure on the missing registration is delivered to it (the next plan drops it) |
| adopted | has no row until the next run |

The residual is a slug another writable repository takes within the run: the row syncs that repository as the plan's.

### Syncing a branch

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<name> -f branch=<branch>
```

The same row runs against that branch: the clone checks it out, the writer reads the registration on it, and the delivery commits the writer's output onto it as one commit (`chore: sync repo-platform build <sha>`), pushed with a lease on the commit the row cloned, so a commit pushed to the branch meanwhile fails the push instead of being overwritten.

A PR that changes a module selection carries its own files this way, declared and delivered together ([new-repo.md](new-repo.md#changing-the-module-selection)).

- **No sync PR, no auto-merge, and no issue touched on a clean run:** the failure issue is the default-branch sync's. A failed checkout, writer, or push files it as any delivery failure does.

- **The report** the PR body would carry goes to the run's job summary, for a public repository; a private repository's summary says the report is withheld, and the commit on the branch is the record.

- **`repo` names exactly one repository** (no list, no `all`, no visibility token, no `modules:` filter), and `manual` is refused beside `branch`: both refuse in the plan job, before any repository is probed.

- **A branch the repository does not have,** or its default branch (a direct push there would pass the repository's PR gate; the plain dispatch syncs it through a PR), refuses in the row's resolve step, so the row prints `failed before the target was resolved`.

- **The branch name** rides the event payload as the repository name does, never step env, and never reaches the log; a public repository's job summary is the one place that names it.

### Syncing a branch by label

A human adds the `repo-platform:sync` label to a pull request; the repository's own managed [sync-branch.yml](../files/base/.github/workflows/sync-branch.yml) syncs the branch with the repository token, so nothing reaches the operator and no fleet token is involved. Nothing adds the label but a human.

```text
label added -> checks out the branch and the platform at `stable`
            -> the migrations, then the writer over the branch (the operator's row 4 and 5)
            -> the delivery step takes the label off
            -> one commit onto the branch, pushed with a lease on the commit it checked out
            -> one sticky comment on the pull request carrying the report
```

| Outcome | Job | Comment says |
| --- | --- | --- |
| files written | green | pushed as `<commit>`; approve the head's held pull_request run from the merge box, or push a commit; then the report |
| tree already matches | green | nothing pushed |
| the writer holds (a replaced local edit, a registration note, a link in a managed file's place) | red, nothing pushed | the report with its Review section: a hold is a human's call, and the branch is a human's |
| the sync changes a file under `.github/workflows/` | red, nothing pushed | the paths, and the operator's branch dispatch as the way: the repository token cannot create or update a workflow file |
| a rung or the writer failed | red, nothing pushed | the log tail |
| a written path git cannot stage | red, nothing pushed | no comment; the job log carries git's line naming the path |
| the push refused (a commit reached the branch meanwhile, a rule the token cannot meet) | red | git's message; add the label again once the branch is where you want it |

- **Same-repository branches only:** a fork's pull request skips the job at zero billed minutes (its token could not push), and so does any other label.

- **The pushed head's checks wait for a human:** GitHub holds the `pull_request` run a repository-token push creates for approval, so approve it from the merge box (or push a commit of your own) to run them.

- **The platform dispatches nothing:** a `workflow_dispatch` run of `ci.yml` would post `all-green` on the head while skipping the pull-request-only legs, and the `pr-title` module's check never posts on one, a weaker gate than the held run.

- **What is committed:** the manifest, the paths the writer's report says it changed, and the paths the rungs reported, each a literal pathspec staged forced, so a path the repository's own `.gitignore` covers lands in the commit that names it and a `[` in a name stages that name alone.

- **What the label covers:** toolchain pins, the rendered settings, the `.gitignore` and `AGENTS.md` regions, the manifest stamp, and the validator's drift findings on any file outside `.github/workflows/`. A change under `.github/workflows/` stays with the operator's branch dispatch.

- **The job holds** `contents: write` and `pull-requests: write` (the comment and the label), nothing else, with no secret.

- **A run that goes red before the delivery step** (a checkout or the install) leaves the label on: remove it and add it again to retry.

- **The label is declared** in the baseline settings layer ([settings.md](settings.md#what-the-baseline-contains)); the validator's red comment names it as the remedy for managed drift.

## Private repositories

repo-platform is public, and GitHub Actions has no log-level access control: run logs, job names, step headers, and annotations are as readable as the repository they run in. The operator therefore never lets a private repository's name or content reach that log. Four rules carry the whole model; the job shape enforces them, not a per-step discipline.

| Rule | Where it lives |
| --- | --- |
| **Index-only names.** The matrix carries row indexes and opaque keys (an HMAC of the slug under the fleet token and the run id, in three-character groups: the runner drops a job output that carries a masked value, so no four characters of the matrix may spell a private name), the job names row indexes (`sync (row 3)`), never repository names. The plan names public repositories and counts private ones. | [sync-repos.yml](../.github/workflows/sync-repos.yml) |
| **Mask at the boundary.** One step per row lists the owner's writable repositories, finds the one whose key is the row's, and registers every form of the name (slug and bare name, each lower-cased too; the masker matches substrings, so every URL spelling of the slug falls with it) with the runner's masker before anything else prints. The name then rides `GITHUB_ENV` alone, which the next run step's preamble spells under `env:` already masked; the target is cloned by a script whose git output is captured, never by the checkout action. | [sync/resolve_row.ts](../.github/scripts/sync/resolve_row.ts), [sync/checkout_target.ts](../.github/scripts/sync/checkout_target.ts) |
| **Logs to files.** Every later `run:` step writes its whole output to a `$RUNNER_TEMP` file; the writer's report and the delivery log never touch stdout. The only lines printed are the operator's vocabulary above. | the row job's step shape |
| **Details in the target repository.** The report becomes the sync PR's body; a failure's log tails become one reused `[repo-platform] sync failed` issue there. Both are exactly as private as the repository. | [sync/deliver.ts](../.github/scripts/sync/deliver.ts) |

The same job runs for public and private targets: nothing is conditional on visibility except the report's `Visibility` cell and a branch dispatch's job summary, which withholds a private repository's report ([syncing a branch](#syncing-a-branch)).

What a run still shows:

- `plan: <N> rows` and one `row <i>: ...` line per row.

- The delivery commit the run ships: it names THIS repository's main history, not a target.

- A step's exit status, and the red step's own error when a row failed before its target was resolved (nothing target-derived exists yet at that point).

- The plan job's selection line, which names public repositories in the clear and counts the private ones.

The settings apply ([settings-repos.yml](../.github/workflows/settings-repos.yml)) runs the same shape, with its own delivery ([settings.md](settings.md#how-the-apply-works)):

- **The plan** names public targets and counts private ones, and masks every form of a private slug before anything prints. Its matrix carries keyed rows: an HMAC of the slug under the fleet token and the run id.

- **Each apply row** resolves its key against one listing of the owner's repositories and registers the name with the masker. Only then does the library's CLI run, on that one target.

- **The CLI** shows a private target as `private repository #N` (`--private-repos redact`). Its full report goes to a reused issue on the target itself, pinned by the `settings-as-code-report` label.

Limits, stated plainly:

- **The masker is substring-based,** so a private repository's bare name is registered only from four characters (masking `api` would garble every innocent occurrence of those letters); the file-and-target rules do not depend on the mask.

- **Inside one row job,** an innocent occurrence of the repository's name (a dependency sharing it) renders as `***` too. Cosmetic, and scoped to that job.

- **Mask registration is a snapshot:** a repository renamed while its row runs surfaces under its new name, which no mask covers.

- **The `repo=` input** typed into a dispatch stays off the log: the plan reads it from the event payload, never from step env, and refusals count entries instead of quoting them.

- **The failure issue and the PR body are write-forward:** a report delivered while the repository was private stays in the issue's edit history forever. Flipping a repository public publishes it; delete the report issue before a deliberate flip.

- **The [site module](site.md)** publishes a PUBLIC site even from a private repository, `<owner>.github.io/<repo>` included; that is outside this model entirely.

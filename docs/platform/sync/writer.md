---
order: 2
---

# The writer

This page is how the writer runs and writes: its command, how each class of file is written and what holds the PR, a path whose class changed, how a file the platform stopped writing leaves, the rungs that carry a transition the writer cannot, and the report. What an entry may say is [the file list](files.md); [mirrors](mirrors.md) and [the manifest](manifest.md) have pages of their own.

## The command

```text
bun .github/scripts/sync/writer/sync.ts \
  --files files.yml --tree files \
  --target <checkout> --build <full sha> \
  --repository <owner/name> --private <true|false> \
  [--summary <path for the JSON summary>] [--upstream <raw-content host>]
```

- **`--tree`** is the `files/` directory itself. Every tree `source` starts with `files/` and resolves under it, and a ref source is fetched ([Upstream refs](files.md#upstream-refs)).
- **`--build`** is the delivery commit's full sha, 40 lowercase hex characters. A short or uppercase one is refused before anything is written.
- **Resolving `--build`:** `git fetch origin +refs/tags/stable:refs/tags/stable`, then `git rev-parse stable^{commit}`. The forced refspec refreshes a local tag an earlier fetch left.
- **The delivery commit is named** in full in the PR body, by its first 12 characters in the sync commit's subject, and in the manifest's own entry under the stamp rule ([The manifest](manifest.md#when-the-judged-commit-moves)).
- **`--repository`** names the GitHub repository, whose owner the placeholders derive from ([Placeholders](files.md#placeholders)).
- **`--upstream`** swaps the host every upstream ref is fetched from ([Upstream refs](files.md#upstream-refs)); the tests serve their fixture over loopback.
- **Output:** the Markdown report goes to stdout. The JSON summary carries the same rows plus `hold` and `holdReasons`.
- **Exit 0** whether or not the report holds the PR.

A nonzero exit is a data or environment error, one of:

- a `--build` that is not a full sha
- a bad `files.yml`
- an unreadable registration
- a registration naming a module `files.yml` does not offer
- a manifest record the writer cannot read ([Retirement](#retirement))
- a recorded commit the build checkout's history lacks ([The manifest](manifest.md#when-the-judged-commit-moves))
- a symlinked ancestor at a path the writer touches
- a directory or a symlink at the manifest or registration path
- a directory at a stale record's path
- a split file whose marker text is duplicated or buried mid-line
- a placeholder value carrying a double quote, backslash, or control character
- a mirror declaration the writer cannot honour ([Mirrors](mirrors.md))

## Classes

| Class | Written | Existing local content | Manifest record |
| --- | --- | --- | --- |
| `managed` | whole file, every sync; a `render: settings` entry writes the rendered settings document instead of a copy | replaced and reported (`replaced local edits`, with a diff), holds the PR | `hash` = sha256 of the file |
| `split` | the marker-bounded region, every sync | everything above BEGIN and below END is kept; a file that never mentions the markers gets the region above its content and the verdict `region added`, which holds the PR; marker text duplicated or buried mid-line fails the run | `hash` = sha256 of the region, marker lines included |
| `starter` | once, when the path is absent (a link there counts as present) | never touched again | no hash |

A written row's change (`created`, `updated`, `unchanged`, `replaced local edits`, `region added`, `held`) and a held row's detail are the reader's vocabulary, owned by the sync-pr skill ([Read the report](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-sync-pr/SKILL.md#read-the-report)).

What holds an entry: a symlink at a managed or split path (the writer never reads through a link and has no record of writing one there), a directory or anything that is neither a file nor a link at any entry's path, and a rendered entry whose overlay is missing, not a regular file, unparsable, names one label twice, or carries tracking labels the registration refuses ([settings.md](../../settings.md)).

## Class flips

A path recorded under one writer class (`managed`, `split`, `starter`, `mirror`) that `files.yml` now declares under another is a class flip. Without the rule below, a managed file that becomes split would have the region prepended above its old content and report `updated`. `files.yml` is the truth for a path's class, and the recorded content is the platform's own previous write, so:

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

## Retirement

A recorded `managed` or `split` path that no selected entry writes now (a module deselected, or an entry that left `files.yml`) is stale, and retirement runs over the stale records before writing, every row with the detail `no longer selected`.

Rows appear only for files present, save a `released` row, which reports a record. An unrecorded file produces no row, since no manifest record vouches for it and it is not the platform's to retire.

Each outcome (`deleted`, `region removed`, `held`, `released`) is the reader's vocabulary, owned by the sync-pr skill ([the Retired outcomes](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-sync-pr/SKILL.md#read-the-report)). Two carry writer mechanics of their own:

- **`released`:** a `managed`, `split`, or `starter` record at a path the registration's `except` names, whatever sits at the path. The record leaves, nothing at the path is probed or touched, and the PR does not hold; the row appears whether or not a file is present, since the manifest changed.
- **`region removed`:** the marker lines and the region go, the content above and below stays byte for byte as a plain file, and the record leaves. The PR holds this once, with a detail asking the reader to complete the file or delete it; next run the path is unrecorded and produces no row.
- **The seam of a removed region:** the blank lines that framed it become one when content stands on both sides and none when it stands on one side only, so a tail under a top region starts at its first content line.

Beyond the outcomes:

- **A stale record at a path no `files.yml` entry declares at all** (a hand edit, or an entry that left `files.yml`) is retired the same way. While a file sits at the path it is also noted (`manifest record for <path> had no writer: ...`), which holds the PR for the Retired row's outcome.
- **A recorded path that is not a clean repository path** is ignored and noted.
- **A held file and a held entry keep their records** (from a manifest the writer accepted) in the new manifest every run, so the file is held again next time and never becomes an unrecorded orphan.
- **A `starter` record whose entry nothing selects** leaves the manifest; the file is the repository's own either way.
- **A `mirror` record no declaration reaches any more** (a fleet target the registration excepts included) is dropped with a note. The copy stays as the repository's own, and a mirror declared again adopts it while it still holds the source's content.
- **A record that is not exactly a shape the writer writes** (an unknown class, a field the class does not carry, a hash that is not a sha256 digest, a `mirror` kind other than `symlink`, a `split` without a known grammar or its markers) fails the run with a count before anything is written.
- **The fix for such a record:** the target's own `validate-managed-files` check shows the refusal, so the fix is a manifest edit (git history has the stamped original) and a new dispatch.
- **A file the platform stops writing needs no grammar of its own:** its entry leaves `files.yml`, and every target retires the recorded file as above on its next sync. A transition the sync cannot carry by itself is one rung in `migrations/` ([Migrations](#migrations)).

## Migrations

`migrations/` is the only home for transitional code ([fleet-guidelines.md](../../fleet-guidelines.md#no-backwards-compatibility-code)): the writer and the validator know the current shape alone, so a fleet transition the writer cannot carry by itself (a manifest record class that left, say) is one rung there.

- **A rung** is one self-contained bun script, `migrations/<NNNN>-<what>.ts <checkout>`, numbered in the order it was written, idempotent (a checkout it has already crossed is a no-op), and never retired: a target that missed a round crosses every rung on its next sync.
- **A rung's output:** its stdout is the checkout-relative paths it wrote, one per line, and nothing else; anything it has to say goes to stderr.
- **The operator runs every rung** in the build's `migrations/` over the target checkout, in name order, before the writer reads it ([sync/migrate.ts](../../../.github/scripts/sync/migrate.ts)); nothing outside `migrations/` knows any rung. The runner writes the union of the reported paths to `$RUNNER_TEMP/migrated.txt`, NUL-separated, once every rung has finished.
- **A rung that exits nonzero fails the row:** the rungs after it and the writer do not run, nothing is delivered, and the failure is filed as the writer's with the rung's line in the log tail.
- **A rung ships with the PR that changes the shape** and rides the next sync round that reaches the repository (the PR's fleet-sync label for public repositories; private ones on the owner's next sync), with one test seen red on the old shape and a no-op control.
- **A rung's edit is committed because the rung reported it:** the delivery stages the runner's list beside the writer's paths and the manifest ([what a delivery commits](operator.md#delivering-a-row)), so an edit at a path neither the rung printed nor the writer's report or the manifest names stays out of the commit.

| Rung | Transition |
| --- | --- |
| `0001-link-records-are-mirrors` | a `link` manifest record becomes `{"class": "mirror", "kind": "symlink"}` with its hash kept, the fleet's `AGENTS.md` symlinks having become mirrors the fleet declares |
| `0002-homepage-unmanaged` | the overlay's `homepage` key is deleted when its value is empty or the repository's own GitHub address (read from the checkout's `origin`), the platform having stopped managing the homepage ([settings.md](../../settings.md#apply-semantics)); any other value stays |
| `0003-topics-empty-list` | the overlay's `topics: ""` (or a valueless `topics:`) becomes `topics: []`, the spelling the settings library accepts for no topics; any other value stays |

## The report

The report's sections (header, Written, Replaced local edits, Retired, Registration notes, Mirrors, Review), each row's vocabulary, and every Registration note's exact text are the sync-pr skill's ([Read the report](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-sync-pr/SKILL.md#read-the-report)). A Written row's detail is a held row's reason, or the stale-class explanation on a class-flip row; a replaced-file diff is capped at 40 lines.

**`hold` is true on** any held or `region added` written row, any replaced local edit (a mirror's included), any held or `region removed` retirement, any `replaced` mirror, or any registration note.

**The report's shape defends itself:**

- Table cells escape `|`, so a path or detail carrying one keeps the columns.
- Every cell, note, and code-formatted value (the replaced-file headings included) is printed on one line: a newline inside a registration value or a manifest path (the writer copies both into the report verbatim) cannot end the row and start a heading of its own.
- A replaced diff sits in a fence one backtick longer than any backtick run its lines open with, so the target's own content cannot close it.

**The PR body stays under GitHub's 65,536-character limit** (`BODY_CAP` in [sync/deliver.ts](../../../.github/scripts/sync/deliver.ts)). The header and the Review section take their room first, then the tables and notes, then the replaced-edit diffs. A section the room runs out on ends in a warning naming how many characters were cut, and one with no room left is dropped.

## The code behind each rule

| Question | Owner |
| --- | --- |
| What does `files.yml` look like, and what does the loader refuse? | [actions/plan/files_config.ts](../../../actions/plan/files_config.ts), the grammar every reader shares (the writer, the fleet plan, the checks); the writer's own checks against the `files/` tree and the placeholder defaults are in [sync/writer/files_config.ts](../../../.github/scripts/sync/writer/files_config.ts) |
| Which placeholder tokens exist? | `PLACEHOLDER_NAMES` in [sync/writer/placeholders.ts](../../../.github/scripts/sync/writer/placeholders.ts) |
| How are the values derived from `.repo-platform.yml`? | [sync/writer/registration.ts](../../../.github/scripts/sync/writer/registration.ts) |
| Which entries apply to one repository? | `selects` in [actions/shared/selection.ts](../../../actions/shared/selection.ts), the one rule the writer, the fleet plan, and the validator select by; `selectEntries` in [actions/plan/files_config.ts](../../../actions/plan/files_config.ts) |
| How is each class written? | [sync/writer/write_managed.ts](../../../.github/scripts/sync/writer/write_managed.ts), [write_split.ts](../../../.github/scripts/sync/writer/write_split.ts), [write_starter.ts](../../../.github/scripts/sync/writer/write_starter.ts); the mirrors, the fleet's and the repository's, by [mirrors.ts](../../../.github/scripts/sync/writer/mirrors.ts) |
| Where do blocks land, and what may a value contain? | `spliceBlocks` and `substitute` in [sync/writer/placeholders.ts](../../../.github/scripts/sync/writer/placeholders.ts) |
| What happens when an entry's class differs from its record? | `writeEntry` in [sync/writer/sync.ts](../../../.github/scripts/sync/writer/sync.ts) |
| How is `.github/settings.yml` rendered? | [sync/writer/settings_entry.ts](../../../.github/scripts/sync/writer/settings_entry.ts) over [settings_layers.ts](../../../.github/scripts/sync/writer/settings_layers.ts), which folds with the github-settings-as-code library ([settings.md](../../settings.md)) |
| When does a file the platform stopped writing leave? | [sync/writer/retire.ts](../../../.github/scripts/sync/writer/retire.ts) |
| What does the manifest record? | [sync/writer/manifest.ts](../../../.github/scripts/sync/writer/manifest.ts) |
| What holds a PR for review? | `holdReasons` in [sync/writer/report.ts](../../../.github/scripts/sync/writer/report.ts) |
| How does a dispatch add a module to a registration? | `withModules` in [sync/add_modules.ts](../../../.github/scripts/sync/add_modules.ts) ([the operator's "Adding modules"](operator.md#adding-modules)) |
| The whole run, as a CLI | [sync/writer/sync.ts](../../../.github/scripts/sync/writer/sync.ts) |

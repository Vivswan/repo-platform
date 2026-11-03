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
- **The delivery commit is named** in full in the PR body, by its first 12 characters in the sync commit's subject, and in the manifest's own entry under the stamp rule ([The manifest](manifest.md#when-the-judged-commit-moves)).
- **`--repository`** names the GitHub repository, whose owner the placeholders derive from ([Placeholders](files.md#placeholders)).
- **`--upstream`** swaps the host every upstream ref is fetched from ([Upstream refs](files.md#upstream-refs)); the tests serve their fixture over loopback.
- **Output:** the Markdown report goes to stdout. The JSON summary carries the same rows plus `hold` and `holdReasons`.
- **Exit 0** is a report, whether or not it holds the PR; a nonzero exit is a data or environment error, named in the output.

## Classes

| Class     | Written                                                                                                    | Existing local content                                                                                                                                                                                                             | Manifest record                                      |
| --------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `managed` | whole file, every sync; a `render: settings` entry writes the rendered settings document instead of a copy | replaced and reported (`replaced local edits`, with a diff), holds the PR                                                                                                                                                          | `hash` = sha256 of the file                          |
| `split`   | the marker-bounded region, every sync                                                                      | everything above BEGIN and below END is kept; a file that never mentions the markers gets the region above its content and the verdict `region added`, which holds the PR; marker text duplicated or buried mid-line fails the run | `hash` = sha256 of the region, marker lines included |
| `starter` | once, when the path is absent (a link there counts as present)                                             | never touched again                                                                                                                                                                                                                | no hash                                              |

A written row's change (`created`, `updated`, `unchanged`, `replaced local edits`, `region added`, `held`) and a held row's detail are the reader's vocabulary, owned by the sync-pr skill ([Read the report](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-sync-pr/SKILL.md#read-the-report)).

## Class flips

A path recorded under one writer class (`managed`, `split`, `starter`, `mirror`) that `files.yml` now declares under another is a class flip. Without the rule below, a managed file that becomes split would have the region prepended above its old content and report `updated`. `files.yml` is the truth for a path's class, and the recorded content is the platform's own previous write, so:

| State                                                                                                                                  | Outcome                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the path already holds exactly what the entry writes                                                                                   | `unchanged`; the record takes the new class                                                                                                                                                                                                                                                                         |
| what sits there is the recorded write (same rule as retirement: whole-file hash, clean region with nothing outside it, or link target) | removed and written whole under the new class: `updated`                                                                                                                                                                                                                                                            |
| anything else, a `starter` record included                                                                                             | the record is stale, and the file is written as an unrecorded one under the new class, with the detail `class changed from <old> to <new>; the record was stale, so the file was judged unrecorded`; its Written row is then the unrecorded file's (`replaced local edits`, `region added`, `unchanged`, or `held`) |
| the new class is `starter`                                                                                                             | a handover: the file is the repository's own, nothing is held                                                                                                                                                                                                                                                       |

## Retirement

A recorded `managed` or `split` path that no selected entry writes now (a module deselected, or an entry that left `files.yml`) is stale, and retirement runs over the stale records before writing, every row with the detail `no longer selected`.

Rows appear only for files present, save a `released` row, which reports a record. An unrecorded file produces no row, since no manifest record vouches for it and it is not the platform's to retire.

Each outcome (`deleted`, `region removed`, `held`, `released`) is the reader's vocabulary, owned by the sync-pr skill ([the Retired outcomes](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-sync-pr/SKILL.md#read-the-report)). Two carry writer mechanics of their own:

- **`released`:** a `managed`, `split`, or `starter` record at a path the registration's `except` names, whatever sits at the path. The record leaves, nothing at the path is probed or touched, and the PR does not hold; the row appears whether or not a file is present, since the manifest changed.
- **`region removed`:** the marker lines and the region go, the content above and below stays byte for byte as a plain file, and the record leaves. The PR holds this once, with a detail asking the reader to complete the file or delete it; next run the path is unrecorded and produces no row.
- **The seam of a removed region:** the blank lines that framed it become one when content stands on both sides and none when it stands on one side only, so a tail under a top region starts at its first content line.

Beyond the outcomes:

- **A record the writer refuses** (a shape it never writes) fails the run before anything is written; the target's own `validate-managed-files` check shows the refusal, so the fix is a manifest edit (git history has the stamped original) and a new dispatch.
- **A file the platform stops writing needs no grammar of its own:** its entry leaves `files.yml`, and every target retires the recorded file as above on its next sync. A transition the sync cannot carry by itself is one rung in `migrations/` ([Migrations](#migrations)).

## Migrations

`migrations/` is the only home for transitional code ([fleet-guidelines.md](../../fleet-guidelines.md#no-backwards-compatibility-code)): the writer and the validator know the current shape alone, so a fleet transition the writer cannot carry by itself (a manifest record class that left, say) is one rung there.

- **A rung** is one self-contained bun script, `migrations/<NNNN>-<what>.ts <checkout>`, numbered in the order it was written, idempotent (a checkout it has already crossed is a no-op), and never retired: a target that missed a round crosses every rung on its next sync.
- **A rung's output:** its stdout is the checkout-relative paths it wrote, one per line, and nothing else; anything it has to say goes to stderr.
- **The operator runs every rung** in the build's `migrations/` over the target checkout, in name order, before the writer reads it ([sync/migrate.ts](../../../.github/scripts/sync/migrate.ts)); nothing outside `migrations/` knows any rung. The runner writes the union of the reported paths to `$RUNNER_TEMP/migrated.txt`, NUL-separated, once every rung has finished.
- **A rung that exits nonzero fails the row:** the rungs after it and the writer do not run, nothing is delivered, and the failure is filed as the writer's with the rung's line in the log tail.
- **A rung ships with the PR that changes the shape** and rides the next sync round that reaches the repository (the PR's fleet-sync label for public repositories; private ones on the owner's next sync), with one test seen red on the old shape and a no-op control.
- **A rung's edit is committed because the rung reported it:** the delivery stages the runner's list beside the writer's paths and the manifest ([what a delivery commits](operator.md#delivering-a-row)), so an edit at a path neither the rung printed nor the writer's report or the manifest names stays out of the commit.

The rungs are [migrations/](../../../migrations/), each one's header its transition.

## The report

The report's sections, each row's vocabulary, and every Registration note's text are the sync-pr skill's ([Read the report](https://github.com/Vivswan/repo-platform/blob/main/skills/repo-platform-sync-pr/SKILL.md#read-the-report)).

- **`hold` is true on** any row a human must look at: a held or `region added` write, a replaced local edit (a mirror's included), a held or `region removed` retirement, a `replaced` mirror, or a registration note.
- **The PR body is capped** (`BODY_CAP` in [sync/deliver.ts](../../../.github/scripts/sync/deliver.ts)): the header and the Review section take their room first, then the tables and notes, then the replaced-edit diffs; a section the room runs out on ends in a warning, and one with no room left is dropped.

## The code behind each rule

| Question                                                          | Owner                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What does `files.yml` look like, and what does the loader refuse? | [actions/plan/files_config.ts](../../../actions/plan/files_config.ts), the grammar every reader shares (the writer, the fleet plan, the checks); the writer's own checks against the `files/` tree and the placeholder defaults are in [sync/writer/files_config.ts](../../../.github/scripts/sync/writer/files_config.ts)                               |
| Which placeholder tokens exist?                                   | `PLACEHOLDER_NAMES` in [sync/writer/placeholders.ts](../../../.github/scripts/sync/writer/placeholders.ts)                                                                                                                                                                                                                                               |
| How are the values derived from `.repo-platform.yml`?             | [sync/writer/registration.ts](../../../.github/scripts/sync/writer/registration.ts)                                                                                                                                                                                                                                                                      |
| Which entries apply to one repository?                            | `selects` in [actions/shared/selection.ts](../../../actions/shared/selection.ts), the one rule the writer, the fleet plan, and the validator select by; `selectEntries` in [actions/plan/files_config.ts](../../../actions/plan/files_config.ts)                                                                                                         |
| How is each class written?                                        | [sync/writer/write_managed.ts](../../../.github/scripts/sync/writer/write_managed.ts), [write_split.ts](../../../.github/scripts/sync/writer/write_split.ts), [write_starter.ts](../../../.github/scripts/sync/writer/write_starter.ts); the mirrors, the fleet's and the repository's, by [mirrors.ts](../../../.github/scripts/sync/writer/mirrors.ts) |
| Where do blocks land, and what may a value contain?               | `spliceBlocks` and `substitute` in [sync/writer/placeholders.ts](../../../.github/scripts/sync/writer/placeholders.ts)                                                                                                                                                                                                                                   |
| What happens when an entry's class differs from its record?       | `writeEntry` in [sync/writer/sync.ts](../../../.github/scripts/sync/writer/sync.ts)                                                                                                                                                                                                                                                                      |
| How is `.github/settings.yml` rendered?                           | [sync/writer/settings_entry.ts](../../../.github/scripts/sync/writer/settings_entry.ts) over [settings_layers.ts](../../../.github/scripts/sync/writer/settings_layers.ts), which folds with the github-settings-as-code library ([settings.md](../../settings.md))                                                                                      |
| When does a file the platform stopped writing leave?              | [sync/writer/retire.ts](../../../.github/scripts/sync/writer/retire.ts)                                                                                                                                                                                                                                                                                  |
| What does the manifest record?                                    | [sync/writer/manifest.ts](../../../.github/scripts/sync/writer/manifest.ts)                                                                                                                                                                                                                                                                              |
| What holds a PR for review?                                       | `holdReasons` in [sync/writer/report.ts](../../../.github/scripts/sync/writer/report.ts)                                                                                                                                                                                                                                                                 |
| How does a dispatch add a module to a registration?               | `withModules` in [sync/add_modules.ts](../../../.github/scripts/sync/add_modules.ts) ([the operator's "Adding modules"](operator.md#adding-modules))                                                                                                                                                                                                     |
| The whole run, as a CLI                                           | [sync/writer/sync.ts](../../../.github/scripts/sync/writer/sync.ts)                                                                                                                                                                                                                                                                                      |

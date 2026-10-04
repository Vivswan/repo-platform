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
- **A rendered entry whose overlay is missing, does not parse, names one label twice,** or whose registration's tracking labels are refused ([settings.md](../../settings.md)).

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

Beyond the table:

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

| Section | Content |
| --- | --- |
| header | Build, Modules, Visibility |
| Written | path, class, change, detail for every selected entry (detail is a held row's reason, or the stale-class explanation on a class-flip row) |
| Replaced local edits | one unified diff per replaced file, capped at 40 lines |
| Retired | path, outcome, detail |
| Registration notes | the notes below |
| Mirrors | source, target, outcome, detail |
| Review | `Hold for review: yes` with the reasons, or `no` |

A Registration note is one of:

- a manifest refused whole ([The manifest](manifest.md#when-the-judged-commit-moves))
- a placeholder with no value, and the key that sets it
- a manifest record at a path that is not a clean repository path
- a stale record no `files.yml` entry declares now, while a file sits at its path
- a mirror record no declaration reaches
- an `except` path no `files.yml` entry or fleet mirror writes

**`hold` is true on** any held or `region added` written row, any replaced local edit (a mirror's included), any held or `region removed` retirement, any `replaced` mirror, or any registration note.

**The report's shape defends itself:**

- Table cells escape `|`, so a path or detail carrying one keeps the columns.
- Every cell, note, and code-formatted value (the replaced-file headings included) is printed on one line: a newline inside a registration value or a manifest path (the writer copies both into the report verbatim) cannot end the row and start a heading of its own.
- A replaced diff sits in a fence one backtick longer than any backtick run its lines open with, so the target's own content cannot close it.

**The PR body stays under GitHub's 65,536-character limit** (`BODY_CAP` in [sync/deliver.ts](../../../.github/scripts/sync/deliver.ts)). The header and the Review section take their room first, then the tables and notes, then the replaced-edit diffs. A section the room runs out on ends in a warning naming how many characters were cut, and one with no room left is dropped.

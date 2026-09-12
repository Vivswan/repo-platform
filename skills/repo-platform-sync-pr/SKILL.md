---
name: repo-platform-sync-pr
description: 'Handle an automated sync PR from Vivswan/repo-platform - read its report, clear every row, keep local content in its owned place, and follow the failure path. Use when a PR arrives on branch automation/repo-platform, for "the repo-platform bot PR", "the sync PR", "the automation branch PR", when a sync PR says "Hold for review: yes", reports "replaced local edits", a held retirement, or a replaced mirror, when "the sync PR deleted my local section", or when a "[repo-platform] sync failed" issue appears in the repository.'
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# repo-platform: Handling a Sync PR

The platform writes its files into managed repos from the outside: a sync run opens (or refreshes) one PR on the `automation/repo-platform` branch for each repo whose tree differs from the build (a repo already matching gets none, and its stale sync PR is closed), and the PR body is the writer's report. This skill is how to read that report, decide every row, and escalate when the sync itself failed.

Work in this order, always:

1. Read the report top to bottom (the section table below).
2. Clear every row: each Written, Retired, and Mirrors row explained; every Replaced local edits diff decided.
3. Move local content the sync replaced into its owned place (below), on the PR branch or in a follow-up PR.
4. Disposition every bot review comment; none may be left unaddressed.
5. Merge (or let auto-merge fire) unless a human does the merging, in which case stop at green and report with a verdict line.

## When to Apply

- A sync PR appeared, head branch `automation/repo-platform`
- Its Review section says `Hold for review: yes`
- A `[repo-platform] sync failed` issue appeared in the repository

## What the PR is

- A copy, not a merge. The writer copies each selected file from the platform's `files/` tree: managed files whole, split files only between their `BEGIN/END REPO-PLATFORM MANAGED` markers, starters once when absent. The one rendered file is `.github/settings.yml`, folded from the fleet settings layers and the repo's own `.github/settings.local.yml`. Nothing is three-way merged and no conflict marker ever lands in the branch.
- The writer tells its own previous write from a local edit through `.github/repo-platform-manifest.json`, which records a hash per managed file and per split region. A managed file, or a split region, whose content is neither the recorded hash nor the new content is replaced and reported with a diff.
- The head branch is rewritten on every sync run (a dispatch, a labeled merge, or the weekly cron). Commits parked on it between runs are replaced; fix-then-merge promptly.
- A PR whose report holds nothing arms auto-merge and lands once the required check passes (`all-green`, plus `pr-title` where selected). A run dispatched with `manual=true`, or any hold reason, waits for a human.

Find and open the PR from the repo:

```bash
gh pr list --head automation/repo-platform --json number,title,url
gh pr view <number>
```

Exactly one open sync PR should exist per repo; when none exists, or more than one does, stop and report that instead of guessing.

## Read the report

| Section | Content | What to verify |
|---|---|---|
| header | Build sha, the modules the registration selected, the visibility | The module list matches `.repo-platform.yml`; visibility matches the repo |
| Written | one row per selected path: class and change (`created`, `updated`, `unchanged`, `replaced local edits`, `region added`, `held`) | `created` is explained by a new module or a first sync; `updated` and `unchanged` need no look; `replaced local edits` (a managed file, or a split file's region) has a diff below; `region added` is a split file that had no markers, its whole prior content now below the new region; `held` wrote nothing and its Detail says why (the list below). A starter is only ever `created`, `unchanged`, or `held` |
| Replaced local edits | one unified diff per replaced file or region (40 lines shown, the rest counted) | Decide per diff: the content moves into a repo-owned hook or upstream, or it was a stray edit and goes |
| Retired | one row per file the platform no longer writes: `deleted`, `region removed`, `held`, `kept`, `moved` | `deleted` removed the platform's own content; `region removed` took the managed region and its markers out of a split file and left the repository-owned content as a plain file (the record leaves with it, so the row appears once); `held` left a file no manifest record vouched for, or one whose `moved_to` destination already exists, for your decision; `kept` is a starter (yours); `moved` is a git rename |
| Registration notes | one line per note: an unknown module dropped, an unreadable manifest, a placeholder with no value, a manifest record dropped or ignored, or a stale record no entry declares or retires (the exact forms below) | Fix the registration. An unreadable manifest is rewritten by this sync; a managed file or region that differs from the incoming content reads as replaced in the same report. A dropped mirror record means that copy is the repository's own now |
| Mirrors | one row per declared target: `written`, `current`, `replaced local edits` (its diff below), `replaced` with a detail naming what was removed | `replaced local edits`: decide per diff like a managed file; `replaced`: a directory stood at the target or a file where a directory had to be, and the diff shows what went. A declaration the writer cannot honour never reaches the report: the sync fails instead (the failure path below) |
| Review | `Hold for review: yes` with one line per reason, or `no` | Every listed reason resolved before merging |

The Registration notes, exactly:

- ``dropped unknown module `<name>` (files.yml does not know it)``: dropped for this sync
- `.github/repo-platform-manifest.json <problem>; every existing file is judged as unrecorded`: the manifest could not be read, so this sync rewrites it
- ``placeholder `{{<name>}}` has no value: set <key> in .repo-platform.yml``: every file rendering that placeholder is `held`; an empty value counts as none
- ``manifest record for `<path>` dropped: its class or shape is not one the writer records``: the record is not exactly a shape the writer writes (an unknown class, a field its class does not carry, a hash that is neither null nor a sha256 digest or is missing where the class carries one, a `mirror` kind other than `symlink`, a `split` without a known grammar or its markers). The path is unrecorded from then on: a selected entry or a declared mirror writes it as any unrecorded path, and anywhere else the file is the repository's own
- ``manifest record for `<path>` ignored: the path <problem>``: an unclean path
- ``manifest record for `<path>` had no writer: no files.yml entry declares or retires the path now; it is retired as a stale record (the Retired row has the outcome)``: read that Retired row; `deleted` removed a file the record vouched for, `held` left one it did not, for your decision (the Held retirement case below)
- ``manifest record for `<path>` dropped: no mirror in .repo-platform.yml reaches it now, so the file is the repository's own (a mirror declared again adopts it while it still holds the source's content)``

The `held` details of a Written row, exactly:

- `a symbolic link sits where a file is declared` (a managed or split entry; the writer never reads through a link)
- `a regular file sits where a link is declared`
- `no value for {{<placeholder>}}` (a Registration note names the key to set)
- `no overlay at .github/settings.local.yml (its starter is held or missing)`, `.github/settings.local.yml is <what>, which the render does not read through` (a directory, a symbolic link, or something that is not a regular file stands at the overlay path), an overlay problem (a YAML parse error or a duplicated label or ruleset name in `.github/settings.local.yml`, or a tracking label the plan refuses, in the plan's words): the rendered `.github/settings.yml`; the Settings row of the table below says what to do
- `<what> sits at the path, and the writer will not replace it`: a directory, or something that is neither a regular file nor a link, stands where an entry of any class is declared

A written row (`replaced local edits`, `region added`, `unchanged`) may carry the detail `class changed from <old> to <new>; the record was stale, so the file was judged unrecorded`: the recorded class differs from the one the selection declares now and the file was not provably the platform's last write, so the sync judges it as an unrecorded file by the declared class and restamps a successful outcome; the change says what that outcome was.

The hold reasons, exactly: `local edits replaced in <path>`, `<path>: the managed region was added above repository-owned content`, `<path> held: <detail>`, `retirement of <path> held: <detail>`, `retirement of <path>: the managed region was removed and the repository-owned content kept`, `mirror <target> replaced: <detail>`, `registration: <note>`.

## Check the diff against the report

The report lists what the writer did; the diff is what lands. Compare them before pushing any repair commit of your own (afterwards, diff the sync's own commit instead: `git diff origin/main...<sync commit>`):

```bash
gh pr diff <number> --name-only
```

Every changed path must be one of:

- a Written row whose change is not `unchanged`
- a Retired row reading `deleted`, `region removed`, or `moved`
- a Mirrors row reading `written`, `replaced local edits`, or `replaced` (a `replaced` row also explains the deleted paths under its target and the ancestor file its detail names)
- `.github/repo-platform-manifest.json` (rewritten every sync, no row)

Any other path with no row in the sync's own commit is a sync bug: do not merge, report it on Vivswan/repo-platform. One exception: a body carrying a section-ending warning of the form `<N> characters of this section were cut to fit GitHub's body limit.` lost the rows after the cut, so judge those paths by their class in [references/file-ownership.md](references/file-ownership.md) instead. A replaced diff cut at 40 lines is read in full from git:

```bash
git fetch origin main automation/repo-platform
git diff origin/main...origin/automation/repo-platform -- <path>
```

## The manual review cases

| Case | What happened | What to do |
|---|---|---|
| Replaced local edits | Someone edited a managed file (`ci.yml`, a module workflow, a pin dotfile) or the managed region of a split file | Read the diff; move the need (below). The platform version stays |
| Held retirement | A retired path holds content no manifest record vouched for, a split file's region differs from the recorded one, or a move's destination already exists | Keep what matters, delete the rest yourself (a blocked move: free the destination or delete the file); the row returns every sync until the file is gone |
| Removed region | A retired split file carried repository-owned content around its recorded region: the region and its markers went, the rest stayed as a plain file | Read the file that remains; it is yours now, and no row returns for it |
| Replaced mirror | A declared target held other content (`replaced local edits`, diff below), or a directory or a blocking file stood in the target's way (`replaced`, the detail names it) | Read the diff; the platform's copy or link, by the declared `kind`, stays. Content worth keeping moves to a path no declaration names |
| Registration drop | `modules:` names a module the platform does not know | Fix the name; the module's files were not written |
| Settings | `.github/settings.yml` reads `replaced local edits` (someone edited the rendered file, or the repository carried a hand-written one the sync had not recorded) or `held` (`no overlay at .github/settings.local.yml (its starter is held or missing)`, an overlay naming one label twice, or a tracking label the plan refuses) | `replaced local edits`: move what the diff removed into `.github/settings.local.yml` (the rendered file is never edited by hand); the holds name the registration key or the overlay line to fix |

Something that matches none of the above: do not merge. The branch is rewritten on the next run, so nothing is lost by waiting. Escalate with an issue on Vivswan/repo-platform.

## Repository-owned markdown after a retirement

The platform no longer writes the community health files; GitHub serves the account's defaults from its `<owner>/.github` repository, and a default shows ONLY when the repository has no file of the same name. A sync PR that retires the platform's `CONTRIBUTING.md` or `.github/SECURITY.md` can leave a repository-owned tail in it, and that tail (a `held` retirement, or a file the platform never recorded, which stays in place with no row at all) hides the complete default behind a fragment. Before merging, decide each file:

| File left behind | Either delete it | Or make it complete |
|---|---|---|
| `CONTRIBUTING.md` | Move the repo-specific content into `README.md` and delete the file, so the account default shows | It states the Conventional Commit PR-title rule and the CI gate (`all-green` as the required check) |
| `.github/SECURITY.md` | Move anything repo-specific into `README.md` and delete the file | It lists the supported versions and the private reporting route |

A sync PR that retires a workflow or reshapes the CI legs also orphans the comments that named the old shape, so grep the repository's own markdown and workflow comments for every name under `retired` in `files.yml` and rewrite every hit. A comment that names a workflow the repository no longer has is a false statement about the repository.

- The fix is ONE commit pushed onto `automation/repo-platform` BEFORE merging, never a separate PR: the branch is rewritten on the next run, and a follow-up PR leaves the merged tree wrong in between.
- Repeat the check on every later sync PR that retires or reshapes a file: each retirement can leave a tail, and each reshaped workflow can orphan a comment that named the old shape.

## The repo-owned tail

A split file (`AGENTS.md`, `LICENSE.md`, `.gitignore`, `.editorconfig`, `.gitattributes`, `.github/CODEOWNERS`) has one managed region between `BEGIN REPO-PLATFORM MANAGED` and `END REPO-PLATFORM MANAGED`. Everything above BEGIN and below END is the repository's own and rides through every sync byte-for-byte. A file that never mentions the markers gets the region placed above its content, so its whole prior content becomes the tail.

- For override-by-position formats (`.editorconfig`, `CODEOWNERS`, `.gitignore`) put overrides below END, where later entries win.
- Content inside the region is the platform's; an edit there is replaced on the next sync and reported under Replaced local edits, exactly like a managed file.
- Marker text duplicated in a file, or buried mid-line, fails the run: the sync cannot tell which region is meant.

## Keeping a local change

| The change was in | Move it to |
|---|---|
| `ci.yml` (a job, a step) | `checks.yml` for gate jobs; `post-green.yml` for green-gated work on main; `update-release.yml` / `update-release-pr.yml` for release-time logic |
| the managed region of a split file | above BEGIN or below END of the same file |
| a module workflow or a pin dotfile | the platform's `files/` (a PR there reaches the whole fleet; one that feeds a platform action a new input lands as a stack, action first: [build provenance](https://github.com/Vivswan/repo-platform/blob/main/docs/build-provenance.md#a-new-action-input-lands-as-a-stack)), or a repo-owned workflow beside it |
| a module setting | the module's key in `.repo-platform.yml` (`labels.*`, `site.*`) |
| the rendered `.github/settings.yml` (a label, a ruleset, an identity key) | `.github/settings.local.yml`, the overlay the render reads; the next sync re-renders the managed file from it |
| a site build command | the repo-owned `.github/actions/site-build/action.yml` hook (its `dist` output names the built directory) |

## Fix the PR

The branch is rewritten every run, so a stale local copy of it bites; always reset to the remote:

```bash
git fetch origin
git checkout -B automation/repo-platform origin/automation/repo-platform
# move content into its owned place
git add -A && git commit -m "fix: keep repository-local lines after the sync"
git push origin automation/repo-platform
```

- Pushing more commits is the supported way to fix the PR; CI re-runs on the push. Held PRs are never auto-merged, so merge manually when green.
- Do not rebase the branch onto the default branch or force-push it; the next run replaces it wholesale anyway.

## Disposition every bot review comment

Copilot and other bots leave review comments on sync PRs; do not merge with any of them unaddressed. Read them all (`gh pr view <number> --comments`, plus `gh api repos/{owner}/{repo}/pulls/<number>/comments` for inline ones). Fix the valid ones on the branch, reply on the thread explaining why an invalid one is rejected, and resolve the thread.

## Resolving on a human's behalf

When a human does the merging, your job ends with the branch resolved, pushed, and green:

- NEVER merge, enable auto-merge, or approve reviews.
- Never rebase or force-push the automation branch; never edit `.github/repo-platform-manifest.json` by hand.
- Green means the required checks pass on the branch: `all-green`, plus `pr-title` where selected.
- End the report with a verdict line: "READY TO MERGE" when every row is explained, local content sits in its owned place, and every bot comment is fixed or answered, or "NOT READY: <what blocks it>".

## The failure path

A sync leg that fails files (or refreshes) one issue in the target repository titled `[repo-platform] sync failed`, with the error. The operator run's job log (`gh run view <id> --log` on Vivswan/repo-platform) shows the row as `row <i>: failed, report filed in the target repository`; the line carries an index from 0, never the repository's name. Fix what the issue names (usually the registration, a mirror declaration the writer cannot honour - each named as `.repo-platform.yml: mirrors: source '<s>', target '<t>': <reason>` in the writer log - or a split file's markers), then dispatch again:

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<name> -f manual=true
```

A row reading `failed before the target was resolved; re-run the workflow` means the run broke before reaching the repo: re-run it, and escalate on Vivswan/repo-platform when it repeats.

## Closing instead of fixing

Closing the PR is not an opt-out: the next run rewrites the branch and opens a fresh PR with the same report. To pause syncs, revoke the fleet token's access to the repo or delete `.repo-platform.yml`. To detach permanently, see the platform's [docs/eject.md](https://github.com/Vivswan/repo-platform/blob/main/docs/eject.md).

Worked examples of report rows and their resolutions are in [references/worked-examples.md](references/worked-examples.md); the class of every path is in [references/file-ownership.md](references/file-ownership.md).

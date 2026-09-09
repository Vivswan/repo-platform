---
order: 20
group: Start here
---

# Fleet guidelines

Conventions every managed repository follows, whether the file is managed by sync or repo-owned. Each entry names what enforces it; "review only" means nothing in CI does.

| Guideline | Enforced by |
|---|---|
| [Sticky PR comments](#sticky-pr-comments) | the `sticky-pr-comments` ssot rule (repo-platform templates, landing); review only in repo-owned workflows |
| [Conventional Commits, squash-merged](#conventional-commits-squash-merged) | the `pr-title` check; the `commit-names` job; the settings override layer (squash-only) |
| [Plain ASCII punctuation](#plain-ascii-punctuation) | check-typography |
| [Markdown prose is never hard-wrapped](#markdown-prose-is-never-hard-wrapped) | `wrap:check` (repo-platform); `deno fmt --prose-wrap preserve` (deno repos); review elsewhere |
| [Managed vs repo-owned files](#managed-vs-repo-owned-files) | validate-template; copier's `_skip_if_exists` |
| [Split files: the managed region](#split-files-the-managed-region) | the sync's split-file rebuild and tail tripwire; validate-template's marker rule |
| [Copilot review comments are advisory](#copilot-review-comments-are-advisory) | the managed `.github/instructions/review.instructions.md`; no ruleset requires Copilot's approval |
| [No backwards-compatibility code](#no-backwards-compatibility-code) | review; the `no-retired-shapes` ssot rule (repo-platform, landing) |
| [Short comments](#short-comments) | the `file-size` step's comment caps (warn only); review for content |

## Sticky PR comments

- Rule: a workflow that comments on a PR uses `marocchino/sticky-pull-request-comment`, pinned by full sha with the version tag in a trailing comment, `header: <repo>/<workflow-stem>`, upserting in place, and never swallowing a failure (no `continue-on-error`, no `|| true`).
- Why: one comment per workflow that edits itself on later runs, instead of a new comment per run.
- How (repo-platform's managed workflows use `repo-platform/<stem>`):

  ```yaml
  - uses: marocchino/sticky-pull-request-comment@5770ad5eb8f42dd2c4f34da00c94c5381e49af88 # v3.0.5
    with:
      header: my-repo/auto-format
      message: ...
  ```

- Enforced by: the `sticky-pr-comments` ssot rule in repo-platform's [scripts/check/ssot/sticky_comments.ts](../scripts/check/ssot/sticky_comments.ts) (landing) over every file under its `templates/`, `.github/workflows/`, and `actions/`: no hand-rolled `gh pr comment`, `gh pr close --comment`, or comments REST call anywhere in them, and every sticky step pinned with `header: repo-platform/<workflow stem or action name>`. The rule reads YAML step lists (workflows, composite actions, step fragments; jinja sources as the YAML they render) as the runner does: a step is a mapping whatever its key order, its `run` is one shell line per folded `>-` block and one per literal `|` line, and each command line is split into words, so `gh pr close` is caught by its comment option in any spelling (`--comment`, `--comment=`, `-c`, `-dc`) and `gh pr comment` or a comments REST route in a shell line, a github-script body, or an argv array alike. `gh issue comment` is not judged (the issue-tracking actions comment on issues by design). Composite actions alone may set `continue-on-error` on the step: they post under the calling job's token, which a fork PR grants no write, so their comment is a convenience sink beside the step summary. Review only in repo-owned workflows.

## Conventional Commits, squash-merged

- Rule: PR titles and commit subjects are [Conventional Commits](https://www.conventionalcommits.org/); PRs squash-merge, so the PR title becomes the commit subject.
- Why: release-please derives versions and changelogs from the subjects.
- How: `fix(sync): ...`, `feat(templates)!: ...`, `docs: ...`.
- Enforced by: the [`pr-title` check](settings.md#the-pr-title-ruleset) on the PR title (pr-title module); the `commit-names` job (actions/validate-commit-names) on the subjects; squash-only merging with the PR title as subject is the [settings override layer](settings.md) (settings-sync module).

## Plain ASCII punctuation

- Rule: no curly quotes, em-dashes, or invisible unicode in any text file.
- Why: look-alike characters break greps, diffs, and agent edits that match on plain text.
- How: `"..."`, `'...'`, `-`; a file that must carry non-ASCII goes in `.typography-allow.local`.
- Enforced by: check-typography.

## Markdown prose is never hard-wrapped

- Rule: one source line per paragraph, list item, or quote paragraph.
- Why: a wrapped paragraph diffs as many changed lines for a one-word edit, and renders as ragged breaks in soft-wrapping viewers.
- How: write the paragraph on one line and let the viewer wrap it.
- Enforced by: `bun run wrap:check` in repo-platform; `deno fmt --prose-wrap preserve` in deno repos; review elsewhere.

## Managed vs repo-owned files

- Rule: a file whose header says `This file is managed by <owner>/repo-platform.` changes only through sync PRs; a repo-owned starter (`checks.yml`, `post-green.yml`, `.github/settings.yml`, ...) is rendered once and never overwritten.
- Why: an edit to a managed file is overwritten by the next sync PR, so the change belongs in repo-platform.
- How: change the template under `templates/` in repo-platform; the starters are the `_skip_if_exists` list in its copier.yml ([new-repo.md](new-repo.md#3-add-checks-to-checksyml) has the table).
- Enforced by: validate-template (the headers and manifest parity checks) for managed files; copier's `_skip_if_exists` for the starters.

## Split files: the managed region

- Rule: a split file (`.gitignore`, `.github/CODEOWNERS`, `AGENTS.md`, ...) is optional repo-owned content above a BEGIN marker line, managed content, an END marker line, and optional repo-owned content below; the ownership manifest declares the markers per file. Repo-owned content goes outside the region; inside it, the content stays exactly as rendered.
- Why: the sync rebuilds every split file structurally instead of merging it: the fresh render's managed region, the repository's own sides byte-for-byte around it. A template retraction can never eat a local side and a local side can never resurrect retracted managed lines, but an edit INSIDE the region is reset to the fresh render on every sync, with a reset note in the PR body and the PR held for review.
- How: put local content above the BEGIN marker or below the END marker. A previous copy the sync cannot trust to split (markers missing, duplicated even as mid-line text, or reversed; or a manifest at the repo's HEAD it cannot read) is appended WHOLE below the END marker under a marked recovery-appendix comment and the PR is held for review: nothing is dropped silently. Marker text must appear exactly once per marker in the file.
- Enforced by: the sync's split-file rebuild ([preserve_local_content.ts](../.github/scripts/sync/preserve_local_content.ts)); the tail tripwire ([tail_tripwire.ts](../.github/scripts/sync/tail_tripwire.ts)) holds the PR when repository-owned lines went missing after the rebuild; validate-template's exactly-once marker rule.

## Copilot review comments are advisory

- Rule: Copilot code review comments only on a defect it can demonstrate in the diff; its comments are advisory, so rejecting one is a valid outcome: reply with the reason, then resolve the thread.
- Why: speculative hardening and unenforced style opinions cost review time without catching a bug.
- How: the rules Copilot reads are the managed `.github/instructions/review.instructions.md` (template: `templates/base/.github/instructions/review.instructions.md.jinja` in repo-platform). Rejecting a comment is reply then resolve (the UI's "Resolve conversation", or GraphQL `resolveReviewThread`): the managed `main` ruleset sets `required_review_thread_resolution`, so an unresolved thread blocks the merge whatever the reply says.
- Enforced by: that file for what earns a comment (base content of every render); advisory because the `main` ruleset requests the review and no ruleset requires Copilot's approval.

## No backwards-compatibility code

- Rule: no compatibility shims, dual code paths, or retired-shape handling outside repo-platform's migration ladder or a repo's own `migrations/` directory.
- Why: a one-shot replacement with a loud PR note stays readable; a compat era accretes paths nobody removes.
- How: replace the shape in one PR and say so in the PR body; when live state must be moved, write a migration rung.
- Enforced by: review; the `no-retired-shapes` ssot rule in repo-platform once its migration ladder lands.

## Short comments

- Rule: a comment says what the code cannot show, in one to three lines; a comment block over 8 lines, or a file header comment over 20, is a warning.
- Why: a comment grown into a paragraph is narration (delete it) or a workaround defense (fix the code); the code is the single source of truth.
- How: cut the comment to its constraint. A block that must stay long (a license text, an upstream-shaped header) carries a comment line `comment-cap: ignore <reason>` inside it or directly above it, which exempts that block alone; the reason is mandatory, and a bare marker warns.
- Enforced by: the comment caps of the `file-size` step ([the file size caps](new-repo.md#file-size-caps)), warn only, never a failure.

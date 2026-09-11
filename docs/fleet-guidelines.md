---
order: 20
group: Start here
---

# Fleet guidelines

Conventions every managed repository follows, whether the file is managed by sync or repo-owned. Each entry names what enforces it; "review only" means nothing in CI does.

| Guideline | Enforced by |
|---|---|
| [Sticky PR comments](#sticky-pr-comments) | the `sticky-pr-comments` ssot rule (repo-platform's sources, landing); review only in repo-owned workflows |
| [Pinned actions](#pinned-actions) | the `action-pins` ssot rule and the `action-refs` CI job (repo-platform, landing); Dependabot bumps the pins |
| [Conventional Commits, squash-merged](#conventional-commits-squash-merged) | the `pr-title` check; the `commit-names` job; the settings override layer (squash-only) |
| [Plain ASCII punctuation](#plain-ascii-punctuation) | check-typography |
| [Markdown prose is never hard-wrapped](#markdown-prose-is-never-hard-wrapped) | `wrap:check` (repo-platform); `deno fmt --prose-wrap preserve` (deno repos); review elsewhere |
| [Managed vs repo-owned files](#managed-vs-repo-owned-files) | validate-managed-files; the writer's starter rule |
| [Split files: the managed region](#split-files-the-managed-region) | the writer's split write; validate-managed-files' parity check |
| [Copilot review comments are advisory](#copilot-review-comments-are-advisory) | the managed `.github/instructions/review.instructions.md`; no ruleset requires Copilot's approval |
| [No backwards-compatibility code](#no-backwards-compatibility-code) | review |
| [Short comments](#short-comments) | the `file-size` step's comment caps (warn only); review for content |
| [File size caps](#file-size-caps) | the `file-size` step (a hard cap fails the step; fleet-ci.yml carries `continue-on-error` on it for now, repo-platform's own ci.yml gates) |
| [How to bypass a check](#how-to-bypass-a-check) | each tool's own per-finding, in-repo bypass; no job-level switch exists |

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

- Enforced by: the `sticky-pr-comments` ssot rule in repo-platform's [scripts/check/ssot/sticky_comments.ts](../scripts/check/ssot/sticky_comments.ts) (landing) over every file under its `files/`, `.github/workflows/`, and `actions/`: no hand-rolled `gh pr comment`, `gh pr close --comment`, or comments REST call anywhere in them, and every sticky step pinned with `header: repo-platform/<workflow stem or action name>`. The rule reads YAML step lists (workflows, composite actions, block files) as the runner does: a step is a mapping whatever its key order, its `run` is one shell line per folded `>-` block and one per literal `|` line, and each command line is split into words, so `gh pr close` is caught by its comment option in any spelling (`--comment`, `--comment=`, `-c`, `-dc`) and `gh pr comment` or a comments REST route in a shell line, a github-script body, or an argv array alike. `gh issue comment` is not judged (the issue-tracking actions comment on issues by design). Composite actions alone may set `continue-on-error` on the step: they post under the calling job's token, which a fork PR grants no write, so their comment is a convenience sink beside the step summary. Review only in repo-owned workflows.

## Pinned actions

- Rule: every third-party action is pinned by full commit sha with the release tag in a trailing comment, `uses: actions/checkout@<40-hex sha> # v7.0.1`, and the same action carries the same sha everywhere repo-platform ships it.
- Why: a moving tag lets upstream change what the fleet runs without a PR anywhere; the sha freezes the code, the comment keeps the version readable, and Dependabot bumps both together.
- Exception: `Vivswan/repo-platform/...@build` references stay on the mutable `build` branch on purpose. It is the green-gated delivery channel ([build-provenance](build-provenance.md)), so a pinned sha there would freeze the fleet on one publish.
- Exception: an action that publishes no version tags is pinned to a branch commit with the branch in the comment, `uses: dtolnay/rust-toolchain@<40-hex sha> # master`, and the version it installs travels as the step's explicit input (`toolchain:`). The rule's `BRANCH_PINNED` table records each such action with its reason; a moving tag is still refused.
- Enforced by: the `action-pins` ssot rule in [scripts/check/ssot/delivery_pins.ts](../scripts/check/ssot/delivery_pins.ts) (shape and one-sha-per-action, offline) and the `action-refs` CI job ([resolve_action_refs.ts](../.github/scripts/ci/resolve_action_refs.ts)), which asks GitHub that every sha exists and that the tag named in its comment is that commit. The sync writer's `files/` sources are outside Dependabot's reach, so a bump PR here updates them by hand before all-green passes; the fleet receives them through the next sync.

## Conventional Commits, squash-merged

- Rule: PR titles and commit subjects are [Conventional Commits](https://www.conventionalcommits.org/); PRs squash-merge, so the PR title becomes the commit subject.
- Why: release-please derives versions and changelogs from the subjects.
- How: `fix(sync): ...`, `feat(writer)!: ...`, `docs: ...`.
- Enforced by: the [`pr-title` check](settings.md#the-pr-title-ruleset) on the PR title (pr-title module); the `commit-names` job (actions/validate-commit-names) on the subjects; squash-only merging with the PR title as subject is the [settings override layer](settings.md), applied to every managed repository.

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

- Rule: a file whose header says `This file is managed by <owner>/repo-platform.` changes only through sync PRs; a repo-owned starter (`checks.yml`, `post-green.yml`, `.github/settings.yml`, ...) is written once and never overwritten.
- Why: an edit to a managed file is overwritten by the next sync PR, so the change belongs in repo-platform.
- How: change the source under `files/` in repo-platform; the starters are the `class: starter` entries of its `files.yml` ([new-repo.md](new-repo.md#what-the-sync-writes) has the table).
- Enforced by: validate-managed-files (the manifest parity check) for managed files; the writer for the starters (written only when the path is absent, never touched again).

## Split files: the managed region

- Rule: a split file (`.gitignore`, `.github/CODEOWNERS`, `AGENTS.md`, ...) is optional repo-owned content above a BEGIN marker line, managed content, an END marker line, and optional repo-owned content below; the ownership manifest declares the markers per file. Repo-owned content goes outside the region; inside it, the content stays exactly as rendered.
- Why: the sync rewrites every split file structurally instead of merging it: the fresh managed region, the repository's own sides byte-for-byte around it. A platform retraction can never eat a local side and a local side can never resurrect retracted managed lines, but an edit INSIDE the region is replaced on every sync, reported as a replaced local edit with its diff, and the PR is held for review.
- How: put local content above the BEGIN marker or below the END marker. A file that never mentions the markers gets the region placed above its content and the PR held for review (`region added`); marker text duplicated or buried mid-line fails the run, so nothing is dropped silently. Marker text must appear exactly once per marker in the file.
- Enforced by: the writer's split write ([write_split.ts](../.github/scripts/sync/writer/write_split.ts), the class table in [sync.md](sync.md#classes)); validate-managed-files' parity check on the region.

## Copilot review comments are advisory

- Rule: Copilot code review comments only on a defect it can demonstrate in the diff; its comments are advisory, so rejecting one is a valid outcome: reply with the reason, then resolve the thread.
- Why: speculative hardening and unenforced style opinions cost review time without catching a bug.
- How: the rules Copilot reads are the managed `.github/instructions/review.instructions.md` (source: `files/base/.github/instructions/review.instructions.md` in repo-platform). Rejecting a comment is reply then resolve (the UI's "Resolve conversation", or GraphQL `resolveReviewThread`): the managed `main` ruleset sets `required_review_thread_resolution`, so an unresolved thread blocks the merge whatever the reply says.
- Enforced by: that file for what earns a comment (written to every repository); advisory because the `main` ruleset requests the review and no ruleset requires Copilot's approval.

## No backwards-compatibility code

- Rule: no compatibility shims, dual code paths, or retired-shape handling outside a repo's own `migrations/` directory; in repo-platform the transitional paths are the writer's cutover of pre-writer repositories and fleet-ci.yml's ignored legacy inputs, both retired at the fleet cutover.
- Why: a one-shot replacement with a loud PR note stays readable; a compat era accretes paths nobody removes.
- How: replace the shape in one PR and say so in the PR body; a file the platform stops writing gets a `retired` entry in `files.yml` (with `moved_to` for a rename), and the sync carries the transition.
- Enforced by: review.

## Short comments

- Rule: a comment says what the code cannot show, in one to three lines; a comment block over 10 lines, or a file header comment over 25, is a warning.
- Why: a comment grown into a paragraph is narration (delete it) or a workaround defense (fix the code); the code is the single source of truth.
- How: cut the comment to its constraint. A block that must stay long (a license text, an upstream-shaped header) carries a comment line `comment-cap: ignore <reason>` inside it or directly above it, which exempts that block alone; the reason is mandatory, and a bare marker warns.
- Enforced by: the comment caps of the `file-size` step ([file size caps](#file-size-caps)), warn only, never a failure. Comment lines are what the file's tree-sitter grammar tokenizes as comments (a string holding `//` is a string, an unterminated `/*` is a syntax error), and a file whose extension has no working grammar is named as unjudged in the step summary instead of being guessed at.

## File size caps

- Rule: no file over its hard line cap and no code line over 256 characters; a comment block over 10 lines, or a file header comment over 25, warns. The caps live in [check-file-size.ts](../actions/check-file-size/check-file-size.ts):

| Kind | Which files | Hard cap (fails) | Warn cap (annotates) |
|---|---|---|---|
| source | `.ts`, `.js`, `.py`, `.rs`, `.go`, `.swift`, `.kt`, `.java`, `.c`, `.cpp`, and their sibling extensions | 2000 lines | 1600 lines |
| test | a source file named `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, `test_*`, Rust's `*_tests.rs`, `tests.rs`, `proptests.rs`, or under `test/`, `tests/`, `__tests__/` | 3200 lines | 2560 lines |
| workflow | yaml under `.github/workflows/`, and any `action.yml` or `action.yaml` | 1000 lines | 800 lines |
| shell | `.sh`, `.bash`, `.zsh` | 1000 lines | 800 lines |
| markdown | `.md` | 1300 lines | 1040 lines |
| line width | every kind but markdown (one source line per paragraph is the fleet rule) | 256 code points | 150 code points |
| comment block | a run of lines holding nothing but comment tokens as the file's grammar tokenizes them (a multi-line comment counts every line between its delimiters; a string or here-doc holding comment syntax is code); a blank line or a code line ends the run, a line with code on it is code (an inline comment after it is not a block), and markdown is prose | never fails | 10 lines; 25 for the file header (the first block, when nothing but a shebang or a generated region precedes it) |

- Why: a file past these sizes is several files wearing one name; a line past the width is unreadable in any review pane; a comment past its cap is narration or a workaround defense, and the code is the source of truth. The caps are generous on purpose: they catch drift, not style.
- Exempt by construction:
  - lockfiles, json, and non-workflow yaml (no kind); anything under `node_modules/`, `vendor/`, `third_party/`, `goldens/`, or `__snapshots__/`
  - a file whose first ten lines carry a comment declaring it generated (`generated by X`, `do not edit`; a comment that merely names a generator is not a declaration), and the lines inside a `BEGIN GENERATED`/`END GENERATED` region
  - a file carrying repo-platform's managed header (the repository cannot fix it; the summary counts them)
  - a line that is one whitespace-free token (a URL, a sha, an expression): unbreakable, so it passes both width tiers; a literal assigned on the same line is two tokens and does not
  - a line that is one string, template, or regex literal with nothing but punctuation and keywords beside it (assigned, returned, keyed, a sole argument, a line inside a multi-line literal): passes the warn width tier only, since wrapping it means splitting the literal
- How: split the file, wrap the line, shorten the comment. Two per-finding bypasses exist, both repo-owned and visible in the diff:
  - A comment block that must stay long (a license text, an upstream-shaped header) carries a comment line `comment-cap: ignore <reason>` inside it or directly above it, which exempts that block alone. A bare marker exempts nothing and warns itself.
  - A file that must stay large goes in `.file-size-allow.local`, one `path # reason` per line (blank lines and `#` comment lines are skipped), which exempts every finding on that path in both tiers. The reason is mandatory and must be one a reader accepts: vendored or upstream-shaped, generated but missed by the header exemption, a split that would break an external contract, a file that predates the cap and names the PR its split waits on. "Large" or "legacy" alone is not a reason.
  - An allowlist entry without a reason fails the check, and so does a stale one: a path with no finding left (under every cap, no bare marker) or not a tracked file.
  - A repository that packages from its root (a VS Code extension's VSIX, an npm package with no `files` field) lists the allowlist in its packaging ignore file (`.vscodeignore`, `.npmignore`), or it ships as content.
- Enforced by: the `file-size` step of fleet-ci.yml's `base-checks` job ([actions/check-file-size](../actions/check-file-size/action.yml)), which parses every judged file with web-tree-sitter and prebuilt wasm grammars for TypeScript, JavaScript, Python, Rust, Go, Kotlin, Java, C, C++, shell, and yaml; an extension without a working grammar (today Swift, whose prebuilt grammar keeps scanner state across files) gets no comment judgement and no literal exemption, and the step summary names it as unjudged. A hard-cap finding or an allowlist defect fails the step; across the fleet the step carries `continue-on-error` for now, so it annotates and comments without turning the PR red (the judge step reports it as `advisory`), while repo-platform's own ci.yml gates on it. The step summary is written on every outcome (findings, clean, or an error that stopped the check), findings also go to the log annotations, and on pull requests to one sticky PR comment, deleted when the tree is clean.

## How to bypass a check

- Rule: a blocking check is bypassed only through its tool's own per-finding mechanism, in the repository, visible in the diff, with a reason beside it. No job-level switch, environment variable, or label skips a check.
- Why: a per-finding bypass records what was accepted and why, beside the code it excuses, and covers only that finding; a switch hides every future finding too.
- How: the table below, one row per check fleet-ci.yml runs. A repo-owned config file (`.github/zizmor.yml`, `knip.json`) replaces the fleet default for that tool; `_typos.toml` extends it.
- The fleet knip default names the fleet's layout under `entry`, on top of what knip finds on its own (package.json `main`, `bin`, and scripts; the scripts that workflow `run:` steps and `.github/**/action.yml` files invoke; what its plugins read, such as a bunfig `preload`). The globs cover `.ts`, `.mts`, `.js`, and `.mjs` files in the root workspace:
  - `index`, `cli`, and `main` at the root or under `src/` (every JavaScript and TypeScript extension): knip's own defaults, restated because a custom `entry` replaces them.
  - `*.test.*` anywhere and everything under `tests/`: test files run by name through a launcher script, their helpers, and a preload.
  - everything under `.githooks/`: git hooks run by path.
  - everything under a `scripts/` directory at any depth (`scripts/`, `skills/*/scripts/`): entrypoints run by path from anywhere.
- The fleet knip default also lists the tools the fleet's CI installs itself (`uv`, `uvx`, `actionlint`, `gitleaks`) under `ignoreBinaries`, so a package.json script that runs one is not an unlisted binary.
- A repository whose composite actions live outside `.github/`, whose entrypoints sit anywhere else or carry another extension, or which declares package workspaces (knip gives each its own entries) needs its own `knip.json` naming them under `entry`, or knip reports them as unused files. That file replaces the fleet default entirely, so it starts from a copy of the fleet `entry` and `ignoreBinaries` lists.

| Check | Where it runs | Blocks on | Bypass |
|---|---|---|---|
| actionlint | base-checks | any finding | a `# shellcheck disable=SCnnnn` comment on the line above the command (shellcheck findings); the repo-owned `.github/actionlint.yaml` for the rest |
| yamllint | base-checks | any finding (strict) | a `# yamllint disable-line rule:<name>` comment on the line (`.yamllint` itself is managed) |
| gitleaks | base-checks | any leak | the finding's fingerprint in `.gitleaksignore`; an allowlist rule in the repo-owned `.gitleaks.toml` |
| typography | base-checks | any non-ASCII look-alike | the file's path prefix in `.typography-allow.local` |
| file-size | base-checks | a hard-cap finding or an allowlist defect fails the step; the fleet-ci step carries `continue-on-error` for now, so the PR stays green (repo-platform's own ci.yml gates) | the path in the repo-owned `.file-size-allow.local` with a `# reason` (every finding on that path); a `comment-cap: ignore <reason>` line inside or above a comment block ([file size caps](#file-size-caps)) |
| commit-names | base-checks | a non-conventional subject | none: reword the commit |
| typos | base-checks | any finding | an entry in the repo-owned `_typos.toml` (or `typos.toml`, `.typos.toml`), which typos layers under the fleet config: `[default.extend-words]` for the repository's vocabulary, `[files] extend-exclude` for fixture paths spelled wrong on purpose, `[default.extend-identifiers]` for one identifier; or `# typos: ignore` or `// typos: ignore` at the end of the line for a one-off |
| zizmor | zizmor | a high finding (zizmor exits non-zero alike on an audit error and on a finding, so a failed attempt runs once more and only the retry's result counts) | a `# zizmor: ignore[rule]` comment on the finding's line with the reason beside it; a `rules.<rule>.ignore` entry naming the file in the repo-owned `.github/zizmor.yml` |
| knip | knip (bun or node repos with a package.json to install from; `npm ci` also needs package-lock.json or npm-shrinkwrap.json, and a repo without them stands down with a notice) | any finding | an `ignore*` entry in the repo-owned `knip.json` or a `@public` JSDoc tag on the export |
| semgrep | semgrep (public repos) | an ERROR finding, or a scan that did not complete (its exit status is named) | a `// nosemgrep: <rule-id>` comment (`# nosemgrep: <rule-id>` in YAML) on the finding's line or the line above it, with the reason beside it; the rule set, the excluded rules, and what the upload drops are in [security-scans.md](security-scans.md#semgrep) |
| dependency-review | dependency-review | a vulnerable dependency at or above low | none: upgrade or drop the dependency |
| Trivy | trivy (every event but the schedule; `trivy-nightly` on the schedule reports without blocking) | a CRITICAL vulnerability with a fix available, or any CRITICAL misconfiguration | an entry in the repo-owned `.trivyignore.yaml` carrying a `statement` and an `expired_at` date ([security-scans.md](security-scans.md#bypassing-a-finding-trivyignoreyaml)); the plain `.trivyignore` is refused |
| CodeQL | codeql | nothing (alerts only) | a code scanning dismissal with a reason |

- What the fleet configs settle before a repository's bypass applies:
  - typos accepts `unparseable` and the hyphenated `mis-` prefix (`mis-parses`, `mis-set`) everywhere and skips lockfiles, minified bundles, SVGs, `node_modules/`, and a root `dist/` (committed build output). A root `lib/` is source in a Node repository, so a repository that generates it excludes it in its own file.
  - semgrep runs the registry's `p/default` rule set with two rules excluded, one permanently and one until the fleet cutover; WARNING and INFO findings reach code scanning without blocking, and what to mark there is the repository's own call ([security-scans.md](security-scans.md#semgrep)).
- Enforced by: review of the diff that carries the bypass; the sync overwrites a managed file, so a bypass in one is lost on the next sync PR.

---
order: 20
group: Start here
---

# Fleet guidelines

Conventions every managed repository follows, whether the file is managed by sync or repo-owned. Each entry names what enforces it; "review only" means nothing in CI does.

| Guideline | Enforced by |
|---|---|
| [Sticky PR comments](#sticky-pr-comments) | review |
| [Pinned actions](#pinned-actions) | pinact and `tests/workflows/delivery_pins.test.ts` in repo-platform (landing); zizmor in every fleet push and PR run; Dependabot bumps the pins |
| [Conventional Commits, squash-merged](#conventional-commits-squash-merged) | the `pr-title` check; the `commit-names` step; the settings override layer (squash-only) |
| [Plain ASCII punctuation](#plain-ascii-punctuation) | the `typography` step |
| [Shell is a straight line of commands](#shell-is-a-straight-line-of-commands) | the `shell-complexity` job of repo-platform's ci.yml; the fleet's `standard-checks` step is staged |
| [Markdown prose is never hard-wrapped](#markdown-prose-is-never-hard-wrapped) | `wrap:check` (repo-platform); review elsewhere |
| [Managed vs repo-owned files](#managed-vs-repo-owned-files) | the managed files check; the writer's starter rule |
| [Split files: the managed region](#split-files-the-managed-region) | the writer's split write; the managed files check |
| [Copilot review comments are advisory](#copilot-review-comments-are-advisory) | the managed `.github/instructions/review.instructions.md`; no ruleset requires Copilot's approval |
| [No backwards-compatibility code](#no-backwards-compatibility-code) | review |
| [Short comments](#short-comments) | the `file-size` step's comment caps (warn only); review for content |
| [Pre-commit hooks only check](#pre-commit-hooks-only-check) | review |
| [File size caps](#file-size-caps) | the `file-size` step (a hard cap fails the step, and the step fails the `standard-checks` job) |
| [How to bypass a check](#how-to-bypass-a-check) | each tool's own per-finding, in-repo bypass; no job-level switch exists |

## Sticky PR comments

**Rule:** a workflow that comments on a PR uses `marocchino/sticky-pull-request-comment`, pinned by full sha with the version tag in a trailing comment, `header: <repo>/<workflow-stem>`, upserting in place, and never swallowing a failure (no `continue-on-error`, no `|| true`).

**The one exception:** composite actions alone may set `continue-on-error` on the step. They post under the calling job's token, which a fork PR grants no write, so their comment is a convenience sink beside the step summary.

**Why:** one comment per workflow that edits itself on later runs, instead of a new comment per run.

**How** (repo-platform's managed workflows use `repo-platform/<stem>`):

```yaml
- uses: marocchino/sticky-pull-request-comment@5770ad5eb8f42dd2c4f34da00c94c5381e49af88 # v3.0.5
  with:
    header: my-repo/auto-format
    message: ...
```

**Enforced by:** review.

## Pinned actions

**Rule:** every action outside this repository, the owner's other repositories included, is pinned by full commit sha with the release tag in a trailing comment, `uses: actions/checkout@<40-hex sha> # v7.0.1`. The same action carries the same sha everywhere repo-platform ships it.

**Why:** a moving tag lets upstream change what the fleet runs without a PR anywhere. The sha freezes the code, the comment keeps the version readable, and Dependabot bumps both together.

**Exceptions:**

- **The platform's own channel:** `Vivswan/repo-platform/...@stable` references stay on the moving `stable` tag on purpose. It is the green-gated delivery channel ([build-provenance](platform/build-provenance.md)), so a pinned sha there would freeze the fleet on one green commit.

- **An action that publishes no version tags** is pinned to a branch commit with the branch in the comment, `uses: <owner>/<action>@<40-hex sha> # main`, the sha alone naming the version. [.github/pinact.yaml](../.github/pinact.yaml) skips each such action at a full sha only; the same action at a moving ref is judged like any other. Today that is `Vivswan/skills`, whose validate-skills action repo-platform's own ci.yml runs on its skills catalog.

- **How `Vivswan/skills` is held:** [tests/workflows/ci_shape.test.ts](../tests/workflows/ci_shape.test.ts) holds its lines to one sha and the branch comment, which pinact reads as no comment.

**Enforced by, in repo-platform (landing):** [pinact](https://github.com/suzuki-shunsuke/pinact) `run -check -verify-comment` in ci.yml's `actionlint` job, over this checkout and the two fleet trees the writer lands from `files/`.

- **What pinact refuses:** a third-party ref that is not a full sha, a sha without a version comment (pinact code 005), and a comment whose tag GitHub does not resolve to that very sha (code 001). So a dangling sha, a dangling tag, and a stale comment all fail before the fleet receives them.

- **What the delivery pins test refuses:** [tests/workflows/delivery_pins.test.ts](../tests/workflows/delivery_pins.test.ts) refuses a numeric comment pinact reads as a version but does not verify (`# v7`, `# v7.0`, `# v7-beta`). Such a line passes pinact unverified, sha included.

**Enforced by, in every managed repository:** [actions/zizmor](../actions/zizmor/action.yml) under the fleet policy.

- **`unpinned-uses`:** hash-pin for everything but the platform's own actions, so a `@main` platform ref passes here where pinact refuses it.
- **The online `impostor-commit`:** a sha outside the named repository's own history.

**Not judged, on purpose:**

- **One sha per action repo-wide** is Dependabot's doing, not a check's, since its one grouped `github-actions` bump PR ([dependabot.yml](../.github/dependabot.yml)) moves every site at once.

- **A commented example pin** (the toolchain blocks of the managed `checks.yml`) never executes, so pinact does not read it. The delivery pins test still reads its comment shape, so an example spells the full version too.

- **The sync writer's `files/` sources** are outside Dependabot's reach and nothing compares them with the bumped pins. So a bump PR here updates them by hand, commented examples included; the fleet receives them through the next sync.

## Conventional Commits, squash-merged

**Rule:** PR titles and commit subjects are [Conventional Commits](https://www.conventionalcommits.org/) as [commitlint](https://commitlint.js.org/)'s config-conventional judges them, with one scope per subject. PRs squash-merge, so the PR title becomes the commit subject.

**Refused:**

- a scope list (`fix(sync,writer): ...`: split the change or pick the scope that names it)
- a Sentence-case description (`fix: Repair installer`)
- a trailing period

**Exempt:** merge, revert, reapply, fixup, squash, amend, and bare version-number subjects (commitlint's default ignores, applied to the subject line). No line has a length cap.

**Why:** release-please derives versions and changelogs from the subjects.

**How:** `fix(sync): ...`, `feat(writer)!: ...`, `docs: ...`.

**Enforced by:** one judge, actions/validate-commit-names.

- **On the PR title:** the [`pr-title` check](settings.md#the-pr-title-ruleset) (pr-title module).
- **On the commit subjects:** the `commit-names` step of fleet-ci.yml's `standard-checks` job (in repo-platform's own ci.yml, a `commit-names` job).
- **Squash-only merging with the PR title as subject:** the [settings override layer](settings.md), applied to every managed repository.

## Plain ASCII punctuation

**Rule:** no curly quotes, em-dashes, or invisible unicode in any text file git tracks or would track, outside vendored installs and build output (the action's directory skip list); an ignored path is never judged.

**Why:** look-alike characters break greps, diffs, and agent edits that match on plain text.

**How:** `"..."`, `'...'`, `-`; a file that must carry non-ASCII goes in `.typography-allow.local`.

**Enforced by:** the `typography` step of `standard-checks` ([actions/check-typography](../actions/check-typography/action.yml)).

## Shell is a straight line of commands

**Rule:** an inline shell body (a workflow or composite-action `run:` step, a moon task `script`, a Containerfile `RUN`, a `*.sh`, `*.ps1`, or `*.bat` file, a tracked extensionless file whose shebang names a shell) may carry one level of a construct. A construct inside another, or a function at any depth, is a TypeScript script run by bun.

- **Depth 1, allowed:** an `if`, `for`, `while`, `until`, `case`, `||` chain, or tested command substitution whose body holds only plain commands.
- **Depth 2, refused:** any construct inside another: an `if` inside a `for`, a `case` inside an `if`, a `||` inside an `if` body, a tested `$(...)` inside a loop or an `if`.
- **A function is refused at any depth:** a function is a script asking to be TypeScript.

Refused:

```bash
for f in *; do
  if [ -f "$f" ]; then cat "$f"; fi
done
```

Allowed:

```bash
if [ -f x ]; then cat x; fi
```

**Why:** bash-only defects cost review rounds: `set -e` does not reach a failed command inside a tested `$(...)`, macOS ships bash 3.2, and `grep`'s locale and PCRE behaviour differ by runner. A script has types, a test, and one runtime.

**How:** the constructs the depth rule counts, per dialect:

| Dialect | Parsed by | Constructs |
| --- | --- | --- |
| bash, sh, zsh (an unset `shell:` is bash, or pwsh on a Windows `runs-on`) | mvdan/sh, shfmt's parser, as bash | `if`, `case`, `for`, `while`, `until`, a `\|\|` chain, a `$(...)` fed to `test`, `[`, or `[[`; a function is refused outright |
| PowerShell (`pwsh`, `powershell`, `*.ps1`, `*.psm1`) | PowerShell's own parser, through `pwsh` | `if`, `switch`, `for`, `foreach`, `while`, `do`, `try`, a `\|\|` chain; a function is refused outright |
| cmd (`shell: cmd`, `*.bat`, `*.cmd`) | tokens, after dropping `rem` and `::` lines: no parser exists for cmd | `if`, `for`, `\|\|`, counted by keyword rather than structure: one passes, two or more are refused; a `goto`, a `:label`, or a `call :label` is refused outright |

- **Allowed at any depth:** commands joined by newlines, `&&`, or pipes; redirects; `set -e` and `set -o pipefail`; assignments, `${X:-default}` included; `echo "k=$(v)" >> "$GITHUB_OUTPUT"`.
- **cmd over-reports:** a token scan cannot tell a keyword inside a quoted argument from the real thing, so it counts both; the allow-list is the remedy.
- **zsh parses as bash:** mvdan/sh's zsh support is experimental, so a zsh-only expansion is a "does not parse" finding; the allow-list is the remedy.
- **pwsh must be on the runner** when a PowerShell body exists; the step fails naming it, never skips.
- **Exempt:** a block that must stay shell goes in `.shell-complexity-allow.local` as `path # reason`, the reason mandatory; an entry whose file has no refused construct left fails as stale.
- **Skipped and counted:** a file with the managed header (repo-platform owns it), and a yaml file that does not parse (yamllint owns validity; the check warns). Vendored installs and build output are never read: `node_modules`, `vendor`, `third_party`, `dist`, `build`, `.venv`.

**Enforced by:** today, repo-platform's own `shell-complexity` job ([actions/check-shell-complexity](../actions/check-shell-complexity/action.yml)), over this checkout and over the fleet trees its writer lands (the templates under `files/` are not yaml until written, and there the managed files are judged too). The `standard-checks` step for the fleet lands in a sibling PR once every shipped template and reusable workflow is clean.

## Markdown prose is never hard-wrapped

**Rule:** one source line per paragraph, list item, or quote paragraph.

**Why:** a wrapped paragraph diffs as many changed lines for a one-word edit, and renders as ragged breaks in soft-wrapping viewers.

**How:** write the paragraph on one line and let the viewer wrap it.

**Enforced by:** `bun run wrap:check` in repo-platform; review elsewhere.

- **Deno repos:** the auto-format starter runs `deno fmt --prose-wrap preserve`, which keeps a paragraph's existing line breaks. It adds no wraps but removes none, so it does not enforce the rule.

## Managed vs repo-owned files

**Rule:** a file whose header says `This file is managed by <owner>/repo-platform.` changes only through sync PRs, and so does the rendered `.github/settings.yml` (its header says `Generated by repo-platform - do not edit.`). A repo-owned starter (`checks.yml`, `post-green.yml`, `.github/settings.local.yml`, ...) is written once and never overwritten.

**Why:** an edit to a managed file is overwritten by the next sync PR, so the change belongs in repo-platform.

**How:** change the source under `files/` in repo-platform; the starters are the `class: starter` entries of its [files.yml](../files.yml).

**Enforced by:**

- **Managed files:** the managed files check ([actions/validate-managed-files](../actions/validate-managed-files/action.yml)), byte to byte against the recorded commit's write.
- **Starters:** the writer, which writes one only when the path is absent and never touches it again ([platform/sync/writer.md](platform/sync/writer.md#classes)).

## Split files: the managed region

**Rule:** a split file (`.gitignore`, `.github/CODEOWNERS`, `AGENTS.md`, ...) is optional repo-owned content above a BEGIN marker line, managed content, an END marker line, and optional repo-owned content below. The ownership manifest declares the markers per file. Repo-owned content goes outside the region; inside it, the content stays exactly as rendered.

**Why:** the sync rewrites every split file structurally instead of merging it: the fresh managed region, the repository's own sides byte-for-byte around it. A platform retraction can never eat a local side, and a local side can never resurrect retracted managed lines.

**The cost of an edit INSIDE the region:** it is replaced on every sync, reported as a replaced local edit with its diff, and the PR is held for review.

**How:** put local content above the BEGIN marker or below the END marker.

**Enforced by:** the writer's split write ([write_split.ts](../.github/scripts/sync/writer/write_split.ts), the class table in [platform/sync/writer.md](platform/sync/writer.md#classes)); the managed files check on the region.

## Copilot review comments are advisory

**Rule:** Copilot code review comments only on a defect it can demonstrate in the diff. Its comments are advisory, so rejecting one is a valid outcome: reply with the reason, then resolve the thread.

**Why:** speculative hardening and unenforced style opinions cost review time without catching a bug.

**How:** the rules Copilot reads are the managed `.github/instructions/review.instructions.md` (source: `files/base/.github/instructions/review.instructions.md` in repo-platform).

**Resolving the thread** is the UI's "Resolve conversation", or GraphQL `resolveReviewThread`. It is required: the managed `main` ruleset sets `required_review_thread_resolution`, so an unresolved thread blocks the merge whatever the reply says.

**Enforced by:** that file for what earns a comment (written to every repository). The comments are advisory by the settings layers ([Copilot code review](settings.md#copilot-code-review)).

## No backwards-compatibility code

**Rule:** no compatibility shims, dual code paths, or retired-shape handling outside a repo's own `migrations/` directory; repo-platform's rungs live in its own ([platform/sync/writer.md](platform/sync/writer.md#migrations)).

**Why:** a one-shot replacement with a loud PR note stays readable; a compat era accretes paths nobody removes.

**How:** replace the shape in one PR and say so in the PR body.

- **A file the platform stops writing** leaves `files.yml`, and every target's next sync retires the recorded file ([platform/sync/writer.md](platform/sync/writer.md#retirement)).
- **A transition the sync cannot carry by itself** is one rung in `migrations/`, the only home for transitional code.

**Enforced by:** review.

## Short comments

**Rule:** a comment says what the code cannot show, in one to three lines. A comment block or file header past its warn cap ([the caps table](#file-size-caps)) is a warning.

**Why:** a comment grown into a paragraph is narration (delete it) or a workaround defense (fix the code); the code is the single source of truth.

**How:** cut the comment to its constraint.

**A block that must stay long** (a license text, an upstream-shaped header) carries a comment line `comment-cap: ignore <reason>` inside it or directly above it, which exempts that block alone. The reason is mandatory: a bare marker exempts nothing and warns itself.

**Enforced by:** the comment caps of the `file-size` step ([file size caps](#file-size-caps)), warn only, never a failure.

## Pre-commit hooks only check

**Rule:** a pre-commit hook does one of two things: it checks, and a failing check fails the commit; or it checks, writes the fix into the working tree, and still fails. Nothing else: no staging or committing, no fix-then-pass, no push, no network, no side effect beyond that write. The developer reviews and stages the fix, then reruns the commit.

**Why:** a hook that fixes and re-stages commits bytes the developer never saw, and the one that regenerated and staged under git's exported `GIT_DIR` rewrote a repository's shared config.

**How:** either run the check-only form of each tool (`biome ci`) and let its failure stand, or run the write form (`biome format --write`) and fail the hook whenever it changed a file, naming the files. Never a git command that writes (`add`, `commit`, `stash`, `checkout`, `reset`, `push`, `config`); read-only queries such as `git diff --cached --name-only` are fine. A formatter-and-restage step, lint-staged and its kind, is out.

**Enforced by:** review; repo-platform ships no hook.

## File size caps

**Rule:** no file over its hard line cap, and in a source, test, workflow, or shell file no line over 256 code points, comment lines included. A `//` line past the cap is a width finding whatever block it sits in.

The caps live in [check-file-size.ts](../actions/check-file-size/check-file-size.ts):

| Kind | Which files | Hard cap (fails) | Warn cap (annotates) |
|---|---|---|---|
| source | `.ts`, `.js`, `.py`, `.rs`, `.go`, `.swift`, `.kt`, `.java`, `.c`, `.cpp`, and their sibling extensions | 2000 lines | 1600 lines |
| test | a source file named `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, `test_*`, Rust's `*_tests.rs`, `tests.rs`, `proptests.rs`, or under `test/`, `tests/`, `__tests__/` | 3200 lines | 2560 lines |
| workflow | yaml under `.github/workflows/`, and any `action.yml` or `action.yaml` | 1000 lines | 800 lines |
| shell | `.sh`, `.bash`, `.zsh` | 1000 lines | 800 lines |
| markdown | `.md` | 1300 lines | 1040 lines |
| line width | every kind but markdown (one source line per paragraph is the fleet rule) | 256 code points | 150 code points |
| comment block | a run of comment-only lines (below; markdown is prose) | never fails | 10 lines; 25 for the file header |

- **A comment block** is a run of lines holding nothing but comment tokens as the file's grammar tokenizes them. A multi-line comment counts every line between its delimiters, and a string or here-doc holding comment syntax is code.
- **What ends a block:** a blank line or a code line. A line with code on it is code, so an inline comment after it is not a block.
- **The file header** is the first block, when nothing but a shebang, blank lines, or a generated region precedes it.

**Why:** a file past these sizes is several files wearing one name, and a line past the width is unreadable in any review pane. The caps are generous on purpose: they catch drift, not style.

**Exempt by construction:**

- **No kind:** lockfiles, json, and non-workflow yaml; anything under `node_modules/`, `vendor/`, `third_party/`, `goldens/`, or `__snapshots__/`.

- **Generated:** a file whose first ten lines carry a comment declaring it generated (`generated by X`, `do not edit`; a comment that merely names a generator is not a declaration), and the lines inside a `BEGIN GENERATED`/`END GENERATED` region.

- **Managed:** a file carrying repo-platform's managed header (the repository cannot fix it; the summary counts them).

- **One token:** a line that is one whitespace-free token (a URL, a sha, an expression) is unbreakable, so it passes both width tiers. A literal assigned on the same line is two tokens and does not.

- **One literal:** a line that is one string, template, or regex literal with nothing but punctuation and keywords beside it (assigned, returned, keyed, a sole argument, a line inside a multi-line literal) passes the warn width tier only, since wrapping it means splitting the literal.

**How:** split the file, wrap the line, shorten the comment. Two per-finding bypasses exist, both repo-owned and visible in the diff: the comment block's marker ([short comments](#short-comments)) and the allowlist.

- **A file that must stay large** goes in `.file-size-allow.local`, one `path # reason` per line (blank lines and `#` comment lines are skipped), which exempts every finding on that path in both tiers.

- **The reason is mandatory** and must be one a reader accepts: vendored or upstream-shaped, generated but missed by the header exemption, a split that would break an external contract, a file that predates the cap and names the PR its split waits on. "Large" or "legacy" alone is not a reason.

- **An allowlist entry without a reason fails the check,** and so does a stale one: a path with no finding left (under every cap, no bare marker) or not a tracked file.

- **Packaging:** a repository that packages from its root (an npm package with no `files` field, for one) lists the allowlist in its packaging ignore file (`.npmignore`), or it ships as content.

**Enforced by:** the `file-size` step of fleet-ci.yml's `standard-checks` job ([actions/check-file-size](../actions/check-file-size/action.yml)). It parses every judged file with web-tree-sitter and prebuilt wasm grammars for TypeScript, JavaScript, Python, Rust, Go, Kotlin, Java, C, C++, shell, and yaml.

- **An extension without a working grammar** (today Swift, whose prebuilt grammar keeps scanner state across files) gets no comment judgement and no literal exemption, and the step summary names it as unjudged instead of guessing at it.

- **What fails:** a hard-cap finding or an allowlist defect fails the step, and the judge fails the `standard-checks` job naming it. repo-platform's own ci.yml runs the same action as its standalone `file-size` job.

- **Where findings go:** the step summary is written on every outcome (findings, clean, or an error that stopped the check). Findings also go to the log annotations, and on pull requests to one sticky PR comment, deleted when the tree is clean.

## How to bypass a check

**Rule:** a blocking check is bypassed only through its tool's own per-finding mechanism, in the repository, visible in the diff, with a reason beside it. No job-level switch, environment variable, or label skips a check.

**Why:** a per-finding bypass records what was accepted and why, beside the code it excuses, and covers only that finding; a switch hides every future finding too.

**How:** the table below, one row per check fleet-ci.yml runs. zizmor runs the fleet policy alone; knip runs on its own defaults, which the repo-owned `knip.json` overrides where it sets a key; `_typos.toml` extends the fleet allowlist.

| Check | Where it runs | Blocks on | Bypass |
|---|---|---|---|
| actionlint | standard-checks | any finding | a `# shellcheck disable=SCnnnn` comment on the line above the command (shellcheck findings); the repo-owned `.github/actionlint.yaml` for the rest |
| yamllint | standard-checks | any finding (strict) | a `# yamllint disable-line rule:<name>` comment on the line (`.yamllint` itself is managed) |
| gitleaks | standard-checks | any leak | the finding's fingerprint in `.gitleaksignore`; an allowlist rule in the repo-owned `.gitleaks.toml` |
| typography | standard-checks | any non-ASCII look-alike | the file's path prefix in `.typography-allow.local` |
| shell-complexity | repo-platform's ci.yml today; the `standard-checks` step is staged | a refused construct or an allowlist defect | the path in the repo-owned `.shell-complexity-allow.local` with a `# reason` |
| file-size | standard-checks | a hard-cap finding or an allowlist defect | the path in the repo-owned `.file-size-allow.local` with a `# reason`; the comment block's marker ([short comments](#short-comments)) |
| commit-names | standard-checks | a subject commitlint refuses under config-conventional plus one scope ([the grammar](#conventional-commits-squash-merged)) | none: reword the commit |
| typos | standard-checks | any finding | an entry in the repo-owned `_typos.toml` (keys below), or a trailing `typos: ignore` comment for a one-off |
| zizmor | standard-checks | a high finding (retry rule below); code scanning shows high findings only | a `# zizmor: ignore[rule]` comment on the finding's line with the reason beside it |
| knip | standard-checks (bun repos with a package.json to install from; a repo without one stands down with a notice) | any finding | an `ignore*` entry in the repo-owned `knip.json` or a `@public` JSDoc tag on the export |
| semgrep | semgrep (public repos) | an ERROR finding, a fatal analysis error, or a scan that did not complete (its exit status is named) | a `// nosemgrep: <rule-id>` comment (`# nosemgrep: <rule-id>` in YAML) on the finding's line or the line above it, with the reason beside it ([security-scans.md](modules/security-scans.md#semgrep)) |
| dependency-review | dependency-review | a vulnerable dependency at or above high | none: upgrade or drop the dependency |
| deno audit | deno-audit.yml (deno repos; pull requests and main pushes touching deno.lock, plus a weekly run) | a high or critical advisory (`--level high`), a lockfile out of date with its manifest (`--frozen`), or no tracked `deno.lock` at the repository root | none: upgrade or drop the dependency, or commit the lockfile |
| Trivy | standard-checks on every event but the schedule (the schedule split below) | a HIGH or CRITICAL vulnerability with a fix available, or any HIGH or CRITICAL misconfiguration | an entry in the repo-owned `.trivyignore.yaml` carrying a `statement` and an `expired_at` date ([security-scans.md](modules/security-scans.md#bypassing-a-finding-trivyignoreyaml)); the plain `.trivyignore` is refused |
| CodeQL | codeql | nothing in the job; the `main` ruleset's `code_scanning` rule blocks the merge at the fleet's alert bar ([settings.md](settings.md#what-the-baseline-contains)) | a code scanning dismissal with a reason |

- **typos config files:** the repo-owned file may be `_typos.toml`, `typos.toml`, or `.typos.toml`, which typos layers under the fleet config. `[default.extend-words]` holds the repository's vocabulary, `[files] extend-exclude` fixture paths spelled wrong on purpose, and `[default.extend-identifiers]` one identifier.

- **The typos one-off:** `# typos: ignore` or `// typos: ignore` at the end of the line.

- **zizmor's retry:** zizmor exits non-zero alike on an audit error and on a finding, so a failed attempt runs once more and only the retry's result counts.

- **Trivy on the schedule:** `trivy-nightly` runs instead, public repositories only, and reports without blocking. Both scans run at HIGH and CRITICAL, so a MEDIUM or LOW finding appears nowhere.

**What knip finds on its own:** package.json `main`, `bin`, and scripts; the scripts that workflow `run:` steps and `.github/**/action.yml` files invoke; what its plugins read (a bunfig `preload`); `index`, `cli`, and `main` at the root or under `src/`.

**What a repo-owned `knip.json` names,** under `entry` and `ignoreBinaries`, is what knip would otherwise report as unused files and unlisted binaries:

- **Entrypoints anywhere else:** tests run by name through a launcher script, git hooks, scripts run by path, composite actions outside `.github/`.
- **Package.json scripts** that run a tool CI installs itself.
- **A configured `entry` list replaces** knip's default `index`, `cli`, and `main` patterns rather than extending them, so a repo that keeps one of those repeats it.

**What the typos fleet config settles before a repository's bypass applies:** it ignores hex digests and the one-off marker above, and skips lockfiles, minified bundles, SVGs, `node_modules/`, and a root `dist/` (committed build output). A root `lib/` is source in a Node repository, so a repository that generates it excludes it in its own file; a spelling variant a repository keeps goes in its own `_typos.toml`.

**Enforced by:** review of the diff that carries the bypass; the sync overwrites a managed file, so a bypass in one is lost on the next sync PR.

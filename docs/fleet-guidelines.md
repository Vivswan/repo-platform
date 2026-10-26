---
order: 20
group: Start here
---

# Fleet guidelines

Conventions every managed repository follows, whether the file is managed by sync or repo-owned. A rule a check enforces is the check's to state when it fires, so this page keeps the rest: each entry names what enforces it, and "review" means nothing in CI does.

| Guideline | Enforced by |
|---|---|
| [Sticky PR comments](#sticky-pr-comments) | review |
| [Conventional Commits, squash-merged](#conventional-commits-squash-merged) | the `pr-title` check and the `commit-names` step for the grammar; review for the type |
| [Markdown prose is never hard-wrapped](#markdown-prose-is-never-hard-wrapped) | `wrap:check` (repo-platform); review elsewhere |
| [AGENTS.md keeps what the skills do not](#agentsmd-keeps-what-the-skills-do-not) | review |
| [Copilot review comments are advisory](#copilot-review-comments-are-advisory) | the managed `.github/instructions/review.instructions.md` for what earns a comment; the `main` ruleset for thread resolution; review for the reply |
| [No backwards-compatibility code](#no-backwards-compatibility-code) | review |
| [The boundary repairs or refuses](#the-boundary-repairs-or-refuses) | review |
| [Short comments](#short-comments) | the `file-size` step's comment caps (warn only); review for content |
| [Action and workflow descriptions](#action-and-workflow-descriptions) | `tests/actions/action_metadata.test.ts` in repo-platform (no expression delimiter); review for the shape |
| [Pre-commit hooks only check](#pre-commit-hooks-only-check) | review |
| [File size caps](#file-size-caps) | the `file-size` step (a hard cap fails the step, and the step fails the `standard-checks` job) |
| [How to bypass a check](#how-to-bypass-a-check) | each tool's own per-finding, in-repo bypass; no job-level switch exists |

## Sticky PR comments

**Rule:** a workflow that comments on a PR uses `marocchino/sticky-pull-request-comment` with `header: <repo>/<workflow-stem>` (repo-platform's managed workflows use `repo-platform/<stem>`), upserting in place and never swallowing a failure (no `continue-on-error`, no `|| true`): one comment per workflow that edits itself on later runs. A composite action alone may set `continue-on-error` on its comment step, since a fork PR grants its token no write.

**Enforced by:** review.

## Conventional Commits, squash-merged

**Rule:** the type names what the change does to behavior, not the shape of the diff: observable behavior that moved is a `fix`, a `feat`, or a `perf`, even when the work began as a refactor, and `refactor` means the existing tests pass unchanged. release-please hides `refactor` (with `chore`, `test`, and `docs`) from the release notes, so a fix titled that way vanishes from them.

**Enforced by:** review of the type (read the diff's shape against the title's purpose before landing); the grammar is the `pr-title` check's and the `commit-names` step's, and squash-only merging with the PR title as subject is the [settings override layer](settings.md)'s.

## Markdown prose is never hard-wrapped

**Rule:** one source line per paragraph, list item, or quote paragraph, so a one-word edit diffs as one line and a soft-wrapping viewer shows no ragged breaks.

**Enforced by:** `bun run wrap:check`, in repo-platform alone; review elsewhere.

## AGENTS.md keeps what the skills do not

**Rule:** AGENTS.md holds what an agent cannot learn elsewhere: the repository's CI gates, its contracts and decisions, its toolchain entry points, and the managed block. It never restates a rule an installed agent skill owns outright (PR body shape, review rounds, attribution lines, comment and test standards). A convention a skill defers to the repository (Conventional Commits) stays.

**Enforced by:** review.

## Copilot review comments are advisory

**Rule:** rejecting a Copilot review comment is a valid outcome: reply with the reason, then resolve the thread ("Resolve conversation", or GraphQL `resolveReviewThread`). What earns a comment is the managed `.github/instructions/review.instructions.md` (source: `files/base/.github/instructions/review.instructions.md`); whether a review blocks is the settings layers' ([Copilot code review](settings.md#copilot-code-review)).

**Enforced by:** review of the reply; the `main` ruleset's thread resolution blocks the merge on an unresolved thread whatever the reply says.

## No backwards-compatibility code

**Rule:** no compatibility shims, dual code paths, or retired-shape handling outside a repo's own `migrations/` directory; repo-platform's rungs live in its own ([platform/sync/writer.md](platform/sync/writer.md#migrations)).

**Why:** a one-shot replacement with a loud PR note stays readable; a compat era accretes paths nobody removes.

**How:** replace the shape in one PR and say so in the PR body.

- **A file the platform stops writing** leaves `files.yml`, and every target's next sync retires the recorded file ([platform/sync/writer.md](platform/sync/writer.md#retirement)).
- **A transition the sync cannot carry by itself** is one rung in `migrations/`, the only home for transitional code.

**Enforced by:** review.

## The boundary repairs or refuses

**Rule:** malformed input or state is resolved once, where it enters. Ownership follows the direction of data. What the tool only reads is never its own: a malformation there is refused, naming the key and the fix. What the tool also writes may be its own: one unambiguous repair is applied, reported where a user would want to know, and the tool continues. With no repair, refuse there.

**Why:** a refusal in state the tool itself writes, where one repair exists, stops a repository for nothing. A repair of a value the user declared hides their mistake and rewrites their file. A defect carried past the boundary fails a later step far from its cause.

**How:** read only (a user's settings file, CLI arguments, a caller's payload): refuse. Read and written (state the tool applies, config it renders, caches, generated artifacts): heal toward the declared intent. A quoted `"true"` is refused in the user's settings file and healed in a config file the tool renders. When the direction is unclear, ask the owner.

**Healing runs toward the declaration, never away from it.** A settings-apply tool heals the live settings when they drift from the user's yaml. Healing the yaml from the live settings is the forbidden direction. The comment on a healing step states the rule in one line and does not argue for it ([short comments](#short-comments)).

**A tool's block inside a user's file splits by the same test.** User-supplied values in the block are the user's: a malformation is reported, naming the key and the fix, never healed. The shape is the tool's: a [schema migration](#no-backwards-compatibility-code) may rewrite the block. In a block the tool renders whole, an edit is [replaced](platform/sync/writer.md#classes) toward the declaration and the diff is reported. Nothing outside the block is touched.

**A failure that happens on its own needs no check in front of it.** The tool's own failure is the boundary's refusal. A missing package, a stale lockfile, a version conflict, or a wrong toolchain fails the build or the gate when it happens and is fixed then. A pre-check that restates the tool's failure is deleted. A test stays for behavior the code does not enforce.

The specimen: a 500-line pre-commit script comparing installed packages against the lockfile, deleted. The one case it caught that does not fail by itself is an installed version drifting from the lock. That drift is accepted. CI's fresh install is the source of truth.

**Enforced by:** review.

## Short comments

**Rule:** a comment says what the code cannot show, in one to three lines; one grown into a paragraph is narration (delete it) or a workaround defense (fix the code), since the code is the single source of truth. A block that must stay long (a license text, an upstream-shaped header) carries a comment line `comment-cap: ignore <reason>` inside it or directly above it, the reason mandatory.

**Enforced by:** the comment caps of the `file-size` step ([file size caps](#file-size-caps)), warn only, never a failure; review for content.

## Action and workflow descriptions

**Rule:** an action's `description:`, a workflow's header comment, and a `workflow_call` or `workflow_dispatch` input or output description open with one orienting sentence, then carry one fact per paragraph of one to three sentences, under 70 words, with no semicolon chain.

**The shape:** an action's description in a literal block (`|`), an enumerable set as a `-` list, an input or output in one sentence, the caller's obligations (permissions, inputs, PATH) stated plainly, and a fact a file or page owns as one sentence plus its name.

**Enforced by:** `tests/actions/action_metadata.test.ts` in repo-platform refuses an expression delimiter in any action's name or descriptions; review for the shape.

## Pre-commit hooks only check

**Rule:** a pre-commit hook does one of two things: it checks, and a failing check fails the commit; or it checks, writes the fix into the working tree, and still fails. Nothing else: no staging or committing, no fix-then-pass, no push, no network, no side effect beyond that write. The developer reviews and stages the fix, then reruns the commit.

**Why:** a hook that fixes and re-stages commits bytes the developer never saw, and the one that regenerated and staged under git's exported `GIT_DIR` rewrote a repository's shared config.

**How:** either run the check-only form of each tool (`biome ci`) and let its failure stand, or run the write form (`biome format --write`) and fail the hook whenever it changed a file, naming the files. Never a git command that writes (`add`, `commit`, `stash`, `checkout`, `reset`, `push`, `config`); read-only queries such as `git diff --cached --name-only` are fine. A formatter-and-restage step, lint-staged and its kind, is out.

A hook installs nothing: no runtime, no dependencies, no tools. Setup is the repository's bootstrap command (`bun run bootstrap` here), and no step pre-checks it: a missing dependency fails the first check on its own, and a check for what fails by itself is not written. Scripts run installed launchers under bun (`bun node_modules/.bin/biome ci .`), never `bun x`, whose fallback downloads a package when none is installed.

A hook is a tracked executable file, with `core.hooksPath` naming its folder, so every checkout and worktree has it with nothing generated. A hook folder a tool generates at install time exists only where that install ran, and a fresh worktree commits unchecked.

A hook runs only the checks the repository's own toolchain provides (bun here; uv in a Python repository). A check that needs another runtime or a separately installed binary, yamllint, actionlint, and gitleaks among them, is CI's: the shipped workflow runs it on every pull request and push to main, for every repository alike.

**Enforced by:** review. repo-platform's own hook is the tracked [.githooks/pre-commit](../.githooks/pre-commit), which `bun run bootstrap` installs through `core.hooksPath` ([scripts/bootstrap.ts](../scripts/bootstrap.ts)); it runs the static checks and fails, and never writes.

## File size caps

**Rule:** no file over its hard line cap, no line over 256 code points in a source, test, workflow, or shell file (comment lines included), and no comment block over its cap. Below the width cap, line length is the repo-owned formatter's or linter's to judge (biome, ruff, prettier, yamllint).

The caps live in [check-file-size.ts](../actions/check-file-size/check-file-size.ts):

| Kind | Which files | Hard cap (fails) | Warn cap (annotates) |
|---|---|---|---|
| source | `.ts`, `.js`, `.py`, `.rs`, `.go`, `.swift`, `.kt`, `.java`, `.c`, `.cpp`, and their sibling extensions | 2000 lines | 1600 lines |
| test | a source file named `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, `test_*`, Rust's `*_tests.rs`, `tests.rs`, `proptests.rs`, or under `test/`, `tests/`, `__tests__/` | 3200 lines | 2560 lines |
| workflow | yaml under `.github/workflows/`, and any `action.yml` or `action.yaml` | 1000 lines | 800 lines |
| shell | `.sh`, `.bash`, `.zsh` | 1000 lines | 800 lines |
| markdown | `.md` | 1300 lines | 1040 lines |
| line width | every kind but markdown (one source line per paragraph is the fleet rule) | 256 code points | none |
| comment block | a run of comment-only lines (below; markdown is prose) | never fails | 10 lines; 25 for the file header |

- **A comment block** is a run of consecutive lines opening with a comment prefix (`#`, `//`, `/*`, `*`, `<!--`, `--`, `;`, `%`, `{#`, `"""`, `'''`), indentation aside, whatever the file's language. The reading is by line, never by grammar.
- **The accepted cost:** a string, here-doc, or block-scalar line opening with one of those prefixes reads as a comment, and a `/* */` body line opening with anything else reads as code. A misread can raise a block warning the language would not, or merge a block into the header and hide one. Both caps are the warn tier: a warning either way, never a red check.
- **What ends a block:** a blank line or a code line. A line opening with code is code, so an inline comment after it is not a block.
- **The file header** is the first block, when nothing but a shebang, blank lines, or a generated region precedes it.

**Why:** a file past these sizes is several files wearing one name, and a line past the width is unreadable in any review pane. The caps are generous on purpose: they catch drift, not style.

**Exempt by construction:**

- **No kind:** lockfiles, json, and non-workflow yaml; anything under `node_modules/`, `vendor/`, `third_party/`, `goldens/`, or `__snapshots__/`.

- **Generated:** a file whose first ten lines carry a comment declaring it generated (`generated by X`, `do not edit`; a comment that merely names a generator is not a declaration), and the lines inside a `BEGIN GENERATED`/`END GENERATED` region.

- **Managed:** a file carrying repo-platform's managed header (the repository cannot fix it; the summary counts them).

- **One token:** a line that is one whitespace-free token (a URL, a sha, an expression) is unbreakable, so it passes the width cap. A literal assigned on the same line is two tokens and does not.

**How:** split the file, wrap the line, shorten the comment. Two per-finding bypasses exist, both repo-owned and visible in the diff: the comment block's marker ([short comments](#short-comments)) and the allowlist.

- **A file that must stay large** goes in `.file-size-allow.local`, one `path # reason` per line (blank lines and `#` comment lines are skipped), which exempts every finding on that path in both tiers.

- **The reason is mandatory** and must be one a reader accepts: vendored or upstream-shaped, generated but missed by the header exemption, a split that would break an external contract, a file that predates the cap and names the PR its split waits on. "Large" or "legacy" alone is not a reason.

- **An allowlist entry without a reason fails the check,** and so does a stale one: a path with no finding left (under every cap, no bare marker) or not a tracked file.

- **Packaging:** a repository that packages from its root (an npm package with no `files` field, for one) lists the allowlist in its packaging ignore file (`.npmignore`), or it ships as content.

**Enforced by:** the `file-size` step of fleet.yml's `standard-checks` job ([actions/check-file-size](../actions/check-file-size/action.yml)). It reads lines and nothing else: no parser, no grammar. Its one runtime dependency is `@actions/core`, which writes its annotations, summary, and output.

- **What fails:** a hard-cap finding or an allowlist defect fails the step, and with it the `standard-checks` job. repo-platform's own ci.yml runs the same action as its standalone `file-size` job.

- **Where findings go:** the step summary is written on every outcome (findings, clean, or an error that stopped the check). Findings also go to the log annotations, and on pull requests to one sticky PR comment, deleted when the tree is clean.

## How to bypass a check

**Rule:** a blocking check is bypassed only through its tool's own per-finding mechanism, in the repository, visible in the diff, with a reason beside it. No job-level switch, environment variable, or label skips a check.

**Why:** a per-finding bypass records what was accepted and why, beside the code it excuses, and covers only that finding; a switch hides every future finding too.

**How:** the table below, one row per check fleet.yml runs, plus the clippy floor the rust starter's cargo steps gate. zizmor runs the fleet policy alone; knip runs on its own defaults, which the repo-owned `knip.json` overrides where it sets a key; `_typos.toml` extends the fleet allowlist.

| Check | Where it runs | Blocks on | Bypass |
|---|---|---|---|
| actionlint | standard-checks | any finding | a `# shellcheck disable=SCnnnn` comment on the line above the command (shellcheck findings); the repo-owned `.github/actionlint.yaml` for the rest |
| yamllint | standard-checks | any finding (strict) | a `# yamllint disable-line rule:<name>` comment on the line (`.yamllint` itself is managed) |
| gitleaks | standard-checks | any leak | the finding's fingerprint in `.gitleaksignore`; an allowlist rule in the repo-owned `.gitleaks.toml` |
| typography | standard-checks | any non-ASCII look-alike | the file's path prefix in `.typography-allow.local` |
| shell-complexity | standard-checks | a refused construct or an allowlist defect | the path in the repo-owned `.shell-complexity-allow.local` with a `# reason` |
| file-size | standard-checks | a hard-cap finding or an allowlist defect | the path in the repo-owned `.file-size-allow.local` with a `# reason`; the comment block's marker ([short comments](#short-comments)) |
| commit-names | standard-checks | a subject commitlint refuses under config-conventional plus one scope ([the grammar](#conventional-commits-squash-merged)) | none: reword the commit |
| typos | standard-checks | any finding | an entry in the repo-owned `_typos.toml` (keys below), or a trailing `typos: ignore` comment for a one-off |
| zizmor | standard-checks | a high finding, by zizmor's own exit code; code scanning shows high findings only | a `# zizmor: ignore[rule]` comment on the finding's line with the reason beside it |
| biome | standard-checks (bun repos with a `biome.json`; a repo the sync has not reached stands down with a notice) | any finding under the managed `biome.json` ([typescript.md](modules/typescript.md#the-two-layers)) | a per-path `overrides` entry in the repo-owned `biome.local.jsonc` with its reason beside it, never a `biome-ignore` line; a repository-wide relaxation has no home, since the managed file applies last over the local layer's top-level rules |
| member-shape | standard-checks (bun repos) | nothing: advisory, a finding is a warning annotation and a sticky comment under the four [member-shape rules](modules/typescript.md#the-member-shape-rules); a file oxc cannot parse is warned, never judged | the path in the repo-owned `.member-shape-allow.local` with a `# reason` |
| ruff | standard-checks (uv repos with a `ruff.toml`; a repo the sync has not reached stands down with a notice; a root `.ruff.toml` is refused) | any finding under the managed `ruff.toml` ([python.md](modules/python.md)) | a scoped `per-file-ignores` entry in the repository's `pyproject.toml`, its reason beside it; the floor's families and thresholds have no bypass, since an `ignore` or a looser threshold there is re-selected or overridden by the managed file |
| clippy floor | the cargo steps of the repo-owned `checks.yml` (rust repos, [rust.md](modules/rust.md)) | any lint of the floor, every one `deny` | `#[expect(clippy::<lint>, reason = "...")]` on the one item it names; never `#[allow]` (itself denied), never a raised threshold (the floor's lint tables are the fleet's) |
| knip | standard-checks (bun repos with a package.json to install from; a repo without one stands down with a notice) | any finding | an `ignore*` entry in the repo-owned `knip.json` or a `@public` JSDoc tag on the export |
| semgrep | semgrep (public repos) | an ERROR finding, a fatal analysis error, or a scan that did not complete (its exit status is named) | a `// nosemgrep: <rule-id>` comment (`# nosemgrep: <rule-id>` in YAML) on the finding's line or the line above it, with the reason beside it ([security-scans.md](modules/security-scans.md#semgrep)) |
| dependency-review | dependency-review | a vulnerable dependency at or above high | none: upgrade or drop the dependency |
| Trivy | standard-checks on every event but the schedule (the schedule split below) | a HIGH or CRITICAL vulnerability with a fix available, or any HIGH or CRITICAL misconfiguration | an entry in the repo-owned `.trivyignore.yaml` carrying a `statement` and an `expired_at` date ([security-scans.md](modules/security-scans.md#bypassing-a-finding-trivyignoreyaml)); the plain `.trivyignore` is refused |
| CodeQL | codeql | nothing in the job; the `main` ruleset's `code_scanning` rule blocks the merge at the fleet's alert bar ([settings.md](settings.md#what-the-baseline-contains)) | a code scanning dismissal with a reason |

- **typos config files:** the repo-owned file may be `_typos.toml`, `typos.toml`, or `.typos.toml`, which typos layers under the fleet config. `[default.extend-words]` holds the repository's vocabulary, `[files] extend-exclude` fixture paths spelled wrong on purpose, and `[default.extend-identifiers]` one identifier.

- **The typos one-off:** `# typos: ignore` or `// typos: ignore` at the end of the line.

- **zizmor's two passes:** one pinned zizmor under one rendered policy, a SARIF pass for code scanning (zizmor exits 0 in SARIF mode whatever it finds) and a plain pass whose exit is the verdict.

- **Trivy on the schedule:** `trivy-nightly` runs instead, public repositories only, and reports without blocking. Both scans run at HIGH and CRITICAL, so a MEDIUM or LOW finding appears nowhere.

**What knip finds on its own:** package.json `main`, `bin`, and scripts; the scripts that workflow `run:` steps and `.github/**/action.yml` files invoke; what its plugins read (a bunfig `preload`); `index`, `cli`, and `main` at the root or under `src/`.

**What a repo-owned `knip.json` names,** under `entry` and `ignoreBinaries`, is what knip would otherwise report as unused files and unlisted binaries:

- **Entrypoints anywhere else:** tests run by name through a launcher script, git hooks, scripts run by path, composite actions outside `.github/`.
- **Package.json scripts** that run a tool CI installs itself.
- **A configured `entry` list replaces** knip's default `index`, `cli`, and `main` patterns rather than extending them, so a repo that keeps one of those repeats it.
- **A configuration hint fails the fleet run** (the knip action passes `--treat-config-hints-as-errors`): an `ignore*` entry nothing matches any more, a pattern matching no file, a `workspaces` key with no package. knip prints the hint under "Configuration hints" with the file it came from; the fix is in the repo's own knip configuration.

**What the typos fleet config settles before a repository's bypass applies:** it ignores hex digests and the one-off marker above, and skips lockfiles, minified bundles, SVGs, `node_modules/`, and a root `dist/` (committed build output). A root `lib/` is source in a Node repository, so a repository that generates it excludes it in its own file; a spelling variant a repository keeps goes in its own `_typos.toml`.

**Enforced by:** review of the diff that carries the bypass; the sync overwrites a managed file, so a bypass in one is lost on the next sync PR.

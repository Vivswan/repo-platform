---
order: 20
group: Start here
---

# Fleet guidelines

Conventions every managed repository follows, whether the file is managed by sync or repo-owned. A rule a check enforces is the check's to state when it fires, so this page keeps the rest: each entry names what enforces it, and "review" means nothing in CI does.

| Guideline                                                                        | Enforced by                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Sticky PR comments](#sticky-pr-comments)                                        | review                                                                                                                                                                          |
| [Conventional Commits, squash-merged](#conventional-commits-squash-merged)       | the `pr-title` check and the `commit-names` step for the grammar; review for the type                                                                                           |
| [Markdown prose is never hard-wrapped](#markdown-prose-is-never-hard-wrapped)    | `wrap:check` (repo-platform); review elsewhere                                                                                                                                  |
| [AGENTS.md keeps what the skills do not](#agentsmd-keeps-what-the-skills-do-not) | review                                                                                                                                                                          |
| [Copilot review comments are advisory](#copilot-review-comments-are-advisory)    | the managed `.github/instructions/review.instructions.md` for what earns a comment; the `main` ruleset for thread resolution; review for the reply                              |
| [No backwards-compatibility code](#no-backwards-compatibility-code)              | review                                                                                                                                                                          |
| [The boundary repairs or refuses](#the-boundary-repairs-or-refuses)              | review                                                                                                                                                                          |
| [Short comments](#short-comments)                                                | the `file-size` step's comment caps (warn only); review for content                                                                                                             |
| [Action and workflow descriptions](#action-and-workflow-descriptions)            | `tests/actions/action_metadata.test.ts` in repo-platform (no expression delimiter); review for the shape                                                                        |
| [Pre-commit hooks only check](#pre-commit-hooks-only-check)                      | review                                                                                                                                                                          |
| [File size caps](#file-size-caps)                                                | the `file-size` step (a hard cap fails the step, and the step fails the `standard-checks` job)                                                                                  |
| [Runner](#runner)                                                                | `tests/workflows/runner_switch.test.ts`, `tests/workflows/bare_runner.test.ts`, and the `bare-runner` job in repo-platform for the jobs it ships; review for a repository's own |
| [How to bypass a check](#how-to-bypass-a-check)                                  | each tool's own per-finding, in-repo bypass; no job-level switch exists                                                                                                         |

## Sticky PR comments

**Rule:** a workflow that comments on a PR uses `marocchino/sticky-pull-request-comment` with `header: <repo>/<workflow-stem>` (repo-platform's managed workflows use `repo-platform/<stem>`), upserting in place and never swallowing a failure (no `continue-on-error`, no `|| true`): one comment per workflow that edits itself on later runs. A composite action alone may set `continue-on-error` on its comment step, since a fork PR grants its token no write.

**In checks.yml:** a job of the repo-owned checks.yml may keep one, under `<repo>/checks`. The job declares `pull-requests: write`, and its comment step carries `if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository`.

- **A push to main** has no pull request to comment on.
- **A fork's pull request** gets a read-only token whatever the job asks, unless a private repository's Actions settings send write tokens.
- **A Dependabot pull request** needs no clause: the job's declared grant raises its token.

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

A hook runs only the checks the repository's own toolchain provides (bun here; uv in a Python repository). A check whose tool is outside that toolchain, yamllint, actionlint, and gitleaks among them, is CI's: the shipped workflow fetches the tool at its pin and runs it on every pull request and push to main, for every repository alike.

**Enforced by:** review. repo-platform's own hook is the tracked [.githooks/pre-commit](../.githooks/pre-commit), which `bun run bootstrap` installs through `core.hooksPath` ([scripts/bootstrap.ts](../scripts/bootstrap.ts)); it runs the static checks and fails, and never writes.

## File size caps

**Rule:** no file over its hard line cap, no line over the width cap in a source, test, workflow, or shell file (comment lines included), and no comment block over its cap. Below the width cap, line length is the repo-owned formatter's or linter's to judge (biome, ruff, prettier, yamllint).

**Why:** a file past these sizes is several files wearing one name, and a line past the width is unreadable in any review pane. The caps are generous on purpose: they catch drift, not style.

**How:** split the file, wrap the line, shorten the comment. Two per-finding bypasses exist, both repo-owned and visible in the diff: the comment block's marker ([short comments](#short-comments)) and the allowlist, `.file-size-allow.local`.

- **The reason is mandatory** and must be one a reader accepts: vendored or upstream-shaped, generated but missed by the header exemption, a split that would break an external contract, a file that predates the cap and names the PR its split waits on. "Large" or "legacy" alone is not a reason.

- **Packaging:** a repository that packages from its root (an npm package with no `files` field, for one) lists the allowlist in its packaging ignore file (`.npmignore`), or it ships as content.

**Enforced by:** the `file-size` step of fleet.yml's `standard-checks` job ([actions/check-file-size](../actions/check-file-size/action.yml)), whose description carries the tiers, the exemptions, and the allowlist's grammar; the caps themselves are [check-file-size.ts](../actions/check-file-size/check-file-size.ts)'s.

## Runner

**Rule:** every job the platform ships takes its runner from one line, and a repository's own jobs copy it:

```yaml
runs-on: ${{ github.event.repository.private && vars.CI_RUNS_ON || 'ubuntu-latest' }}
```

| `CI_RUNS_ON`                   | The job runs on                     |
| ------------------------------ | ----------------------------------- |
| unset or empty                 | `ubuntu-latest`                     |
| set, the repository is private | that label, `self-hosted` for one   |
| set, the repository is public  | `ubuntu-latest`, whatever the value |

**Why:** a private repository whose Actions minutes are spent or blocked cannot start a job on GitHub's runners, so its gate never goes green; its own runner costs no minutes. A public repository's minutes are free, and a self-hosted runner must never run a stranger's pull request, so the variable is not read there.

**How:** register a self-hosted runner on the repository, then set the repository variable (`gh variable set CI_RUNS_ON --body self-hosted`).

- **One label:** the value is one runner label. A repository cannot name two.
- **The repository's own files:** a starter is seeded once, so a `checks.yml`, `post-green.yml`, or nightly seeded before the line existed still says `ubuntu-latest` until the repository edits it. `copilot-setup-steps.yml` keeps a plain label: Copilot reads that job's `runs-on` itself.
- **A fork's pull request** to a private repository reads the variable only when the repository's Actions settings send variables to fork pull requests: then it runs on that runner (only people with read access can open one), otherwise on `ubuntu-latest`. The autofix module's run on a fork's pull request reads the repository's own variables, so it goes to the runner either way.
- **Visibility is the event's:** a run reads the visibility its event recorded, so a run started while private and rerun after the repository went public still goes to the runner. Delete the variable before making a repository public.
- **npm publishing:** npm's trusted publishing accepts GitHub-hosted runners only, so a repository on its own runner cannot publish through the npm module.
- **One job at a time:** a single runner runs the gate's jobs one after another, so a run takes longer than on GitHub's runners.
- **A scheduled run** reads the repository's visibility from the event, which GitHub sends with it; an event that names no repository falls back to `ubuntu-latest`.

What the runner must offer is the baseline, each tool on PATH, wherever the system keeps it. Every shipped job fetches whatever else it runs, at the platform's pins, the same on every runner: none needs `python`, `pip`, `pipx`, `jq`, `gh`, `shellcheck`, `sudo`, `apt-get`, Docker, or a `node` or `npm` on PATH.

| The baseline                                                  | For                                                 |
| ------------------------------------------------------------- | --------------------------------------------------- |
| `bash`, `git`, and the GNU core tools (`sed`, `grep`, `find`) | every step                                          |
| `curl`, `wget`, `tar`, `gzip`, `xz`, `unzip`                  | the downloads                                       |
| glibc and CA certificates                                     | the binaries the jobs fetch                         |
| the runner's own bundled node                                 | JavaScript actions                                  |
| network access to GitHub and the tools' download hosts        | the downloads, PyPI, the semgrep and npm registries |

- **The proof:** the `bare-runner` job of repo-platform's own ci.yml runs every shipped action it can, and the gate's steps, in a Debian container holding the baseline alone, so a step that leans on GitHub's image is red before `stable` moves.
- **Not in the proof:** the release, npm publish, Pages deploy, CodeQL, ruff, and cargo steps, which need a release, a package, or a toolchain repo-platform lacks. Their `run:` lines are held by the test below, the rest by review.
- **PowerShell:** a repository holding a PowerShell script or a `shell: pwsh` step needs `pwsh` on its runner. The shell-complexity step fails naming it.
- **A rust repository** also needs a C linker (`cc`) for its cargo steps.
- **bun:** the platform's actions reuse a bun already on PATH when it prints the pinned version, and download it otherwise ([toolchains.md](toolchains.md#how-the-composite-actions-pin-bun)).
- **A clean start, required:** the runner starts every job clean: a fresh machine or container per job, or everything a job can write destroyed when it ends (its work folder, the runner user's home and temp, any tool directory on PATH).
- **Why clean:** the platform's jobs are written for GitHub's fresh machine per job and tested there only. Autofix's write-capable job follows one that ran pull-request code, so a leftover would run that code with the write token.
- **Architecture:** the fetched binaries are pinned for Linux on X64 and ARM64, and another system fails the setup step, named. The proof runs on X64 alone: no CI job runs ARM64.

**Enforced by:** `tests/workflows/runner_switch.test.ts` in repo-platform, which fails a shipped job whose `runs-on` is any other line; `tests/workflows/bare_runner.test.ts` and the `bare-runner` job for the baseline; review for a repository's own jobs.

## How to bypass a check

**Rule:** a blocking check is bypassed only through its tool's own per-finding mechanism, in the repository, visible in the diff, with a reason beside it. No job-level switch, environment variable, or label skips a check.

**Why:** a per-finding bypass records what was accepted and why, beside the code it excuses, and covers only that finding; a switch hides every future finding too.

**How:** each check's action description names what it blocks on and its bypass, or that none exists ([actions/](https://github.com/Vivswan/repo-platform/tree/main/actions)); the Python floor's bypass is [python.md](modules/python.md#building-on-top)'s. The checks fleet.yml runs through a third-party action directly, and the clippy floor the rust starter's cargo steps gate, have no description to carry theirs:

| Check        | Where it runs                                                                           | Blocks on                                                                                                                                                         | Bypass                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gitleaks     | standard-checks                                                                         | any leak                                                                                                                                                          | the finding's fingerprint in `.gitleaksignore`; an allowlist rule in the repo-owned `.gitleaks.toml`                                                                       |
| clippy floor | the cargo steps of the repo-owned `checks.yml` (rust repos, [rust.md](modules/rust.md)) | any lint of the floor but its three thresholds (`too_many_arguments`, `too_many_lines`, `cognitive_complexity`), which warn under `--force-warn`; the rest `deny` | `#[expect(clippy::<lint>, reason = "...")]` on the one item it names; never `#[allow]` (itself denied), never a raised threshold (the floor's lint tables are the fleet's) |
| CodeQL       | codeql                                                                                  | nothing in the job; the `main` ruleset's `code_scanning` rule blocks the merge at the fleet's alert bar ([settings.md](settings.md#what-the-baseline-contains))   | a code scanning dismissal with a reason                                                                                                                                    |

**Enforced by:** review of the diff that carries the bypass; the sync overwrites a managed file, so a bypass in one is lost on the next sync PR.

---
name: repo-platform-new-project
description: Create or adopt a repository managed by Vivswan/repo-platform - create the repo, write .repo-platform.yml, grant the fleet token, run the first sync, review its report, and watch the first CI run. Use when someone wants a new repo on repo-platform, says "new project on the platform", "create a repo-platform repo", "set this repo up with repo-platform", "set it up like my other repos", "with my standard CI setup", "scaffold a repo with my usual standards", "bring this repo into the fleet", or asks how to bring a project under fleet management.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# repo-platform: New Project

Bring a repository under Vivswan/repo-platform management. The platform writes its files into the repository from the outside: the repo carries a registration file, the fleet token can push to it, and every sync arrives as a PR with a report. Nothing is generated locally and the repo holds no sync workflow and no sync secret.

## When to Apply

- "Create a new project managed by repo-platform"
- "Set up a repo on the platform" / "enroll this repo in the fleet"
- "Bring this existing repository into the fleet" (an existing repo skips step 1)

## Key facts before you start

- The platform is standards-only: CI, settings, gitignore, agent instructions, license. The project skeleton comes from the native tool (`uv init`, `bun init`).
- Two facts make a repo managed: `.repo-platform.yml` on its default branch, and the fleet token's write grant. Nothing in repo-platform lists the fleet.
- Every managed repo gets the same `ci.yml`. It never changes with the module selection; the legs after the gate read the selection at run time.
- Steps that need repository-settings access are collected under "Owner actions".

## Workflow

### 1. Create the repository

```bash
# Python (uv would init git itself, on the global default branch)
uv init --vcs none my-project && cd my-project
# TypeScript
mkdir my-project && cd my-project && bun init

git init -b main
git symbolic-ref --short HEAD   # must print main: ci.yml runs on pushes to main only
git add --all && git commit -m "chore: initial scaffold"
gh repo create Vivswan/my-project --public --source . --push
```

For an existing repository, skip this step and work on a branch of the repo as it is.

### 2. Write `.repo-platform.yml`

Only `modules` is required, but write `project` too: the settings starter needs `project.description` (an empty description holds that starter with a Registration note until the key is set). `project` is all-or-nothing: when present it needs `name`, `slug`, and `description` together (`copyright_holder` stays optional). The full key table is in [references/registration.md](references/registration.md).

Minimal:

```yaml
modules: [uv, release-please, issue-templates, pr-title]
```

Full:

```yaml
modules: [bun, pages, docs-site, release-please, issue-templates, pr-title, skills, fuzzer, nightly]
project:
  name: My Project
  slug: my-project
  description: One line for the repository description
  copyright_holder: Vivswan Shah (https://github.com/Vivswan)
pages:
  setup: bun
  install: bun install --frozen-lockfile
  build: bun run build:web
  dist: apps/web/dist
docs_site:
  path: docs
  include:
    - { path: skills, mount: skills, page: SKILL.md }
skills:
  dir: skills
labels:
  fuzzer: fuzz-nightly
  nightly: nightly-failure
  docs_site: docs-link-rot
mirrors:
  - source: LICENSE.md
    targets: [skills/*/LICENSE.md]
```

Commit it to the default branch (or open a PR for an existing repository). The `plan` job of fleet CI parses this file on every PR, so a typo fails loudly there and in the sync.

### 3. Grant the fleet token

Add the repository to the `REPO_PLATFORM_TOKEN` fine-grained PAT's repository list at https://github.com/settings/personal-access-tokens. This is the enrollment; nothing syncs without it, and removing the grant is the opt-out.

### 4. Run the first sync

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/my-project -f manual=true
gh run list -R Vivswan/repo-platform --workflow sync-repos.yml --limit 1
gh run watch -R Vivswan/repo-platform <id> --exit-status
```

`manual=true` keeps the PR waiting for a human even when the report holds nothing. The run's job log (`gh run view <id> --log`) carries the operator's only lines: the selector's `syncing:` line (public slugs by name, private repositories as a count), `plan:` once, then one `row <i>:` line per repository, numbered from 0. No row line names a repository: the details are in the repo's own sync PR or failure issue.

| Line | Meaning |
| --- | --- |
| `plan: N rows` | how many repositories the run resolved |
| `row i: unchanged` | the repo already holds every file; no PR |
| `row i: PR opened` / `PR refreshed` | the sync PR is there, with its report |
| `row i: failed, report filed in the target repository` | read the `[repo-platform] sync failed` issue in the repo |
| `row i: failed before the target was resolved; re-run the workflow` | the run broke before reaching the repo |

### 5. Review the sync PR's report

The PR body is the report, one section per outcome ([the sync-pr skill](https://github.com/Vivswan/repo-platform/tree/main/skills/repo-platform-sync-pr) covers every case in depth):

| Section | On a first sync, expect |
| --- | --- |
| header | Build sha, the modules the registration selected, the visibility |
| Written | `created` for every path that was absent; an adopted repo also sees `unchanged` for a starter it already had, `region added` for a split file that had no markers (the region goes above its content and the PR holds), and `replaced local edits` for a managed file or split region it had written itself |
| Replaced local edits | a diff per replaced file; move anything you want to keep (step 6) |
| Retired | a row per file the platform no longer writes; `held` means it needs your decision |
| Registration notes | a module name `files.yml` does not know, dropped; a placeholder with no value, naming the registration key to set (an empty `project.description` holds the settings starter) |
| Mirrors | one row per declared target: `written`, `current`, `replaced local edits`, or `replaced` (the last two hold the PR); a declaration the writer cannot honour fails the sync instead |
| Review | `Hold for review: yes` with the reasons, or `no` |

Merge when every row is explained.

### 6. Fill in the repo-owned starters

Starters arrive once and are yours afterwards. Put real content in the ones your modules brought:

| File | Role |
| --- | --- |
| `.github/workflows/checks.yml` | the repo's own test and lint jobs; `ci.yml` calls it inside the gate |
| `.github/workflows/post-green.yml` | green-gated work on a push to main, before the release |
| `.github/workflows/update-release.yml` | release-please: mutate the draft release (assets, notes) |
| `.github/workflows/update-release-pr.yml` | release-please: regenerate files that ride in the release commit |
| `.github/workflows/nightly-fuzz.yml` | fuzzer: replace the placeholder step |
| `.github/workflows/nightly.yml` | nightly: replace the placeholder step |
| `.claude-plugin/plugin.json` | skills: list each published skill in `skills` |
| `.github/settings.yml` | the repo's own settings on top of the fleet baseline |

The ownership table for every path is in [references/file-ownership.md](references/file-ownership.md). Local content in a split file (`AGENTS.md`, `.gitignore`, `LICENSE.md`, `.editorconfig`, `.gitattributes`, `.github/CODEOWNERS`) lives outside the `BEGIN/END REPO-PLATFORM MANAGED` markers.

Two modules need content of yours before their first run on main:

- `docs-site`: `docs/README.md` (the landing page) must exist; the build refuses an absent `docs/` tree. Links resolve inside `docs/` or are absolute. repo-platform's [docs/docs-site.md](https://github.com/Vivswan/repo-platform/blob/main/docs/docs-site.md) has the content conventions.
- `pages`: `pages.build` in the registration must produce `pages.dist`.

### 7. Watch the first CI run

Push any commit to main after the merge and read the run. The jobs are the same in every repository:

| Job | On a PR | On a push to main |
| --- | --- | --- |
| `checks` | runs (your checks.yml) | runs |
| `ci` | runs (fleet-ci: plan, base checks, CodeQL where public, module checks) | runs |
| `all-green` | the required check | judged |
| `post-green` | skipped | runs your hook |
| `release`, `update-release`, `publish-release`, `update-release-pr` | skipped | run only with `release-please` selected |
| `pages` | skipped | runs only with `pages` selected |
| `docs-site` | skipped | runs only with `docs-site` and without `pages` |

A grey leg on main has three ordinary causes: its module is not in `modules`, the gate before it (`all-green`, `post-green`) did not succeed, or the push created no release (`update-release`, `publish-release`) or no release PR (`update-release-pr`). Check the module list before reading grey as a failure.

### 8. Settings

Repository settings (labels, rulesets, fields) are applied from repo-platform for every registered repo. The branch protection that makes `all-green` required arrives with the first apply:

```bash
gh workflow run settings-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/my-project
```

The apply reads the tracking labels of `fuzzer`, `nightly`, and `docs-site` from the registration's `labels.*` keys, the module's default when a key is unset, and declares them on the repository.

## Owner actions (need repository-settings access)

- Grant the fleet PAT access to the repo (step 3).
- `pages` or `docs-site`: enable Pages with Source: GitHub Actions before the first deploy, in the repo's Settings -> Pages, or `gh api -X POST repos/Vivswan/my-project/pages -f build_type=workflow`.
- `bun`: register a repo-scoped Contents:RW PAT as a Dependabot secret so the lockfile fixer's push re-runs CI: `gh secret set REPO_PLATFORM_TOKEN --app dependabot`.

## Private repositories

- No CodeQL or dependency-review jobs; the public-only variant of `auto-assign.yml` is not written.
- Fleet run logs are public, so the `plan:` and `row <i>:` lines never name a repository (the plan job's selection line names public repositories and counts private ones); the details land in the repo's own sync PR and failure issue.

## Verify

- The first sync PR merged with every report row explained.
- A PR on the repo shows `all-green` as its check, posted by the PR's own CI run.
- A second dispatch of the sync ends with `row 0: unchanged` in its job log.

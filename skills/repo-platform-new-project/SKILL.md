---
name: repo-platform-new-project
description: Create or adopt a repository managed by Vivswan/repo-platform - create the repo, write .repo-platform.yml, grant the fleet token, run the first sync, review its report, and watch the first CI run. Use when someone wants a new repo on the platform, says "new project on the platform", "create a repo-platform repo", "set this repo up with repo-platform", "set it up like my other repos", "with my standard CI setup", "scaffold a repo with my usual standards", "bring this repo into the fleet", or asks how to bring a project under fleet management.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# repo-platform: New Project

Bring a repository under the platform's management. The platform writes its files into the repository from the outside: the repo carries a registration file, the fleet token can push to it, and every sync arrives as a PR with a report. Nothing is generated locally and the repo holds no sync workflow and no sync secret.

## When to Apply

- "Create a new project managed by repo-platform"
- "Set up a repo on the platform" / "enroll this repo in the fleet"
- "Bring this existing repository into the fleet" (an existing repo skips step 1)

## Key facts before you start

- The platform is standards-only: CI, settings, gitignore, agent instructions, license. The project skeleton comes from the native tool (`uv init`, `bun init`).
- Two facts make a repo managed: `.repo-platform.yml` on its default branch, and the fleet token's write grant. Nothing in the platform repository lists the fleet.
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

`modules` and `project` are both required; `project` needs `name`, `slug`, and `description` together (`copyright_holder` stays optional). The settings overlay starter (`.github/settings.local.yml`) and the managed region of `AGENTS.md` both render `{{description}}`, and the writer treats an empty value as missing, so an empty `project.description` holds `AGENTS.md` on every sync, and the overlay starter while it is still absent (the rendered `.github/settings.yml` is held with it, having no overlay to read), with a Registration note until the key is set. The full key table is in [references/registration.md](references/registration.md).

Minimal:

```yaml
modules: [uv, release-please, pr-title]
project:
  name: My Project
  slug: my-project
  description: One sentence GitHub shows as the repository description
```

Full:

```yaml
modules: [bun, site, release-please, pr-title, fuzzer, nightly]
project:
  name: My Project
  slug: my-project
  description: One line for the repository description
  copyright_holder: Vivswan Shah (https://github.com/Vivswan)
site:
  path: docs
  include:
    - { path: skills, mount: skills, page: SKILL.md }
labels:
  fuzzer: fuzz-nightly
  nightly: nightly-failure
  site: docs-link-rot
mirrors:
  - source: LICENSE.md
    targets: [skills/*/LICENSE.md]
```

Commit it to the default branch (or open a PR for an existing repository). The `plan` job of fleet CI parses this file on every PR, so a typo fails loudly there and in the sync. With `site` selected and a `docs/` directory present, commit `docs/README.md` (the landing page) alongside: the `docs-check` gate job builds `docs/` on every PR from then on (unless `site.path: null` turns the docs half off, for a website that renders `docs/` itself).

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
| Registration notes | a module name `files.yml` does not know, dropped; a placeholder with no value, naming the registration key to set (an empty `project.description` counts as no value: it holds the managed region of `AGENTS.md` on every sync, and the settings starter while it is still absent) |
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
| `.github/actions/site-build/action.yml` | site: build the repo's own website into a directory named in `dist`; a no-op until filled in |
| `.github/workflows/nightly-fuzz.yml` | fuzzer: replace the placeholder step |
| `.github/workflows/nightly.yml` | nightly: replace the placeholder step |
| `.github/settings.local.yml` | the repo's own settings overlay: identity keys, your labels and rulesets; the sync renders the managed `.github/settings.yml` from it and the fleet layers, so never edit the rendered file |

The ownership table for every path is in [references/file-ownership.md](references/file-ownership.md). Local content in a split file (`AGENTS.md`, `.gitignore`, `LICENSE.md`, `.editorconfig`, `.gitattributes`, `.github/CODEOWNERS`) lives outside the `BEGIN/END REPO-PLATFORM MANAGED` markers.

A `site` repository that publishes its own website needs one more thing of yours before the first run on main: the website build in `.github/actions/site-build/action.yml` (seeded as a no-op, which is the whole configuration for a docs-only site; until filled in the site is the docs alone, or nothing). The platform's [docs/site.md](https://github.com/Vivswan/repo-platform/blob/main/docs/site.md) has the hook contract and the docs conventions.

### 7. Watch the first CI run

Push any commit to main after the merge and read the run. The jobs are the same in every repository:

| Job | On a PR | On a push to main |
| --- | --- | --- |
| `checks` | runs (your checks.yml) | runs |
| `ci` | runs (fleet-ci: plan, base checks, CodeQL where public, module checks) | runs |
| `all-green` | the required check | judged |
| `post-green` | skipped | runs your hook |
| `release`, `update-release`, `publish-release`, `update-release-pr` | skipped | run only with `release-please` selected |
| `site` | skipped | runs only with `site` selected (on the nightly schedule and a dispatch too) |

A grey leg on main has three ordinary causes: its module is not in `modules`, the gate before it (`all-green`, `post-green`) did not succeed, or the push created no release (`update-release`, `publish-release`) or no release PR (`update-release-pr`). Check the module list before reading grey as a failure.

### 8. Settings

Repository settings (labels, rulesets, fields) are rendered into the managed `.github/settings.yml` by the sync (the fleet layers, the selected modules' layers, and your `.github/settings.local.yml` overlay folded into one document) and applied by the platform for every registered repo whose rendered file has merged. The branch protection that makes `all-green` required arrives with the first apply after the first sync PR merges:

```bash
gh workflow run settings-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/my-project
```

- The sync renders the tracking labels of `fuzzer`, `nightly`, and `site` from the registration's `labels.*` keys (the module's default when a key is unset) into the file; the apply declares them on the repository.
- Your own labels, rulesets, and identity keys go in `.github/settings.local.yml`; an edit there lands in the rendered file on the next sync PR (`gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/my-project -f manual=true` brings it at once). A hand edit of `.github/settings.yml` is replaced by the next sync and reds the managed files check before that.
- Until the sync PR carrying the rendered file has merged, the apply skips the repository with a notice.

## Owner actions (need repository-settings access)

- Grant the fleet PAT access to the repo (step 3).
- `site`: the module's settings layer enables Pages on the first settings apply (step 8); for a deploy before it, enable Pages with Source: GitHub Actions in the repo's Settings -> Pages, or `gh api -X POST repos/Vivswan/my-project/pages -f build_type=workflow`.

## Private repositories

- No CodeQL or dependency-review jobs; the public-only variant of `auto-assign.yml` is not written.
- Fleet run logs are public, so the `plan:` and `row <i>:` lines never name a repository (the plan job's selection line names public repositories and counts private ones); the details land in the repo's own sync PR and failure issue.

## Verify

- The first sync PR merged with every report row explained.
- A PR on the repo shows `all-green` as its check, posted by the PR's own CI run.
- A second dispatch of the sync ends with `row 0: unchanged` in its job log.

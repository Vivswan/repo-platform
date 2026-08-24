---
name: repo-platform-new-project
description: Create or adopt a repository managed by Vivswan/repo-platform - scaffold with the native toolchain, apply the copier template, publish, enroll, and register settings. Use when someone wants a new repo on repo-platform, says "new project on the platform", "create a repo-platform repo", "set this repo up with repo-platform", "set it up like my other repos", "with my standard CI setup", "scaffold a repo with my usual standards", "bring this repo into the fleet", or asks how to bring a project under fleet management.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# repo-platform: New Project

Bring a repository under Vivswan/repo-platform management: the platform is a Copier template plus push-based sync, so the repo itself carries no sync workflow and no sync secret. Once it exists on GitHub with `.repo-platform.yml` on its default branch and the fleet PAT can write to it, update PRs start arriving on their own.

## When to Apply

- "Create a new project managed by repo-platform"
- "Set up a repo on the platform" / "enroll this repo in the fleet"
- "Apply the repo-platform template" to a fresh OR existing repository (an existing repo skips step 2 and runs copier in place)

## Key facts before you start

- The template is standards-only: CI conventions, settings, gitignore, agent instructions. The project skeleton comes from the native tool (`uv init`, `bun init`); repo-platform layers on top.
- repo-platform's `main` branch is NOT copier-consumable. Consume the generated build refs: the `staging` branch (rebuilt from every main merge) or a `templates/vX.Y.Z` build tag (released versions).
- The `--vcs-ref` you generate from must match the `channel` answer you give: `staging` ref for the staging channel, a `templates/vX.Y.Z` tag for the latest channel.
- Some steps need repository-settings access; they are collected in "Owner actions" below so a human can do them in one sitting.

## Workflow

### 1. Prerequisites

- copier >= 9.8.0 (serialized multiselect answers need it).
- bun on PATH - even for a Python repo. The template's `_migrations` hook runs a bun script, so copier fails without bun available.
- `git` and an authenticated `gh` CLI.

### 2. Scaffold with the native tool (new projects only)

```bash
# Python
uv init my-project && cd my-project

# TypeScript
mkdir my-project && cd my-project && bun init
```

For an existing repository, skip this: run copier in the repo root (the `--overwrite` caveat below matters even more there - review the diff of every file copier replaces).

### 3. Apply the template

```bash
# New projects only - existing repos skip this block and run copier on
# whatever branch the adoption PR will come from:
git init -b main 2>/dev/null || true
git symbolic-ref --short HEAD   # must print main for a new project
# if it prints master (the scaffolder or an older init already created
# the repo): git symbolic-ref HEAD refs/heads/main  (safe before the
# first commit)

# staging channel (main HEAD builds; what Vivswan's own repos use):
copier copy gh:Vivswan/repo-platform . --vcs-ref staging --trust

# OR latest channel (released template versions; pick the newest tag from
# git ls-remote --tags https://github.com/Vivswan/repo-platform.git 'refs/tags/templates/*'):
copier copy gh:Vivswan/repo-platform . --vcs-ref templates/vX.Y.Z --trust

git add --all
git commit -m "chore: initialize from repo-platform"
```

`--trust` is needed because the template declares a `_migrations` hook (copier treats templates with hooks as unsafe).

Running non-interactively (agent-driven): add `--defaults --overwrite`. Without `--overwrite`, copier prompts per conflicting file - the scaffolder already wrote `.gitignore` (and maybe a README) that the template also renders, and `--defaults` does not answer overwrite prompts, so a non-TTY run hangs. The modules multiselect must be a YAML list in ONE `-d` argument:

```bash
copier copy gh:Vivswan/repo-platform . --vcs-ref staging --defaults --overwrite --trust \
  -d project_name=X -d description=Y -d 'modules=[uv]' -d private=false
```

The template's `.gitignore` is generated and managed: after the copy, move any scaffolder-added entries the template does not already cover into its BEGIN/END REPOSITORY LOCAL section (check `git diff` of the overwrite).

### 4. Answer the questions

Full walkthrough in [references/questions.md](references/questions.md). The load-bearing answers:

- `channel`: `latest` follows released `templates/vX.Y.Z` tags and runs migrations between releases; `staging` follows every main merge and skips migrations. Must match the `--vcs-ref` above.
- `modules`: a multiselect (space toggles, enter confirms), any combination. Modules with parameters ask follow-up questions only when selected (pages, fuzzer, nightly, skills, settings-sync). The authoritative roster is the interactive prompt itself (repo-platform's `copier.yml`).
- `private`: gates the render - public repos get CodeQL and dependency-review jobs plus CONTRIBUTING.md; private ones do not. It must match the visibility you create the repo with in step 6.

Two files record the outcome:

- `.copier-answers.yml`: never delete it - `copier update` depends on it. Its one sanctioned edit is changing a question's VALUE key via a default-branch PR to set a module parameter (`nightly_label`, `skills_dir`, `pages_*`, ...); never touch the underscore keys.
- `.repo-platform.yml`: its presence marks the repo as managed, and its top-level `modules:` list is the selection's home from then on. Edit that list and the next sync PR applies the change.

### 5. Fill in the repo-owned starters

Some files are generated once and then owned by the repo (sync never overwrites them). Put real content in the ones your modules created:

- `.github/workflows/checks.yml`: the repo's own test/lint jobs. The managed `ci.yml` calls it inside the all-green gate.
- `.github/workflows/update-release.yml` (release-please module): the repo's hook in the managed `release.yml` pipeline - release-please cuts a draft, this hook mutates it (assets, notes), then the publish stage attests every asset into a single `attestation.jsonl` and flips it live.
- `.github/workflows/update-release-pr.yml` (release-please module): the repo's hook on release-PR creation/refresh - regenerated files and version references that must ride in the release commit go there.
- `.github/workflows/nightly-fuzz.yml` (fuzzer module): replace the placeholder fuzz step with your fuzzer.
- `.github/workflows/nightly.yml` (nightly module): replace the placeholder step with the repo's own nightly checks.
- `.claude-plugin/plugin.json` and `marketplace.json` (skills module): seeded with an empty catalog; list each published skill's path in `plugin.json`'s `skills` array.
- `auto-format.yml` and `copilot-setup-steps.yml` come prefilled for the selected toolchains; issue forms are generic starters to tailor.

The full ownership table is in [references/file-ownership.md](references/file-ownership.md).

### 6. Create the GitHub repo and push

```bash
gh repo create Vivswan/my-project --public --source . --push
# or, matching private=true in the copier answers:
gh repo create Vivswan/my-project --private --source . --push
```

The `--public`/`--private` flag must match the `private` copier answer, or the first sync flags settings drift.

Then one grant: give the fleet `REPO_PLATFORM_TOKEN` PAT access to the new repository (see "Owner actions"). Discovery only enrolls repos the token can WRITE to; that grant is the enrollment.

- No entry in repo-platform's `repos.yml` is needed unless the repo deviates from the default channel (then add a `config:` entry).
- Sync PRs arrive on releases and the weekly cron. To sync immediately:

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/my-project
```

### 7. Pick a settings home

Repository settings (fields, topics, labels, rulesets) are applied FROM repo-platform. Do this before relying on CI gating: the branch protection that makes `all-green` a REQUIRED check comes from the settings apply (rulesets are per-repo; `settings/defaults.yml` carries none, and list sections replace rather than merge).

Two homes; when both exist, the central file wins:

- Central (default for public repos): add `settings/repos/my-project.yml` in repo-platform. No local checkout needed:

  ```bash
  gh repo clone Vivswan/repo-platform && cd repo-platform
  # copy a sibling file in settings/repos/ and trim; open a PR
  ```

  Declare all four identity keys (description, homepage, topics, private) - only declared keys are managed - and every label the repo should keep: undeclared labels are deleted on each apply. Required labels per module are listed in [references/questions.md](references/questions.md#required-settings-labels). Merging the file applies it; for a dry run first: `gh workflow run settings-repos.yml -R Vivswan/repo-platform -f check_only=true`.
- In-repo: carry `.github/settings.yml` in the repo - the file is the whole opt-in; the central run applies it remotely. The `settings-sync` module is optional sugar: it seeds the file and adds push-time self-apply (which needs a repo-scoped PAT and skips with a warning without one).

Private repos should use the in-repo home unless the owner accepts the repo's name appearing in repo-platform's public `settings/repos/` directory - committed names are self-disclosure (see "Private repositories" below).

### 8. What runs on PRs

CI gates on a single check named `all-green` (required once step 7's ruleset is applied): an aggregate job that `needs:` every gating job and fails on any non-success result (skipped counts as failure). Standard jobs (typography, commit-names, actionlint, gitleaks, yamllint), module jobs (pr-title, release-freshness/release-health, validate-skills on skills repos, CodeQL on public repos), and your checks.yml jobs all feed it. `validate-template` also runs but is informational: a red run flags template drift without blocking merges.

On private repositories the five base checks run as one combined `base-checks` job (billing: tiny jobs round up to a minute each).

## Owner actions (need repository-settings access)

Collect these for the human with admin rights:

- Grant the fleet PAT access to the new repo: the `REPO_PLATFORM_TOKEN` fine-grained PAT's repository access list at https://github.com/settings/personal-access-tokens - this is the enrollment step; nothing syncs without it.
- pages module: Settings -> Pages -> Source: GitHub Actions, and add a `v*` tag rule to the `github-pages` environment's deployment branches (release-triggered deploys run on the tag ref and are rejected without it).
- bun module: register a repo-scoped Contents:RW PAT as a Dependabot secret so the lockfile fixer's push re-runs CI: `gh secret set REPO_PLATFORM_TOKEN --app dependabot` (prompts for the token value on stdin - the human runs it, or pass `--body "$TOKEN"` non-interactively). Without it the fix lands but each fixed PR needs a close/reopen for checks to appear.
- settings-sync module self-apply (optional): a repo-scoped PAT with Administration + Issues RW as the repo's own `REPO_PLATFORM_TOKEN` Actions secret; without it self-apply skips and the central run still covers the repo.

## Private repositories

- Base checks merge into one `base-checks` job; no CodeQL or dependency-review jobs; CONTRIBUTING.md is not rendered.
- Fleet run logs are public, so a wildcard-discovered private repo appears only as a name hint (`hidden-server` -> `h**-s**r`) and its details (paths, module lists, conflict content) stay out of public logs; the full detail lands in the repo's own sync PRs and report issues.
- Naming a private repo in repos.yml or `settings/repos/` publishes the name (details stay hidden). That is why the in-repo settings home is the default recommendation for private repos.

## Verify

- After step 7's settings apply: the first PR shows `all-green` as the only required check and it passes. (Before the apply, `all-green` runs but nothing marks it required - that is expected, not a platform failure.)
- `gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=...` produces a run that ends with "already matches ... no sync PR needed" (or a no-op-level PR), proving the repo is enrolled and clean.

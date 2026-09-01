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
- repo-platform's `main` branch is NOT copier-consumable. Consume the generated build ref: the `build` branch (published only from green main commits).
- Some steps need repository-settings access; they are collected in "Owner actions" below so a human can do them in one sitting.

## Workflow

### 1. Prerequisites

- copier >= 9.8.0 (serialized multiselect answers need it).
- bun on PATH - even for a Python repo. The template's post-render stamp hook runs a bun script, so copier fails without bun available.
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

copier copy gh:Vivswan/repo-platform . --vcs-ref build --trust

git add --all
git commit -m "chore: initialize from repo-platform"
```

`--trust` is needed because the template declares a post-render stamp hook (copier treats templates with hooks as unsafe). That hook runs from the `build` tip as-is - this local copy does no provenance verification (the sync pipeline does); pin `--vcs-ref` to a reviewed build commit sha instead of the branch name if that matters in your setting.

Running non-interactively (agent-driven): add `--defaults --overwrite`. Without `--overwrite`, copier prompts per conflicting file - the scaffolder already wrote `.gitignore` (and maybe a README) that the template also renders, and `--defaults` does not answer overwrite prompts, so a non-TTY run hangs. The modules multiselect must be a YAML list in ONE `-d` argument:

```bash
copier copy gh:Vivswan/repo-platform . --vcs-ref build --defaults --overwrite --trust \
  -d project_name=X -d description=Y -d 'modules=[uv]' -d private=false
```

The template's `.gitignore` is generated and managed: after the copy, move any scaffolder-added entries the template does not already cover into its BEGIN/END REPOSITORY LOCAL section (check `git diff` of the overwrite).

### 4. Answer the questions

Full walkthrough in [references/questions.md](references/questions.md). The load-bearing answers:

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

- No entry in repo-platform's `repos.yml` is needed (the wildcard discovers it); `exclude:` is only for opting a repo out.
- Sync PRs arrive on the weekly cron. To sync immediately:

```bash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/my-project
```

### 7. Settings management (the settings-sync module)

Repository settings (fields, topics, labels, rulesets) are applied FROM repo-platform, and selecting the `settings-sync` module in `.repo-platform.yml` is the whole opt-in. Do this before relying on CI gating: the branch protection that makes `all-green` a REQUIRED check is the managed baseline's `main` ruleset, applied by the nightly heal (or immediately via `gh workflow run settings-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/my-project`).

The fleet and module settings layers (shared defaults, every label the module selection requires, the fleet rulesets) are merged per repository at apply time; the repo's own `.github/settings.yml` - a generated-once identity starter carrying description, homepage, topics, private, plus local overrides - merges over them, and the fleet override layer merges over that. Nothing to hand-maintain: the labels each module needs come from that module's own `templates/<module>/settings.yml` layer automatically. For a dry run: `gh workflow run settings-repos.yml -R Vivswan/repo-platform -f check_only=true`. The module also renders a push-time self-apply workflow (needs a repo-scoped PAT and skips with a warning without one).

### 8. What runs on PRs

CI gates on the `all-green` check (required once step 7's ruleset is applied - the sole required check the fleet override carries; the pr-title module requires its own `pr-title` check through its settings layer): the managed ci.yml's `all-green` job needs the `checks` and `ci` callers and fails unless each result is success or skipped, with at least one success. The gate jobs themselves run centrally through repo-platform's fleet-ci.yml (typography, commit-names, actionlint, gitleaks, yamllint, release-freshness/release-health, validate-skills on skills repos, CodeQL on public repos) next to your checks.yml jobs. `validate-template` runs there too and BLOCKS on integrity (managed content changed outside a sync); its freshness report never blocks.

On private repositories the five base checks run as one combined `base-checks` job (billing: tiny jobs round up to a minute each).

## Owner actions (need repository-settings access)

Collect these for the human with admin rights:

- Grant the fleet PAT access to the new repo: the `REPO_PLATFORM_TOKEN` fine-grained PAT's repository access list at https://github.com/settings/personal-access-tokens - this is the enrollment step; nothing syncs without it.
- pages module: Settings -> Pages -> Source: GitHub Actions, and add a `v*` tag rule to the `github-pages` environment's deployment branches (release-triggered deploys run on the tag ref and are rejected without it).
- bun module: register a repo-scoped Contents:RW PAT as a Dependabot secret so the lockfile fixer's push re-runs CI: `gh secret set REPO_PLATFORM_TOKEN --app dependabot` (prompts for the token value on stdin - the human runs it, or pass `--body "$TOKEN"` non-interactively). Without it the fix lands but each fixed PR needs a close/reopen for checks to appear.
- settings-sync module self-apply (optional): a repo-scoped PAT with Administration + Issues RW as the repo's own `REPO_PLATFORM_TOKEN` Actions secret; without it self-apply skips and the central heal still covers the repo.

## Private repositories

- Base checks merge into one `base-checks` job; no CodeQL or dependency-review jobs; CONTRIBUTING.md is not rendered.
- Fleet run logs are public, so a wildcard-discovered private repo appears only as a name hint (`hidden-server` -> `h**-s**r`) and its details (paths, module lists, conflict content) stay out of public logs; the full detail lands in the repo's own sync PRs and report issues.
- Naming a private repo in repos.yml publishes the name (details stay hidden); wildcard discovery keeps it hinted.

## Verify

- After step 7's settings apply: the first PR shows `all-green` as the required check, posted by the PR's own CI run (Copilot's review, where public repos request one, is advisory and blocks nothing). (Before the apply, `all-green` runs but nothing marks it required - that is expected, not a platform failure.)
- `gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=...` produces a run that ends with "already matches ... no sync PR needed" (or a no-op-level PR), proving the repo is enrolled and clean.

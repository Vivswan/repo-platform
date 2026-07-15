# Creating a new repository

The template is standards-only: the native toolchain owns the project
skeleton, repo-platform layers CI conventions, settings, gitignore, and
agent instructions on top.

## 1. Scaffold with the native tool

```bash
# Python
uv init my-project && cd my-project

# TypeScript
mkdir my-project && cd my-project && bun init
```

## 2. Apply the template

```bash
git init -b main
copier copy gh:Vivswan/repo-platform . --vcs-ref v0.0.1
git add --all
git commit -m "chore: initialize from repo-platform"
```

Copier asks for project name, description, stack (`bun-ts` / `python-uv`),
profile (`full` / `minimal`), and visibility. Answers are recorded in
`.copier-answers.yml`. Never delete that file; template sync depends on it.

## 3. Add a ci.yml

`ci.yml` is repo-owned. Start from the [all-green convention](all-green.md)
and include the standard jobs:

```yaml
jobs:
  typography:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/repo-platform/actions/check-typography@v0.0.1
  validate-template:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/repo-platform/actions/validate-template@v0.0.1
  commit-names:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: Vivswan/repo-platform/actions/validate-commit-names@v0.0.1
  # ...your test/lint jobs...
  all-green:
    # see docs/all-green.md
```

## 4. Publish

```bash
gh repo create Vivswan/my-project --public --source . --push
```

Optionally add `REPO_PLATFORM_TOKEN` (a fine-grained PAT with Contents:RW +
Pull requests:RW on this repo) as an Actions secret so template-sync PRs
trigger CI automatically. Without it, sync still works: close/reopen the PR
to run checks.

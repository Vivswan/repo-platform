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

Requires copier >= 9.8.0 (serialized multiselect answers). `main` holds only
sources; consume the GENERATED build refs, and match the initial `--vcs-ref`
to the channel you pick when asked:

```bash
git init -b main
# latest channel (released template versions; pick the newest templates/v*
# tag - list them with:
#   git ls-remote --tags https://github.com/Vivswan/repo-platform.git 'refs/tags/templates/*'
# ):
copier copy gh:Vivswan/repo-platform . --vcs-ref templates/vX.Y.Z
# or staging channel (main HEAD builds; what Vivswan's own repos use):
copier copy gh:Vivswan/repo-platform . --vcs-ref staging
git add --all
git commit -m "chore: initialize from repo-platform"
```

Copier asks for project name, description, an update **channel** (`latest`
follows released `templates/vX.Y.Z` build tags and runs migrations;
`staging` follows every main merge, migrations skipped), a `modules`
multiselect (any combination of `agents`, `bun`, `uv`, `pages`,
`release-please`, `issue-templates`, `pr-title`, `auto-assign`,
`settings-sync`), follow-up
parameters for modules that have them (see [docs/pages.md](pages.md)), and
visibility. Answers are recorded in `.copier-answers.yml`. Never delete
that file; template sync depends on it.

To switch channels later:
`copier update --vcs-ref templates/vX.Y.Z -d channel=latest` (or
`--vcs-ref staging -d channel=staging`).

## 3. Add a ci.yml

`ci.yml` is repo-owned. Start from the [all-green convention](all-green.md)
and include the standard jobs:

```yaml
jobs:
  typography:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/repo-platform/actions/check-typography@vX.Y.Z
  validate-template:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/repo-platform/actions/validate-template@vX.Y.Z
  commit-names:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: Vivswan/repo-platform/actions/validate-commit-names@vX.Y.Z
  # ...your test/lint jobs...
  all-green:
    # see docs/all-green.md
```

## 4. Publish

```bash
gh repo create Vivswan/my-project --public --source . --push
```

Optionally add `REPO_PLATFORM_TOKEN` (a fine-grained PAT with Contents:RW,
Pull requests:RW, Administration:RW, and Issues:RW on this repo) as an
Actions secret so template-sync PRs trigger CI automatically and the
settings-sync module can apply `.github/settings.yml`. Without it, sync
still works (close/reopen the PR to run checks) and settings-sync skips
with a notice.

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

Requires [copier](https://copier.readthedocs.io) >= 9.8.0 (serialized multiselect answers). `main` holds only
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

## 3. Add checks to checks.yml

CI is split so the template can keep improving it while each repo keeps its
own checks:

- `.github/workflows/ci.yml` is template-managed: the standard jobs
  (`typography`, `commit-names`, `validate-template`, `actionlint`,
  `yamllint`), module checks (`pr-title` with that module, `codeql` on
  public repos with a toolchain), the aggregate `all-green` gate, and a
  `checks` job that calls checks.yml. Sync updates it; don't edit it
  directly.
- `.github/workflows/checks.yml` is repo-owned (`_skip_if_exists`): put the
  repository's test and lint jobs there (multiple jobs, matrices, and
  further local reusable workflows all work). They run inside the gate
  through the `checks` job.
- with the release-please module: a `release` job runs on top of the gate
  (`needs: all-green`), calling the repo-owned
  `.github/workflows/release.yml` pipeline. By default that pipeline just
  runs the managed `release-please.yml` machinery; add repo jobs before the
  release (make `release-please` `needs:` them) or after it (gated on its
  `release_created`/`tag_name` outputs: packaging, publishing). Everything
  runs in one workflow run, so no PAT is needed to chain the steps. The
  `release-please-config.json` and `.release-please-manifest.json` starters
  are repo-owned too (release-please updates the manifest via release PRs).
- with the bun or uv module: a repo-owned `auto-format.yml` starter (label a
  PR `fix-lint` to get a formatting commit pushed to it), prefilled with each
  selected toolchain's formatter.
- with the agents module: a repo-owned `copilot-setup-steps.yml` starter
  (environment setup for the Copilot coding agent), prefilled with installs
  for the selected toolchains.

See the [all-green convention](all-green.md) for how the gate works.

## 4. Publish

```bash
gh repo create Vivswan/my-project --public --source . --push
```

Optionally add `REPO_PLATFORM_TOKEN` as an Actions secret: a
[fine-grained PAT](https://github.com/settings/personal-access-tokens/new?name=REPO_PLATFORM_TOKEN&description=repo-platform+template+sync+and+settings-sync&contents=write&pull_requests=write&workflows=write&administration=write&issues=write)
with Contents:RW, Pull requests:RW, Workflows:RW, Administration:RW, and
Issues:RW on this repo (the link pre-selects all five permissions).

With it:

- template-sync PRs trigger CI automatically
- the settings-sync module can apply `.github/settings.yml`

Without it:

- sync still works for most updates (close/reopen the PR to run checks)
- settings-sync skips with a notice
- template updates that change workflow files fail with an error: GitHub
  never lets the default GITHUB_TOKEN push changes under
  `.github/workflows/`

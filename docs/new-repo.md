# Creating a new repository

The template is standards-only: the native toolchain owns the project
skeleton, repo-platform layers CI conventions, settings, gitignore, and
agent instructions on top. There is nothing to configure in the new repo
itself: no sync workflow, no secrets. Once the repo exists on GitHub with
`.repo-platform.yml` on its default branch, repo-platform's push sync
picks it up.

## 1. Scaffold with the native tool

```bash
# Python
uv init my-project && cd my-project

# TypeScript
mkdir my-project && cd my-project && bun init
```

## 2. Apply the template

Requires [copier](https://copier.readthedocs.io) >= 9.8.0 (serialized multiselect answers) and
[bun](https://bun.sh) on PATH (copier's `_migrations` hook runs a bun script). `main` holds
only sources; consume the GENERATED build refs, and match the initial
`--vcs-ref` to the channel you pick when asked:

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
visibility. Answers are recorded in `.copier-answers.yml`; never delete
that file, `copier update` depends on it.

The chosen modules also land in `.repo-platform.yml`, and that file is the
selection's home from then on: edit its `modules:` list and the next sync
PR applies the change. Its presence is what marks the repo as managed.

To switch channels later, change the repo's entry under `config:` in
repo-platform's `repos.yml` (see step 4).

## 3. Add checks to checks.yml

CI is split so the template can keep improving it while each repo keeps its
own checks:

- `.github/workflows/ci.yml` is template-managed: the standard jobs
  (`typography`, `commit-names`, `validate-template`, `actionlint`,
  `yamllint`), module checks (`pr-title` with that module, per-language
  `codeql-*` jobs on public repos with a toolchain), the aggregate
  `all-green` gate, and a `checks` job that calls checks.yml. Sync updates
  it; don't edit it directly.
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

## 4. Publish and register

```bash
gh repo create Vivswan/my-project --public --source . --push
```

That is the whole repo-side setup, plus one grant: give the fleet PAT
access to the new repository (its repository access list) - discovery
only enrolls repos the token can write to. The `repos.yml` wildcard then
picks it up, `.repo-platform.yml` opts it into push sync, and update PRs
start arriving on releases and the weekly cron
(`gh workflow run sync-repos.yml -f repo=Vivswan/my-project -R Vivswan/repo-platform`
syncs it immediately).

In repo-platform, two optional registrations:

- `config:` entry in `repos.yml`: only when the repo deviates from
  `defaults.channel` (staging). Auto-discovered repos need no entry
  otherwise.
- `exclude:` list in `repos.yml`: only for opting a discovered repo OUT of
  management; a new managed repo does not touch it.

## 5. Pick a settings home

Repository settings are applied from repo-platform (see
[docs/settings.md](settings.md)). Pick one of the two homes:

Central (the default): add `settings/repos/my-project.yml` in
repo-platform. `settings/defaults.yml` already supplies the shared
`repository:` field block, so the file only carries repo specifics plus
the list-valued sections (arrays do not merge with defaults):

```yaml
# settings/repos/my-project.yml
repository:
  description: One-line description (match the copier answer)
  topics: comma, separated, topics

labels:
  - name: bug
    color: "d73a4a"
    description: Something isn't working
  # ...every label the repo should keep; undeclared labels are deleted

rulesets:
  - name: main
    # ...branch protection; copy a sibling file in settings/repos/ as the
    # starting point
```

The easiest start is copying `settings/repos/repo-platform.yml` and
trimming it. Merging the file to main applies it (settings-repos.yml runs
on pushes to `settings/**`); for a drift report first, dispatch
`gh workflow run settings-repos.yml -f check_only=true`.

In-repo (opt-in): select the `settings-sync` module instead and skip the
central file. The repo then carries its own `.github/settings.yml`, which
the central run applies; add a repo-scoped PAT only if you want
self-apply on push ([docs/settings.md](settings.md#the-in-repo-home-the-settings-sync-module)).

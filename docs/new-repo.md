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
[bun](https://bun.sh) on PATH (copier's `_migrations` hook runs a bun script;
the hook is also why copier needs `--trust`). `main` holds
only sources; consume the GENERATED build refs, and match the initial
`--vcs-ref` to the channel you pick when asked:

```bash
git init -b main
# latest channel (released template versions; pick the newest templates/v*
# tag - list them with:
#   git ls-remote --tags https://github.com/Vivswan/repo-platform.git 'refs/tags/templates/*'
# ):
copier copy gh:Vivswan/repo-platform . --vcs-ref templates/vX.Y.Z --trust
# or staging channel (main HEAD builds; what Vivswan's own repos use):
copier copy gh:Vivswan/repo-platform . --vcs-ref staging --trust
git add --all
git commit -m "chore: initialize from repo-platform"
```

Copier asks for project name, description, an update **channel** (`latest`
follows released `templates/vX.Y.Z` build tags and runs migrations;
`staging` follows every main merge, migrations skipped), a `modules`<!-- BEGIN GENERATED: module-roster (scripts/generate.ts - edit module.yml manifests, not this block) -->
multiselect (any combination of `agents`, `bun`, `node`, `deno`, `uv`,
`rust`, `pages`, `release-please`, `issue-templates`, `pr-title`,
`auto-assign`, `fuzzer`, `nightly`, `settings-sync`, `custom-license`),
follow-up parameters for modules that have them (see
[docs/pages.md](pages.md), [docs/fuzzer.md](fuzzer.md), and
[docs/nightly.md](nightly.md)), and visibility.<!-- END GENERATED: module-roster -->
Answers are recorded in `.copier-answers.yml`; never delete that file,
`copier update` depends on it.

The chosen modules also land in `.repo-platform.yml`, and that file is the
selection's home from then on: edit its `modules:` list and the next sync
PR applies the change. Its presence is what marks the repo as managed.

To switch channels later, change the repo's entry under `config:` in
repo-platform's `repos.yml` (see step 4). A repo moving from staging to
latest gets every migration up to the target release on its first sync
after the switch - the staging history says nothing about which ones
already applied, and migrations are idempotent, so the runner over-runs
rather than skips (see [migrations/README.md](../migrations/README.md)).

## 3. Add checks to checks.yml

CI is split so the template can keep improving it while each repo keeps its
own checks:

- `.github/workflows/ci.yml` is template-managed: the standard jobs
  (`typography`, `commit-names`, `validate-template`, `actionlint`,
  `gitleaks`, `yamllint` - on private repositories all but
  `validate-template` run as a single combined `base-checks` job),
  module checks (`pr-title` with that module,
  `dependency-review` and per-language `codeql-*` jobs on public repos -
  CodeQL also needs a toolchain), the aggregate `all-green` gate, and a
  `checks` job that calls checks.yml. Sync updates it; don't edit it
  directly.
- `.github/workflows/checks.yml` is repo-owned (`_skip_if_exists`): put the
  repository's test and lint jobs there (multiple jobs, matrices, and
  further local reusable workflows all work). They run inside the gate
  through the `checks` job.
- with the release-please module: a `release` job runs on top of the gate
  (`needs: all-green`), calling the repo-owned
  `.github/workflows/release.yml` pipeline. GitHub releases are immutable
  once published, so every release moves through the same three steps,
  always draft-first: release-please cuts the release as a draft with its
  tag already forced, the starter's `update-release` job is where the
  repository mutates the draft (packaging, asset uploads, note edits),
  and the final `publish-release` job flips it live. Everything runs in
  one workflow run, so no PAT is needed to chain the steps. The
  `release-please-config.json` and `.release-please-manifest.json`
  starters are repo-owned too (release-please updates the manifest via
  release PRs).
- with any toolchain module that ships a formatter (every one except
  rust): a repo-owned `auto-format.yml` starter (label a PR `fix-lint` to
  get a formatting commit pushed to it), prefilled with each selected
  toolchain's formatter.
- with the bun module: a managed `dependabot-bun-lockfile.yml` that
  regenerates `bun.lock` from scratch on Dependabot's PRs and pushes the fix
  to the PR branch (Dependabot's own lockfile edits can leave stale nested
  entries that fail `bun install --frozen-lockfile`; the regeneration also
  refreshes every in-range pin, so most Dependabot PRs get a fix commit).
  Registering `REPO_PLATFORM_TOKEN` as a *Dependabot* secret is recommended:
  it lets the fix commit re-run CI (a fine-grained token scoped to that one
  repo's Contents:RW is enough; do not put the fleet PAT in a downstream
  repo). Without the secret the push cannot re-trigger checks, so the job
  posts a PR comment and a run warning saying so; close/reopen the PR to
  re-run its checks, or register the token.
- with the agents module: a repo-owned `copilot-setup-steps.yml` starter
  (environment setup for the Copilot coding agent), prefilled with installs
  for the selected toolchains.
- with the fuzzer module: a repo-owned `nightly-fuzz.yml` starter that runs a
  placeholder fuzz step nightly and wires up seeded replay inputs, failure
  artifact upload, tracking-issue filing, and auto-close on green. Replace
  the placeholder with your fuzzer; see [docs/fuzzer.md](fuzzer.md) for the
  failure-report contract it must write.
- with the nightly module: a repo-owned `nightly.yml` starter that runs a
  placeholder step nightly and files (or updates) a label-deduplicated
  tracking issue on failure, closing it on the next green night. Move the
  repository's slow nightly checks into it; see
  [docs/nightly.md](nightly.md).

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
  # Declare all four identity keys, empty included: the apply manages
  # only declared keys, so an omitted key's drift is never healed. The
  # settings preflight fails a central file that drops one of them.
  homepage: ""
  topics: comma, separated, topics
  private: false

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

Since undeclared labels are deleted, the list must include the labels
dependabot auto-creates, or the two sides loop forever: every apply
deletes them, dependabot recreates them on its next run. That means
`dependencies` (color `0366d6`) and `github_actions` (`000000`) always,
plus one label per toolchain the repo's dependabot.yml covers:<!-- BEGIN GENERATED: dependabot-labels (scripts/generate.ts - edit module.yml manifests, not this block) -->
`javascript` (`168700`) for bun and npm, `deno` (`70ffaf`) for deno,
`python:uv` (`2b67c6`) for uv, `rust` (`000000`) for cargo.<!-- END GENERATED: dependabot-labels -->
The exact descriptions are in
`templates/settings-sync/.github/settings.yml.jinja`.

The easiest start is copying `settings/repos/repo-platform.yml` and
trimming it. Merging the file to main applies it (settings-repos.yml runs
on pushes to `settings/**`); for a drift report first, dispatch
`gh workflow run settings-repos.yml -f check_only=true`.

In-repo: skip the central file and carry `.github/settings.yml` in the
repo itself - the file is the whole opt-in, and the central run applies
it remotely. Selecting the `settings-sync` module is optional sugar: it
seeds the file with the template baseline and adds push-time self-apply
(which needs a repo-scoped PAT and warns and skips without one); see
[docs/settings.md](settings.md).

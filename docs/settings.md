# Repository settings

Managed repos get their settings (repository fields, topics, labels,
rulesets) applied through
[repo-settings-as-code](https://github.com/Vivswan/repo-settings-as-code),
the replacement for the [Probot Settings app](https://github.com/repository-settings/app). Every apply is a visible
workflow run whose problems surface as loud warnings and errors; no
more silent drift.

A repo's settings live in ONE of two homes:

| Home | Settings file | How to pick it |
|---|---|---|
| Central | `settings/repos/<name>.yml` in repo-platform | add the file here |
| In-repo | the repo's own `.github/settings.yml` | carry the file (that is the whole opt-in) |

Both homes are applied from repo-platform by the `settings-repos.yml`
workflow, in one repo-settings-as-code invocation: `repos-dir` covers the
central files and the action's `repos:` remote mode reads each in-repo
file from its repo's default branch (enrolled and adopted repos only).
When both exist for the same repository, the central file wins.

Two guarantees for the in-repo home:

- The file is repo-owned wherever it exists: template sync never deletes
  it, even when a module change removes it from the render.
- The `settings-sync` module is optional sugar, not the opt-in: it seeds
  the file with the template baseline and adds a push-time self-apply
  workflow (which needs the repo's own PAT and warns and skips without
  one).

`settings-repos.yml` runs on three triggers:

- Push to main touching `settings/**`: merging a settings change applies it.
- Nightly heal cron: reverts out-of-band drift and applies in-repo files.
- Manual dispatch: a plain dispatch applies; pass `-f check_only=true` for
  a drift report without writing.

## The defaults baseline

`settings/defaults.yml` holds the `repository:` field block every repo
shares (merge policy, squash-title enforcement, feature toggles). The
workflow passes it as `defaults-file`, so it deep-merges UNDER every
target, central and in-repo alike:

- Target keys win over defaults.
- Objects merge key by key.
- Arrays REPLACE: list-valued sections (labels, rulesets) live in each
  repo's own settings file, never in defaults.
- A target section set to `null` opts that repo out of that defaults
  section.

## Apply semantics

Stateless, declared-keys-only, upsert-by-name:

- Labels: declared labels are synced; undeclared labels are deleted
  (loudly). List every label the repo should keep, including tool-managed
  ones like [release-please](https://github.com/googleapis/release-please)'s `autorelease: *` pair. Repos running
  dependabot must declare `dependencies` (color `0366d6`) and the
  per-ecosystem defaults its PRs carry: `github_actions` (`000000`) always,
  `javascript` (`168700`) for bun, `python:uv` (`2b67c6`) for uv, `rust`
  (`000000`) for cargo. Dependabot recreates missing labels on its next
  run, so an undeclared one is deleted and recreated forever; exact values
  are in `templates/settings-sync/.github/settings.yml.jinja`. Repos with
  the fuzzer module must likewise declare their `fuzzer_label` (default
  `fuzz-nightly`, color `B60205`): the settings-sync module's settings.yml
  does it automatically, central settings files must carry it by hand, or
  the label sync strips it from the open tracking issue and the auto-close
  loses the issue. The by-hand requirement is checked, not trusted: before
  the apply, `settings-repos.yml` compares each central file that declares
  labels against its repo's recorded module selection and fails the run on
  a missing required label instead of starting the loop. A file with no
  labels section leaves labels unmanaged and is skipped; a repo that
  carries no `.repo-platform.yml` only gets a warning.
- Rulesets: upserted by name (branch and tag targets); never deleted
  when undeclared, since removing protection stays a human action.
- Repository fields, topics, and security toggles are applied only when
  declared; omitting a key leaves the live value alone. The settings-sync
  template therefore renders `homepage:` and `topics:` unconditionally,
  like `private:` below: an empty answer declares-and-clears (empty
  topics normalize to no topics) instead of leaving the field unmanaged.
  A homepage or topics set only in the GitHub UI is cleared by the next
  heal once a sync lands - copy values you want to keep into the settings
  file (or the copier answer) before merging the sync PR. The same
  clearing hits a value that WAS in the settings file when sync's
  conflict resolution drops it toward the template: the dropped-hunk
  warning in the PR body is the tell. Restore the hunk before merging,
  or the key is declared empty and the next heal clears the live value.
- Visibility is managed like any other declared field: the settings-sync
  template renders `private:` unconditionally (false included), so for
  repos whose settings file declares the key, the nightly heal reverts
  an out-of-band flip in either direction - a repo made private in the
  GitHub UI is public again by the next morning. To change visibility on
  purpose, edit `private:` in the settings file and let the apply flip
  the repo. Flipping a bun or uv repo to private must also delete the
  ruleset's `code_scanning` rule in the same commit: GitHub rejects that
  rule on a private personal repo, so every apply fails until it is
  gone. The heal of an out-of-band private flip dodges that rejection
  only because the pinned repo-settings-as-code applies the repository
  field block before rulesets (SECTION_KEYS order in its schema.ts):
  the repo is public again before the code_scanning rule is upserted.
  Check a pin bump keeps that order. The next template sync reads the
  live visibility and re-renders everything that follows it
  (SECURITY.md, the CodeQL jobs, that rule).
  A flip the heal has not reverted by the time that sync runs is not
  ratified silently: the sync compares the live visibility and
  description against the repo's recorded copier answers, and on a
  mismatch the PR arrives review-required (auto-merge off) with the
  drift called out at the top of its body, including how to revert
  instead of merging.
- Short ref names in ruleset conditions are auto-prefixed (`staging` ->
  `refs/heads/staging`, `templates/*` -> `refs/tags/templates/*`);
  `~DEFAULT_BRANCH` passes through.

## The in-repo home

Carrying `.github/settings.yml` in the repo is the whole opt-in: the
central `settings-repos.yml` run reads and applies it remotely, and
template sync never deletes the file. Excluding a repo from sync in
`repos.yml` also pauses its nightly heal, so the settings run warns
when an excluded repo still carries the file. The `settings-sync` module is
optional sugar on top: it seeds the file with the template baseline
(three-way merged on updates) and renders a managed `settings-sync.yml`
workflow (push on that file + manual dispatch) that self-applies it
through `reusable-apply-settings.yml`.

Self-apply needs the repo's OWN `REPO_PLATFORM_TOKEN` Actions secret: a
fine-grained PAT with Administration (read and write) and Issues (read and
write) on that repository. Without the secret, self-apply runs skip with a
warning - the module stays safe to enable before any token exists, and the
central `settings-repos.yml` run applies the repo's settings.yml
regardless. The per-repo PAT only buys apply-on-push immediacy.

## Switching homes

In-repo to central:

1. Copy the repo's rendered `.github/settings.yml` content to
   `settings/repos/<name>.yml` here (bare name, same owner).
2. Remove `settings-sync` from the `modules:` list in the repo's
   `.repo-platform.yml`; the next sync PR deletes the `settings-sync.yml`
   caller. The repo's `settings.yml` stays (sync never deletes it) -
   remove it in the same PR, since the central file now wins over it.

Central to in-repo:

1. Add `settings-sync` to the repo's `.repo-platform.yml` modules; the
   next sync PR renders `settings.yml` and the caller.
2. Move the central `settings/repos/<name>.yml` content into the repo's
   settings.yml and delete the central file - while it exists, it wins
   over the in-repo file.

## Token

The fleet-level token model lives in the
[README's Credentials section](../README.md#credentials): one PAT stored
only in repo-platform drives sync and central settings, and it is
required there - the central runs fail without it. Settings applies are
strict about permissions: a token that cannot reach a declared section
fails the run (`on-missing-permission: fail`), so drift never hides
behind a green run. Administration and Issues write are required
wherever settings are applied.

A per-repo PAT is only needed for the module's self-apply-on-push, and
only needs Administration and Issues on that one repository
([create a module-only PAT with those pre-selected](https://github.com/settings/personal-access-tokens/new?name=REPO_PLATFORM_TOKEN&description=settings-sync+self-apply&administration=write&issues=write));
the fleet link's extra scopes (Contents, Pull requests, Workflows) are for
push sync and are not needed here.

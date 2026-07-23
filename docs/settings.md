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
| Central (the default) | `settings/repos/<name>.yml` in repo-platform | add the file here |
| In-repo (opt-in) | the repo's own `.github/settings.yml` | select the `settings-sync` module |

Both homes are applied from repo-platform by the `settings-repos.yml`
workflow, in one repo-settings-as-code invocation: `repos-dir` covers the
central files and the action's `repos:` remote mode reads each module
repo's own settings.yml from its default branch. When both exist for the
same repository, the central file wins.

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
  ones like [release-please](https://github.com/googleapis/release-please)'s `autorelease: *` pair.
- Rulesets: upserted by name (branch and tag targets); never deleted
  when undeclared, since removing protection stays a human action.
- Repository fields, topics, and security toggles are applied only when
  declared; omitting a key leaves the live value alone.
- Short ref names in ruleset conditions are auto-prefixed (`staging` ->
  `refs/heads/staging`, `templates/*` -> `refs/tags/templates/*`);
  `~DEFAULT_BRANCH` passes through.

## The in-repo home: the settings-sync module

Selecting `settings-sync` renders `.github/settings.yml` in the repo plus
a managed `settings-sync.yml` workflow (push on that file + manual
dispatch) that self-applies it through `reusable-apply-settings.yml`.

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
   `.repo-platform.yml`; the next sync PR deletes `settings.yml` and the
   `settings-sync.yml` caller from the repo.

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

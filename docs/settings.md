# The settings-sync module

Selecting `settings-sync` gives a repository a managed `settings-sync.yml`
workflow that applies `.github/settings.yml` through
[settings-as-code](https://github.com/Vivswan/settings-as-code) - the
replacement for the Probot Settings app. Every apply is a visible workflow
run that fails loudly; no more silent drift.

## When it runs

- on every push to main that touches `.github/settings.yml`
- monthly heal cron
- manual dispatch (with a `check_only` input for a drift report)

repo-platform itself runs the same machinery via its `apply-settings.yml`
caller (weekly heal).

## Semantics

Stateless, declared-keys-only, upsert-by-name:

- **Labels**: declared labels are synced; **undeclared labels are deleted**
  (loudly) - list every label the repo should keep, including tool-managed
  ones like release-please's `autorelease: *` pair.
- **Rulesets**: upserted by name (branch and tag targets); **never deleted**
  when undeclared - removing protection stays a human action.
- Repository fields, topics, and security toggles are applied only when
  declared; omitting a key leaves the live value alone.
- Short ref names in ruleset conditions are auto-prefixed (`staging` ->
  `refs/heads/staging`, `templates/*` -> `refs/tags/templates/*`);
  `~DEFAULT_BRANCH` passes through.

## Token

The workflow needs the `REPO_PLATFORM_TOKEN` secret in the repository, with
these fine-grained permissions on it:

| Permission | Why |
|---|---|
| Administration: read & write | repository fields, rulesets |
| Issues: read & write | labels |
| (plus the existing Contents/Pull requests/Actions scopes from the sync machinery) | |

Without the secret, runs skip with a notice - the module is safe to have
enabled before the token exists.

## Opting in an existing repo

`copier update --vcs-ref <your channel ref> -d 'modules=[...existing..., settings-sync]'`
then add the secret.

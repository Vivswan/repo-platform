# Copier migrations

Version-gated migration scripts, selected by `run.ts` using **from-version** naming: each script is named for the release it migrates AWAY from and runs when an update leaves that version behind (`from <= version < to`). Authoring never requires predicting the next release number, which release-please only decides when the release PR merges.

No migrations exist yet; `run.ts` is wired into `copier.yml`'s `_migrations` and no-ops until the first `<X.Y.Z>.ts` script lands.

Version parsing: copier's own version gating cannot parse the `templates/vX.Y.Z` build tags (not PEP 440), which is why selection lives in the runner instead: copier invokes `run.ts` on every update, and the runner strips the `templates/` prefix (`templates/v0.2.4` -> `0.2.4`) before comparing. Staging-channel updates carry describe/sha strings that do not parse as semver, so **migrations never run while a repo stays on staging**: an unparseable target version means none apply. An unparseable base under a released target has two intended causes: switching a repo from staging to latest, and updating a legacy repo whose recorded `_commit` is a plain main-history sha (copier versions it with dunamai's fallback, which fails the semver parse). In both, the runner cannot know which migrations the repo already covered, so it runs ALL of them up to the target and logs that it is doing so - the idempotence rule below is what makes the over-run harmless. The end-to-end version handoff has only been exercised with no migrations present; verify it live when the first real migration script lands.

## Writing a migration

A hypothetical example: v0.3.0 renames `.yamllint` and the rename needs a fixup in existing repos. The release being left behind is v0.2.4, so the script is named for it:

```text
migrations/0.2.4.ts
```

Rules:

- Executed with `bun`; use only built-in modules (the downstream repo has no `node_modules` for the template's dependencies).
- cwd is the downstream repository being updated; the script edits it directly.
- Must be IDEMPOTENT: updates can be retried, so a script may run twice.
- Best-effort: a non-zero exit warns but never aborts the update; the sync PR's validation step catches structural damage.
- Runs after copier applies the template diff (`_stage == 'after'`), from the NEW template version's checkout.

## When a migration is required

Any template change that renames a rendered file, retires one, changes its render condition (a gate move - some selections retire the file even though the path survives), or flips its ownership class (template-managed <-> repo-owned, e.g. a path entering or leaving `_skip_if_exists`) MUST ship three things in the same PR: the `migrations/<from-version>.ts` script, an upgrade-path test case (below), and a PR-body note naming the transition. `scripts/check_migrations.ts` (in `bun run check`) is the tripwire for the forgotten script: it compares the newest release tag's rendered landing paths and their gate conditions against the working tree's composed template and fails naming each transition and the expected migration filename; release state is checked against origin's tags, so a shallow or tagless checkout cannot silently pass once releases exist.

Salvage policy: WARN-ONLY by default. When a migration finds client content in the old location - a customized copy of a renamed file, local edits in a retired one - it prints what it found and what the repo's owner should do; that output surfaces in the sync run and the PR review. Auto-porting content into the new location is opt-in per migration, decided when the migration is written, never the default: a silent port can destroy local intent no script can judge.

## Proving a migration

- The `.github/scripts/ci/upgrade_path_test.sh` case must include a CUSTOMIZED-client fixture - a repo that locally edited the affected path - not just a clean render; the clean case is the one copier already handles on its own.
- Migrations are skipped on the staging channel (unparseable target versions, above), so the staging canary proves nothing about a migration. Proof is the upgrade-path test plus a local rehearsal against a real client: `bun .github/scripts/sync/rehearse.ts <owner>/<repo>` runs the update, the due migrations, and the cleanup legs against a read-only clone and prints the would-be sync PR.

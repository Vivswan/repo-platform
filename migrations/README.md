# Copier migrations

Version-gated migration scripts, selected by `run.ts` using **from-version**
naming: each script is named for the release it migrates AWAY from and runs
when an update leaves that version behind (`from <= version < to`). Authoring
never requires predicting the next release number, which release-please only
decides when the release PR merges.

No migrations exist yet; `run.ts` is wired into `copier.yml`'s `_migrations`
and no-ops until the first `<X.Y.Z>.ts` script lands.

Version parsing: copier's own version gating cannot parse the
`templates/vX.Y.Z` build tags (not PEP 440), which is why selection lives in
the runner instead: copier invokes `run.ts` on every update, and the runner
strips the `templates/` prefix (`templates/v0.2.4` -> `0.2.4`) before
comparing. Staging-channel updates carry describe/sha strings that do not
parse as semver, so **migrations never run on the staging channel** - they
apply when a repo moves between released `templates/vX.Y.Z` versions. The
end-to-end version handoff has only been exercised with no migrations
present; verify it live when the first real migration script lands.

## Writing a migration

A hypothetical example: v0.3.0 renames `.yamllint` and the rename needs a
fixup in existing repos. The release being left behind is v0.2.4, so the
script is named for it:

```text
migrations/0.2.4.ts
```

Rules:

- Executed with `bun`; use only built-in modules (the downstream repo has no
  `node_modules` for the template's dependencies).
- cwd is the downstream repository being updated; the script edits it
  directly.
- Must be IDEMPOTENT: updates can be retried, so a script may run twice.
- Best-effort: a non-zero exit warns but never aborts the update; the sync
  PR's validation step catches structural damage.
- Runs after copier applies the template diff (`_stage == 'after'`), from
  the NEW template version's checkout.

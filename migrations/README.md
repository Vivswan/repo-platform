# Copier migrations

Version-gated migration scripts, selected by `run.py` using **from-version**
naming (the pattern from copilot-env's `src/migrations`): each script is
named for the release it migrates AWAY from, and runs when an update leaves
that version behind (`from <= version < to`). Authoring never requires
predicting the next release number, which release-please only decides when
the release PR merges.

No migrations exist yet; `run.py` is wired into `copier.yml`'s `_migrations`
and no-ops until the first `<X.Y.Z>.py` script lands.

## Writing a migration

Say v0.3.0 renames `.yamllint` and the rename needs a fixup in existing
repos. The current released version is v0.2.4, so the script is named for
what repos are leaving behind:

```text
migrations/0.2.4.py
```

Rules:

- cwd is the downstream repository being updated; the script edits it
  directly.
- Must be IDEMPOTENT: updates can be retried, so a script may run twice.
- Best-effort: a non-zero exit warns but never aborts the update; the sync
  PR's validation step catches structural damage.
- Runs after copier applies the template diff (`_stage == 'after'`), from
  the NEW template version's checkout.

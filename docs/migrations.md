# Migrations: the ladder

A one-shot fleet transition (a rendered file moving, a repo-owned file needing a rewrite) is one rung on the migration ladder: ONE self-contained file under `.github/scripts/sync/migrations/`, shipped verbatim on the `build` branch. The sync runs, for each repository, the rungs that appeared in build history after the build it last synced from. Rungs are never retired: the ladder is permanent history. Code is the source of truth; this page is the map.

| Question | Owner |
| --- | --- |
| What is a rung, and what may it do? | the `Rung` contract in [sync/run_migrations.ts](../.github/scripts/sync/run_migrations.ts) |
| Which rungs exist, in what order? | the files in `.github/scripts/sync/migrations/` (the rung list below): filename order is ladder order |
| How does a sync decide which rungs to run, and from where? | `pendingRungs` in [sync/run_migrations.ts](../.github/scripts/sync/run_migrations.ts) |
| How do rungs reach the build branch? | `copyMigrations` in [build-branches/branch_tree.ts](../.github/scripts/build-branches/branch_tree.ts) |
| Which recorded `_commit` is a usable base? | [sync/recorded_commit.ts](../.github/scripts/sync/recorded_commit.ts) |
| What keeps the pieces from drifting? | the `migration-ladder`, `migrations-self-contained`, and `no-retired-shapes` rules in [scripts/check_ssot.ts](../scripts/check_ssot.ts) |

## One rung, one file

```text
.github/scripts/sync/migrations/        (on main)
  mNNNN_<slug>.ts                       a rung: export default { id, apply(target) }

migrations/                             (on the build branch, copied verbatim)
  mNNNN_<slug>.ts
```

- `id` equals the filename without `.ts`: `mNNNN_<slug>`, four zero-padded digits, so filename order is ladder order. Numbers are never reused.
- `apply(target)` gets `{ dir, oldSha, newSha }`: the checkout, the build commit the repository was last synced from (null when it has no usable base), and the build commit being delivered. Nothing else: no module list, no helpers.
- It probes, acts when needed, and returns `{ kind: "verdict", verdict: { kind, note } }` or `{ kind: "error", message }`. The note (`{ text, review }` or null) is the PR-body text; `review: true` holds the PR for a human. The runner fails the sync on the error arm and later rungs do not run.
- It STAGES what it changes (`git mv`, `git add`, through `Bun.spawnSync` with an argv array, never a shell string). The runner requires a clean checkout before the ladder and commits each rung's staged changes as the sync identity, `chore: run migration <id>`; anything left unstaged fails the rung.
- It is self-contained: `node:` and `bun:` imports only, never `node:module` or any other reach for a loader. The file runs from whichever build commit carries it, where no sibling script, shared helper, or package exists. Types are restated inline; the rung's unit test pins the contract by assigning the rung to the runner's `Rung` type.
- It is idempotent: a re-run after a failed sync, or a run with no usable base, finds the target already crossed and reports that (`in-place`) instead of acting twice.

## The walk over build history

The build branch is linear and append-only, and every rung file on it is its own marker. Given the repository's recorded `_commit` (old) and the delivered build tip (new), the runner walks the first-parent build commits in `(old, new]`:

```text
build branch (first-parent, oldest to newest)

  old            b1              b2              new (delivered)
  migrations/    migrations/     migrations/     migrations/
    m0001          m0001           m0001           m0001
                   m0002 (v1)      m0002 (v2)                  <- m0002 pruned from main
                                   m0003           m0003

  crossed  = files in old's tree                     = { m0001 }
  pending  = files in any of b1, b2, new - crossed   = { m0002, m0003 }
  source   = the NEWEST commit carrying each         : m0002 from b2, m0003 from new
  order    = filename order                          : m0002, then m0003
```

| Situation | Runs | From |
| --- | --- | --- |
| A repository synced before the rung existed | the rung | the newest build commit that carries it |
| A repository synced after the rung existed | nothing for that rung | - |
| The same build on both sides | nothing | - |
| A rung pruned from main after the repository fell behind | still the rung | the last build commit that carried it (history) |
| No usable base (`recover=recopy`; the recorded `_commit` is unusable) | every rung on the delivered tree, in order; a pruned rung is not among them | the delivered tip; each rung is idempotent |

Because the source is history, pruning an old rung from main is an ordinary PR for every repository with a usable recorded base: one that detaches and re-attaches years later still runs it. The one cost is recovery: a repository with no usable base runs only the delivered tip's rungs, so a pruned rung's postcondition is not re-established there. Prune only rungs whose postcondition a fresh render carries anyway (a rename copier re-renders), never one that rewrites repository-owned content. The rung's source is fetched with `git show <commit>:migrations/<file>` into `$RUNNER_TEMP` and loaded from there.

Rungs run before the module selection and before copier updates the tree: a rung may rewrite `.repo-platform.yml` (m0002 drops names the delivered template no longer offers, which selection would otherwise refuse), and a file a rung moves is committed first, so the split-file rebuild finds its repository-owned half at the new path. Their notes land in two PR-body reports: the informational one and the one that keeps the PR on the manual-review path.

## A usable base

[sync/recorded_commit.ts](../.github/scripts/sync/recorded_commit.ts) is the one judge, shared by the sync and the rehearsal. Only a build commit is a base: the walk needs one, and so does copier's three-way merge. A rejected `_commit` is a hard error unless the sync was dispatched with `recover=recopy`, where it reads as no base; an answers file the sync cannot read at all fails before that judgment, recovery or not, and is fixed by hand first.

| Rejected recorded state | Why | Under `recover=recopy` |
| --- | --- | --- |
| Answers file missing, unreadable, or not a YAML mapping | Nothing to judge | Still a hard error (resolve_refs.ts) |
| No `_commit`, or one that is not a full 40-hex sha (a short sha, a tag, a revspec such as `origin/build`) | git would resolve a revspec to whatever it names today, `origin/build` to the delivered tip, making every rung read as crossed; the stamp hook writes only full shas | No base |
| A sha this checkout cannot resolve, or a 40-hex tag NAME | Nothing to walk from; a ref is not the recorded object | No base |
| A sha that is not a build commit | A commit outside the build branch proves nothing about the repository's last sync | No base |
| A build commit ahead of the delivered build | The build branch never moves backwards, so the recording or the tip is wrong | No base |

## Trust

A rung is code the sync runs from the build branch, the same channel copier's stamp hook and every `uses: ...@build` action already run from. A rung still on the tip loads from the tip, which the provenance proof rebuilds and compares. Any rung absent from the tip loads from an older commit, trusted as append-only history; [build-provenance.md](build-provenance.md) states the residual.

## Adding a rung

1. Create `.github/scripts/sync/migrations/mNNNN_<slug>.ts` (the next number, a snake-case slug) default-exporting `{ id, apply }`, importing only `node:`/`bun:` specifiers. Stage what you change; return the verdict with its note, or the error arm.
2. Add its unit test at `tests/sync/migrations/mNNNN_<slug>.test.ts`: import the rung as the default import from `../../../.github/scripts/sync/migrations/mNNNN_<slug>.ts`, assign it to the runner's `Rung` type, and reach it from an enabled `test()` imported from `bun:test`. The fixtures in `tests/shared/migration_fixtures.ts` build scratch checkouts and build histories.
3. Add its case to [upgrade_path_test.sh](https://github.com/Vivswan/repo-platform/blob/main/.github/scripts/ci/upgrade_path_test.sh): remove the rung file from the synthetic old build, plant the pre-transition state, and assert the postcondition after the ladder runs.
4. Add its line to the list below and a PR-body note describing the transition.
5. `bun run check`: `migration-ladder` pins the filename grammar, the id literal, the bound test, the harness case, and the docs line; `migrations-self-contained` pins the imports; `no-retired-shapes` keeps the sync, the actions, the scripts, the template sources, and their tests free of the shape the rung moves repositories off (`RETIRED_SHAPE_TOKENS` lists the tokens, one line each with what retired it; the ladder is the one exempt place).

## Rungs on the ladder

One entry per file, in ladder order; a rung pruned from main moves to the list below.

- `m0001_security_policy_to_github`: moves a root `SECURITY.md` to `.github/SECURITY.md` byte-for-byte (`git mv`, committed ahead of copier so the split-file rebuild finds the repository-owned half at the new path); a policy at both paths, a non-file, or a symlinked `.github` is the error arm; a stale `mirrors` source at the old path gets advice in the note.
- `m0002_fold_base_modules`: drops `agents`, `auto-assign`, and `settings-sync` from `.repo-platform.yml`'s `modules` list (the three became unconditional base content, and a name that is not a template choice fails module selection), staged ahead of selection and copier so copier records the shorter selection itself; a line-level edit of the list alone, so comments and the `mirrors` declaration are untouched (an emptied list renders `[]`), verified by re-parsing before the write; a declaration selection cannot read is left to the selection step's diagnosis (`unreadable`), a missing file is `missing`, a non-file or a list shape the edit does not understand (a flow list spanning lines, an alias or tagged item) is the error arm; that note is informational. The fold's ARRIVALS are judged too: a repository's own regular file at an agent-file alias path (`CLAUDE.md`, `.github/agents.md`, `.github/copilot-instructions.md`, which the template now renders as symlinks) is appended verbatim to `AGENTS.md` under a heading naming the source and the alias removed, both staged (`+aliases` on the verdict, a warning note that holds the PR; the split-file carry keeps the moved content below the managed region), and its own file at another managed arrival (`review.instructions.md`, `auto-assign.yml`, `settings-sync.yml`) is the error arm, because the sync never overwrites a file it did not render. Until a repository's sync PR merges, the settings apply refuses its stale declaration (unknown module) and skips nothing silently.

## Pruned from main

A rung deleted from main stays on the build branch and keeps its line here, so its number is never reused: the `migration-ladder` rule requires this section and reds a new rung file that takes a number this list (or another live rung) uses. An entry is never removed from this list; nothing but review guards that.

- none yet

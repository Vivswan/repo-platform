---
order: 4
---

# The manifest

This page is the manifest's contract: what `.github/repo-platform-manifest.json` records, when its own commit moves (the stamp rule), and how the fleet's managed files check judges a repository at that commit.

`.github/repo-platform-manifest.json`, the layout `actions/shared/manifest.ts` already parses: one entry per line, sorted by path.

**Classes recorded:** `managed`, `split` (with `grammar`, `begin`, `end`), `starter`, and `mirror` (the copy's hash, or `kind: symlink` and the hash of the link target string). A fleet mirror is recorded as a repository mirror is. The record is how the next sync tells the platform's own previous write from a local edit, for replacement and for retirement.

**The manifest's own entry** is `managed` with `hash: null` and `commit`, the repo-platform commit the repository is judged against:

```json
".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": "c07568b70e1f4b0a9d2c3e4f5a6b7c8d9e0f1a2b"}
```

## When the judged commit moves

The entry moves to the build when the sync wrote a change or the checker changed, and stays otherwise (`judgedCommit` in [sync/writer/judged_commit.ts](../../../.github/scripts/sync/writer/judged_commit.ts)). The manifest is written last, so the decision reads the run's own outcome.

| The manifest names                                                                                                                                                         | The build is                                       | The sync                                                                                                                                         | The entry after the sync |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| no manifest the writer accepts: none (a first sync), one that does not parse, or one whose own entry names no full commit (a hand edit, since every sync writes the field) | any                                                | any                                                                                                                                              | the build                |
| commit C                                                                                                                                                                   | C                                                  | any                                                                                                                                              | C                        |
| commit C                                                                                                                                                                   | N                                                  | wrote at least one byte differently: a managed, split, starter, or mirror write, a retirement, a replaced local edit, or a manifest record moved | N                        |
| commit C                                                                                                                                                                   | N, with the checker different between C and N      | wrote nothing                                                                                                                                    | N                        |
| commit C                                                                                                                                                                   | N, with the checker byte-identical between C and N | wrote nothing                                                                                                                                    | C; no sync PR opens      |

- **The checker surface** is the set of files check.ts imports, derived from the import graph at sync time (`checkerSurface` in [sync/writer/judged_commit.ts](../../../.github/scripts/sync/writer/judged_commit.ts)): exactly the code that runs at the recorded commit, the writer included.
- **Why the checker counts:** a change there can turn C's verdict away from N's with no byte written. N's registration parser accepts a `site.path` C's rejects, so C's check would stay red with no sync PR to move the stamp.
- **Never on the surface:** the operator scripts, the action's stable-run `src/` and `validator/` files (they reach every repository the moment the tag moves), and the docs-site theme.
- **Why not every platform change:** a docs-theme change under `actions/pages-site/` once restamped nine repositories with one-line manifest PRs (copilot-env #279, after repo-platform #356); under this rule that sync writes nothing, moves nothing, and opens no PR.

## Judged at the synced commit

The fleet's `validate-managed-files` check judges a repository as [check.ts](../../../actions/validate-managed-files/check.ts) judges it at the commit the manifest records, byte to byte against what that platform tree writes, so a platform change reddens a repository only once it syncs.

- **A pending registration change** is red until the sync that carries it lands.
- **Freshness never fails:** the action reports how far `stable` has moved past the recorded commit, and a sync moves the judge under [the stamp rule](#when-the-judged-commit-moves).
- **The hygiene checks** (a `release-as` key in `release-please-config.json`, a conflict marker in a source, config, or markdown file) read no platform data and run from the action at `stable`; YAML syntax and duplicate keys are the yamllint step's, in the same job.

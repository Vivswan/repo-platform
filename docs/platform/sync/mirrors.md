---
order: 3
---

# Mirrors

This page is the mirror contract: how a file this sync wrote is carried to more paths, as copies or relative symlinks, what the `plan` step of fleet CI refuses on the PR that declares one, and what the writer refuses or reports at sync time.

**Every declaration is either written or fails the run:** a copy the writer cannot make would leave the repository out of sync with only a hold row to show it. Two readers judge it: the `plan` step of fleet CI on the PR that introduces it, then the writer at sync time.

Two `mirrors` lists in one grammar (`source`, `targets`, `kind`) carry a file this sync wrote to each target: the fleet's in `files.yml`, then the repository's in its registration.

```yaml
mirrors:
  - source: LICENSE.md
    targets:
      - template/LICENSE.md
      - skills/*/LICENSE.md
  - source: AGENTS.md
    kind: symlink
    targets:
      - docs/AGENTS.md
```

The skills repository declares the first: a standalone skill install copies one folder, so each needs its own `LICENSE.md`, rewritten from the fresh source in the same sync PR. A `source` is a file `files.yml` writes for the repository as `managed` or `split`; mirroring repo-owned content is the repository's own job.

- **One pass judges and writes both as one list,** the fleet's declarations first, so a repository target meeting a fleet target is judged as any two claims on one path are (below). It is refused when it is another source's, another kind's, nested, or a literal spelled twice; a pattern of the same source and kind finds the fleet's literal current.
- **A fleet target the registration's `except` names** is dropped from the list, as an entry at that path would be.
- **A failure line names the document that declares the pair:** the registration when it does, `files.yml` otherwise.
- **`kind`** is how a target carries the source, and every reader judges the target through it: `copy` (the default) writes the source's bytes; `symlink` places a symbolic link to the source, relative to the target's directory (`skills/a/LICENSE.md -> ../../LICENSE.md`).
- **A Windows checkout** materializes a link only with `core.symlinks` on; no fleet runner is Windows today.
- **Single-segment `*` globs:** a `*` directory segment matches directories, a final `*` matches existing files, a literal final segment lands in every matched directory. A glob never creates a directory.
- **Literal targets are written before any glob expands,** so a directory a literal creates is matched in the same run; a target a literal claims stays the literal's.
- **A symbolic link above a target,** in a literal or a `*` directory segment, is never followed or listed through.
- **A link that provably resolves to a file** is no directory, so it is passed over like a file.
- **A link a final segment matches** is the target itself, judged by the declared kind (the outcome table below).

## Refused on the PR

The `plan` step of fleet CI rejects, on the PR that introduces it, what `files.yml` alone proves unwritable, each refusal naming the declaration and the reason ([actions/plan/mirrors.ts](../../../actions/plan/mirrors.ts)): a source that is not a managed or split file, an unsafe or reserved path, a `**`, and a path two declarations claim or nest.

The writer judges the same claims again at sync time with what only the checkout shows, the stale records it retires reserved alongside.

**Nesting is judged on the text:** a pattern's own text counts as written, so `skills/*` nests under a literal `skills`. Two different pattern texts are nested as written, never by what they can match: `tests/*/foo` with `tests/a*/foo/bar` passes the plan and fails at sync time on any checkout with a `tests/a*` directory.

## Checked by the writer

A failure exits nonzero before the pass writes anything, each verdict naming the declaring document, the source, the target, and the reason; no PR is opened, and the failure issue the operator files ([the operator](operator.md)) carries the lines in its writer log.

| Outcome                | When                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `written`              | the target was absent, or held exactly the previous mirror (the hash of its `mirror` record, of either kind)                                                                                          |
| `current`              | the target already holds the new content: the bytes for a `copy`, a link to the source for a `symlink`                                                                                                |
| `replaced local edits` | the target held other content: a file with other bytes, a file where a link is declared, a link where a copy is declared, or a link elsewhere where a link is declared                                |
| `replaced`             | a directory stood at the target (removed whole, the links inside unlinked and never followed) or a file stood where an ancestor directory must be (removed); the detail names which, and holds the PR |

- **A previous mirror of either kind vouches for the bytes:** a copy where a link is declared now, or the reverse, is replaced without a diff. A record of another class does not vouch for the bytes.
- **The `replaced local edits` diff** is of link targets where a link is declared, and of the old link target against the new bytes where a copy is. It sits in the report's Replaced local edits section and holds the PR.
- **`written` and `current` never hold:** the declaration is repo-owned consent, so a clean LICENSE bump stays auto-merge-eligible. The fleet's `validate-managed-files` judges each target as the writer does: a file where a link is declared, a link where a copy is, or a link pointing elsewhere is a finding.

Every row's target is recorded as a `mirror` record ([The manifest](manifest.md)).

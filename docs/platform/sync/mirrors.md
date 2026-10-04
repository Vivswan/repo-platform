---
order: 3
---

# Mirrors

This page is the mirror contract: how a file this sync wrote is carried to more paths, as copies or relative symlinks, what the `plan` step of fleet CI refuses on the PR that declares one, and what the writer refuses or reports at sync time.

**Every declaration is either written or fails the run:** a copy the writer cannot make would leave the repository out of sync with only a hold row to show it. Two readers judge it: the `plan` step of fleet CI on the PR that introduces it, then the writer at sync time.

Two `mirrors` lists in one grammar (`source`, `targets`, `kind`) carry a file this sync wrote to each target: the fleet's in `files.yml`, then the repository's in its registration.

- **One pass judges and writes both as one list,** the fleet's declarations first, so a repository target meeting a fleet target is judged as any two claims on one path are (below). It is refused when it is another source's, another kind's, nested, or a literal spelled twice; a pattern of the same source and kind finds the fleet's literal current.
- **A fleet target the registration's `except` names** is dropped from the list, as an entry at that path would be.
- **A failure line names the document that declares the pair:** the registration when it does, `files.yml` otherwise.
- **`kind`** is how a target carries the source, and every reader judges the target through it: `copy` (the default) writes the source's bytes; `symlink` places a symbolic link to the source, relative to the target's directory (`skills/a/LICENSE.md -> ../../LICENSE.md`).
- **A Windows checkout** materializes a link only with `core.symlinks` on; no fleet runner is Windows today.
- **Single-segment `*` globs:** a `*` directory segment matches directories, a final `*` matches existing files, a literal final segment lands in every matched directory. A glob never creates a directory.
- **Literal targets are written before any glob expands,** so a directory a literal creates is matched in the same run; a target a literal claims stays the literal's.
- **A symbolic link above a target,** in a literal or a `*` directory segment, is never followed or listed through. A linked directory, or a link that cannot be looked through (resolving to nothing, to a name too long, or through a directory the runner may not read), fails the run by name, the rest of the pattern riding along (`skills/link/sub/*.md`).
- **A link that provably resolves to a file** is no directory, so it is passed over like a file.
- **A link a final segment matches** is the target itself, judged by the declared kind (the outcome table below).
- **A matched path the grammar refuses** (one grown past 1024 bytes through long directory names) is never probed and fails by name the same way.

## Refused on the PR

The `plan` step of fleet CI rejects, on the PR that introduces it, what `files.yml` alone proves unwritable (the rules in [actions/plan/mirrors.ts](../../../actions/plan/mirrors.ts)):

| Refused on the PR | Detail |
| --- | --- |
| a source that is not a `managed` or `split` file `files.yml` writes for the repository | |
| a `**` | |
| a target or pattern that is unsafe | a control character, a segment over 255 bytes, or a path over 1024 bytes included |
| a target or pattern that is or sits under the registration itself, or sits under `.github/workflows/` | |
| a target or pattern that is, sits under, or is a path prefix of a path `files.yml` writes or the registration excepts | |
| a pattern that matches (segment for segment, as the writer expands it) the registration or a path `files.yml` writes or the registration excepts | the claim reserves the path, whether or not the file stands in the checkout that run |
| every path a declaration is certain to claim, judged as the writer judges a claim (the rows below) | over the literal targets and the directories they create: the only part of the tree the plan knows, since the literal pass writes them before any pattern expands |

A path a declaration is certain to claim is refused when it is:

| Certain claim refused | Detail |
| --- | --- |
| a literal target declared twice | |
| a path nested with another claimed path | both sides, whatever their sources (below) |
| a pattern's path that sits under or above a path `files.yml` writes or the registration excepts, or that the grammar refuses | |
| a path claimed by two sources or as a copy and as a symbolic link | one pattern text declared twice included, since both expand alike |

**Nesting is judged on the text:** a pattern's own text counts as written, so `skills/*` nests under a literal `skills`. Two different pattern texts are nested as written, never by what they can match: `tests/*/foo` with `tests/a*/foo/bar` passes the plan and fails at sync time on any checkout with a `tests/a*` directory.

## Checked by the writer

**The writer runs the same check,** with the stale manifest records it retires reserved alongside (`a path a stale manifest record retires`), then judges each pass's claims the same way with what only the checkout shows.

**A failure exits nonzero** before the pass writes anything, one `::error::` line per verdict for each declaration and path: `<.repo-platform.yml or files.yml>: mirrors: source '<s>', target '<t>': <reason>`, a pattern's reason naming the path it expanded to. No PR is opened; the failure issue the operator files ([the operator](operator.md)) carries the lines in its writer log.

| Outcome | When |
| --- | --- |
| `written` | the target was absent, or held exactly the previous mirror (the hash of its `mirror` record, of either kind) |
| `current` | the target already holds the new content: the bytes for a `copy`, a link to the source for a `symlink` |
| `replaced local edits` | the target held other content: a file with other bytes, a file where a link is declared, a link where a copy is declared, or a link elsewhere where a link is declared |
| `replaced` | a directory stood at the target (removed whole, the links inside unlinked and never followed) or a file stood where an ancestor directory must be (removed); the detail names which, and holds the PR |

- **A previous mirror of either kind vouches for the bytes:** a copy where a link is declared now, or the reverse, is replaced without a diff. A record of another class does not vouch for the bytes.
- **The `replaced local edits` diff** is of link targets where a link is declared, and of the old link target against the new bytes where a copy is. It sits in the report's Replaced local edits section and holds the PR.

Every claim of a pass is judged before the pass writes, and the run fails when:

- the source was held this run
- the pattern matches nothing, or reads through a symbolic link or a file in its literal prefix
- a claimed path is unsafe
- a claimed path nests with a path `files.yml` writes, a stale record retires, or the registration excepts
- a claimed path sits under a symbolic link, or (a pattern's) sits under a file or in a directory that does not exist
- a path is a prefix of or sits under another target (both sides; a target an earlier pass settled included)
- a path is claimed by more than one source, or as a copy and as a link

Every row's target is recorded as a `mirror` record ([The manifest](manifest.md)).

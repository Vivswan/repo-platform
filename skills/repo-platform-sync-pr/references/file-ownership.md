# File classes and the decision rule per class

Classify every file a sync PR touches before deciding what to do with a surprising row. The Written section names each path's class, and the PR head's `.github/repo-platform-manifest.json` records the class of every platform-written path; this table says what the class means for the decision.

| Class | Decision rule in a sync PR |
|---|---|
| Managed (rewritten whole every sync) | Accept the platform version. `created`, `updated`, and `unchanged` need no look; `replaced local edits` shows the diff of what someone wrote there, and that content moves into a repo-owned hook, into `.github/settings.local.yml` for a setting, or into the platform's `files/` |
| Split (managed region, repo-owned tail) | Only the region between `BEGIN REPO-PLATFORM MANAGED` and `END REPO-PLATFORM MANAGED` changes; the diff must stay inside the markers. Content above BEGIN and below END rides through byte-for-byte. An edit inside the region reads `replaced local edits` with its diff, like a managed file |
| Starter (written once, then repo-owned) | `created` when the path was absent (a first sync, a new module, or a path the platform newly declares explains it), `unchanged` when it exists; never `updated` or `replaced local edits`. A starter row that modifies or deletes an existing file is a sync bug; stop and report |
| Repo-owned, read by the platform | Never in the diff: the sync reads it and rewrites nothing |
| Mirror | `written` and `current` are routine; `replaced local edits` shows the replaced content's diff and `replaced` names the directory or blocking file removed, both holding the PR. A declaration the writer cannot honour fails the sync instead of appearing here |

Retired rows (the Retired section) follow the same ownership; the skill's Retired outcomes table ([Read the report](../SKILL.md#read-the-report)) says what each outcome did.

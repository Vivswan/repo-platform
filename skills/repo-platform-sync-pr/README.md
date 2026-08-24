# repo-platform: Sync PR

`repo-platform-sync-pr` is the playbook for the automated template update PRs that [Vivswan/repo-platform](https://github.com/Vivswan/repo-platform) pushes into managed repositories.

## Install

```bash
npx skills add https://github.com/Vivswan/repo-platform/tree/main/skills/repo-platform-sync-pr -g
```

## What It Does

- Explains what the PR is (a three-way `copier update` on a rolling, force-pushed automation branch) and when it auto-merges vs waits
- Mandates a per-file review pass: classify every changed file and catch local-content loss before merging
- Gets conflicts right: the branch carries no markers in the normal case (template side kept, dropped local lines in the PR body), local-section files get their hunks moved below the marker, and malformed markers stay in the file for hand-editing
- Covers fixing the PR (push to the automation branch, merge promptly), why closing is not an opt-out, and the `recover=recopy` escalation for an unresolvable recorded `_commit`

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.

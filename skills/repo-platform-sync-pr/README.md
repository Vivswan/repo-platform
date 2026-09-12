# repo-platform: Sync PR

`repo-platform-sync-pr` is the playbook for the sync PRs that [Vivswan/repo-platform](https://github.com/Vivswan/repo-platform) pushes into managed repositories.

## Install

```bash
npx skills add https://github.com/Vivswan/repo-platform/tree/main/skills/repo-platform-sync-pr -g
```

## What It Does

- Explains what the PR is (a copy of the platform's files, no merge, on a branch rewritten every run) and when it auto-merges vs waits
- Reads the report section by section: Written, Replaced local edits, Retired, Registration notes, Mirrors, Review, and the exact hold reasons
- Covers the manual review cases (replaced local edits, held retirements, replaced mirrors, registration drops), the repo-owned tail of a split file, and where a local change lives
- Covers fixing the PR, resolving on a human's behalf, and the failure path (the `[repo-platform] sync failed` issue in the repository)

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.

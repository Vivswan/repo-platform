# repo-platform: New Project

`repo-platform-new-project` walks the creation of a repository managed by
[Vivswan/repo-platform](https://github.com/Vivswan/repo-platform): native
scaffold, copier template, publish, enrollment, and settings.

## Install

```bash
npx skills add https://github.com/Vivswan/repo-platform/tree/main/skills/repo-platform-new-project -g
```

## What It Does

- Applies the copier template from the right build ref for the chosen
  channel (staging branch or a `templates/vX.Y.Z` tag)
- Walks the copier questions: channel, modules multiselect, per-module
  follow-ups (pages, fuzzer, settings-sync), visibility
- Publishes the repo, enrolls it (fleet PAT access is the enrollment),
  and registers central settings with the labels each module requires
- Explains what runs on the first PR (the all-green gate) and which
  files are managed vs repo-owned

## Plugin-Ready Layout

This skill directory already includes plugin metadata in
[`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers,
hooks, or app manifests can be added later without moving the skill.

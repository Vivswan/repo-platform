# repo-platform: Add or Remove a Module

`repo-platform-add-module` is the playbook for changing a managed repository's module selection under [Vivswan/repo-platform](https://github.com/Vivswan/repo-platform): editing the `modules:` list and the module keys in `.repo-platform.yml`, running the sync that writes the module's files, and finishing each module's companion steps.

## Install

```bash
npx skills add https://github.com/Vivswan/repo-platform/tree/main/skills/repo-platform-add-module -g
```

## What It Does

- Walks the add flow: edit `.repo-platform.yml` on a branch, merge (the plan job validates it), dispatch the sync with `manual=true`, check that the module diff explains every row of the sync PR's report, merge
- Lists what each module writes (path and class, from `files.yml`) and that `ci.yml` never changes with the selection
- Documents the module keys (`site.*`, `skills.dir`, `labels.*`) and the ripple a tracking-label change has on the repo-owned starters
- Carries the per-module companion checklist and what removal retires vs leaves behind

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.

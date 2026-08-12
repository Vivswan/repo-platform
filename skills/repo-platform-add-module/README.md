# repo-platform: Add or Remove a Module

`repo-platform-add-module` is the playbook for changing a managed
repository's module selection under
[Vivswan/repo-platform](https://github.com/Vivswan/repo-platform):
editing the `modules:` list, setting module parameters, and finishing
each module's companion steps.

## Install

```bash
npx skills add https://github.com/Vivswan/repo-platform/tree/main/skills/repo-platform-add-module -g
```

## What It Does

- Locates the selection (the repo-owned `modules:` list in
  `.repo-platform.yml`) and walks the add flow: edit, merge, get the
  sync PR (or dispatch it), review every changed file
- Documents the module-parameter mechanism: recorded answers in
  `.copier-answers.yml`, edited by PR (value keys only), with the
  ripples a tracking-label rename has on repo-owned starters
- Carries the per-module companion checklist: central settings labels,
  the bun module's Dependabot secret, pages one-time setup, listing
  skills in the repo-owned plugin manifest
- Covers removal: what the sync cleans up vs what stays (starters,
  settings.yml), label cleanup, and the custom-license flip guard

## Plugin-Ready Layout

This skill directory already includes plugin metadata in
[`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers,
hooks, or app manifests can be added later without moving the skill.

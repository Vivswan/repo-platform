# repo-platform: New Project

`repo-platform-new-project` walks the creation or adoption of a repository managed by [Vivswan/repo-platform](https://github.com/Vivswan/repo-platform): create the repo, write the registration, grant the fleet token, run the first sync, review its report, watch the first CI run.

## Install

```bash
npx skills add https://github.com/Vivswan/repo-platform/tree/main/skills/repo-platform-new-project -g
```

## What It Does

- Writes `.repo-platform.yml`: the module list and the project block, plus only the other keys whose defaults are wrong, with a minimal and a full example and the key reference
- Enrolls the repo (the fleet token's write grant is the membership) and dispatches the first sync with `manual=true`
- Reads the sync PR's report section by section (Written, Replaced local edits, Retired, Registration notes, Mirrors, Review) before merging
- Names the repo-owned starters to fill in, the CI jobs every repo shares, and the owner actions (token grant, Pages, the bun Dependabot secret)

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.

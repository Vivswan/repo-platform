# Agent skills

Portable agent skills for working with repo-platform from other repositories: each folder is a standalone skill an agent installs wherever it needs the platform knowledge. They live in this operator repo but are not platform files - the sync never writes them into managed repos.

| Skill | Purpose |
|---|---|
| [repo-platform-sync-pr](repo-platform-sync-pr/) | Handle an automated sync PR: read the report, clear every row, keep local content in its owned place, follow the failure path |
| [repo-platform-new-project](repo-platform-new-project/) | Create or adopt a repository under platform management: write the registration, grant the fleet token, run the first sync, watch the first CI run |
| [repo-platform-add-module](repo-platform-add-module/) | Add or remove a platform module in a managed repository: edit the registration, run the sync for the module's files, finish the companion steps |

## Install

Each skill installs standalone with the skills CLI (`-g` targets the global skill directory; drop it for a per-project install):

```bash
npx skills add https://github.com/Vivswan/repo-platform/tree/main/skills/<skill-name> -g
```

Details per skill are in each folder's README.md.

# Agent skills

Portable agent skills for working with repo-platform from other repositories: each folder is a standalone skill an agent installs wherever it needs the platform knowledge. They live in this operator repo but are not template content - template sync never copies them into managed repos.

| Skill | Purpose |
|---|---|
| [repo-platform-sync-pr](repo-platform-sync-pr/) | Handle an automated template sync PR: triage the body, review every changed file, resolve conflicts, and recover a broken sync |
| [repo-platform-new-project](repo-platform-new-project/) | Create or adopt a repository under platform management: scaffold, apply the copier template, publish, enroll, and register settings |
| [repo-platform-add-module](repo-platform-add-module/) | Add or remove a platform module in a managed repository: edit the selection, set parameters, land the companion steps, and verify the sync PR |

## Install

Each skill installs standalone with the skills CLI (`-g` targets the global skill directory; drop it for a per-project install):

```bash
npx skills add https://github.com/Vivswan/repo-platform/tree/main/skills/<skill-name> -g
```

Details per skill are in each folder's README.md.

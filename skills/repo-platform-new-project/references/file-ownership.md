# File ownership in a managed repository

<!-- The Class and Files columns are one roster with skills/repo-platform-sync-pr/references/file-ownership.md (skills install standalone, so each ships its own table); repo-platform's check_ssot skill-ownership-tables rule fails on any difference between the two. The third column is this skill's own. -->

Who owns what after the first sync. The classes come from repo-platform's `files.yml`; the sync PR's Written section names the class of every path it touched.

| Class | Files | What that means |
|---|---|---|
| Managed (rewritten whole every sync) | `.github/workflows/ci.yml`, `.github/instructions/review.instructions.md`, `.yamllint`, `.typography-allow`, `.github/workflows/auto-assign.yml`, the module workflows (`dependabot-bun-lockfile.yml`, `deno-audit.yml`, `pages.yml`, `docs-site.yml`, `validate-skills.yml`, `pr-title.yml`), the toolchain pin dotfiles (`.bun-version`, `.node-version`, `.dvmrc`), `.github/repo-platform-manifest.json` (the record of what the platform wrote) | Do not edit. A local edit is replaced on the next sync and shown under Replaced local edits; the need moves into a repo-owned hook or into repo-platform's `files/` |
| Split (managed region, repo-owned tail) | `.editorconfig`, `.gitattributes`, `.gitignore`, `.github/CODEOWNERS`, `.github/dependabot.yml`, `AGENTS.md`, `LICENSE.md` (not with `custom-license`) | Everything above `BEGIN REPO-PLATFORM MANAGED` and below `END REPO-PLATFORM MANAGED` is yours and rides through every sync. An edit inside the region is replaced and reported like a managed file. For override-by-position formats (`.editorconfig`, `CODEOWNERS`, `.gitignore`) put overrides below END, where later entries win |
| Starter (written once, then repo-owned) | `.github/workflows/checks.yml`, `post-green.yml`, `update-release.yml`, `update-release-pr.yml`, `copilot-setup-steps.yml`, `auto-format.yml` (formatter toolchains), `.gitleaks.toml`, `.github/actionlint.yaml`, `.github/settings.yml`, `release-please-config.json`, `.release-please-manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `nightly-fuzz.yml`, `nightly.yml` | Fill them in; the sync never touches an existing one. A repo that already has a file at a starter path keeps its copy |
| Repo-owned, read by the platform | `.repo-platform.yml` | The registration: the sync and fleet CI read it, nothing rewrites it |
| Mirror | the targets declared under `mirrors` in `.repo-platform.yml` | Copies of a file the sync wrote, refreshed every sync from the source; edit the source, never the copy |

Retired paths (files the platform used to write and no longer does, `.github/.copier-answers.yml` and `.github/workflows/release.yml` among them) are deleted by the sync when they still hold the platform's own content, kept when they were starters (yours), and held for your decision otherwise.

# File ownership in a managed repository

<!-- Keep in sync with the twin copy in skills/repo-platform-sync-pr/
     references/file-ownership.md - skills install standalone, so the table is duplicated. -->

Who owns what after generation. "Managed" files are template-owned; "repo-owned" files are yours.

| Category | Files | What that means |
|---|---|---|
| Fully managed (template-owned) | `.copier-answers.yml` (one sanctioned edit; see notes), `.github/workflows/ci.yml`, `release-please.yml`, `dependabot-bun-lockfile.yml` (bun module), `validate-skills.yml` (skills module), thin workflow callers (`auto-assign.yml`, `pages.yml`, `settings-sync.yml`), `dependabot.yml`, toolchain pin dotfiles (`.bun-version`, `.node-version`, `.dvmrc`), `CODE_OF_CONDUCT.md`, `.yamllint`, `.typography-allow`, agent-file symlinks | Do not edit; local edits that overlap a template change lose to the template on sync (with review), and even non-overlapping edits are unowned |
| Managed shape, repo-owned selection | `.repo-platform.yml` | Its presence enrolls the repo; its top-level `modules:` list is yours - edit it and the next sync applies the change |
| Managed + local section (sentinel) | `SECURITY.md`, `CONTRIBUTING.md` (public repos only), `LICENSE.md`, `AGENTS.md`, `.gitattributes`, `.editorconfig`, `.github/CODEOWNERS` | Everything below the `repo-platform:local-section` marker line is yours; the half above is managed. The semantics favor your half where it matters: .editorconfig applies later sections over earlier ones and CODEOWNERS applies the LAST matching pattern, so entries below the marker override the managed half. Sync conflict resolution moves overlapping local edits below the marker |
| Managed + local section (`.gitignore`) | `.gitignore` | The BEGIN/END REPOSITORY LOCAL section is yours (put scaffolder or project entries there). It uses those markers, not the sentinel, so a sync conflict there is resolved with the local side dropped into the PR body for you to re-add |
| Mergeable (three-way) | `.github/settings.yml` (never deleted by sync) | Local edits merge with template updates |
| Generated once, then repo-owned (`_skip_if_exists`) | `.github/workflows/checks.yml`, `release.yml`, `auto-format.yml`, `copilot-setup-steps.yml`, `nightly-fuzz.yml`, `nightly.yml`, issue forms and chooser config, `release-please-config.json`, `.release-please-manifest.json`, `.gitleaks.toml`, `.github/actionlint.yaml`, `.claude-plugin/plugin.json` and `marketplace.json` (skills module) | Seeded on first render (adding a module later seeds its starters in that sync PR), then never overwritten - fill them in freely |
| Repo-owned (never touched) | source code, release tooling, `.typography-allow.local`, everything else | The template never renders these paths |

Notes:

- `.copier-answers.yml` is managed; the one sanctioned edit is changing a question's VALUE key via a default-branch PR to set a module parameter (`nightly_label`, `skills_dir`, `pages_*`, `fuzzer_label`, ...) - the sync loads those values from the recorded answers, so the edit sticks. Never touch the underscore keys (`_commit`, `_src_path`).
- The toolchain pin dotfiles (`.bun-version`, `.node-version`, `.dvmrc`) are fleet-wide: sync PRs add and bump them (one shared version per toolchain). Override a version in your repo-owned workflows' version inputs, not by editing the dotfile.
- `LICENSE.md` carries the fleet license (Individual and Small Organization License); local notices (third-party components) go below its marker. With the `custom-license` module the file is the repo's own license and sync never touches it.
- `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to `AGENTS.md` (agents module): one source of truth.
- The authoritative generated-once list is `_skip_if_exists` in repo-platform's `copier.yml`.

# File classes and the decision rule per class

<!-- Keep in sync with the twin copy in skills/repo-platform-new-project/
     references/file-ownership.md - skills install standalone, so the
     table is duplicated. -->

Classify every file a sync PR touches before deciding what to do with a
conflict or a surprising diff.

| Class | Files | Decision rule in a sync PR |
|---|---|---|
| Fully managed (template-owned) | `.copier-answers.yml`, `.github/workflows/ci.yml`, `release-please.yml`, `dependabot-bun-lockfile.yml` (bun module), thin workflow callers (`auto-assign.yml`, `pages.yml`, `settings-sync.yml`), `dependabot.yml`, `CODE_OF_CONDUCT.md`, `.yamllint`, `.typography-allow`, agent-file symlinks | Accept the template side. Overlapping local edits lose to the template (a non-overlapping edit can survive a given sync, but it is unowned); move the need into a repo-owned file or into the template itself |
| Managed shape, repo-owned selection | `.repo-platform.yml` | The `modules:` list is the repo's own; the file's shape is managed |
| Managed + local section (sentinel) | `SECURITY.md`, `CONTRIBUTING.md` (public repos only), `LICENSE.md`, `AGENTS.md`, `.gitattributes` | Everything below the `repo-platform:local-section` marker line is repo-owned; the half above is managed. Conflict resolution MOVES overlapping local edits below the marker where there is content to move; verify placement. A deletion-dominant diff on one of these means local content loss - restore before merging |
| Managed + local section (`.gitignore`) | `.gitignore` | The BEGIN/END REPOSITORY LOCAL section is repo-owned - but it is NOT the sentinel, so the conflict resolver does not move hunks here: a true conflict is resolved with the local side DROPPED and reported in the PR body. Re-add dropped lines inside the LOCAL section yourself |
| Mergeable (three-way) | `.github/settings.yml` (never deleted by sync), `.github/CODEOWNERS`, `.editorconfig` | Local edits merge with template updates. In settings.yml, restore any dropped hunk: a key dropped toward the template is declared empty and the nightly settings heal clears the live value |
| Generated once, then repo-owned (`_skip_if_exists`) | `.github/workflows/checks.yml`, `release.yml`, `auto-format.yml`, `copilot-setup-steps.yml`, `nightly-fuzz.yml`, issue forms and chooser config, `release-please-config.json`, `.release-please-manifest.json`, `.gitleaks.toml`, `.github/actionlint.yaml` | Never touched once they exist. A first-time ADDITION is expected when the same PR's `.repo-platform.yml` diff adds the owning module; a MODIFICATION or DELETION is suspicious - stop and investigate |
| Repo-owned (never touched) | source code, release tooling, `.typography-allow.local`, everything else | The template never renders these paths; they appear only in the retired-file deletion list, and then only if the path was once template-rendered |

Notes:

- `LICENSE.md` carries the fleet license; with the `custom-license`
  module it is the repo's own license and sync never touches it. An
  update that DELETES a license file is flagged in the PR body: content
  below its marker does not survive a delete-vs-modify merge, so check
  the old file for local notices worth moving.
- `CONTRIBUTING.md` is a public-only render: a repo flipped private has
  it retired, local section included.
- The authoritative generated-once list is `_skip_if_exists` in
  repo-platform's `copier.yml`.

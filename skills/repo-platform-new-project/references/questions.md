# Copier questions, module roster, and required labels

The authoritative source is repo-platform's `copier.yml` (the interactive prompt shows exactly the current questions). This walkthrough matches it at the time of writing; if the prompt shows a module not listed here, trust the prompt.

## Base questions

| Question | Meaning | Default |
|---|---|---|
| `project_name` | Human-readable project name | - |
| `project_slug` | Repository / package identifier (kebab-case) | derived from the name |
| `description` | One-line repository description (used in settings.yml) | - |
| `channel` | `latest` (released `templates/vX.Y.Z` tags, migrations run) or `staging` (main HEAD builds, migrations skipped) | `latest` |
| `modules` | Multiselect, any combination (space toggles, enter confirms) | `agents, release-please, issue-templates, pr-title, auto-assign` |
| `private` | Repository visibility; gates CodeQL, dependency-review, CONTRIBUTING.md | `false` |
| `github_username` | Owner of the repository | `Vivswan` |
| `copyright_holder` | Licensor named in the fleet license's Required Notice (skipped with the custom-license module) | `Vivswan Shah (https://github.com/Vivswan)` |

## Module roster

One line each, from the choices descriptions:

- `agents`: AGENTS.md agent instructions, agent-file symlinks, Copilot setup
- `bun`: TypeScript/bun toolchain (gitignore, dependabot, CodeQL JS)
- `node`: JavaScript/Node.js toolchain (gitignore, npm dependabot, CodeQL JS)
- `deno`: Deno toolchain (deno fmt/lint, deno dependabot, CodeQL JS)
- `uv`: Python/uv toolchain (gitignore, dependabot, CodeQL Python)
- `rust`: Rust/cargo toolchain (cargo dependabot, Rust gitignore; no CodeQL)
- `pages`: GitHub Pages deploy (root = latest release, /staging/ = main)
- `release-please`: release job on top of all-green + autorelease labels
- `issue-templates`: bug/feature issue forms
- `skills`: agent skills hosting (plugin manifests, skill validation)
- `pr-title`: Conventional Commit PR title check in the all-green gate
- `auto-assign`: auto-assign issues/PRs/alerts to owner
- `fuzzer`: nightly fuzz starter with issue filing, replay inputs, auto-close
- `nightly`: nightly CI starter with failure issue filing and auto-close
- `settings-sync`: in-repo .github/settings.yml applied with the repo's own PAT
- `custom-license`: repo carries its own license in LICENSE.md; the fleet license is not rendered

`settings-sync` is deliberately not a default: central settings (`settings/repos/<name>.yml` in repo-platform) are the default home.

## Per-module follow-up questions

Asked only when the module is selected.

### settings-sync

| Question | Meaning | Default |
|---|---|---|
| `homepage` | Homepage URL for settings.yml | empty |
| `topics` | Comma-separated GitHub topics for settings.yml | empty |

### pages

| Question | Meaning | Default |
|---|---|---|
| `pages_setup` | Toolchain(s) on the build runner (comma-separated bun/node/deno/uv, or none) | selected toolchain modules, else `none` |
| `pages_install_command` | Install step before each build (empty skips) | per toolchain, e.g. `bun install --frozen-lockfile` |
| `pages_build_command` | The build; must not be empty. `PAGES_BASE_PATH`, `PAGES_ORIGIN`, `PAGES_STAGING` are exported | per toolchain, e.g. `bun run build` |
| `pages_dist_dir` | Build output directory (plain relative path) | `dist` |
| `pages_production` | Root built from `release` (latest tag) or `main` | `release` |
| `pages_staging` | Also publish main HEAD under `/staging/` | `true` |

One-time repo setup afterwards: Settings -> Pages -> Source: GitHub Actions, and add a `v*` tag rule to the `github-pages` environment's deployment branches (release-triggered deploys run on the tag ref and are rejected without it).

### fuzzer

| Question | Meaning | Default |
|---|---|---|
| `fuzzer_label` | Label identifying the nightly-fuzz tracking-issue stream (one open issue per label; plain label characters, max 50) | `fuzz-nightly` |

### nightly

| Question | Meaning | Default |
|---|---|---|
| `nightly_label` | Label identifying the nightly-CI tracking-issue stream (same shape rules as `fuzzer_label`; must differ from it - each stream needs its own label or a green night in one closes the other's open issue) | `nightly-failure` |

### skills

| Question | Meaning | Default |
|---|---|---|
| `skills_dir` | Directory holding the repository's agent skills (plain relative path; baked into the managed validation workflow's trigger paths and action input) | `skills` |

To change a module parameter later, edit that question's VALUE key in `.copier-answers.yml` through a normal default-branch PR - the sync loads recorded values from there, so the edit sticks and the next sync re-renders consistently. Never touch the underscore keys (`_commit`, `_src_path`).

## Required settings labels

Settings applies delete undeclared labels, so the repo's settings file (central or in-repo) must declare every label the repo needs. The settings-sync module's rendered settings.yml declares these automatically; a central `settings/repos/<name>.yml` must carry them by hand. A preflight compares a central file that declares labels against the repo's recorded module selection and fails the apply on a missing required label.

| Needed by | Labels |
|---|---|
| Any repo running dependabot (all toolchain modules do) | `dependencies` (color `0366d6`), `github_actions` (`000000`) |
| bun / node | `javascript` (`168700`) |
| deno | `deno` (`70ffaf`) |
| uv | `python:uv` (`2b67c6`) |
| rust | `rust` (`000000`) |
| release-please | the `autorelease: *` pair, `release-blocker` (`B60205`), `release-override` (`FBCA04`) |
| fuzzer | the `fuzzer_label` answer (default `fuzz-nightly`, `B60205`) |
| nightly | the `nightly_label` answer (default `nightly-failure`, `D93F0B`) |
| private repos declaring labels | `settings-as-code-report` (`0e2a47`) |

Exact descriptions live in repo-platform's `templates/settings-sync/.github/settings.yml.jinja`.

# The registration file: `.repo-platform.yml`

The registration is the only file a repository writes to be managed. The sync and fleet CI read it; the platform rewrites it exactly once, on the cutover of a repository registered the old way (a file holding only `modules`, and possibly `mirrors`, beside `.github/.copier-answers.yml`), when the sync derives the keys below from the recorded answers and holds that PR with a `cutover:` Registration note. Unknown keys, wrong types, and a missing `modules` list are refused by the `plan` job on every PR and by the sync.

## Keys

| Key | Meaning | Default |
|---|---|---|
| `modules` | The selected modules, a list of names from the roster below. Required: an absent key is refused. An empty list is accepted and deselects every module, so the next sync retires their files | - |
| `project.name` | Human-readable project name (`AGENTS.md`, the docs site title, the plugin manifest). `project` is all-or-nothing: `name`, `slug`, and `description` are required together whenever the block is present. Values are substituted into every managed file and split region on each sync; an existing starter keeps its content | the repository name |
| `project.slug` | Kebab-case identifier (the skills plugin name) | the repository name |
| `project.description` | One-line repository description, written into the settings starter | empty |
| `project.copyright_holder` | Licensor named in the fleet license's Required Notice; the one optional `project` key | the repository owner |
| `pages.setup` | Comma-separated toolchain tokens the Pages build installs (`bun`, `uv`, ...), or `none` | the selected toolchain modules, joined by commas; `none` when no toolchain is selected |
| `pages.install` | Install command of the Pages build | the install command of the first `pages.setup` toolchain in roster order; empty with `none` |
| `pages.build` | Build command of the Pages build; must be nonempty when `pages` is selected | the build command of the first `pages.setup` toolchain in roster order; empty with `none`, so the key is mandatory then unless a surviving answers file records `pages_build_command` |
| `pages.dist` | Directory the build writes, relative to the repo root | `dist` |
| `docs_site.path` | URL segment the docs mount at when `pages` is also selected | `docs` |
| `docs_site.include` | Extra source roots rendered into the docs site: `{path, mount, page?}` each, `page` naming the file that is a page (a skills tree uses `SKILL.md`) | none |
| `skills.dir` | The directory holding the repository's agent skills | `skills` |
| `labels.fuzzer` | The fuzzer module's tracking-issue label | `fuzz-nightly` |
| `labels.nightly` | The nightly module's tracking-issue label | `nightly-failure` |
| `labels.docs_site` | The docs-site link-rot tracking label | `docs-link-rot` |
| `mirrors` | `{source, targets}` entries copying a file the sync wrote to other paths; single-segment `*` globs | none |

Shapes the schema pins: `project.slug` is kebab-case; `docs_site.path` and every `mount` are one lowercase URL segment; `pages.dist`, `skills.dir`, and every `include.path` are relative paths with no `..`; a label is plain text of at most 50 characters not starting with a dash.

## Module roster

One line each, generated from the module manifests:<!-- BEGIN GENERATED: module-roster (scripts/generate.ts - edit module.yml manifests, not this block) -->

- `bun`: TypeScript/bun toolchain (gitignore, dependabot, CodeQL JS)
- `node`: JavaScript/Node.js toolchain (gitignore, npm dependabot, CodeQL JS)
- `deno`: Deno toolchain (deno fmt/lint, deno dependabot, CodeQL JS)
- `uv`: Python/uv toolchain (gitignore, dependabot, CodeQL Python)
- `rust`: Rust/cargo toolchain (cargo dependabot, Rust gitignore; no CodeQL)
- `pages`: GitHub Pages deploy of the repo's own build (root = newest served version tag, /latest/ = main)
- `docs-site`: VitePress docs site from docs/ under the central fleet theme (repos carry only markdown)
- `release-please`: release-please releases through the fleet's release pipeline, plus autorelease labels
- `issue-templates`: bug/feature issue forms
- `skills`: agent skills hosting (plugin manifests, skill validation)
- `pr-title`: Conventional Commit PR title check, its own required workflow
- `fuzzer`: nightly fuzz starter with issue filing, replay inputs, auto-close
- `nightly`: nightly CI starter with failure issue filing and auto-close
- `custom-license`: repo carries its own license in LICENSE.md; the fleet license is not rendered<!-- END GENERATED: module-roster -->

The files each module brings are listed in the `repo-platform-add-module` skill and in repo-platform's `files.yml`.

## Labels and streams

- `fuzzer`, `nightly`, and `docs-site` each file one tracking issue per failure stream and dedup and auto-close by label. When several are selected, their labels must differ (case-insensitively).
- The fuzzer and nightly starters hard-code the default label in their `label:` inputs. A custom `labels.*` value needs the same edit in the repo-owned starter.
- The settings apply declares each module's default label, but it reads the tracking labels of `fuzzer`, `nightly`, and `docs-site` from the retired `.github/.copier-answers.yml` and fails for a repo that selects one of them without that file. Declare those labels in the repo's own `.github/settings.yml`; a custom `labels.*` value is never read by the apply.
- A repo that still carries that answers file must not contradict it: when both the registration and the answers file hold a value for the same setting and the values differ, the plan fails (`the two must agree while both exist`). Each setting is checked where the plan resolves it: `labels.*` (`nightly_label`, `fuzzer_label`, `docs_site_label`) and `skills.dir` by the `plan` job on every PR; `pages.*`, `docs_site.path`, and `project.name` (with `docs-site` selected) when the pages or docs-site leg plans the site. A setting present in only one of the two files is simply read from there.
- A `labels.<key>` whose module is not selected fails the plan (`labels.nightly names no selected tracking stream`): remove the key together with the module.

## Visibility

Visibility is read from GitHub, not from this file. Public repositories get CodeQL and dependency-review jobs and the public settings starter; private ones do not.

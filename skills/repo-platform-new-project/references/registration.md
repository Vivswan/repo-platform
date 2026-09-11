# The registration file: `.repo-platform.yml`

The registration is the only file a repository writes to be managed. The sync and fleet CI read it; the platform rewrites it exactly once, on the cutover of a repository registered the old way (a file holding only `modules`, and possibly `mirrors`, beside `.github/.copier-answers.yml`), when the sync derives the keys below from the recorded answers and holds that PR with a `cutover:` Registration note. Unknown keys, wrong types, and a missing `modules` list are refused by the `plan` job on every PR and by the sync.

## Keys

| Key | Meaning | Default |
|---|---|---|
| `modules` | The selected modules, a list of names from the roster below. Required: an absent key is refused. An empty list is accepted and deselects every module, so the next sync retires their files | - |
| `project.name` | Human-readable project name (`AGENTS.md`, the docs site title, the plugin manifest). `project` is all-or-nothing: `name`, `slug`, and `description` are required together whenever the block is present. Values are substituted into every managed file and split region on each sync; an existing starter keeps its content | the repository name |
| `project.slug` | Kebab-case identifier (the skills plugin name) | the repository name |
| `project.description` | One-line repository description, written into the settings overlay starter (`.github/settings.local.yml`); while it is empty the writer holds that starter (`no value for {{description}}`) and the rendered `.github/settings.yml` with it (`no overlay at .github/settings.local.yml (its starter is held or missing)`), and the PR waits | empty |
| `project.copyright_holder` | Licensor named in the fleet license's Required Notice; the one optional `project` key | the repository owner |
| `site.path` | URL segment the docs mount at when the repo-owned site-build hook also builds a website | `docs` |
| `site.include` | Extra source roots rendered into the docs site: `{path, mount, page?}` each, `page` naming the file that is a page (a skills tree uses `SKILL.md`) | none |
| `skills.dir` | The directory holding the repository's agent skills | `skills` |
| `labels.fuzzer` | The fuzzer module's tracking-issue label | `fuzz-nightly` |
| `labels.nightly` | The nightly module's tracking-issue label | `nightly-failure` |
| `labels.site` | The site module's link-rot tracking label | `docs-link-rot` |
| `mirrors` | `{source, targets}` entries copying a `managed` or `split` file the sync writes here to other paths; single-segment `*` globs. The `plan` job rejects a target that nests with another, with a path the sync writes or retires, or under `.github/workflows/` | none |

Shapes the schema pins: `project.slug` is kebab-case; `site.path` and every `mount` are one lowercase URL segment; `skills.dir` and every `include.path` are relative paths with no `..`; a label is plain text of at most 50 characters not starting with a dash.

## Module roster

One line each, the `description` of each module in repo-platform's `files.yml`:

- `bun`: TypeScript/bun toolchain (gitignore, dependabot, CodeQL JS)
- `node`: JavaScript/Node.js toolchain (gitignore, npm dependabot, CodeQL JS)
- `deno`: Deno toolchain (deno fmt/lint, deno dependabot, CodeQL JS)
- `uv`: Python/uv toolchain (gitignore, dependabot, CodeQL Python)
- `rust`: Rust/cargo toolchain (cargo dependabot, Rust gitignore; no CodeQL)
- `site`: one GitHub Pages site per repository (the repo-owned site-build hook's website at the root, docs/ rendered under the central fleet theme)
- `release-please`: release-please releases through the fleet's release pipeline, plus autorelease labels
- `issue-templates`: bug/feature issue forms (served by the account's .github repository; no files here)
- `skills`: agent skills hosting (plugin manifests, skill validation)
- `pr-title`: Conventional Commit PR title check, its own required workflow
- `fuzzer`: nightly fuzz starter with issue filing, replay inputs, auto-close
- `nightly`: nightly CI starter with failure issue filing and auto-close
- `custom-license`: repo carries its own license in LICENSE.md; the fleet license is not written

The files each module brings are listed in the `repo-platform-add-module` skill and in repo-platform's `files.yml`.

## Labels and streams

- `fuzzer`, `nightly`, and `site` each file one tracking issue per failure stream and dedup and auto-close by label. When several are selected, their labels must differ (case-insensitively).
- The fuzzer and nightly starters carry the label in their `label:` inputs as it was when the starter was first written (`labels.*` or the default). A later change to `labels.*` needs the same edit in the repo-owned starter.
- The sync renders the tracking labels of `fuzzer`, `nightly`, and `site` from `labels.*` (the module's default when a key is unset) into the managed `.github/settings.yml`, and the settings apply declares them; the same keys reach the starters' `label:` inputs when they are first written, and the plan's `tracking-labels` output feeds release-health's gate.
- A `labels.<key>` whose module is not selected fails the plan (`labels.nightly names no selected tracking stream`): remove the key together with the module.

## Visibility

Visibility is read from GitHub, not from this file. Public repositories get CodeQL and dependency-review jobs and the public variant of the settings overlay starter; private ones do not. The starter seeds `repository.private` from that reading, and from then on the rendered `.github/settings.yml` follows the value your `.github/settings.local.yml` declares.

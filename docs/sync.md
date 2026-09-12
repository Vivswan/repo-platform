---
order: 232
group: Fleet operations
---

# Sync writer

The sync writer copies the platform's files into a managed repository. It reads one data file, `files.yml`, and one tree of plain files, `files/`. There is no template language and no merge: managed content is copied whole, split regions are copied between the repository-owned halves, starters are copied once, and links are relative symlinks the writer places and repairs. The one file the writer renders instead of copying is `.github/settings.yml`, folded from the settings layers and the repository's own overlay ([settings.md](settings.md)). Code is the source of truth; this page is the map.

| Question | Owner |
| --- | --- |
| What does `files.yml` look like, and what does the loader refuse? | [actions/plan/files_config.ts](../actions/plan/files_config.ts), the grammar every reader shares (the writer, the fleet plan, the checks); the writer's own checks against the `files/` tree and the placeholder defaults are in [sync/writer/files_config.ts](../.github/scripts/sync/writer/files_config.ts) |
| Which placeholder tokens exist? | `PLACEHOLDER_NAMES` in [sync/writer/placeholders.ts](../.github/scripts/sync/writer/placeholders.ts) |
| How are the values derived from `.repo-platform.yml`? | [sync/writer/registration.ts](../.github/scripts/sync/writer/registration.ts) |
| Which entries apply to one repository? | `applies` and `selectEntries` in [actions/plan/files_config.ts](../actions/plan/files_config.ts) |
| How is each class written? | [sync/writer/write_managed.ts](../.github/scripts/sync/writer/write_managed.ts), [write_split.ts](../.github/scripts/sync/writer/write_split.ts), [write_starter.ts](../.github/scripts/sync/writer/write_starter.ts), [write_link.ts](../.github/scripts/sync/writer/write_link.ts) |
| Where do blocks land, and what may a value contain? | `spliceBlocks` and `substitute` in [sync/writer/placeholders.ts](../.github/scripts/sync/writer/placeholders.ts) |
| What happens when an entry's class differs from its record? | `writeEntry` in [sync/writer/sync.ts](../.github/scripts/sync/writer/sync.ts) |
| How is `.github/settings.yml` rendered? | [sync/writer/settings_entry.ts](../.github/scripts/sync/writer/settings_entry.ts) over [settings_layers.ts](../.github/scripts/sync/writer/settings_layers.ts) and [merge_settings_layers.ts](../.github/scripts/sync/writer/merge_settings_layers.ts) ([settings.md](settings.md)) |
| When does a retired file leave? | [sync/writer/retire.ts](../.github/scripts/sync/writer/retire.ts) |
| What does the manifest record? | [sync/writer/manifest.ts](../.github/scripts/sync/writer/manifest.ts) |
| What holds a PR for review? | `holdReasons` in [sync/writer/report.ts](../.github/scripts/sync/writer/report.ts) |
| The whole run, as a CLI | [sync/writer/sync.ts](../.github/scripts/sync/writer/sync.ts) |

## The command

```text
bun .github/scripts/sync/writer/sync.ts \
  --files files.yml --tree files \
  --target <checkout> --build <full sha> \
  --repository <owner/name> --private <true|false> \
  [--previous-files <files.yml of the build being replaced>] \
  [--summary <path for the JSON summary>]
```

- `--tree` is the `files/` directory itself; every `source` in `files.yml` starts with `files/` and resolves under it.
- `--build` is the build commit's full sha, 40 lowercase hex characters (`git rev-parse origin/build`), stamped into the manifest's `commit` field, which the fleet validator reads as a full sha; a short or uppercase one is refused before anything is written.
- `--repository` names the GitHub repository; the owner is the `github_username` placeholder and the name is the fallback project name and slug.
- `--previous-files` turns on the retirement check (below).
- The Markdown report goes to stdout. The JSON summary carries the same rows plus `hold` and `holdReasons`.
- Exit 0 whether or not the report holds the PR. A nonzero exit is a data or environment error: a `--build` that is not a full sha, a bad `files.yml`, an unreadable registration, a symlinked ancestor at a path the writer touches, a directory or a symlink at the manifest or registration path, a directory at a retired path or at a `moved_to` destination, a split file whose marker text is duplicated or buried mid-line, a placeholder value carrying a double quote, backslash, or control character, a mirror declaration the writer cannot honour ([Mirrors](#mirrors)).

## files.yml

```yaml
placeholders: [project_name, project_slug, description, github_username, github_username_lower, copyright_holder, year, fuzzer_label]
modules:
  bun: {codeql_language: javascript-typescript, gitignore_sources: [Node, Bun], dependabot_ecosystems: [bun], settings_layers: [settings.yml, settings-public.yml]}
  fuzzer: {tracking_label: {key: fuzzer, default: fuzz-nightly, color: B60205, description: Automated nightly fuzz failure}}
  release-please: {}
settings:
  baseline: files/settings/baseline.yml
  public: files/settings/public.yml
  private: files/settings/private.yml
  override: files/settings/override.yml
files:
  - {path: .github/workflows/ci.yml, class: managed}
  - {path: .gitignore, class: split, region: hash, blocks: gitignore_sources}
  - {path: .github/dependabot.yml, class: managed, blocks: dependabot_ecosystems}
  - {path: .github/settings.local.yml, class: starter, when: {private: false}}
  - {path: .github/settings.local.yml, class: starter, when: {private: true}, source: files/base/.github/settings.local.private.yml}
  - {path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.local.yml}
  - {path: CLAUDE.md, class: link, target: AGENTS.md}
  - {path: .github/agents.md, class: link, target: ../AGENTS.md}
  - {path: .typography-allow, class: managed, when: {without: [release-please]}}
  - {path: .typography-allow, class: managed, when: {modules: [release-please]}}
  - {path: .github/actions/site-build/action.yml, class: starter}
  - {path: .github/workflows/nightly-fuzz.yml, class: starter, when: {modules: [fuzzer]}}
retired:
  - {path: CONTRIBUTING.md}
  - {path: SECURITY.md, moved_to: .github/SECURITY.md}
```

| Key | Meaning |
| --- | --- |
| `placeholders` | The placeholder names sources may use, each spelled as the name inside double braces. Each must be one the writer derives (`PLACEHOLDER_NAMES`). |
| `modules.<name>` | A module and its data; the keys ARE the module roster, in the order the writer selects and the fleet plan lists. Any key is allowed; `blocks` entries name one of these keys. One key carries a placeholder default: `tracking_label: {key, default, ...}` backs the `<key>_label` placeholder (below). |
| `files[].path` | The repository-relative path written. Clean paths only: no `..`, no empty segment, no `.git`. |
| `files[].class` | `managed`, `split`, `starter`, or `link` (below). |
| `files[].source` | The source file, under `files/`. Default: `files/<first when.modules entry, or base>/<path>`. Not for links. |
| `files[].when` | The selection condition (below). Absent or empty means always. |
| `files[].region` | Split entries only: `hash` for `#` comment markers, `html` for `<!-- -->` markers. |
| `files[].blocks` | Managed, split, and starter entries: a module-data key. For each selected module carrying it, in `modules` order, each listed value names the block file `files/<module>/<path with .block.<value> between its stem and its extension>` (`.github/dependabot.block.bun.yml`; an extension-only dotfile keeps its suffix: `.block.Node.gitignore`), so every tool parses a block file by its real extension. Byte-identical block files land once, from the first selected module declaring them (a gitignore source two toolchains share); files that differ are each their module's own block even under one value name (each toolchain's `AGENTS.md` bullets). |
| `files[].target` | Link entries only: the symlink target, relative to the link's own directory (`../AGENTS.md` from `.github/`). It must resolve to a clean repository path other than the link itself. |
| `files[].render` | Managed entries only, one value: `settings`. The entry has no source; the writer renders the settings document from the `settings` layers, the selected modules' `settings_layers` files, and the repository's overlay at `overlay` ([settings.md](settings.md)). |
| `files[].overlay` | Rendered entries only, required: the repository-owned file the render folds in (`.github/settings.local.yml`). The path must be written by starter entries only, listed before this entry, and selected exactly when this entry is. |
| `settings.baseline`, `settings.public`, `settings.private`, `settings.override` | The four fleet settings layers, clean paths under `files/`; present exactly when a `render: settings` entry exists. |
| `retired[].path` | A path the platform no longer writes. The entry leaves the roster only after a live probe (`gh api repos/<owner>/<repo>/contents/<path>` over every fleet repository) shows that no repository carries the path. |
| `retired[].moved_to` | The path the file moves to (`git mv`) when that path is absent. |

Blocks land at the anchor line: the word `blocks` inside double braces, alone on its line, spelled like a placeholder. A source without one gets them appended at the end. Every piece is newline-terminated first, so the seams never merge two lines. The anchor appears at most once and only as a whole line, in sources of entries that declare `blocks` (for a split entry, inside the region body). A starter's blocks are rendered once, at creation.

The loader refuses, all problems at once:

- a placeholder the writer cannot derive, or a source file using a token outside `placeholders`
- a `when` naming a module absent from `modules`
- a `split` without `region`; `region` on a non-split entry; `target` on a non-link entry; a link with a `source` or `blocks`, without a `target`, or with a target that is absolute, leaves the repository, or is the link itself
- a `source` outside `files/`, or one missing from the tree (block files included)
- a `blocks` anchor mentioned twice or mid-line, in a source whose entries do not all declare `blocks`, or inside a block file
- a listed `<key>_label` placeholder no module declares a default for; a default declared by two modules; a `tracking_label` without `key` and `default`, or without `color` and `description` while the data file renders settings
- `render` on an entry that is not managed; `overlay` on an entry that is not rendered; a rendered entry with a `source` or `blocks`, or without `overlay`
- an `overlay` path that is not clean, is the entry's own path, a retired path, or the manifest; one that any non-starter entry writes or no entry writes; overlay starters listed after the rendered entry; overlay starters not selected exactly when the rendered entry is (an unconditional rendered entry needs one unconditional starter or a `private: true` / `private: false` pair; a conditional one a starter with the same `when`)
- a `settings` block missing while a `render: settings` entry exists, or present with none; a layer path that is not a clean path under `files/`
- a declared settings layer missing from the tree, not a YAML mapping, or naming one label (case-insensitively) or one ruleset twice; a `settings.yml`, `settings-public.yml`, or `settings-private.yml` in a module directory that its `settings_layers` does not declare
- two entries for one `path` whose conditions can both hold (below)
- a path listed under both `files` and `retired`
- a `files` entry at `.github/repo-platform-manifest.json`, the manifest the writer itself writes last
- with `--previous-files`: a path the previous `files.yml` wrote that the current one neither writes nor retires, starters excepted (a written starter is repo-owned, so a dropped one needs no retirement; a retired entry may leave, the probe above being its gate)

## files.yml reference

What the committed `files.yml` uses today, so a reader knows which forms are live. The loader accepts more (above); the file table itself is in [new-repo.md](new-repo.md#what-the-sync-writes), generated by `scripts/files_table.ts`.

| Entry class | Used for |
| --- | --- |
| `managed` | the workflows the fleet runs unchanged (`ci.yml`, `auto-assign.yml`, the module workflows), `.github/dependabot.yml`, `.yamllint`, `.typography-allow`, the review instructions, the toolchain pin files, and the rendered `.github/settings.yml` (`render: settings`, over the `.github/settings.local.yml` overlay starter) |
| `split` (region `hash`) | `.editorconfig`, `.gitattributes`, `.gitignore`, `.github/CODEOWNERS` |
| `split` (region `html`) | `AGENTS.md`, `LICENSE.md` |
| `starter` | `checks.yml`, `post-green.yml`, the release hooks, the site-build hook (`.github/actions/site-build/action.yml`), `auto-format.yml`, `copilot-setup-steps.yml`, `.gitleaks.toml`, `.github/actionlint.yaml`, `.github/settings.local.yml`, the release-please, skills, fuzzer, and nightly starters |
| `link` | `CLAUDE.md` (to `AGENTS.md`), `.github/agents.md` and `.github/copilot-instructions.md` (to `../AGENTS.md`) |

| `when` form | Used by |
| --- | --- |
| `modules: [x]` | every module-owned file |
| `any: [...]` | `auto-format.yml` and the CodeQL variant of `auto-assign.yml` (any toolchain with a formatter), the Toolchain variant of `AGENTS.md` (any toolchain) |
| `without: [...]` | `LICENSE.md` (not `custom-license`), the plain variants of `.typography-allow`, `AGENTS.md`, and `auto-assign.yml` |
| `private: true` / `false` | the two `.github/settings.local.yml` starters, the `auto-assign.yml` variants (code scanning exists on public repositories only) |

The three links carry no `when`: every repository gets them.

| `blocks` key | Entry | Block files |
| --- | --- | --- |
| `gitignore_sources` | `.gitignore` (split) | `files/<module>/.block.<Source>.gitignore`, one github/gitignore template or platform-authored section (`PLATFORM_SECTIONS` in `scripts/generate/build_gitignore.ts`, the fuzzer's failure directory) each, written by that script together with `files/base/.gitignore`; the Node source two toolchains declare is byte-identical in each, so it lands once |
| `dependabot_ecosystems` | `.github/dependabot.yml` (managed) | `files/<module>/.github/dependabot.block.<ecosystem>.yml`, appended at the anchor line that ends the source |
| `agents_toolchain` | `AGENTS.md` (Toolchain variant, split) | `files/<module>/AGENTS.block.toolchain.md`, the module's Toolchain bullets, appended after the region body |
| `toolchain_steps` | `checks.yml`, `copilot-setup-steps.yml`, `auto-format.yml` (starters) | `files/<module>/.github/workflows/<stem>.block.toolchain.yml`: the example checks, the setup and install steps, the setup and format steps; each block opens with the blank line that separates it from the step above, and the anchor sits after the checkout step (`copilot-setup-steps.yml` ends there; `checks.yml` and `auto-format.yml` keep one blank line below it before their closing steps) |

| Module data key | Meaning | Reader |
| --- | --- | --- |
| `description` | the module's one-line description | docs and the PR body |
| `codeql_language` | the CodeQL language the toolchain contributes | the fleet plan |
| `pin` | `{file, version}` of the toolchain's version dotfile: `bun run pins` writes `files/<module>/<file>` from it (and the `.bun-version` copies beside the actions and at this repository's root), and the toolchain refresh bumps it | the pin writer and the toolchain refresh |
| `dependabot_ecosystems` | the Dependabot ecosystems the module adds (also its `blocks` list) | the writer |
| `dependabot_label` | `{name, color}` of the label its Dependabot PRs carry | the `dependabot-label-tuples` rule in `scripts/check/ssot/labels.ts`, which pins it equal to the label in `files/<module>/settings.yml` (the layer the applied roster comes from) |
| `gitignore_sources` | the github/gitignore templates and platform-authored sections the module adds (its `blocks` list) | the writer |
| `agents_toolchain` | the AGENTS.md block list (`[toolchain]`) | the writer |
| `toolchain_steps` | the block list (`[toolchain]`) of the three starter workflows that carry per-toolchain steps | the writer |
| `path` | the `site` module only: the URL segment the docs mount under when the repository's site-build hook also builds a website, unless the registration sets `site.path` | the fleet plan |
| `settings_layers` | the settings layer files the module contributes (`settings.yml`, `settings-public.yml`, `settings-private.yml`), read from `files/<module>/` | the writer's settings render |
| `tracking_label` | `{key, default, color, description}` of the module's tracking-issue label; `key` is the registration's `labels` key and `default` backs the `<key>_label` placeholder; `color` and `description` are the tuple the render writes the label with | the fleet plan, the writer's settings render, and the placeholder defaults |

Placeholders in use beyond the project block: `fuzzer_label` in `nightly-fuzz.yml`, `nightly_label` in `nightly.yml`. No committed source names `site_label`: the site leg does not pass the link-rot label (the plan action resolves it from the registration), so it is not listed.

A module with no files still appears under `modules` (`custom-license`) so a registration selecting it is known and a `when` can name it.

## Placeholders

| Name | Value |
| --- | --- |
| `project_name` | `project.name` from the registration, else the repository name |
| `project_slug` | `project.slug`, else the repository name |
| `description` | `project.description`, else empty |
| `github_username` | the repository owner |
| `github_username_lower` | the owner, lower-cased |
| `copyright_holder` | `project.copyright_holder`, else the owner |
| `year` | the current UTC year |
| `fuzzer_label`, `nightly_label`, `site_label` | `labels.<key>` from the registration, else the `default` of the `modules.<m>.tracking_label` whose `key` is `fuzzer`, `nightly`, or `site` |

- A token is the name inside double braces with no spaces; spaces inside the braces make it plain text.
- A `$` before the braces marks a GitHub Actions expression, left untouched.
- Substitution runs on source files only. A literal double brace in a repository-owned tail is never touched.
- A value lands inside quoted YAML scalars verbatim, so a value carrying a double quote, a backslash, or a control character is refused twice: the registration grammar (`actions/plan/registration.ts`) rejects such a `project.name`, `project.description`, or `project.copyright_holder`, and `substitute` fails the run on any such value.
- An absent or empty value is never written: an entry whose text needs it is `held` with `no value for <token>`, a Registration note names the registration key to set, and the PR holds. A registration carrying only `modules:` (no `project:` block) holds every entry that uses `description`.

## Selection

| Clause | Holds when |
| --- | --- |
| `modules: [a, b]` | every listed module is selected |
| `any: [a, b]` | at least one listed module is selected |
| `without: [a]` | none of the listed modules is selected |
| `private: true` | the repository's visibility matches |

- The selected modules are the registration's `modules` filtered to the names `files.yml` knows, in `files.yml` order. Unknown names are dropped and listed under Registration notes, which holds the PR.
- Two entries for one path must be provably exclusive: a module one requires and the other forbids, an `any` list the other forbids entirely, or opposite `private` values. Anything subtler is a loader error.

## Classes

| Class | Written | Existing local content | Manifest record |
| --- | --- | --- | --- |
| `managed` | whole file, every sync; a `render: settings` entry writes the rendered settings document instead of a copy | replaced and reported (`replaced local edits`, with a diff), holds the PR | `hash` = sha256 of the file |
| `split` | the marker-bounded region, every sync | everything above BEGIN and below END is kept; a file that never mentions the markers gets the region above its content and the verdict `region added`, which holds the PR; marker text duplicated or buried mid-line fails the run | `hash` = sha256 of the region, marker lines included |
| `starter` | once, when the path is absent (a link there counts as present) | never touched again | no hash |
| `link` | a relative symlink, every sync | a link elsewhere is re-pointed and reported like a local edit (the old target is the replaced text); a regular file at the path is held | `hash` = sha256 of the target string |

Change verdicts per written row: `created` (absent before), `updated` (was exactly the recorded content), `unchanged` (already the new content), `replaced local edits` (was neither), `region added` (a split region placed above repository-owned content), `held` (not written; the Detail column says why). A managed or split entry finding a symlink at its path is held: the writer never reads through a link and has no record of writing one there. An entry of any class finding a directory (or anything else that is neither a file nor a link) at its path is held with `<what> sits at the path, and the writer will not replace it`. A rendered entry whose overlay path holds anything but a regular file is held too, with the detail naming what sits there. A rendered entry is also held when its overlay is missing, does not parse, names one label twice, or when the registration's tracking labels are refused ([settings.md](settings.md)).

## Class flips

A path recorded under one writer class (`managed`, `split`, `starter`, `mirror`, `link`) that `files.yml` now declares under another is a class flip. The recorded content is the platform's own previous write, so:

| State | Outcome |
| --- | --- |
| the path already holds exactly what the entry writes | `unchanged`; the record takes the new class |
| what sits there is the recorded write (same rule as retirement: whole-file hash, clean region with nothing outside it, or link target) | removed and written whole under the new class: `updated` |
| anything else, a `starter` record or a record without a hash included | `held` with `class changed from <old> to <new>, and <reason>`; the file and its previous record stay, and no mirror copies the file |
| the new class is `starter` | a handover: the file is the repository's own, nothing is held |

Without the rule, a managed file that becomes split would have the region prepended above its old content and report `updated`.

## Retirement

Retirement runs before writing. Rows appear only for files present. A `moved_to` whose destination is written for this repository is moved or held whatever the record says; every other retirement of an unrecorded file produces no row, since the platform never wrote it and it is not its to retire.

| State of the retired file | Outcome |
| --- | --- |
| `managed` or `mirror`, content equals the recorded hash | `deleted` |
| `split`, region equals the recorded hash, nothing outside the region | `deleted` |
| `split`, region equals the recorded hash, repository-owned content outside it | `region removed`: the marker lines and the region go, the content above and below stays byte for byte as a plain file, and the record leaves; the blank lines that framed the region become one when content stands on both sides and none when it stands on one side only, so a tail under a top region starts at its first content line, and blank lines away from the seam stay. The PR holds this once, with a detail asking the reader to complete the file (a heading and intro if it lost them) or delete it. Next run the path is unrecorded and produces no row. |
| `split`, region equals the recorded hash, only blank lines outside it | `deleted`, with the detail saying so |
| `split`, region differs from the recorded hash, or markers missing or malformed | `held` |
| `link`, a symlink whose target hashes to the recorded hash | `deleted` (the link goes; what it points at is never touched) |
| a symlink with another target; a regular file where a `link` was recorded; a symlink where a `managed`, `split`, or `mirror` was recorded | `held` |
| content differs, or a record without a hash | `held` |
| recorded as `starter` | `kept` (repo-owned) |
| `moved_to` given, new path absent | `moved` (`git mv`; the record travels, so the following write of the new path judges it as the platform's own) |
| `moved_to` given, new path present | `held` |
| `moved_to` given, new path not written for this repository (its entry is unselected) | treated as a plain retirement: the outcomes above apply |

A recorded `managed`, `split`, or `link` path that no selected entry writes and no `retired` entry names (a module was deselected) is retired the same way, with the detail `no longer selected`; a recorded path that is not a clean repository path is ignored and noted. A held or kept file and a held entry keep their records in the new manifest every run (a record without a hash is carried as such), so the file is held again next time and never becomes an unrecorded orphan; a record whose class the writer does not know is dropped with a note, and so is a `mirror` record no declaration reaches any more (the copy stays as the repository's own; a mirror declared again adopts it while it still holds the source's content). A repository-owned tail left in a retired `CONTRIBUTING.md` or `.github/SECURITY.md` hides the account default, so the PR's reviewer deletes or completes it before merging, in one commit on the sync branch ([the sync-pr skill](../skills/repo-platform-sync-pr/SKILL.md#repository-owned-markdown-after-a-retirement)).

## Mirrors

The registration's `mirrors` list (`source`, `targets`) copies a file this sync wrote to each target. Single-segment `*` globs: a `*` directory segment matches directories, a final `*` matches existing files, a literal final segment lands in every matched directory. Literal targets are written before any glob expands, so a directory a literal creates is matched in the same run; a target a literal claims stays the literal's. A glob never creates a directory. A symbolic link a glob meets is never skipped and never listed through: a linked file, a linked directory, or a link that cannot be looked through (resolving to nothing, to a name too long, or through a directory the runner may not read) fails the run by name, the rest of the pattern riding along (`skills/link/sub/*.md`); only a link that provably resolves to a file in a directory segment is no directory and is passed over like a file. A matched path the grammar refuses (one grown past 1024 bytes through long directory names) is never probed either and fails by name the same way.

A copy the writer cannot make would leave the repository out of sync with only a hold row to show it, so every declaration is either written or fails the run. Two readers judge it. The `plan` job of fleet CI rejects, on the PR that introduces it, what `files.yml` alone proves unwritable (the rules in [actions/plan/mirrors.ts](../actions/plan/mirrors.ts)): a source that is not a `managed` or `split` file `files.yml` writes for the repository; a `**`; a target or pattern that is unsafe (a control character, a segment over 255 bytes, or a path over 1024 bytes included), is or sits under the registration itself, sits under `.github/workflows/`, or is, sits under, or is a path prefix of a path `files.yml` writes or retires; a literal target declared twice or nested with another (both sides, whatever their sources); a pattern whose literal prefix is a literal target; a pattern that matches (segment for segment, as the writer expands it) the registration, a path `files.yml` writes or retires (the claim reserves the path, whether or not the file stands in the checkout that run), or another source's literal target. The writer runs the same check, with the stale manifest records it retires as a further reserved set (`a path a stale manifest record retires`), and adds what only the checkout shows. A failure exits nonzero, one `::error::` line per declaration (`.repo-platform.yml: mirrors: source '<s>', target '<t>': <reason>`), before the pass writes anything: no PR is opened, the operator's row reads `failed, report filed in the target repository`, and the failure issue's writer log carries the lines.

| Outcome | When |
| --- | --- |
| `written` | the target was absent, or held exactly the previous mirror (the hash of its `mirror` record; a record of another class does not vouch for the bytes) |
| `current` | the target already holds the new content |
| `replaced local edits` | the target held other content; the diff is in the Replaced local edits section and holds the PR |
| `replaced` | a directory stood at the target (removed whole, the links inside unlinked and never followed) or a file stood where an ancestor directory must be (removed); the detail names which, and holds the PR |
| the run fails | the source was held this run; the pattern matches nothing, or reads through a symbolic link or a file in its literal prefix; a matched path is unsafe, nests with a path `files.yml` writes or retires or a stale record retires, sits under a symbolic link, is a symbolic link, or (a glob's) sits under a file or has no existing directory; a path is a prefix of or sits under another target (both sides; a target an earlier pass settled included); a path is claimed by more than one source. Every path of a pass is judged before the pass writes |

Every row's target is recorded as class `mirror` with the copy's hash, so the next sync can tell its own previous write from a local edit ([docs/new-repo.md](new-repo.md#mirror-copies-of-platform-files)).

## The manifest

`.github/repo-platform-manifest.json`, the layout `actions/shared/manifest.ts` already parses: one entry per line, sorted by path. The manifest's own entry carries the build sha in `commit` (`null` before the first sync, else the build's full sha) and no hash. That entry is the one record of the build commit: `validate-managed-files` judges its shape in place ([manifest_shape.ts](../actions/validate-managed-files/validator/checks/manifest_shape.ts)), and nothing fetches the build branch to learn it. Classes recorded: `managed`, `split` (with `grammar`, `begin`, `end`), `starter`, `mirror`, `link` (hash of the target string). The record is how the next sync tells the platform's own previous write from a local edit, for replacement and for retirement.

## The report

| Section | Content |
| --- | --- |
| header | Build, Modules, Visibility |
| Written | path, class, change, detail for every selected entry (detail is the reason of a `held` row) |
| Replaced local edits | one unified diff per replaced file, capped at 40 lines |
| Retired | path, outcome, detail |
| Registration notes | dropped unknown modules; an unparsable manifest; a placeholder with no value and the key that sets it; a manifest record the writer cannot carry; a mirror record no declaration reaches |
| Mirrors | source, target, outcome, detail |
| Review | `Hold for review: yes` with the reasons, or `no` |

`hold` is true on any held or `region added` written row, any replaced local edit (a mirror's included), any held or `region removed` retirement, any `replaced` mirror, or any registration note. Table cells escape `|`, so a path or detail carrying one keeps the columns. Every cell, note, and code-formatted value (the replaced-file headings included) is printed on one line: a newline inside a registration value or a manifest path (the writer copies both into the report verbatim) cannot end the row and start a heading of its own. A replaced diff sits in a fence one backtick longer than any backtick run its lines open with, so the target's own content cannot close it.

The PR body stays under GitHub's 65,536-character limit (`BODY_CAP` in [sync/deliver.ts](../.github/scripts/sync/deliver.ts)): the header and the Review section take their room first, then the tables and notes, then the replaced-edit diffs; a section the room runs out on ends in a warning naming how many characters were cut, and one with no room left is dropped.

## The operator

[sync-repos.yml](../.github/workflows/sync-repos.yml) runs the writer against every managed repository: a `plan` job, then one `sync (row <i>)` job per row. It wakes on the Tuesday cron (the weekly heal), on a dispatch, or as the called leg of a merge's post-green run ([all-green.md](all-green.md#after-the-gate)). The job shape is the redaction: the public log carries row indexes and the vocabulary below, nothing else, and every detail lands in the target repository ([private repositories](#private-repositories)).

| Step | Script | What it does |
| --- | --- | --- |
| plan: resolve the build | [sync/resolve_build.ts](../.github/scripts/sync/resolve_build.ts) | the build tip, proven the builder's output of a green main commit ([build-provenance.md](build-provenance.md)) and carrying `files.yml`; every row checks out exactly this commit |
| plan: discover and select | [fleet/discover_repos.ts](../.github/scripts/fleet/discover_repos.ts), [fleet/select_sync_repos.ts](../.github/scripts/fleet/select_sync_repos.ts) | the rows: the repositories the fleet token can push to that have adopted the platform (this repository excepted), narrowed by the dispatch `repo` input or the called `repos` scope ([fleet/sync_scope.ts](../.github/scripts/fleet/sync_scope.ts)), written sorted to `$RUNNER_TEMP/rows.json`, and the matrix: one `{row, key}` per row, the key an HMAC of the slug under the fleet token and the run id (opaque in the public log, so a private row is identified without being named); the log names the public slugs and counts the private ones |
| plan: print | [sync/verdict.ts](../.github/scripts/sync/verdict.ts) `plan` | `plan: <N> rows` |
| row 1: check out | actions/checkout | repo-platform, then the build at the plan's commit under `build/` |
| row 2: resolve | [sync/resolve_row.ts](../.github/scripts/sync/resolve_row.ts) | discovery and selection re-run with the plan's inputs (their output in `$RUNNER_TEMP` files), the row's key recomputed over the re-run rows and the one row carrying it taken (no such row: the step refuses, naming no repository); every form of the name is registered with the masker before anything else prints, and the name and its visibility ride `GITHUB_ENV` (which the runner never echoes) from here |
| row 3: check out the target | [sync/checkout_target.ts](../.github/scripts/sync/checkout_target.ts) | a captured `git clone` with the fleet token (actions/checkout echoes git's diagnostics, which can quote target file text); the token is stripped from the remote afterwards; `continue-on-error` |
| row 4: write | [sync/writer/sync.ts](../.github/scripts/sync/writer/sync.ts) | the one writer step: report to `$RUNNER_TEMP/sync.log`, summary to `summary.json`, `continue-on-error` |
| row 5: deliver | [sync/deliver.ts](../.github/scripts/sync/deliver.ts) | a commit on `automation/repo-platform`, pushed with a lease, and a PR whose body is the report (auto-merge armed only when `hold` is false and the run's `manual` input is false); a refresh re-bases the PR onto the checkout's default branch, and a fork's PR from a same-named branch is never taken for the sync's; a tree that already matches the build closes any open sync PR as obsolete (disarmed, closed with a one-line comment, its branch deleted); a failed checkout, writer, or push files or refreshes one `[repo-platform] sync failed` issue in the target with the log tails; every line goes to `$RUNNER_TEMP/deliver.log` |
| row 6: print | [sync/verdict.ts](../.github/scripts/sync/verdict.ts) `row` | one verdict line |

The vocabulary, complete (`tests/fleet/verdict.test.ts` pins it):

```text
plan: <N> rows
row <i>: unchanged
row <i>: PR opened
row <i>: PR refreshed
row <i>: failed, report filed in the target repository
row <i>: failed before the target was resolved; re-run the workflow
```

- A row is red only when a step before or at the resolve failed (the install, the build checkout, the re-run selection, the resolve itself): the printer then prints the unresolved line, and the failed step's exit status is the whole public signal (its output sits in the runner's `$RUNNER_TEMP` file, gone with the runner); the plan job ran the same code moments earlier in the clear, so re-running the workflow is the remedy. From the checkout on, the steps continue on error and the failure is delivered to the target; the row stays green with its verdict line. The one exception is a target that cannot take the failure report (no Issues grant): that row prints nothing and is red.
- Where the detail is: a delivered row's PR body; a failed row's issue (the tails of the checkout, writer, and delivery logs).
- The `operator-verdict-only` rule (`scripts/check/ssot/sync_operator.ts`) pins the shape: the plan's matrix of row indexes and keys, every row `run:` step one bun command redirected to a `$RUNNER_TEMP` file except the resolver and the printer, only the checkout and setup-bun actions and never a checkout of another repository, no target name in a step's declared env, the target clone after the resolver, the row job's selector carrying the plan's exact env, the writer step carrying its own `timeout-minutes`, and the row job's `timeout-minutes` at least the budget `row_budget.ts` sums from its steps' bounds (a row the runner kills at its timeout files no failure report).
- Rows are re-derived, not carried, and a row is bound to its repository by the key of its slug, not by index: a repository renamed, revoked, or un-adopted between the plan and its row makes that row refuse (red, `re-run the workflow`), one adopted mid-run has no row until the next run, and no count or order change moves a row onto another repository. The residual is a slug another adopted fleet repository takes within the run: the row syncs that repository as the plan's, one the next run would select anyway.

## Private repositories

repo-platform is public, and GitHub Actions has no log-level access control: run logs, job names, step headers, and annotations are as readable as the repository they run in. The operator therefore never lets a private repository's name or content reach that log. Four rules carry the whole model; the job shape enforces them, not a per-step discipline.

| Rule | Where it lives |
| --- | --- |
| **Index-only names.** The matrix carries row indexes and opaque keys (an HMAC of the slug under the fleet token and the run id), the job names row indexes (`sync (row 3)`), never repository names. The plan names public repositories and counts private ones. | [sync-repos.yml](../.github/workflows/sync-repos.yml); the `operator-verdict-only` rule pins it |
| **Mask at the boundary.** One step per row finds its key's repository in the selector's rows file and registers every form of the name (slug, bare name, both URL spellings, lower-cased) with the runner's masker before anything else prints. The name then rides `GITHUB_ENV` alone, which the runner never echoes; the target is cloned by a script whose git output is captured, never by the checkout action. | [sync/resolve_row.ts](../.github/scripts/sync/resolve_row.ts), [sync/checkout_target.ts](../.github/scripts/sync/checkout_target.ts) |
| **Logs to files.** Every later `run:` step writes its whole output to a `$RUNNER_TEMP` file; the writer's report and the delivery log never touch stdout. The only lines printed are the operator's vocabulary above. | the row job's step shape |
| **Details in the target repository.** The report becomes the sync PR's body; a failure's log tails become one reused `[repo-platform] sync failed` issue there. Both are exactly as private as the repository. | [sync/deliver.ts](../.github/scripts/sync/deliver.ts) |

The same job runs for public and private targets: nothing is conditional on visibility except the report's `Visibility` cell.

What a run still shows:

- `plan: <N> rows` and one `row <i>: ...` line per row.
- The build commit the run ships and its stamped main commit: those name THIS repository's builds, not a target.
- A step's exit status, and the red step's own error when a row failed before its target was resolved (nothing target-derived exists yet at that point).
- The plan job's selection line, which names public repositories in the clear and counts the private ones.

The settings apply ([settings-repos.yml](../.github/workflows/settings-repos.yml)) keeps its own model: its selector names public targets and counts private ones, masks every form of a private slug before anything prints, and hands the list to github-settings-as-code, which shows a private target as `private repository #N` (`private-repos: redact`) and delivers its full report to a reused issue on the target itself, pinned by the `settings-as-code-report` label ([settings.md](settings.md#how-the-apply-works)).

Limits, stated plainly:

- Run logs from before this model still contain slugs; delete old runs if that matters.
- The masker is substring-based, so a private repository's bare name is registered only from four characters (masking `api` would garble every innocent occurrence of those letters); the file-and-target rules do not depend on the mask.
- Inside one row job, an innocent occurrence of the repository's name (a dependency sharing it) renders as `***` too. Cosmetic, and scoped to that job.
- Mask registration is a snapshot: a repository renamed while its row runs surfaces under its new name, which no mask covers.
- The `repo=` input typed into a dispatch stays off the log: the plan reads it from the event payload, never from step env, and refusals count entries instead of quoting them.
- The failure issue and the PR body are write-forward: a report delivered while the repository was private stays in the issue's edit history forever. Flipping a repository public publishes it; delete the report issue before a deliberate flip.
- The [site module](site.md) publishes a PUBLIC site even from a private repository, `<owner>.github.io/<repo>` included; that is outside this model entirely.

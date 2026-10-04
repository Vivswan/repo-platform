---
order: 1
---

# The file list

This page is the grammar of `files.yml`, the one data file the writer reads: what an entry may say, what a module's data may carry, what the loader refuses, which forms the committed file uses today, and which entries one repository selects. How a selected entry is written is [the writer page](writer.md).

## files.yml

```yaml
placeholders: [project_name, project_slug, description, github_username, github_username_lower, copyright_holder, year, private, fuzzer_label, fuzzer_label_color, fuzzer_label_description]
modules:
  bun: {codeql_languages: [javascript-typescript], gitignore_sources: [Node, bun], dependabot_ecosystems: [bun]}
  fuzzer: {gitignore_sources: [fuzzer], tracking_label: {key: fuzzer, default: fuzz-nightly, color: B60205, description: Automated nightly fuzz failure}}
  release-please: {}
settings:
  baseline: files/settings/baseline.yml
  layers:
    - {source: files/settings/public.yml, when: {private: false}}
    - {source: files/bun/settings.yml, when: {modules: [bun]}}
  override: files/settings/override.yml
files:
  - {path: .github/workflows/ci.yml, class: managed}
  - path: .gitignore
    class: split
    region: hash
    blocks: gitignore_sources
    replace: {"[\r]": "?"}
    always: [Windows, macOS, Linux, VSCode, JetBrains]
    sources:
      Windows: {repository: github/gitignore, sha: 356fd7baab4c05e092194a41f64dbd5afc8817e4, path: Global/Windows.gitignore}
      macOS: {repository: github/gitignore, sha: 356fd7baab4c05e092194a41f64dbd5afc8817e4, path: Global/macOS.gitignore}
      Linux: {repository: github/gitignore, sha: 356fd7baab4c05e092194a41f64dbd5afc8817e4, path: Global/Linux.gitignore}
      VSCode: {repository: github/gitignore, sha: 356fd7baab4c05e092194a41f64dbd5afc8817e4, path: Global/VisualStudioCode.gitignore}
      JetBrains: {repository: github/gitignore, sha: 356fd7baab4c05e092194a41f64dbd5afc8817e4, path: Global/JetBrains.gitignore}
      Node: {repository: github/gitignore, sha: 356fd7baab4c05e092194a41f64dbd5afc8817e4, path: Node.gitignore}
      bun: {repository: github/gitignore, sha: 356fd7baab4c05e092194a41f64dbd5afc8817e4, path: bun.gitignore}
      fuzzer: files/fuzzer/fuzzer.gitignore
  - {path: .github/dependabot.yml, class: managed, blocks: dependabot_ecosystems, sources: {bun: files/bun/.github/dependabot.bun.yml}}
  - {path: .github/settings.local.yml, class: starter}
  - {path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.local.yml}
  - {path: AGENTS.md, class: split, region: html}
  - {path: .typography-allow, class: managed, when: {without: [release-please]}}
  - {path: .typography-allow, class: managed, when: {modules: [release-please]}}
  - {path: .github/actions/site-build/action.yml, class: starter}
  - {path: .github/workflows/nightly-fuzz.yml, class: starter, when: {modules: [fuzzer]}}
mirrors:
  - {source: AGENTS.md, kind: symlink, targets: [CLAUDE.md, .github/agents.md]}
```

| Key | Meaning |
| --- | --- |
| `placeholders` | The placeholder names sources may use, each spelled as the name inside double braces. Each must be one the writer derives (`PLACEHOLDER_NAMES`). |
| `modules.<name>` | A module and its data; the keys ARE the module roster, in the order the writer selects and the fleet plan lists. What the data may carry: [Module data](#module-data). |
| `files[].path` | The repository-relative path written. Clean paths only: no `..`, no empty segment, no `.git`. |
| `files[].class` | `managed`, `split`, or `starter` ([Classes](writer.md#classes)). |
| `files[].source` | The source file, under `files/`, or an upstream ref `{repository, sha, path}` fetched at sync time ([Upstream refs](#upstream-refs)). Default: `files/<first when.modules entry, or base>/<path>`. |
| `files[].when` | The selection condition ([Selection](#selection)). Absent or empty means always. |
| `files[].region` | Split entries only: `hash` for `#` comment markers, `html` for `<!-- -->` markers. |
| `files[].blocks` | Managed, split, and starter entries: a module-data key. For each selected module carrying it, in `modules` order, each listed value names one block (below); a value listed twice lands once. |
| `files[].always` | Managed, split, and starter entries: block values every repository takes, before the modules' blocks; each needs a source in `sources`. |
| `files[].sources` | Managed, split, and starter entries: block value to its source, in the grammar of `files[].source`: a tree file under `files/`, spliced as it reads, or an upstream ref ([Upstream refs](#upstream-refs)). Every value `always` or a module lists has one, and every source is listed by one of them. |
| `files[].replace` | Entries fetching an upstream source or blocks: literal rewrites `{<from>: <to>}` applied to every fetched body of the entry, in order (`{"[\r]": "?"}` turns the macOS template's class holding a bare CR byte, which check-typography refuses, into a one-character glob). A tree file is edited instead. |
| `files[].render` | Managed entries only, one value: `settings`. The entry has no source; the writer renders the settings document from the `settings` layers and the repository's overlay at `overlay` ([settings.md](../../settings.md)). |
| `files[].overlay` | Rendered entries only, required: the repository-owned file the render folds in (`.github/settings.local.yml`). The path must be written by starter entries only, listed before this entry, and selected exactly when this entry is. |
| `settings.baseline`, `settings.layers`, `settings.override` | The settings layers ([settings.md](../../settings.md)), clean paths under `files/`, present exactly when a `render: settings` entry exists: the baseline, then each `{source, when}` layer whose `when` holds (absent means always) in declared order, then the override above the repository's overlay. |
| `mirrors` | The fleet's mirrors, in the registration's grammar; [Mirrors](mirrors.md) says how the fleet's list and the repository's are judged as one. A fleet mirror carries no `when`: every repository gets each target, save one its `except` names. Absent means none. |

**Where blocks land:** at the anchor line, the word `blocks` inside double braces, alone on its line, spelled like a placeholder.

- A source without one gets them appended at the end.
- Every piece is newline-terminated first, so the seams never merge two lines.
- The anchor appears at most once and only as a whole line, in sources of entries that declare `blocks` (for a split entry, inside the region body).
- A starter's blocks are rendered once, at creation.

### Module data

| Module data key | Meaning | Reader |
| --- | --- | --- |
| `description` | the module's one-line description | docs and the PR body |
| `codeql_languages` | the CodeQL languages the toolchain contributes; the plan folds the selected modules' lists into one deduplicated matrix | the fleet plan |
| `dependabot_ecosystems` | the Dependabot ecosystems the module adds (also its `blocks` list) | the writer |
| `gitignore_sources` | the github/gitignore templates and platform-authored blocks the module adds (its `blocks` list) | the writer |
| `agents_toolchain` | the AGENTS.md block list, the module's own name | the writer |
| `toolchain_steps` | the block list, the module's own name, of the three starter workflows that carry per-toolchain steps | the writer |
| `path` | the `site` module only: the URL segment the docs mount under when the repository's site-build hook also builds a website, unless the registration sets `site.path` | the fleet plan |
| `tracking_label` | `{key, default, color, description}` of the module's tracking-issue label; `key` is the registration's `labels` key and `default` backs the `<key>_label` placeholder; `color` and `description` are the tuple the render writes the label with | the fleet plan, the writer's settings render, and the placeholder defaults |
| `pin` | `{file, repository, tag}`: the module's version dotfile under `files/`, the github.com repository whose latest release it follows, and that repository's release tag with `{version}` where the version stands ([toolchains.md](../../toolchains.md#keeping-the-pins-fresh)) | the refresh workflow |

- **The typed keys** are `description`, `path`, `tracking_label`, `codeql_languages`, and `pin`. Any other key is a list some entry's `blocks` or a `declaring` clause reads.
- **Every many-of key is a list,** `codeql_languages` and the block lists alike: a key outside `description`, `path`, `tracking_label`, and `pin` must hold a non-empty list of names, and one spelled as a single word is a loader error naming the module and key.
- **An untyped key no file entry's `blocks` and no `declaring` clause reads** is a loader error naming the module and key too: a typo'd or retired key is refused, never silently skipped.
- **A module with no files** still appears under `modules` (`custom-license`), so a registration selecting it is known and a `when` can name it.

### What the loader refuses

The loader refuses, all problems at once. Each line is the place, then the condition refused:

- **`placeholders`:** it names a placeholder the writer cannot derive, or a source file uses a token outside it.
- **a listed `<key>_label` placeholder:** no module declares a default for it, or two modules do.
- **`modules.<m>.tracking_label`:** it lacks `key` and `default`, or lacks `color` and `description` while the data file renders settings.
- **`modules.<m>.pin`:** its `file` is not a clean path under `files/`, its `repository` is not `owner/name`, or its `tag` does not spell `{version}` exactly once.
- **`files[].when`:** it names a module absent from `modules`, or declares a key no module carries.
- **`files[].region`:** a `split` lacks it, or a non-split entry has it.
- **a `source` or `sources` tree path:** it is outside `files/`, or missing from the tree.
- **a `blocks` anchor:** it is mentioned twice or mid-line, sits in a source whose entries do not all declare `blocks`, or sits inside a block file.
- **`files[].render`, `files[].overlay`:** `render` sits on an entry that is not managed, or `overlay` on one that is not rendered.
- **a rendered entry:** it has a `source`, `blocks`, `always`, `sources`, or `replace`, or lacks `overlay`.
- **a block list:** it is not a list of names (letters, digits, `_`, `-`).
- **a block value or `sources` key:** it is spelled `__proto__`, which the schema would drop.
- **an upstream ref (a `source` object, or a `sources` value):** its `repository` is not `owner/name`, its `sha` is not 40 lowercase hex characters, or its path is not a clean path of letters, digits, `. _ - /`.
- **`files[].sources`:** a value `always` or a module lists has no source there, or it names a value neither `always` nor a module lists.
- **`files[].replace`:** the entry fetches nothing.
- **the `overlay` path:** it is not clean, is the entry's own path, or is the manifest; any non-starter entry writes it, or no entry does.
- **the overlay starters:** they are listed after the rendered entry, or not selected exactly when it is: an unconditional rendered entry needs one unconditional starter, a conditional one a starter with the same `when`.
- **the `settings` block:** it is missing while a `render: settings` entry exists, or present with none.
- **a settings layer:** its path is not a clean path under `files/`, its source is declared twice, or its `when` names a module absent from `modules` or declares a key no module carries.
- **a declared settings layer's file:** it is missing from the tree, is not a YAML mapping, or names one label (case-insensitively) or one ruleset twice.
- **two entries for one `path`:** their conditions can both hold ([Selection](#selection)).
- **a `files` entry at `.github/repo-platform-manifest.json`:** always: that is the manifest the writer itself writes last.

## files.yml reference

What the committed `files.yml` uses today, so a reader knows which forms are live. The loader accepts more ([files.yml](#filesyml)).

The file list is [files.yml](../../../files.yml) itself: its `files` entries name each path and its `class`, and its `mirrors` list names the fleet's mirror targets. Two starter roles the list does not spell: `update-release.yml` and `update-release-pr.yml` are the release hooks, and the rust module's `Cargo.toml` is the workspace root.

The tables below cover the `when` forms and `blocks` keys in use.

| `when` form | Used by |
| --- | --- |
| `modules: [x]` | every module-owned file |
| `any: {declaring: <key>}` | the CodeQL settings layer (`codeql_languages`), `auto-format.yml` (`toolchain_steps`), the Toolchain variant of `AGENTS.md` (`agents_toolchain`) |
| `without: [...]` | `LICENSE.md` (not `custom-license`), the plain variant of `.typography-allow` |
| `without: {declaring: <key>}` | the plain variant of `AGENTS.md` (`agents_toolchain`) |
| `private: true` / `false` | the public, private, and CodeQL settings layers |

| `blocks` key | Entry | Block sources |
| --- | --- | --- |
| `gitignore_sources` | `.gitignore` (split) | github/gitignore templates at one pinned sha, fetched by every sync; the fuzzer's failure directory from `files/fuzzer/fuzzer.gitignore` |
| `dependabot_ecosystems` | `.github/dependabot.yml` (managed) | `files/<module>/.github/dependabot.<ecosystem>.yml`, appended at the anchor line that ends the source |
| `agents_toolchain` | `AGENTS.md` (Toolchain variant, split) | `files/<module>/AGENTS.toolchain.md`, the module's Toolchain bullets, appended after the region body |
| `toolchain_steps` | `checks.yml`, `copilot-setup-steps.yml`, `auto-format.yml` (starters) | `files/<module>/.github/workflows/<stem>.toolchain.yml`: the example checks (rust's are live steps: cargo's own commands, the same in every repository), the setup and install steps, the setup and format steps |

- **The `.gitignore` templates on every repository,** through `always`: the OS templates `Global/Windows.gitignore`, `Global/macOS.gitignore`, `Global/Linux.gitignore` and the editor templates `Global/VisualStudioCode.gitignore`, `Global/JetBrains.gitignore`. The Node template both JavaScript toolchains list lands once.
- **The `toolchain_steps` seams:** each block opens with the blank line that separates it from the step above. The anchor sits after the checkout step: `copilot-setup-steps.yml` ends there, and `checks.yml` and `auto-format.yml` keep one blank line below it before their closing steps.

**Placeholders in use beyond the project block:** `fuzzer_label`, `fuzzer_label_color`, and `fuzzer_label_description` in `nightly-fuzz.yml`; `nightly_label`, `nightly_label_color`, and `nightly_label_description` in `nightly.yml`. No committed source names `site_label`: the site leg does not pass the link-rot label (the plan action resolves it from the registration), so it is not listed.

## Upstream refs

An upstream ref is `{repository, sha, path}`: a file of a github.com repository at one pinned commit. It may stand where a tree source stands, as `files[].source` or a `files[].sources` value, and both read through one fetcher.

- **Fetched** from `https://raw.githubusercontent.com/<repository>/<sha>/<path>` (`--upstream` swaps the host), every ref once per sync and before any file is written. A fetch that fails or answers anything but 200 fails the sync with one `::error::` line, nothing written.
- **The body is normalized** (CRLF to LF, trailing spaces and tabs stripped, surrounding blank lines dropped), then rewritten by the entry's `replace`. As a source it is the entry's text.
- **As a block** it is headed in the entry's region comment, `## <value> (<repository> <path>)` under `hash`, `<!-- <value> (<repository> <path>) -->` under `html`, bare on an entry without a region, and ends with a blank line.
- **Two syncs render the same bytes** until [refresh-upstream.yml](../../../.github/workflows/refresh-upstream.yml) moves the pin. Weekly, its `commit` leg moves every distinct `{repository, sha}` the data file spells to that repository's HEAD by one PR on `automation/refresh-commit-pins`, its body each fetched file's diff between the two commits. The next sync renders the change wherever the file lands.
- **A HEAD under which every fetched file's normalized body is unchanged** leaves the pin where it is, so no PR opens for it. The workflow's other leg moves the modules' release pins ([toolchains.md](../../toolchains.md#keeping-the-pins-fresh)) on a branch of their own.

## Placeholders

| Name | Value |
| --- | --- |
| `project_name` | `project.name` from the registration |
| `project_slug` | `project.slug` |
| `description` | `project.description` |
| `github_username` | the repository owner |
| `github_username_lower` | the owner, lower-cased |
| `copyright_holder` | `project.copyright_holder`, else the owner |
| `year` | the current UTC year |
| `private` | the writer's `--private` flag, `true` or `false`; the `.github/settings.local.yml` starter declares the visibility with it |
| `fuzzer_label`, `nightly_label`, `site_label` | `labels.<key>` from the registration, else the `default` of the `modules.<m>.tracking_label` whose `key` is `fuzzer`, `nightly`, or `site` |
| `<key>_label_color`, `<key>_label_description` | the `color` and `description` of the same `tracking_label`: the tuple the starter's report step creates the label with, and the render declares it with |

- **A token** is the name inside double braces with no spaces; spaces inside the braces make it plain text.
- **A `$` before the braces** marks a GitHub Actions expression, left untouched.
- **Substitution runs on source files only.** A literal double brace in a repository-owned tail is never touched.
- **A value lands inside quoted YAML scalars verbatim,** so a value carrying a double quote, a backslash, or a control character is refused twice. The registration grammar (`actions/plan/registration.ts`) rejects such a `project.name`, `project.description`, or `project.copyright_holder`, and `substitute` fails the run on any such value.
- **An absent or empty value is never written:** an entry whose text needs it is `held` with `no value for <token>`, a Registration note names the registration key to set, and the PR holds. An empty `project.description` holds every entry that uses `description`.

## Selection

| Clause | Holds when |
| --- | --- |
| `modules: [a, b]` | every listed module is selected |
| `any: [a, b]` | at least one listed module is selected |
| `without: [a]` | none of the listed modules is selected |
| `private: true` | the repository's visibility matches |

**A list position may name a module-data key instead of the modules:** `any: {declaring: codeql_languages}` is the list of every module whose data carries `codeql_languages`, in `modules` order. The loader expands it, so a list spelled this way follows the modules block and a new module joins it by declaring the key; a key no module declares is a loader error.

- **The selected modules** are the registration's `modules` in `files.yml` order. A name `files.yml` does not offer fails the sync in the plan's words (the refusal the `plan` step of fleet CI gives the PR that introduces it); nothing is dropped.
- **Two entries for one path must be provably exclusive:** a module one requires and the other forbids, an `any` list the other forbids entirely, or opposite `private` values. Anything subtler is a loader error.
- **The registration's `except`** lists paths the repository keeps as its own: no entry at one is selected, whatever its `when`. A record an earlier sync left there is `released` ([Retirement](writer.md#retirement)).
- **`except` and mirrors:** [the mirrors page](mirrors.md) says what an excepted path does to a fleet target and to a repository target.
- **An `except` path no `files.yml` entry or fleet mirror writes** is a Registration note, which holds the PR.

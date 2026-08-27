# The skills module

Selecting the `skills` module lets a repository host its own agent skills (consumable by `npx skills add <repo>` and Claude Code plugin tooling) with centrally-managed validation. It ships three things:

- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` starters, seeded from the repository's identity (plugin name `<project_slug>-skills`, description from the project name, the owner as author) with an empty `skills` catalog
- a `validate-skills` structure job in repo-platform's fleet-ci gate (armed by the module selection the managed ci.yml passes), so the all-green verdict blocks merges on a broken catalog, plus a standalone advisory `.github/workflows/validate-skills.yml` for CLI discovery
- the `validate-skills` composite action in this repository (`actions/validate-skills`), pinned at the green-gated `build` delivery branch by fleet-ci and the advisory workflow alike

## Module parameter (copier question)

| Question | Meaning | Default |
|---|---|---|
| `skills_dir` | Directory holding the repository's agent skills. Relative path segments of letters, digits, dots, underscores, and dashes: the value lands in the discovery workflow's `paths` filter, where `!`, `*`, `?`, and `[` carry glob meaning, so the charset keeps the trigger literal. | `skills` |

The directory is asked as a copier question, rather than left as an edit in the rendered files, because the gate job's action input and the discovery workflow's trigger paths must agree on it.

## Starter vs managed

- The two `.claude-plugin/` manifests are generated once and then repo-owned (`_skip_if_exists`): repos list their published skills in `plugin.json`'s `skills` array and tailor the descriptions, and template sync never overwrites that. A repo adopting the module with existing manifests keeps them untouched.
- The fleet-ci `validate-skills` job and the advisory `validate-skills.yml` are fully managed: validation logic updates in repo-platform reach the whole fleet through the `@build` refs (fleet-ci.yml and the composite action), no sync PR needed; the advisory workflow file itself updates on sync. Do not edit them; repo-specific checks belong in the repo-owned `checks.yml`.

## What is checked, and where

The validation is split by what a failure means:

1. `validate-skills` (a fleet-ci job, gating merges through the all-green verdict; offline and cheap, so it runs on every PR): `plugin.json` parses with a kebab-case name, its `skills` paths are real direct children of the skills directory, every folder under the skills directory has a `SKILL.md` whose frontmatter `name` matches the kebab-case folder and whose `description` is nonempty (both within Claude Code's 64/1024-character limits), a skill's `.mcp.json` (when present) parses, the skills directory (when it exists - a repo that publishes nothing yet has none, and anything other than a directory at the path is an error) carries an index `README.md` at its root, and `marketplace.json` (when present) is well-formed and consistent with `plugin.json` (a plugin publishing the repository root must carry the same name). Symlinks are rejected anywhere on a validated path - the skills directory (ancestor components included), skill folders, `SKILL.md`, `.mcp.json`, the skills root's index `README.md`, and the two manifests themselves - because a link can point outside the checkout, so what ships would not be what was validated. The one exception is a marketplace plugin's `source`, which may pass through in-repo symlinks; its physical path must still stay inside the repository.
2. `discovery` (the standalone validate-skills.yml, advisory, outside the gate): runs the real `npx -y skills add . --list` against the checkout (with bounded retries) and asserts every skill published in `plugin.json` appears in the CLI listing. It downloads the CLI from the npm registry, so it needs network and can flake on registry hiccups; an advisory red must never block merges, which is exactly why it does not live in the gate. The plugin-title group heading is only a notice: it mirrors the CLI's own formatting, which the manifest does not control.

An empty catalog (`"skills": []`, the seeded state) passes both: a freshly adopted repo publishes nothing yet.

repo-platform dogfoods the module on itself: it selects `skills` in `.repo-platform-answers.yml` (its two fleet-operations skills live under `skills/`, and its `.claude-plugin/` manifests are its own, repo-owned like any starter), carries the managed discovery workflow as a generated dogfood copy, and runs both modes from its hand-written ci.yml - there the discovery job gates through all-green too, per this repository's all-jobs-gate convention, because a listing regression in the action it ships should block its own merges. A PR touching `skills/` therefore runs discovery twice - advisory via the dogfooded workflow, gating via ci.yml - an intended overlap. `bun run validate:skills` is the local structure check.

## Publishing a skill

Each published skill is a direct child of the skills directory, and the directory itself carries an index README (required by the structure check as soon as the directory exists):

```
skills/
  README.md       # index of the hosted skills (what each is, how to install)
  my-skill/
    SKILL.md      # YAML frontmatter: name (= folder, kebab-case), description
    ...           # whatever else the skill carries
```

A skill folder is UNPUBLISHED until `plugin.json` lists it: installers and the discovery check both read the manifest, not the disk, so a folder you forgot to list validates green and silently never ships. Adding the skill means adding its path to `plugin.json`'s `skills` array, as `./skills/my-skill` (paths are checked against `skills_dir`, so a repo with `skills_dir=lib/skills` lists `./lib/skills/my-skill`).

## Adopting in an existing skills repository (Vivswan/skills)

1. Add `skills` to the `modules` list in `.repo-platform.yml`; the next sync renders the module.
2. The existing `.claude-plugin/` manifests survive untouched (`_skip_if_exists`), catalog included.
3. The managed baseline coexists with the repo's richer checks: repo-specific assertions (its template-skill hiding, version-drift and catalog-coverage smoke tests, per-skill README/plugin files) stay in its own `checks.yml` machinery, exactly like any other repo-owned CI.

## Consuming

`npx skills add <owner>/<repo>` reads `plugin.json`, offers the published skills grouped under the plugin's title, and installs the chosen skill folders. (npx resolves `node_modules/.bin` first, so a local dependency named `skills` would shadow the CLI.) The marketplace manifest makes the same catalog addressable as a Claude Code plugin marketplace (`/plugin marketplace add <owner>/<repo>`).

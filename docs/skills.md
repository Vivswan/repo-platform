# The skills module

Selecting the `skills` module lets a repository host its own agent skills (consumable by `npx skills add <repo>` and Claude Code plugin tooling) with centrally-managed validation. The published layout:

```
skills/             # the skills directory (skills_dir answer, default `skills`)
  README.md         # index of the hosted skills (what each is, how to install) - required as soon as the directory exists
  my-skill/
    SKILL.md        # YAML frontmatter: name (= folder, kebab-case), description
    ...             # whatever else the skill carries
```

## Publishing a skill

A skill folder is UNPUBLISHED until `plugin.json` lists it: installers and the [discovery check](#what-is-checked-and-where) both read the manifest, not the disk, so a folder you forgot to list validates green and silently never ships. Publishing means adding the folder's path to `plugin.json`'s `skills` array, as `./skills/my-skill` (paths are checked against `skills_dir`, so a repo with `skills_dir=lib/skills` lists `./lib/skills/my-skill`).

## What the module ships

- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` starters, seeded from the repository's identity (plugin name `<project_slug>-skills`, description from the project name, the owner as author) with an empty `skills` catalog
- a `validate-skills` structure job in repo-platform's fleet-ci gate, so the [all-green verdict](all-green.md) blocks merges on a broken catalog
- a standalone advisory `.github/workflows/validate-skills.yml` for CLI discovery
- both run the `validate-skills` composite action ([actions/validate-skills](../actions/validate-skills/validate_skills.ts)), pinned at the green-gated `build` delivery branch

## Module parameter (copier question)

| Question | Meaning | Default |
|---|---|---|
| `skills_dir` | Directory holding the repository's agent skills. Relative path segments of letters, digits, dots, underscores, and dashes: the value lands in the discovery workflow's `paths` filter, where `!`, `*`, `?`, and `[` carry glob meaning, so the charset keeps the trigger literal. | `skills` |

The directory is a copier question, rather than an edit in the rendered files, because the gate job's action input and the discovery workflow's trigger paths must agree on it.

## Starter vs managed

- The two `.claude-plugin/` manifests are generated once and then repo-owned (`_skip_if_exists`): repos list their published skills in `plugin.json`'s `skills` array and tailor the descriptions; template sync never overwrites that. A repo adopting the module with existing manifests keeps them untouched.
- The fleet-ci `validate-skills` job and the advisory `validate-skills.yml` are fully managed: validation logic updates reach the whole fleet through the `@build` refs with no sync PR, and the advisory workflow file itself updates on sync. Do not edit them; repo-specific checks belong in the repo-owned `checks.yml`.

## What is checked, and where

Two checks, split by what a failure means. An empty catalog (`"skills": []`, the seeded state) passes both: a freshly adopted repo publishes nothing yet. `bun run validate:skills` runs the structure check locally.

| Check | Where it runs | What a red means |
|---|---|---|
| `validate-skills` | fleet-ci job, gating merges through the all-green verdict; offline and cheap, so it runs on every PR | the catalog structure is broken |
| `discovery` | the standalone validate-skills.yml, advisory, outside the gate | the real `npx -y skills add . --list` does not list every skill published in `plugin.json` |

The structure check's full rule set lives in [actions/validate-skills/validate_skills.ts](../actions/validate-skills/validate_skills.ts). Headlines: `plugin.json` parses with a kebab-case name and its `skills` paths are real direct children of the skills directory; every skill folder's `SKILL.md` frontmatter `name` matches the kebab-case folder and its `description` is nonempty (both within Claude Code's 64/1024-character limits); the skills directory carries an index `README.md` at its root; `marketplace.json` (when present) is well-formed and consistent with `plugin.json`; and symlinks are rejected anywhere on a validated path, because a link can point outside the checkout, so what ships would not be what was validated. The one exception is a marketplace plugin's `source`, which may pass through in-repo symlinks; its physical path must still stay inside the repository.

Discovery downloads the CLI from the npm registry, so it needs network and can flake on registry hiccups; an advisory red must never block merges, which is exactly why it does not live in the gate.

## Dogfooding

repo-platform selects `skills` in `.repo-platform-answers.yml` (its fleet-operations skills live under `skills/`, and its `.claude-plugin/` manifests are its own, repo-owned like any starter), carries the managed discovery workflow as a generated dogfood copy, and runs both modes from its hand-written ci.yml. There the discovery job gates through all-green too, per this repository's all-jobs-gate convention: a listing regression in the action it ships should block its own merges. A PR touching `skills/` therefore runs discovery twice - advisory via the dogfooded workflow, gating via ci.yml - an intended overlap.

## Adopting in an existing skills repository

1. Add `skills` to the `modules` list in `.repo-platform.yml`; the next sync renders the module.
2. The existing `.claude-plugin/` manifests survive untouched (`_skip_if_exists`), catalog included.
3. The managed baseline coexists with the repo's richer checks: repo-specific assertions stay in its own `checks.yml` machinery, exactly like any other repo-owned CI.

## Consuming

`npx skills add <owner>/<repo>` reads `plugin.json`, offers the published skills grouped under the plugin's title, and installs the chosen skill folders. (npx resolves `node_modules/.bin` first, so a local dependency named `skills` would shadow the CLI.) The marketplace manifest makes the same catalog addressable as a Claude Code plugin marketplace (`/plugin marketplace add <owner>/<repo>`).

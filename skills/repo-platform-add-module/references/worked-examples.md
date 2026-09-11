# Worked examples

Two end-to-end module additions, with the checks that matter at each step.

## 1. Adding `nightly` to a repo that already has `fuzzer`

Goal: the repo's slow suites move off the PR path into a nightly stream with automatic issue filing, next to the existing fuzz stream.

### Label distinctness first

Both streams dedup and auto-close their tracking issue by label, so the nightly label must differ from the fuzzer label (case-insensitively). The defaults already differ (`nightly-failure` vs `fuzz-nightly`); a custom label goes under `labels.nightly`.

### The edit

```bash
git checkout -b add-nightly
# .repo-platform.yml: add "nightly" to modules; a custom label only if wanted:
#   labels:
#     nightly: slow-suite-failure
git commit -am "chore: add the nightly module"
gh pr create
# the plan job validates the file; merge when green, then:
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f manual=true
```

### The sync PR

The run's job log ends `row 0: PR opened`. In the report:

- Written: `.github/workflows/nightly.yml` as `starter`, `created`. Every other row `unchanged`.
- Review: `Hold for review: no`; `manual=true` keeps it waiting for you.
- No `.github/settings.yml` diff from the sync: the settings apply declares the label from the registration (`labels.nightly`, else the default `nightly-failure`).

### The starter, and moving real checks in

Two jobs: `checks` (yours; the placeholder is a green no-op that never files issues) and `report` (the machinery: `needs: [checks]`, `if: always()`, a cancelled checks job counts as red). Pick the repo's own cron minute.

- Port the slow suites' steps into `checks`, or add them as sibling jobs, list every one in `report`'s `needs`, and fold each result into the red/green conditions. Keep siblings unconditional: a job skipped by its own `if:` matches neither condition and the report does nothing that night.
- With a custom label, change the two `label:` inputs in the starter to match `labels.nightly`.

### Verify

- The first scheduled run is green, or files one issue carrying the label.
- The label exists on the repo: `gh label list -R Vivswan/<repo>`. Create it with `gh label create` when no settings apply has declared it yet.

## 2. Adding `skills`

Goal: the repo hosts agent skills other repositories install with `npx skills add`.

### The edit

```bash
git checkout -b add-skills
# .repo-platform.yml: add "skills" to modules. Keep the default skills/ directory:
# the managed validate-skills.yml is written for it.
# .claude-plugin/plugin.json: a minimal manifest, because the validate-skills
# gate job runs on this PR and reads it:
#   { "name": "<slug>-skills", "description": "Agent skills for <name>", "skills": [] }
git add -A && git commit -m "chore: add the skills module"
gh pr create
# merge, then:
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo> -f manual=true
```

### The sync PR

- Written: `.claude-plugin/plugin.json` as `starter`, `unchanged` (you committed it; an existing starter is never rewritten), `.claude-plugin/marketplace.json` as `starter`, `created`, `.github/workflows/validate-skills.yml` as `managed`, `created`.
- The plugin name is `<project.slug>-skills`: use the same slug in the manifest you committed and in the registration's `project` block (`name`, `slug`, `description` together) when the repository name is not the slug you want.

### Publishing a skill

1. Create `skills/<name>/SKILL.md` with frontmatter `name: <name>` (equal to the folder, kebab-case) and a nonempty `description`.
2. Add `./skills/<name>` to `plugin.json`'s `skills` array. Unlisted folders validate and never ship.
3. Keep an index `README.md` at the root of the skills directory.
4. Per-skill license copies: declare `mirrors: [{source: LICENSE.md, targets: ["skills/*/LICENSE.md"]}]` in the registration; every sync refreshes them and a new folder is picked up by the glob.

### Verify

- The `validate-skills` job inside `ci` is green on the next PR (structure), and the advisory `validate-skills.yml` run lists every published skill (discovery).
- `npx skills add Vivswan/<repo> --list` names the skill.

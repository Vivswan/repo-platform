# Worked examples

Two end-to-end module additions, with the checks that matter at each step.

## 1. Adding `nightly` to a repo that already has `fuzzer`

Goal: the repo's slow suites (full end-to-end runs, docker builds, live integration tests) move off the PR path into a nightly stream with automatic issue filing, alongside the existing fuzz stream.

### Label distinctness first

Both streams dedup AND auto-close their tracking issue by label, so `nightly_label` must differ from `fuzzer_label` (case-insensitive - GitHub deduplicates label names that way). The defaults already differ (`nightly-failure` vs `fuzz-nightly`); a custom label collision is rejected by the copier validator at render time and by the settings preflight in recorded answers.

### The edit

```bash
git checkout -b add-nightly
# .repo-platform.yml: add "nightly" to the top-level modules list.
# .copier-answers.yml: record the label even when accepting the
# default (the central-settings preflight reads it from this file):
#   nightly_label: nightly-failure     # or a custom label
git commit -am "chore: add the nightly module"
gh pr create && gh pr merge --auto --squash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo>
```

### The sync PR

Every file should be explained by the modules diff:

- `.github/workflows/nightly.yml` - NEW, the starter (repo-owned from now on).
- `.copier-answers.yml` - records `nightly` and `nightly_label`.
- No settings.yml diff: the managed baseline declares the `nightly-failure` label automatically at apply time, read from the recorded `nightly_label` answer (below).

### The starter, and moving real checks in

Two jobs: `checks` (yours - the placeholder is a green no-op that prints a warning and never files issues) and `report` (the machinery - `needs: [checks]`, `if: always()`, treats a cancelled checks job as red so a timeout-hang still files). Cron is 06:59 UTC, offset from the fuzzer starter's 09:11 UTC; pick the repo's own minute.

Move the real checks in either way:

- Port their setup and run steps into the `checks` job, or
- add them as sibling jobs, list every one in `report`'s `needs`, and fold each result into the red/green conditions. Keep siblings unconditional: a job skipped by its own `if:` matches neither condition and the report silently does nothing that night.

Unlike the fuzz stream, the nightly issue does NOT gate releases; add `release-blocker` to a nightly issue by hand when it should block a cut.

### Companion step: record the answer

The settings assembly reads the module list from the repo's `.repo-platform.yml` (live as soon as the step-1 PR merges) but the label value from `.copier-answers.yml` - so record `nightly_label` in the step-1 PR even when accepting the default, or the repo's settings apply fails (the assembly refuses to guess a tracking label) until the sync PR merges the recorded answer.

## 2. Adding `skills`

Goal: the repo hosts installable agent skills with centrally-managed validation.

### The edit

`skills_dir` defaults to `skills`. For a different directory, record it in the same PR (`.copier-answers.yml`: `skills_dir: lib/skills`) - the value is baked into the managed workflow's trigger paths and the gate job's input, which is why it is an answer, not a starter edit.

```bash
git checkout -b add-skills
# .repo-platform.yml: add "skills" to the top-level modules list.
# Non-default directory? Also add to .copier-answers.yml:
#   skills_dir: lib/skills
git commit -am "chore: add the skills module"
gh pr create && gh pr merge --auto --squash
gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/<repo>
```

### The sync PR

- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` - starters, seeded from the repo identity with an empty `skills` catalog, repo-owned from now on. A repo that already carries them (an existing skills repo adopting the module) sees NO diff here - `_skip_if_exists` files are never re-rendered.
- `.github/workflows/validate-skills.yml` - managed, the advisory discovery workflow (runs the real `npx -y skills add . --list`; network-dependent, deliberately outside the gate).
- `.github/workflows/ci.yml` - gains the `validate-skills` structure job, gating through all-green (offline: manifests parse, `skills` paths are real direct children of the skills directory, every skill folder has a `SKILL.md` with a matching kebab-case `name` and a nonempty `description`, no symlinks on validated paths).

An empty catalog passes both checks; a freshly adopted repo publishes nothing yet.

### Publishing the first skill

```
skills/
  my-skill/
    SKILL.md      # frontmatter: name (= folder, kebab-case), description
```

Then list it in `plugin.json` - the manifest, not the disk, is what installers and the discovery check read. Structure validation checks every direct child folder either way (an invalid unlisted folder fails the gate), but a valid unlisted folder passes and silently never ships:

```json
"skills": ["./skills/my-skill"]
```

Verify locally before pushing: `npx -y skills add . --list` from the repo root shows the skill under the plugin's title.

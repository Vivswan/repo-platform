# Target architecture

Status: the target the current work implements; sections are updated as phases land. The metric is the cost of a simple change, not past incidents.

## 1. The measure

| Simple change | Today | Target |
|---|---|---|
| add a CI leg for a module (PR #146) | 62 files, +2,755 lines, 11 checkers that can go red, then one sync PR per repo | 1 workflow + 1 test, 0 fleet PRs |
| rename a managed file | ~12 files + a migration rung + a harness case | 1 line in the file list |
| change a setting default | layer file + merge code + tests here | layer file only (the merge lives in the settings action) |
| platform-written files per repo | 49 | ~14 |
| runner jobs per push here | ~42 | ~12 |
| checker layers that pin other files' text | 56 rules, 5 goldens, smoke x15, bash harness | 0 rules; unit tests + one end-to-end test |

## 2. Root cause

Variability is resolved at RENDER time into per-repo text, and that text is then held correct by a second hand-written model of the same text (ssot rules, smoke greps, goldens, the bash harness). Every change is written twice and can go red in each checker independently. Three choices cause it:

| | Choice today | Consequence |
|---|---|---|
| R1 | CI behavior lives in rendered per-repo workflow text | fragments, anchors, conditions, leg rules, goldens, a fleet sync per behavior change |
| R2 | Copier's three-way merge is the transport | 14 of 36 sync steps exist to undo or police the merge; rungs; the upgrade harness |
| R3 | a public operator pushes into private repos | redaction in 32 files, hidden reports, masked outputs |

## 3. Principles (each named by the cost it removes)

| # | Principle | Removes |
|---|---|---|
| P1 | Behavior never lives in a rendered file. ci.yml is byte-identical in every repo; modules are read at run time. | R1 entirely |
| P2 | Fewer derived artifacts beats a better generator. Nothing is generated that then needs a drift check; what remains is written once and copied. | the second model of the text (rules, goldens, smoke) |
| P3 | One run, one order. Everything after the gate is a job in the same run, ordered by `needs`. | cross-workflow races, dispatch tokens |
| P4 | Sync is copy, not merge. | R2 |
| P5 | Private is private by where it runs and by what the run can emit. | R3 |
| P6 | Own as few files as possible. Health files go to the account's `.github` defaults repository (works for a personal account, public and private repos); tool configs ride inside the actions that use them. | most of the 49 files |
| P7 | TypeScript only; a workflow step is one `bun` call. The shell ports are done; the shell that stays is listed in AGENTS.md. | shell-specific failure classes |

Not a principle: "one typed model generates everything". It rebuilds compose + ssot + goldens under a new name. "No migration code" is not one either: rungs that rewrite repo-owned files stay; the bash harness around them goes.

## 4. CI: the skeleton

Decision D1: the CI shape is one managed skeleton with static jobs. A called workflow cannot invoke the caller's `./.github/workflows/*.yml`, so the repo hooks are static jobs in the repo's own ci.yml, not jobs inside a platform workflow. The skeleton is `templates/base/.github/workflows/ci.yml.jinja`; its only variable is the owner slug in the `uses:` lines.

```text
ci.yml (managed, byte-identical fleet-wide except the owner slug)
every job after all-green also requires needs.all-green.result == 'success' and a push to main

  checks:            uses ./.github/workflows/checks.yml         repo hook, static; skipped on the schedule
  ci:                uses fleet-ci.yml@build                     the plan job reads .repo-platform.yml and outputs modules,
                                                                 tracking-labels, ...; every platform check keys its `if` on them
  all-green:         needs [checks, ci], if always()             THE gate: the ruleset's required check
  post-green:        uses ./.github/workflows/post-green.yml     repo hook, static; needs [all-green]
  release:           needs [ci, all-green, post-green]           if post-green succeeded and contains(needs.ci.outputs.modules, '"release-please"')
  update-release:    uses ./.github/workflows/update-release.yml repo hook, static; needs [release]; if release_created; the draft's packaging
  publish-release:   needs [release, update-release]             if release_created; attests the assets (public repos) and flips the draft live
  update-release-pr: uses ./.github/workflows/update-release-pr.yml  repo hook, static; needs [release]; if prs_created; the release PR's files
  pages:             needs [ci, all-green, publish-release]      !cancelled(), if contains(needs.ci.outputs.modules, '"pages"')
  docs-site:         needs [ci, all-green, post-green, publish-release]  !cancelled(), if contains(..., '"docs-site"') and not '"pages"'
```

- The module test is a substring match on the plan's compact JSON array, hence the quoted token: `'"pages"'` cannot match a longer name such as `"pages-site"`.
- Every job that tests the modules output needs `ci` directly, because a job reads outputs only from its direct dependencies.
- The deploys sit behind `publish-release` under `!cancelled()`: a release commit's own deploy serves its new tag, and a skipped or red release still deploys.
- Adding a module: one line in `.repo-platform.yml`, picked up next run. ci.yml does not change. The module data files (the files a module owns beyond ci.yml) still render per selection until the writer of section 6 lands, so the module-render check and the branch sync dispatch it names as the remedy remain until then.
- Adding a leg: one static job in the skeleton plus its platform workflow; the skeleton is a managed file, so that is one sync of one identical file.
- The release hooks' permission ceiling is the contract with the repo-owned hooks: a hook may need up to those grants and narrows itself per job; a narrower ceiling rejects an existing hook that asks for more.
- repo-platform's own ci.yml uses the same shape (deploy = publish the build branch; verify = fleet sync).

## 5. Footprint per repo (P6)

Decision D5: health files move to the account's `.github` defaults repository; tool configs move into the actions that run them; the rest stays a data file per repo.

| Today (49 files) | Target (~14) |
|---|---|
| CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, funding, issue and PR templates | the account's `.github` defaults repository; zero code |
| tool configs (biome, yamllint, typography lists, ...) | inside the action that runs the tool |
| ci.yml with legs | one identical skeleton |
| nightly, fuzzer, dependabot-lockfile, pr-title workflows | one static `fleet.yml` for the non-push triggers, or static jobs in the skeleton |
| LICENSE, .gitignore blocks, .editorconfig, AGENTS.md, skills | stay as data files (managed, split, starter) |
| settings.yml | stays; merged and applied by the settings action |

## 6. Transport for the remaining files (P4)

Decision D2: a copy-not-merge writer, driven by one file list, `files.yml`. No template language. The operator opens a sync PR per repo: managed files are copied whole, split files have their managed region replaced, starter files are written once, retired files are deleted. A rename is one line in `files.yml`.

Rejected:

| Option | Why not |
|---|---|
| deliberate bulk PRs only over an explicit inventory | removes the obligation of uniformity instead of meeting it; the ~14 files drift between sweeps |
| Copier (today) | the three-way merge and everything that polices it (P4) |
| Projen | node in every repo; `GITHUB_TOKEN` PRs need approval, so the required check never lands |

## 7. Private repositories (P5)

Decision D3: the operator stays in this repository, and privacy is a property of the job shape, not of a redaction layer. Job names carry only an index, never a repository name. Repository names and anything derived from them are masked at the boundary where they enter a step. Per-repository logs go to files, not to the console. Details live in the target repository (its sync PR, its check run), never in the public run.

## 8. Settings

Settings leave repo-platform. The settings-as-code action (v3) owns layering: `mode: merge` takes `settings-file` as an ordered list of workspace-relative paths (low to high) and writes `merged-file` with no token and no API call; a second step applies that one document. Dialect: objects key by key, `null` deletes the lower key, `labels` and `rulesets` union by name, every other array replaces; duplicates inside one layer are errors; a `_layering: merge|replace` directive can override per section or per file.

repo-platform keeps only: which layer paths form the list and in what order, the tracking-labels scratch layer (written after the module layers), the "no settings.yml means skip" rule, and a lint that the override layer never touches all-green or integration_id. Deleted here once v3 ships: merge_settings_layers, render_managed_settings, settings_document, build_settings_matrix, select_settings_repos, their tests, and the merge steps of settings-repos.yml.

## 9. Verification (P2)

| Failure class | The one proof |
|---|---|
| a platform check or leg misbehaves | one fixture repo runs the skeleton against `@build` end to end |
| the writer corrupts a repo | one end-to-end sync over a fixture with local edits in every class |
| a function is wrong | its unit test |
| a review wants to see the rendered result | ONE golden kept as a review diff, not as a gate |

Retired: 56 ssot rules, dogfood oracle, smoke x15, upgrade-path harness, rehearse, four of five goldens.

## 10. Kept

actions/all-green (the judge), actions/pages-site (theme and build), fleet-ci.yml and the reusable workflows, build provenance (the green-gated publish), the migration rungs themselves, the manifest and ownership vocabulary (managed, split, starter, retired), module.yml as data, `shared/proc.ts` and `tests/shared/temp_dir.ts`.

## 11. Order of landing (each step deletes more than it adds and is reversible)

| Step | What | Deletes |
|---|---|---|
| 1 | skeleton ci.yml + `plan` job in fleet-ci.yml; one repo (cloud-speech) proves it | 3 leg fragments, anchors, `fragment_conditions`, `fleet_ci_render.ts` + test, 3 rules, 2 goldens: over 3,000 lines |
| 2 | the account's `.github` defaults repository | health files from every repo |
| 3 | tool configs into actions; one static `fleet.yml` | more rendered files, their rules |
| 4 | the writer and `files.yml` | copier, the sync's merge-policing steps, the upgrade harness, the module-render check and its branch dispatch |
| 5 | redaction by job shape | the redaction layer's 32 files' worth |
| 6 | settings action lands; delete the settings code here | ~2,400 lines |

Pass condition for step 1: more than 3,000 lines deleted and fewer than 300 added, cloud-speech's CI green with the same jobs, and zero per-repo variance in ci.yml.

## Appendix: measurements (main at 2a98abda)

| Measure | Today |
|---|---|
| sync workflow steps | 36; about 6 essential |
| ssot rules | 56 in 17 files, 8,511 lines |
| runner jobs per push | about 42 |
| proof layers | 5 plus validator and unit tests |
| committed golden renders | 5 selections, 153 files, 9,506 lines |
| test code | 153 files, about 51,000 lines; about 12,800 test the checkers |
| shell | 19 scripts, 3,724 lines |
| redaction | 32 files |
| repo age | 8 weeks, 565 commits, 31% fixes |

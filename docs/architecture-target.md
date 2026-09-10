# Target architecture, v2

Status: the target the current work implements, step by step (section 11). v2 folds in three independent reviews (a fresh Claude, a second Claude session, Codex) and the owner's correction that the metric is the cost of a simple change, not past incidents.

## 1. The measure

| Simple change | Today | Target |
|---|---|---|
| add a CI leg for a module (PR #146) | 62 files, +2,755 lines, 11 checkers that can go red, then one sync PR per repo | 1 workflow + 1 test, 0 fleet PRs |
| rename a managed file | ~12 files + a migration rung + a harness case | 1 line in the file list |
| change a setting default | layer file + merge code + tests here | layer file only (the merge lives in the settings action) |
| platform-written files per repo | 49 | ~14 |
| runner jobs per push here | ~42 | ~12 |
| checker layers that pin other files' text | 56 rules, 5 goldens, smoke x15, bash harness | 0 rules; unit tests + one end-to-end test |

## 2. Root cause (all three reviews agree)

Variability is resolved at RENDER time into per-repo text, and that text is then held correct by a second hand-written model of the same text (ssot rules, smoke greps, goldens, the bash harness). Every change is written twice and can go red in each checker independently. Three choices cause it:

| | Choice today | Consequence |
|---|---|---|
| R1 | CI behavior lives in rendered per-repo workflow text | fragments, anchors, conditions, leg rules, goldens, a fleet sync per behavior change |
| R2 | Copier's three-way merge is the transport | 14 of 36 sync steps exist to undo or police the merge; rungs; the upgrade harness |
| R3 | a public operator pushes into private repos | redaction in 32 files, hidden reports, masked outputs |

## 3. Principles, v2 (each named by the cost it removes)

| # | Principle | Removes |
|---|---|---|
| P1 | Behavior never lives in a rendered file. ci.yml is byte-identical in every repo; modules are read at run time. | R1 entirely |
| P2 | Fewer derived artifacts beats a better generator. Nothing is generated that then needs a drift check; what remains is written once and copied. | the second model of the text (rules, goldens, smoke) |
| P3 | One run, one order. Everything after the gate is a job in the same run, ordered by `needs`. | cross-workflow races, dispatch tokens |
| P4 | Sync is copy, not merge. | R2 |
| P5 | Private is private by where it runs. | R3 |
| P6 | Own as few files as possible. Health files go to a `Vivswan/.github` defaults repo (works for a personal account, public and private repos); tool configs ride inside the actions that use them. | most of the 49 files |
| P7 | TypeScript only; a workflow step is one `bun` call. | shell-specific failure classes |

Dropped from v1: "one typed model generates everything" (all three reviews: that rebuilds compose + ssot + goldens under a new name). "No migration code" (rungs that rewrite repo-owned files stay; the bash harness around them goes).

## 4. CI: the skeleton (corrected)

Correction from review: a called workflow cannot invoke the caller's `./.github/workflows/*.yml`, so repo hooks are static jobs in the repo's own ci.yml, not inside a platform workflow.

```text
ci.yml (managed, byte-identical fleet-wide except the owner slug)

  ci:        uses fleet-ci.yml@build      first job `plan` reads .repo-platform.yml -> outputs modules, private, ...
                                          every platform check keys its `if` on those outputs
  checks:    uses ./.github/workflows/checks.yml            (repo hook, static)
  all-green: needs [ci, checks]

  release:   needs all-green, if contains(needs.ci.outputs.modules, 'release-please')
  pages:     needs [all-green, release], !cancelled(), if contains(..., 'pages')
  docs-site: needs [all-green, release], !cancelled(), if contains(..., 'docs-site')
  post-green: uses ./.github/workflows/post-green.yml       (repo hook, static)
```

- Adding a module: one line in `.repo-platform.yml`, picked up next run. No render, no `module-render` check, no branch dispatch (#145's feature is dead under P1).
- Adding a leg: one static job in the skeleton plus its platform workflow; the skeleton is a managed file, so that is one sync of one identical file.
- repo-platform's own ci.yml uses the same shape (deploy = publish the build branch; verify = fleet sync).

## 5. Footprint per repo (P6)

| Today (49 files) | Target (~14) |
|---|---|
| CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, funding, issue and PR templates | `Vivswan/.github` defaults repo; zero code, one day |
| tool configs (biome, yamllint, typography lists, ...) | inside the action that runs the tool |
| ci.yml with legs | one identical skeleton |
| nightly, fuzzer, dependabot-lockfile, pr-title workflows | one static `fleet.yml` for the non-push triggers, or static jobs in the skeleton |
| LICENSE, .gitignore blocks, .editorconfig, AGENTS.md, skills | stay as data files (managed, split, starter) |
| settings.yml | stays; merged and applied by the settings action |

## 6. Transport for the remaining files (D2, the real fork)

| Option | How a change reaches a repo | Owns | Reviews |
|---|---|---|---|
| copy-not-merge writer (~600 lines, no template language) | operator opens a sync PR: managed whole, split region, starter once, retired delete | continuous uniformity of ~14 files | recommended by both Claude reviews |
| deliberate bulk PRs only (Codex, direction F) | rare, scoped bulk PRs over an explicit inventory; repos own their prose in between | nothing continuously | recommended by Codex: removes the obligation instead of re-implementing it |
| Copier (today) | three-way merge | the merge and everything that polices it | ruled out by P4 |
| Projen | per-repo synth on a package bump | node in every repo; `GITHUB_TOKEN` PRs need approval so the required check never lands | rejected by all three |

## 7. Private repositories (P5)

Small private ops repo holding the PAT and the two operator workflows, calling scripts from `@build`. Alternative offered by one review: run the operator from the laptop until that hurts. Either way the redaction layer is deleted.

## 8. Settings

Settings leave repo-platform. The settings-as-code action (v3, approved, being built) owns layering: `mode: merge` takes `settings-file` as an ordered list of workspace-relative paths (low to high) and writes `merged-file` with no token and no API call; a second step applies that one document. Dialect: objects key by key, `null` deletes the lower key, `labels` and `rulesets` union by name, every other array replaces; duplicates inside one layer are errors; a `_layering: merge|replace` directive can override per section or per file.

repo-platform keeps only: which layer paths form the list and in what order, the tracking-labels scratch layer (written after the module layers), the "no settings.yml means skip" rule, and a lint that the override layer never touches all-green or integration_id. Deleted here once v3 ships: merge_settings_layers, render_managed_settings, settings_document, build_settings_matrix, select_settings_repos, their tests, and the merge steps of settings-repos.yml.

## 9. Verification (P2)

| Failure class | The one proof |
|---|---|
| a platform check or leg misbehaves | one fixture repo runs the skeleton against `@build` end to end |
| the writer corrupts a repo | one end-to-end sync over a fixture with local edits in every class |
| a function is wrong | its unit test |
| a review wants to see the rendered result | ONE golden kept as a review diff, not as a gate |

Retired: 56 ssot rules, dogfood oracle, smoke x15, upgrade-path harness, rehearse, four of five goldens.

## 10. Worth keeping under any direction (from the reviews)

actions/all-green (the judge), actions/pages-site (theme and build), fleet-ci.yml and the reusable workflows, build provenance (the green-gated publish), the migration rungs themselves, the manifest and ownership vocabulary (managed, split, starter, retired), module.yml as data, `shared/proc.ts` and `tests/shared/temp_dir.ts`.

## 11. Order of work (each step deletes more than it adds and is reversible)

| Step | What | Size | Deletes |
|---|---|---|---|
| 1 | skeleton ci.yml + `plan` job in fleet-ci.yml; one repo (cloud-speech) proves it | 1 week | 3 leg fragments, anchors, `fragment_conditions`, `fleet_ci_render.ts` + test, 3 rules, 2 goldens, #145's module-render and branch dispatch: over 3,000 lines |
| 2 | `Vivswan/.github` defaults repo | 1 day | health files from every repo |
| 3 | tool configs into actions; one static `fleet.yml` | 1 week | more rendered files, their rules |
| 4 | decide D2; build the writer or the bulk-PR inventory | 2 weeks | copier, the sync's merge-policing steps, the upgrade harness |
| 5 | private ops repo; delete redaction | 2 days | 32 files' worth |
| 6 | settings action lands; delete the settings code here | with that repo | ~2,400 lines |

Pass condition for step 1: more than 3,000 lines deleted and fewer than 300 added, cloud-speech's CI green with the same jobs, and zero per-repo variance in ci.yml.

## 12. Open decisions

| # | Decision | Lean after review |
|---|---|---|
| D1 | CI shape | skeleton with static jobs (all three agree) |
| D2 | transport for the remaining files: continuous writer vs bulk PRs | the fork to discuss; Claude reviews say writer, Codex says bulk PRs |
| D3 | private operator: ops repo vs laptop | ops repo |
| D4 | bash ports in flight | owner said finish all five; one review says the two harness ports are dead work under step 4 |
| D5 | what stays a data file per repo vs moves into `.github` defaults or actions | inventory in step 2 |

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

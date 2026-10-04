# Sync

This page is the entry to the sync's contract: the writer that copies the platform's files into a managed repository, the operator that runs it against the fleet, and what the public log keeps out for private repositories. Each subject has one page below; code is the source of truth, and the pages are the map.

The writer reads one data file, `files.yml`, and one tree of plain files, `files/`. There is no template language and no merge:

| What the writer writes | How it is written |
| --- | --- |
| managed content | copied whole |
| split regions | copied between the repository-owned halves |
| starters | copied once |
| mirrors | carry a written file to more paths as copies or relative symlinks |

The one file the writer renders instead of copying is `.github/settings.yml`, folded from the settings layers and the repository's own overlay ([settings.md](../../settings.md)).

## Find the page for your question

- **What may `files.yml` say, and which entries apply to one repository?** [The file list](files.md): the grammar, module data, what the loader refuses, upstream refs, placeholders, selection.
- **How is each class written, what holds the PR, and how does a file leave?** [The writer](writer.md): the command, classes, class flips, retirement, migrations, the report.
- **How is a written file carried to more paths?** [Mirrors](mirrors.md): what fleet CI's `plan` step refuses on the PR, what the writer refuses or reports.
- **What does the manifest record, and at which commit is a repository judged?** [The manifest](manifest.md): the records, when the judged commit moves, the managed files check.
- **How does the fleet run reach a repository, a branch, or a labeled pull request?** [The operator](operator.md): the row jobs, delivery, the branch dispatch, the label.
- **What stays out of the public log for a private repository?** [Private repositories](private-repositories.md): the four rules, what a run still shows, where the model stops.

## Find the code behind a rule

| Question | Owner |
| --- | --- |
| What does `files.yml` look like, and what does the loader refuse? | [actions/plan/files_config.ts](../../../actions/plan/files_config.ts), the grammar every reader shares (the writer, the fleet plan, the checks); the writer's own checks against the `files/` tree and the placeholder defaults are in [sync/writer/files_config.ts](../../../.github/scripts/sync/writer/files_config.ts) |
| Which placeholder tokens exist? | `PLACEHOLDER_NAMES` in [sync/writer/placeholders.ts](../../../.github/scripts/sync/writer/placeholders.ts) |
| How are the values derived from `.repo-platform.yml`? | [sync/writer/registration.ts](../../../.github/scripts/sync/writer/registration.ts) |
| Which entries apply to one repository? | `selects` in [actions/shared/selection.ts](../../../actions/shared/selection.ts), the one rule the writer, the fleet plan, and the validator select by; `selectEntries` in [actions/plan/files_config.ts](../../../actions/plan/files_config.ts) |
| How is each class written? | [sync/writer/write_managed.ts](../../../.github/scripts/sync/writer/write_managed.ts), [write_split.ts](../../../.github/scripts/sync/writer/write_split.ts), [write_starter.ts](../../../.github/scripts/sync/writer/write_starter.ts); the mirrors, the fleet's and the repository's, by [mirrors.ts](../../../.github/scripts/sync/writer/mirrors.ts) |
| Where do blocks land, and what may a value contain? | `spliceBlocks` and `substitute` in [sync/writer/placeholders.ts](../../../.github/scripts/sync/writer/placeholders.ts) |
| What happens when an entry's class differs from its record? | `writeEntry` in [sync/writer/sync.ts](../../../.github/scripts/sync/writer/sync.ts) |
| How is `.github/settings.yml` rendered? | [sync/writer/settings_entry.ts](../../../.github/scripts/sync/writer/settings_entry.ts) over [settings_layers.ts](../../../.github/scripts/sync/writer/settings_layers.ts), which folds with the github-settings-as-code library ([settings.md](../../settings.md)) |
| When does a file the platform stopped writing leave? | [sync/writer/retire.ts](../../../.github/scripts/sync/writer/retire.ts) |
| What does the manifest record? | [sync/writer/manifest.ts](../../../.github/scripts/sync/writer/manifest.ts) |
| What holds a PR for review? | `holdReasons` in [sync/writer/report.ts](../../../.github/scripts/sync/writer/report.ts) |
| The whole run, as a CLI | [sync/writer/sync.ts](../../../.github/scripts/sync/writer/sync.ts) |

## This repository as a target

The sync targets this repository like any other: its [.repo-platform.yml](../../../.repo-platform.yml) registers it, and the writer keeps its root copies of the files it ships (`.editorconfig`, the `.gitignore` region, `LICENSE.md`, the `AGENTS.md` region, the rendered `.github/settings.yml`, the links) by sync PR, recorded in its own manifest.

- **Its `except`:** the paths whose file is this repository's own and cannot be the fleet's (its `ci.yml`, `dependabot.yml`, `.yamllint`, and the starters it does not take).
- **Its CI** runs the [plan action](../../../actions/plan/action.yml) over the registration and then the [validate-managed-files action](../../../actions/validate-managed-files/action.yml) from the checkout, as fleet CI does: this checkout's action shell runs, the recorded commit's `check.ts` judges. A PR that changes `files/` stays green until this repository syncs itself.
- **Its `.yamllint`** ignores `files`, so the writer's templates (placeholder tokens, not YAML) are outside the hygiene scan as they are outside yamllint.

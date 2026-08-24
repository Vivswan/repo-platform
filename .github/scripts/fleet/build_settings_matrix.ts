// Builds the per-repo apply matrix for settings-repos.yml: one entry per
// managed settings target, each carrying its home, so the workflow can
// run one fail-fast-free matrix job per repository and one target's
// failure never blocks the heal for the others.
//
// Usage:
//   bun .github/scripts/fleet/build_settings_matrix.ts --owner Vivswan
//     --in-repo in_repo_targets.json [--dir settings/repos]
//     [--only owner/name]
//
// Central targets come from the <name>.yml files in --dir (bare names,
// same owner - the layout docs/settings.md documents); in-repo targets
// from --in-repo, a JSON array of the selector's enriched rows
// ({repo, redact_name, hide_details, display, verify, ...}). Prints a
// JSON array of {repo, name, home, redact_name, verify}
// entries, home = "central" | "in-repo", sorted by the emitted repo; a
// repository with both homes gets one central entry (the central file
// wins - matched on the REAL slug, which a redacted row then drops:
// `repo`/`name` carry its display hint so the matrix, the job name it
// becomes, and the called steps never see the slug; the apply leg
// re-resolves it from `verify`). Central names are committed filenames,
// self-disclosed by definition, and always print plainly.
// Errors are selection-infrastructure failures and exit 1: unlike a
// flaky per-repo probe, a central file the matrix cannot represent
// (.yaml suffix, an owner subdirectory) would otherwise silently fall
// out of every apply.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "../shared/flags.ts";
import { fail } from "../shared/gha.ts";
import { type EnrichedRow, parseEnrichedRows } from "./redact.ts";

// No hide_details here: unlike the sync matrix, the apply leg has no
// consumer for it (the action's own private-repos redaction covers its
// output, and the central preflight probes visibility itself).
export interface Target {
  repo: string;
  name: string;
  home: "central" | "in-repo";
  redact_name: boolean;
  verify: string;
}

/** Central targets from a repos-dir listing. Entries that would never
 *  reach a per-repo apply job are errors, not skips: before the matrix
 *  split they were part of the one full-dir invocation, so ignoring
 *  them here would silently unmanage a repo. */
export function centralTargets(
  owner: string,
  entries: { name: string; isDirectory: boolean }[],
  dir: string,
): { targets: Target[]; errors: string[] } {
  const targets: Target[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      errors.push(
        `${path}: owner subdirectories are not supported here - the per-repo apply ` +
          `matrix scopes central files by <name>.yml (same owner); move the files up`,
      );
      continue;
    }
    if (entry.name.endsWith(".yaml")) {
      errors.push(
        `${path}: central settings files must use the .yml suffix - a .yaml file ` +
          `would silently fall outside every check keyed on <name>.yml; rename it`,
      );
      continue;
    }
    if (!entry.name.endsWith(".yml")) continue;
    const name = entry.name.slice(0, -".yml".length);
    targets.push({
      repo: `${owner}/${name}`,
      name,
      home: "central",
      redact_name: false,
      verify: "",
    });
  }
  return { targets, errors };
}

/** Merge central and in-repo targets into the matrix: central wins on a
 *  duplicate slug (the selector already drops such repos from its list,
 *  but the matrix must hold the invariant on its own; the comparison
 *  uses each in-repo row's REAL slug, before a redacted row swaps its
 *  display in). */
export function buildMatrix(central: Target[], inRepo: EnrichedRow[]): Target[] {
  // Slug comparisons are case-insensitive, like GitHub's.
  const centralRepos = new Set(central.map((t) => t.repo.toLowerCase()));
  const targets = [...central];
  const seen = new Set<string>();
  for (const row of inRepo) {
    const key = row.repo.toLowerCase();
    if (centralRepos.has(key) || seen.has(key)) continue;
    seen.add(key);
    const emitted = row.redact_name ? row.display : row.repo;
    targets.push({
      repo: emitted,
      name: row.redact_name ? row.display : (row.repo.split("/").pop() ?? row.repo),
      home: "in-repo",
      redact_name: row.redact_name,
      verify: row.verify,
    });
  }
  return targets.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
}

/** Scope both target lists to one repository (real owner/name slug,
 *  case-insensitive) for single-repo dispatch runs. Redaction has not
 *  happened yet - in-repo rows still carry the real slug - so a private
 *  target is matchable here and redacted as usual afterwards. */
export function applyOnly(
  central: Target[],
  inRepo: EnrichedRow[],
  only: string,
): { central: Target[]; inRepo: EnrichedRow[] } {
  const wanted = only.toLowerCase();
  return {
    central: central.filter((t) => t.repo.toLowerCase() === wanted),
    inRepo: inRepo.filter((r) => r.repo.toLowerCase() === wanted),
  };
}

function loadInRepoRows(path: string): EnrichedRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    fail([`${path}: cannot read the in-repo target list`]);
  }
  return parseEnrichedRows(parsed, `${path}: in-repo target list`);
}

function main(args: string[]): void {
  const flags = parseFlags(args, ["--owner", "--in-repo"], ["--dir", "--only"]);
  const dir = flags["--dir"] ?? "settings/repos";

  let listing: { name: string; isDirectory: boolean }[];
  try {
    listing = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    fail([`${dir}: cannot read the central settings directory`]);
  }

  let central: Target[];
  {
    const result = centralTargets(flags["--owner"], listing, dir);
    if (result.errors.length > 0) fail(result.errors);
    central = result.targets;
  }
  let inRepo = loadInRepoRows(flags["--in-repo"]);
  const only = flags["--only"] ?? "";
  if (only !== "") ({ central, inRepo } = applyOnly(central, inRepo, only));
  console.log(JSON.stringify(buildMatrix(central, inRepo)));
}

if (import.meta.main) {
  main(process.argv.slice(2));
}

// Builds the per-repo apply matrix for settings-repos.yml: one entry per
// managed settings target, each carrying its home, so the workflow can
// run one fail-fast-free matrix job per repository and one target's
// failure never blocks the heal for the others.
//
// Usage:
//   bun .github/scripts/fleet/build_settings_matrix.ts --owner Vivswan
//     --in-repo in_repo_targets.txt [--dir settings/repos]
//
// Central targets come from the <name>.yml files in --dir (bare names,
// same owner - the layout docs/settings.md documents); in-repo targets
// from --in-repo, a file of newline-separated owner/name slugs (the
// selector's probed list). Prints a JSON array of {repo, name, home}
// entries, home = "central" | "in-repo", sorted by repo; a repository
// with both homes gets one central entry (the central file wins).
// Errors are selection-infrastructure failures and exit 1: unlike a
// flaky per-repo probe, a central file the matrix cannot represent
// (.yaml suffix, an owner subdirectory) would otherwise silently fall
// out of every apply.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "../shared/flags.ts";

export interface Target {
  repo: string;
  name: string;
  home: "central" | "in-repo";
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
    targets.push({ repo: `${owner}/${name}`, name, home: "central" });
  }
  return { targets, errors };
}

/** Merge central and in-repo targets into the matrix: central wins on a
 *  duplicate slug (the selector already drops such repos from its list,
 *  but the matrix must hold the invariant on its own). */
export function buildMatrix(central: Target[], inRepoSlugs: string[]): Target[] {
  const centralRepos = new Set(central.map((t) => t.repo));
  const targets = [...central];
  const seen = new Set<string>();
  for (const slug of inRepoSlugs) {
    if (centralRepos.has(slug) || seen.has(slug)) continue;
    seen.add(slug);
    targets.push({ repo: slug, name: slug.split("/").pop() ?? slug, home: "in-repo" });
  }
  return targets.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
}

function fail(errors: string[]): never {
  for (const message of errors) {
    console.error(`::error::${message}`);
  }
  process.exit(1);
}

function main(args: string[]): void {
  const flags = parseFlags(args, ["--owner", "--in-repo"], ["--dir"]);
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
  let inRepoText: string;
  try {
    inRepoText = readFileSync(flags["--in-repo"], "utf-8");
  } catch {
    fail([`${flags["--in-repo"]}: cannot read the in-repo target list`]);
  }

  const { targets: central, errors } = centralTargets(flags["--owner"], listing, dir);
  if (errors.length > 0) fail(errors);
  const slugs = inRepoText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  console.log(JSON.stringify(buildMatrix(central, slugs)));
}

if (import.meta.main) {
  main(process.argv.slice(2));
}

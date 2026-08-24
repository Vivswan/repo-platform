// Retired-file cleanup for the push sync: `copier update` deletes
// unmodified files that leave the render, but a locally MODIFIED removed
// file becomes a conflict and can survive the update. This script computes
// the deletion candidates from two clean renders of the template: paths
// present in the OLD render and absent from the NEW render, minus the
// union of both template versions' `_skip_if_exists` lists (generated-once,
// repo-owned files survive even across a list change). Paths the template
// never rendered - repo source code, repo-owned workflows - cannot appear.
// A formerly rendered path that the repo repurposed after the template
// retired it IS a candidate; the sync lists every removal in the PR body
// for review.
//
// Usage:
//   bun .github/scripts/sync/retired_paths.ts --old-render <dir> --new-render <dir>
//     --old-copier <copier.yml> --new-copier <copier.yml>
//
// Prints the candidate paths (relative to the render roots) as a sorted
// JSON array on stdout. Errors print as ::error:: workflow commands (on
// stdout, where the runner parses them) and the exit code is nonzero.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { parseFlags } from "../shared/flags.ts";
import { fail } from "../shared/gha.ts";
import { parseModules } from "../shared/modules.ts";

// Relative paths of every file and symlink under root (directories are
// implicit); symlinks are never followed.
export function listRenderPaths(root: string): Set<string> {
  const paths = new Set<string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") {
        continue;
      }
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(join(dir, entry.name), rel);
      } else {
        paths.add(rel);
      }
    }
  };
  walk(root, "");
  return paths;
}

// Repo-owned wherever they exist: never deletion candidates even when a
// module selection removes them from the render. settings.yml is applied
// remotely by settings-repos regardless of who renders it. The license
// files are protected only on the custom-license module: there the
// repo's own replacement license (either spelling) must survive the
// de-render, while a fleet repo's license is template-managed - its old
// extensionless LICENSE must be deletable across the LICENSE.md rename.
export function protectedPaths(modules: readonly string[]): ReadonlySet<string> {
  return modules.includes("custom-license")
    ? new Set([".github/settings.yml", "LICENSE", "LICENSE.md"])
    : new Set([".github/settings.yml"]);
}

// A repo dropping the custom-license module still carries its own
// repo-owned license file, which no clean render of either version
// contains - retired-path diffing cannot see it, and the incoming fleet
// LICENSE.md would land alongside (or clobber) terms the sync cannot
// reconcile, in a PR that could otherwise auto-merge. The flip is a
// deliberate human act in the target repo, so the sync fails with
// instructions instead of deleting a license file it does not manage.
// Recovery mode (recover=recopy) skips retired cleanup and this guard
// with it; a recopy PR is always manual-review, so the human sees the
// whole diff there.
export function customLicenseFlipError(
  oldModules: readonly string[],
  newModules: readonly string[],
  presentLicenses: readonly string[],
): string | null {
  if (!oldModules.includes("custom-license") || newModules.includes("custom-license")) {
    return null;
  }
  if (presentLicenses.length === 0) {
    return null;
  }
  return (
    `this update drops the custom-license module, but ${presentLicenses.join(" and ")} from ` +
    "the custom-license era still exists in the repo; the fleet LICENSE.md would land beside " +
    "license terms the sync cannot reconcile. Delete the old license in the same commit that " +
    "removes the module from .repo-platform.yml (git history remains the record of prior " +
    "licensing; third-party notices can move below LICENSE.md's local-section marker), then " +
    "re-run the sync."
  );
}

// Candidate deletions: in the old render, gone from the new render, not
// protected, and not matched by any `_skip_if_exists` pattern from either
// version.
export function retiredPaths(
  oldPaths: ReadonlySet<string>,
  newPaths: ReadonlySet<string>,
  skipPatterns: readonly string[],
  modules: readonly string[],
): string[] {
  const globs = skipPatterns.map((pattern) => new Bun.Glob(pattern));
  const protectedSet = protectedPaths(modules);
  return [...oldPaths]
    .filter(
      (path) =>
        !newPaths.has(path) && !protectedSet.has(path) && !globs.some((glob) => glob.match(path)),
    )
    .sort();
}

// Read a copier.yml's `_skip_if_exists` list (absent = empty).
export function readSkipIfExists(
  data: unknown,
  label = "copier.yml",
): { patterns: string[] | null; errors: string[] } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { patterns: null, errors: [`${label}: top level must be a mapping`] };
  }
  const raw = (data as Record<string, unknown>)._skip_if_exists;
  if (raw === undefined) {
    return { patterns: [], errors: [] };
  }
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === "string" && entry !== "")) {
    return {
      patterns: null,
      errors: [`${label}: _skip_if_exists must be a list of path patterns`],
    };
  }
  return { patterns: raw, errors: [] };
}

function skipPatternsFrom(path: string): string[] {
  let data: unknown;
  try {
    data = parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    fail([`${path}: cannot read as YAML: ${detail}`]);
  }
  const { patterns, errors } = readSkipIfExists(data, path);
  if (patterns === null) {
    fail(errors);
  }
  return patterns;
}

function requireDir(path: string): string {
  try {
    if (statSync(path).isDirectory()) {
      return path;
    }
  } catch {
    // fall through to the error below
  }
  fail([`${path}: not a directory`]);
}

function main(args: string[]): void {
  const flags = parseFlags(args, [
    "--old-render",
    "--new-render",
    "--old-copier",
    "--new-copier",
    "--modules",
  ]);

  const oldPaths = listRenderPaths(requireDir(flags["--old-render"]));
  const newPaths = listRenderPaths(requireDir(flags["--new-render"]));
  const skipPatterns = [
    ...skipPatternsFrom(flags["--old-copier"]),
    ...skipPatternsFrom(flags["--new-copier"]),
  ];
  const modules = parseModules(flags["--modules"]);
  if (modules === null) {
    fail([`--modules must be a JSON list of strings: ${flags["--modules"]}`]);
  }
  console.log(JSON.stringify(retiredPaths(oldPaths, newPaths, skipPatterns, modules)));
}

if (import.meta.main) {
  main(process.argv.slice(2));
}

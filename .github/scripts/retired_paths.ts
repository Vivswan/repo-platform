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
//   bun .github/scripts/retired_paths.ts --old-render <dir> --new-render <dir>
//     --old-copier <copier.yml> --new-copier <copier.yml>
//
// Prints the candidate paths (relative to the render roots) as a sorted
// JSON array on stdout. Errors go to stderr as ::error:: workflow commands
// and the exit code is nonzero.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

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

// Candidate deletions: in the old render, gone from the new render, and
// not matched by any `_skip_if_exists` pattern from either version.
export function retiredPaths(
  oldPaths: ReadonlySet<string>,
  newPaths: ReadonlySet<string>,
  skipPatterns: readonly string[],
): string[] {
  const globs = skipPatterns.map((pattern) => new Bun.Glob(pattern));
  return [...oldPaths]
    .filter((path) => !newPaths.has(path) && !globs.some((glob) => glob.match(path)))
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

function fail(errors: string[]): never {
  for (const message of errors) {
    console.error(`::error::${message}`);
  }
  process.exit(1);
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

function parseFlags(args: string[], allowed: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!allowed.includes(flag) || value === undefined) {
      fail([`unknown or valueless argument "${flag}" - allowed flags: ${allowed.join(", ")}`]);
    }
    flags.set(flag, value);
  }
  return flags;
}

function main(args: string[]): void {
  const flags = parseFlags(args, ["--old-render", "--new-render", "--old-copier", "--new-copier"]);
  const missing = ["--old-render", "--new-render", "--old-copier", "--new-copier"].filter(
    (flag) => !flags.has(flag),
  );
  if (missing.length > 0) {
    fail([`missing required flags: ${missing.join(", ")}`]);
  }

  const oldPaths = listRenderPaths(requireDir(flags.get("--old-render")!));
  const newPaths = listRenderPaths(requireDir(flags.get("--new-render")!));
  const skipPatterns = [
    ...skipPatternsFrom(flags.get("--old-copier")!),
    ...skipPatternsFrom(flags.get("--new-copier")!),
  ];
  console.log(JSON.stringify(retiredPaths(oldPaths, newPaths, skipPatterns)));
}

if (import.meta.main) {
  main(process.argv.slice(2));
}

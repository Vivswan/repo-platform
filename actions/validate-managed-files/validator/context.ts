import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "dist",
  "build",
  "coverage",
  "htmlcov",
  "__pycache__",
  ".output",
  ".wxt",
  ".astro",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
]);

export interface Context {
  root: string;
  /** Every regular file below root, sorted, relative paths. */
  files: readonly string[];
}

/** --directory reports an ignored directory collapsed, so the walk prunes it without ever descending (.claude/worktrees/
 *  holds whole checkouts). null when git cannot answer (no git on PATH, or root is not a checkout): the honest reading
 *  of a plain tree is that nothing is ignored. */
function gitIgnored(root: string): { dirs: Set<string>; files: Set<string> } | null {
  const proc = spawnSync(
    "git",
    ["-C", root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (proc.error || proc.status !== 0) return null;
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const entry of proc.stdout.split("\0")) {
    if (entry === "") continue;
    if (entry.endsWith("/")) dirs.add(entry.slice(0, -1));
    else files.add(entry);
  }
  return { dirs, files };
}

function walk(root: string, ignored: ReturnType<typeof gitIgnored>): string[] {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (SKIP_DIRS.has(name)) continue;
      const stat = lstatSync(join(root, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!ignored?.dirs.has(childRel)) visit(childRel);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        if (!ignored?.files.has(childRel)) found.push(childRel);
      }
    }
  };
  visit("");
  return found.sort();
}

/** The sync writer's source tree: its files carry `{{placeholder}}` tokens
 *  and are not YAML before substitution, so self mode leaves them to the
 *  writer's own loader. */
const WRITER_SOURCES = "files/";

/** Managed repositories walk every path: they are validated as plain trees and everything in them is content. Self mode
 *  (the operator's own checkout) skips gitignored paths, which carry working state (agent worktrees with in-progress
 *  rebases) that is not the repository's content. */
export function loadContext(root: string, self: boolean): Context {
  return {
    root,
    files: self
      ? walk(root, gitIgnored(root)).filter((rel) => !rel.startsWith(WRITER_SOURCES))
      : walk(root, null),
  };
}

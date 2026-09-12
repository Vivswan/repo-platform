import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MANIFEST_NAME,
  type ManifestEntryShape,
  parseManifestFiles,
} from "../../shared/manifest.ts";
import { hasConflictMarker, isRecord, isRegularFile, shapeOfYaml } from "./readers.ts";

export const REGISTRATION_PATH = ".repo-platform.yml";

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

export type Manifest =
  | { state: "absent" }
  /** Conflict-marked text is the conflict-marker check's report; the shared
   *  parser would resolve the blocks toward one side, and this validator
   *  must never quietly read one side of a conflicted manifest. */
  | { state: "conflicted" }
  | { state: "malformed"; problem: string }
  | { state: "parsed"; files: Record<string, ManifestEntryShape> };

/** The module vocabulary files.yml declares (its `modules` keys), or the
 *  reason it could not be read: the registration check reports that once,
 *  and the module names then stand unjudged. */
export type ModuleVocabulary = { modules: ReadonlySet<string> } | { problem: string };

/** Every cross-check dependency (a missing modules list, a conflicted manifest, self mode) is a field here, never an
 *  ordering between checks. */
export interface Context {
  mode: "self" | "render";
  root: string;
  /** Every regular file below root, sorted, relative paths. */
  files: readonly string[];
  /** .repo-platform.yml's top-level `modules` value as written (undefined
   *  when the key is missing, null when the document is not a mapping);
   *  the record is null when the file is absent. */
  registration: { modules: unknown } | null;
  vocabulary: ModuleVocabulary;
  manifest: Manifest;
}

function loadRegistration(root: string): { modules: unknown } | null {
  const path = join(root, REGISTRATION_PATH);
  if (!isRegularFile(path)) return null;
  let data: unknown = {};
  try {
    data = shapeOfYaml(readFileSync(path, "utf-8")) ?? {};
  } catch {
    data = {};
  }
  return { modules: isRecord(data) ? data.modules : null };
}

function loadVocabulary(filesConfig: string): ModuleVocabulary {
  if (!isRegularFile(filesConfig)) {
    return { problem: `${filesConfig}: the module data file is missing` };
  }
  let data: unknown;
  try {
    data = shapeOfYaml(readFileSync(filesConfig, "utf-8"));
  } catch {
    return { problem: `${filesConfig}: the module data file does not parse as YAML` };
  }
  const modules = isRecord(data) ? data.modules : undefined;
  if (!isRecord(modules)) {
    return { problem: `${filesConfig}: the module data file carries no modules mapping` };
  }
  return { modules: new Set(Object.keys(modules)) };
}

function loadManifest(root: string): Manifest {
  const path = join(root, MANIFEST_NAME);
  if (!isRegularFile(path)) return { state: "absent" };
  const text = readFileSync(path, "utf-8");
  if (hasConflictMarker(text)) return { state: "conflicted" };
  const parsed = parseManifestFiles(text);
  if (parsed.problem !== null) return { state: "malformed", problem: parsed.problem };
  return { state: "parsed", files: parsed.files };
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
 *  skips gitignored paths: the operator checkout carries gitignored working state (agent worktrees with in-progress
 *  rebases) that is not the repository's content. */
export function loadContext(root: string, selfMode: boolean, filesConfig: string): Context {
  return {
    mode: selfMode ? "self" : "render",
    root,
    files: selfMode
      ? walk(root, gitIgnored(root)).filter((rel) => !rel.startsWith(WRITER_SOURCES))
      : walk(root, null),
    registration: loadRegistration(root),
    vocabulary: loadVocabulary(filesConfig),
    manifest: loadManifest(root),
  };
}

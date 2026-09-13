import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ManifestEntryShape, parseManifestFiles } from "../../shared/manifest.ts";
import { MANIFEST_NAME, REGISTRATION_PATH } from "../../shared/platform.ts";
import { pathProblem } from "../../shared/repo_path.ts";
import { applies, type Selection, type When } from "../../shared/selection.ts";
import { hasConflictMarker, isRecord, isRegularFile, shapeOfYaml } from "./readers.ts";
import { whenOf } from "./when_of.ts";

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

/** A manifest key the sync would never write (`./x`, `a//b`, a traversal), with pathProblem's reason. Read as a
 *  record, a traversal key's hash would come from outside the root, and `./x` resolves to a declared file while
 *  matching no declaration. */
export interface RefusedKey {
  key: string;
  problem: string;
}

export type Manifest =
  | { state: "absent" }
  /** Conflict-marked text is the conflict-marker check's report; the shared
   *  parser would resolve the blocks toward one side, and this validator
   *  must never quietly read one side of a conflicted manifest. */
  | { state: "conflicted" }
  | { state: "malformed"; problem: string }
  | {
      state: "parsed";
      records: Record<string, ManifestEntryShape>;
      refused: readonly RefusedKey[];
    };

export interface Declaration {
  path: string;
  class: string;
  when: When | null;
}

/** The problem is reported once, by checks/registration.ts; every other reader leaves the data unjudged. */
export type Vocabulary =
  | { modules: ReadonlySet<string>; files: readonly Declaration[] }
  | { problem: string };

export type Target = { mode: "self" } | { mode: "render"; private: boolean };

/** Every cross-check dependency (a missing modules list, a conflicted manifest, self mode) is a field here, never an
 *  ordering between checks. */
export interface Context {
  mode: "self" | "render";
  root: string;
  /** Every regular file below root, sorted, relative paths. */
  files: readonly string[];
  /** The registration's top-level `modules` value as written (undefined
   *  when the key is missing, null when the document is not a mapping);
   *  the record is null when the file is absent. */
  registration: { modules: unknown } | null;
  vocabulary: Vocabulary;
  /** The class files.yml writes each path under for THIS repository, by the
   *  one selection rule: a path whose declarations are all deselected
   *  is absent here as it is from the writer's reservations (ownedPaths in
   *  actions/plan/mirrors.ts). null when the registration or the data file
   *  leaves the selection unknown. */
  classes: ReadonlyMap<string, string> | null;
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

function loadVocabulary(filesConfig: string): Vocabulary {
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
  const files = isRecord(data) ? data.files : undefined;
  if (!Array.isArray(files)) {
    return { problem: `${filesConfig}: the module data file carries no files list` };
  }
  const declarations: Declaration[] = [];
  for (const entry of files) {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.class !== "string") {
      return {
        problem: `${filesConfig}: the module data file carries a files entry without a string path and class`,
      };
    }
    const when = whenOf(entry.when, modules);
    if (when === undefined) {
      return {
        problem: `${filesConfig}: the module data file carries a files entry whose when clause is not the grammar's`,
      };
    }
    declarations.push({ path: entry.path, class: entry.class, when });
  }
  return { modules: new Set(Object.keys(modules)), files: declarations };
}

/** Selected modules are the registration's names files.yml knows (the writer's resolveModules); one declaration per
 *  path is live because the loader refuses two that can both hold (docs/sync.md, Selection). */
function liveClasses(
  vocabulary: Vocabulary,
  registration: { modules: unknown } | null,
  privateRepo: boolean,
): ReadonlyMap<string, string> | null {
  if ("problem" in vocabulary || !Array.isArray(registration?.modules)) return null;
  const selection: Selection = {
    modules: registration.modules.filter(
      (name): name is string => typeof name === "string" && vocabulary.modules.has(name),
    ),
    private: privateRepo,
  };
  const classes = new Map<string, string>();
  for (const entry of vocabulary.files) {
    if (applies(entry.when, selection)) classes.set(entry.path, entry.class);
  }
  return classes;
}

function loadManifest(root: string): Manifest {
  const path = join(root, MANIFEST_NAME);
  if (!isRegularFile(path)) return { state: "absent" };
  const text = readFileSync(path, "utf-8");
  if (hasConflictMarker(text)) return { state: "conflicted" };
  const parsed = parseManifestFiles(text);
  if (parsed.problem !== null) return { state: "malformed", problem: parsed.problem };
  const refused: RefusedKey[] = [];
  const accepted: [string, ManifestEntryShape][] = [];
  for (const [key, entry] of Object.entries(parsed.files)) {
    const problem = pathProblem(key);
    if (problem === null) accepted.push([key, entry]);
    else refused.push({ key, problem });
  }
  // fromEntries defines own properties, so a key spelled like an inherited one (`__proto__`) stays a record.
  return { state: "parsed", records: Object.fromEntries(accepted), refused };
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
export function loadContext(root: string, filesConfig: string, target: Target): Context {
  const registration = loadRegistration(root);
  const vocabulary = loadVocabulary(filesConfig);
  return {
    mode: target.mode,
    root,
    files:
      target.mode === "self"
        ? walk(root, gitIgnored(root)).filter((rel) => !rel.startsWith(WRITER_SOURCES))
        : walk(root, null),
    registration,
    vocabulary,
    classes: target.mode === "self" ? null : liveClasses(vocabulary, registration, target.private),
    manifest: loadManifest(root),
  };
}

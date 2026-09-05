import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MANIFEST_NAME, type ManifestEntryShape, parseManifestFiles } from "../shared/manifest.ts";
import { declaredOwnership, type OwnedFile } from "./ownership.ts";
import { hasConflictMarker, isRecord, isRegularFile, shapeOfYaml } from "./readers.ts";

export const ANSWERS_PATH = ".github/.copier-answers.yml";
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

export interface AnswersFile {
  /** The mapping as the core schema reads it; {} when the file does not
   *  parse or is not a mapping (the yaml check reports the parse failure,
   *  and the empty record makes the owner-pin error name the missing pin). */
  data: Record<string, unknown>;
  /** `_commit` re-read under the failsafe schema, where every scalar stays
   *  a string: PyYAML (copier's writer) dumps exponent-shaped shas like
   *  95e1875 UNQUOTED, and the core schema would resolve digits-e-digits to
   *  a float. null when the key is absent or empty, or the file does not
   *  parse. */
  commit: string | null;
}

export type Manifest =
  | { state: "absent" }
  /** Conflict-marked text is the conflict-marker check's report; the shared
   *  parser would resolve the blocks toward the template side, and this
   *  validator must never quietly read one side of a conflicted manifest. */
  | { state: "conflicted" }
  | { state: "malformed"; problem: string }
  | { state: "parsed"; files: Record<string, ManifestEntryShape> };

/** What every run loads, whichever tree it validates. */
interface Tree {
  root: string;
  /** Every regular file below root, sorted, relative paths. */
  files: readonly string[];
  isPrivateRender: boolean;
  /** The ownership roster the tree must satisfy (ownership.ts). */
  ownership: readonly OwnedFile[];
}

/** repo-platform itself: no registration files to check, no ownership
 *  headers (its files are sources, not renders), gitignored paths skipped
 *  in the walk, any well-formed owner accepted, and the manifest must NOT
 *  exist. */
export interface SelfContext extends Tree {
  mode: "self";
  /** Presence alone: the manifest lands only in generated repos, so self
   *  mode never reads one. */
  manifestPresent: boolean;
}

/** A repository generated from the template. */
export interface RenderContext extends Tree {
  mode: "render";
  /** null when .github/.copier-answers.yml is not a regular file. */
  answers: AnswersFile | null;
  /** .repo-platform.yml's top-level `modules` value as written (undefined
   *  when the key is missing, null when the document is not a mapping);
   *  the record is null when the file is absent. */
  registration: { modules: unknown } | null;
  /** The `github_username` answer, which pins whose composite actions and
   *  reusable workflows the render must use; null while the answers cannot
   *  pin an owner (the registration check reports that once, and the
   *  owner-dependent checks stand down). */
  owner: string | null;
  /** The string entries of a list-shaped modules list; null while the list
   *  is missing or malformed (the registration check's error). */
  selectedModules: string[] | null;
  manifest: Manifest;
}

/** Everything the checks read, loaded once. Checks are pure functions of
 *  this record; every cross-check dependency (an unhealed owner, a missing
 *  modules list, a conflicted manifest, self mode) is a field here, never
 *  an ordering between checks. */
export type Context = SelfContext | RenderContext;

function loadAnswers(root: string): AnswersFile | null {
  const path = join(root, ANSWERS_PATH);
  if (!isRegularFile(path)) return null;
  const text = readFileSync(path, "utf-8");
  let data: Record<string, unknown> = {};
  try {
    const parsed = shapeOfYaml(text);
    if (isRecord(parsed)) data = parsed;
  } catch {
    data = {};
  }
  let commit: string | null = null;
  try {
    const raw = parseYaml(text, { schema: "failsafe", logLevel: "error" }) as Record<
      string,
      unknown
    >;
    const value = raw?._commit;
    commit = typeof value === "string" && value !== "" ? value : null;
  } catch {
    commit = null;
  }
  return { data, commit };
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

function loadManifest(root: string): Manifest {
  const path = join(root, MANIFEST_NAME);
  if (!isRegularFile(path)) return { state: "absent" };
  const text = readFileSync(path, "utf-8");
  if (hasConflictMarker(text)) return { state: "conflicted" };
  const parsed = parseManifestFiles(text);
  if (parsed.problem !== null) return { state: "malformed", problem: parsed.problem };
  return { state: "parsed", files: parsed.files };
}

/** Untracked-and-ignored paths under `root`, from one `git ls-files
 *  --others --ignored --directory` pre-pass: `dirs` are ignored
 *  directories (reported collapsed, so the walk can prune them without
 *  ever descending - .claude/worktrees/ holds whole checkouts), `files`
 *  are individually ignored files. null when git cannot answer - no git
 *  on PATH, or root is not a git checkout - which is the honest reading
 *  of a plain tree: nothing is ignored. */
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

/** All regular files below root, sorted, skipping SKIP_DIRS and (when
 *  `ignored` is given) gitignored paths - directories are pruned before
 *  descent. */
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

/** Loads the tree at `root`. Client renders walk every path: they are
 *  validated as plain trees, often before any git init, and everything in
 *  them is content. Self mode skips gitignored paths: the operator checkout
 *  carries gitignored working state (agent worktrees with in-progress
 *  rebases, the composed template/ output) that is not the repository's
 *  content. */
export function loadContext(root: string, selfMode: boolean): Context {
  const answers = loadAnswers(root);
  const isPrivateRender = answers?.data.private === true;
  if (selfMode) {
    return {
      mode: "self",
      root,
      files: walk(root, gitIgnored(root)),
      isPrivateRender,
      ownership: declaredOwnership({ isPrivateRender, selectedModules: null }),
      manifestPresent: isRegularFile(join(root, MANIFEST_NAME)),
    };
  }
  const registration = loadRegistration(root);
  const username = answers?.data.github_username;
  const selectedModules = Array.isArray(registration?.modules)
    ? registration.modules.filter((m): m is string => typeof m === "string")
    : null;
  return {
    mode: "render",
    root,
    files: walk(root, null),
    isPrivateRender,
    ownership: declaredOwnership({ isPrivateRender, selectedModules }),
    answers,
    registration,
    owner: typeof username === "string" && /^[A-Za-z0-9-]+$/.test(username) ? username : null,
    selectedModules,
    manifest: loadManifest(root),
  };
}

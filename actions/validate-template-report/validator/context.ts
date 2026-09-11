import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  MANIFEST_NAME,
  type ManifestEntryShape,
  parseManifestFiles,
} from "../../shared/manifest.ts";
import {
  ANSWERS_PATH,
  declaredOwnership,
  type OwnedFile,
  type RenderSelection,
} from "./ownership.ts";
import {
  hasConflictMarker,
  isRecord,
  isRegularFile,
  regexLiteral,
  shapeOfYaml,
} from "./readers.ts";

export { ANSWERS_PATH };
export const REGISTRATION_PATH = ".repo-platform.yml";

/** The top-level keys the template's registration starter wrote; a key
 *  outside them means the sync writer's cutover (or a hand) already
 *  registered the repository the new way, and the answers file has left
 *  or is leaving. */
const TEMPLATE_REGISTRATION_KEYS: ReadonlySet<string> = new Set(["modules", "mirrors"]);

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

/** Whose repo-platform the render must call, as a regex source and the
 *  name a finding prints: the `github_username` answer while the answers
 *  file exists; any well-formed owner once it has left (the writer
 *  substitutes the repository's own owner and records it nowhere). */
export interface OwnerPin {
  pattern: string;
  display: string;
}

export const ANY_OWNER: OwnerPin = { pattern: "[A-Za-z0-9-]+", display: "<owner>" };

/** Which file records the build commit the tree was written from, and the
 *  value it records (null when the file names none): the answers file
 *  while it exists (copier's record, mirrored into the manifest by the
 *  stamp hook), the manifest's own entry once the sync writer has retired
 *  the answers file. */
export interface BuildRecord {
  file: typeof ANSWERS_PATH | typeof MANIFEST_NAME;
  commit: string | null;
}

/** What every run loads, whichever tree it validates. */
interface Tree {
  root: string;
  /** Every regular file below root, sorted, relative paths. */
  files: readonly string[];
  /** null while the render records no visibility (ownership.ts). */
  isPrivateRender: boolean | null;
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
   *  when the key is missing, null when the document is not a mapping)
   *  and whether the document still has the shape the template rendered;
   *  the record is null when the file is absent. */
  registration: { modules: unknown; templateShape: boolean } | null;
  /** Whether the answers file is the registration record this tree must
   *  carry: the registration is missing or still template-shaped. */
  registeredByAnswers: boolean;
  /** null while the recording file exists and cannot pin an owner (the
   *  registration check reports that once, and the owner-dependent checks
   *  stand down). */
  owner: OwnerPin | null;
  /** null when neither recording file is readable: the answers file is
   *  absent and the manifest is absent, conflicted, or malformed (each its
   *  own check's report). */
  buildRecord: BuildRecord | null;
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

function loadRegistration(root: string): { modules: unknown; templateShape: boolean } | null {
  const path = join(root, REGISTRATION_PATH);
  if (!isRegularFile(path)) return null;
  let data: unknown = {};
  try {
    data = shapeOfYaml(readFileSync(path, "utf-8")) ?? {};
  } catch {
    data = {};
  }
  if (!isRecord(data)) return { modules: null, templateShape: true };
  return {
    modules: data.modules,
    templateShape: Object.keys(data).every((key) => TEMPLATE_REGISTRATION_KEYS.has(key)),
  };
}

function buildRecordOf(answers: AnswersFile | null, manifest: Manifest): BuildRecord | null {
  if (answers !== null) return { file: ANSWERS_PATH, commit: answers.commit };
  if (manifest.state !== "parsed") return null;
  const commit = manifest.files[MANIFEST_NAME]?.commit;
  return {
    file: MANIFEST_NAME,
    commit: typeof commit === "string" && commit !== "" ? commit : null,
  };
}

function ownerOf(answers: AnswersFile | null): OwnerPin | null {
  if (answers === null) return ANY_OWNER;
  const username = answers.data.github_username;
  return typeof username === "string" && /^[A-Za-z0-9-]+$/.test(username)
    ? { pattern: regexLiteral(username), display: username }
    : null;
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

/** The sync writer's source tree: its files carry `{{placeholder}}` tokens
 *  and are not YAML before substitution, so self mode leaves them to the
 *  writer's own loader. */
const WRITER_SOURCES = "files/";

/** Loads the tree at `root`. Client renders walk every path: they are
 *  validated as plain trees, often before any git init, and everything in
 *  them is content. Self mode skips gitignored paths: the operator checkout
 *  carries gitignored working state (agent worktrees with in-progress
 *  rebases, the composed template/ output) that is not the repository's
 *  content. */
export function loadContext(root: string, selfMode: boolean): Context {
  const answers = loadAnswers(root);
  if (selfMode) {
    // The operator renders no answers file: its own tree reads as public.
    const isPrivateRender = answers?.data.private === true;
    return {
      mode: "self",
      root,
      files: walk(root, gitIgnored(root)).filter((rel) => !rel.startsWith(WRITER_SOURCES)),
      isPrivateRender,
      ownership: declaredOwnership({
        isPrivateRender,
        selectedModules: null,
        registeredByAnswers: true,
      }),
      manifestPresent: isRegularFile(join(root, MANIFEST_NAME)),
    };
  }
  const registration = loadRegistration(root);
  const manifest = loadManifest(root);
  const selectedModules = Array.isArray(registration?.modules)
    ? registration.modules.filter((m): m is string => typeof m === "string")
    : null;
  const selection: RenderSelection = {
    isPrivateRender: answers === null ? null : answers.data.private === true,
    selectedModules,
    registeredByAnswers: registration === null || registration.templateShape,
  };
  return {
    mode: "render",
    root,
    files: walk(root, null),
    isPrivateRender: selection.isPrivateRender,
    ownership: declaredOwnership(selection),
    answers,
    registration,
    registeredByAnswers: selection.registeredByAnswers,
    owner: ownerOf(answers),
    buildRecord: buildRecordOf(answers, manifest),
    selectedModules,
    manifest,
  };
}

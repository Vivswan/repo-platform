#!/usr/bin/env bun
// Stamp per-repo content hashes into the ownership manifest
// (.github/repo-platform-manifest.json) of a rendered repository.
//
// The template renders the manifest with every hash null: hashes are
// per-repo facts that exist only once copier has written the tree. This
// script is the post-render stamping hook - copier.yml wires it into
// _tasks (gated off updates: copier runs tasks on the destination pass of
// an update too, measured on 9.17.0) and into _migrations at the 'after'
// stage (update), one destination run per render - and reusable-template-sync
// runs it once more as the sync leg's final stamping step, after conflict
// resolution and the preserve steps have finished rewriting files. Before
// stamping it also normalizes the manifest-listed symlinks' targets
// (normalizeSymlinkTargets: the build branch ships targets with the
// template suffix kept so no branch link is ever dangling).
//
// STANDALONE BY DESIGN: this file lives in actions/shared/, the
// dependency-free zone the build branch ships verbatim, and copier.yml's
// hooks run it from there ({{ _copier_conf.src_path }}/actions/shared/...)
// inside freshly rendered repositories where none of this repository's
// node_modules exist - node builtins and zone-internal imports only, no
// argv subprocesses.
//
// Under --commit the hook also owns the recorded provenance: it rewrites
// the `_commit:` line to the full template sha copier.yml hands it, then
// stamps the manifest's slot from it (why: docs/build-provenance.md).
//
// Only the "hash" field - plus the self entry's "commit" provenance slot,
// filled with the render's recorded _commit, and the "withheld" marker the
// sync's withhold path asks for - is rewritten, in place, line by line:
// the rendered manifest keeps one entry per line (the layout
// manifest.ts's entryLine emits and parseEntry reads back), each entry's
// object is parsed, its fields edited, and the object re-emitted through
// the same layout (entryBody), so a stamped manifest differs from the raw
// render in those field values alone and copier's three-way update merge
// sees minimal local edits. Split entries carry their grammar and its
// begin/end marker lines; the stamper reads the marker pair to hash the
// managed region and passes every other field through untouched. An
// update can still leave inline
// conflict blocks in the manifest (both sides touch the hash lines);
// parseManifestFiles resolves those toward the template ("after updating")
// side before parsing - the direction resolve_copier_conflicts.ts uses -
// and the stamp then rewrites every hash anyway.
//
// Data problems (a missing or unparseable manifest, entries the line
// rewrite cannot reach) warn and exit 0 on the argument-free re-stamp -
// validate-template's parity check reports an unstamped manifest. Under --commit the provenance pair (answers line +
// manifest slot) must never disagree, so a manifest that cannot take the
// stamp fails the render before either file is touched. Entry classes are
// trusted as written; the validator's roster cross-check reports a
// hand-flipped class.
//
// Args: `--root <dir>` (the tree; absent = cwd, never the environment),
// `--commit <40-hex sha>` and `--answers <path>` (the copier hooks pass
// both; the sync's final re-stamp passes neither). `--answers` is refused
// unless it names ANSWERS_FILE: alternates are outside the template's
// contract, and stamping the default file while copier wrote another would
// leave the pair split.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { cleanManagedRegion } from "./grammar.ts";
import {
  entryBody,
  type JsonValue,
  MANIFEST_NAME,
  type ManifestEntryShape,
  parseEntry,
  parseManifestFiles,
  withheldMarkerValid,
} from "./manifest.ts";

/** The template suffix the build branch's symlink targets keep: links on
 *  the branch point at their templated twin so the `uses:` tarball
 *  staging never sees a dangling link, and copier renders link targets as
 *  strings without stripping the suffix - so this hook normalizes the
 *  rendered targets instead (normalizeSymlinkTargets below). */
const JINJA_SUFFIX = ".jinja";

/** The hash token inside an entry object; entries without one (starters,
 *  and legacy "mergeable" entries from renders that predate the class's
 *  retirement) are left alone. */
const HASH_RE = /"hash": (?:null|"[0-9a-f]{64}")/;

/** The provenance token on the manifest's own entry: the render's recorded
 *  _commit, letting the validator tell version skew from entry deletion. */
const COMMIT_RE = /"commit": (?:null|"(?:[^"\\]|\\.)*")/;

/** The answers file copier records the render provenance in. */
export const ANSWERS_FILE = ".github/.copier-answers.yml";

/** The hex width of a full sha1 - the only `_commit` shape the hook
 *  records and every downstream reader (the sync's update base, the
 *  validator, the freshness report) resolves. */
export const FULL_SHA_HEX = 40;
const FULL_SHA_RE = new RegExp(`^[0-9a-f]{${FULL_SHA_HEX}}$`);

/** The answers text with its `_commit:` line's value replaced by `sha`,
 *  whatever copier wrote there (plain, quoted, an abbreviation, a tag
 *  name). copier writes the key on every render before its hooks run, so
 *  a text without exactly one `_commit:` line is not a render's answers
 *  file and throws. An all-digit sha is written quoted: PyYAML (YAML 1.1,
 *  what copier reads the file back with) would otherwise resolve it as an
 *  integer on the next update. */
export function rewriteRecordedCommit(text: string, sha: string): string {
  if (!FULL_SHA_RE.test(sha)) throw new Error(`--commit must be a full 40-hex sha, got '${sha}'`);
  const lines = text.match(/^_commit:[^\n]*$/gm) ?? [];
  if (lines.length !== 1) {
    throw new Error(
      `${ANSWERS_FILE} carries ${lines.length} _commit lines, expected exactly one to rewrite`,
    );
  }
  const value = /^[0-9]+$/.test(sha) ? `"${sha}"` : sha;
  return text.replace(/^(_commit:[ \t]*)[^\n]*$/m, `$1${value}`);
}

/** The `_commit` the render recorded in .github/.copier-answers.yml, or
 *  null when
 *  the file or key is missing. Read with a line regex, not a YAML parser:
 *  this script ships standalone (no node_modules downstream), copier
 *  writes the key as a plain one-line scalar, and a value the regex cannot
 *  see just leaves provenance null - the validator's skew path. */
export function recordedCommit(root: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(root, ANSWERS_FILE), "utf-8");
  } catch {
    return null;
  }
  const match = /^_commit:[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^#\n]*?))[ \t]*$/m.exec(text);
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return value === "" ? null : value;
}

/** The hash a manifest entry should carry for the file as it sits on disk:
 *  sha256 of the whole content (managed), of the managed region between
 *  the entry's begin/end marker lines (split; the marker lines are part of
 *  the hashed region), or of the symlink target. The region slice is the
 *  STRICT one (cleanManagedRegion) - the same accept/reject every writer
 *  applies - so a file with duplicated or reordered markers stamps null
 *  rather than hashing an ambiguous first slice. null also when the file
 *  is missing or its split markers are gone - the parity check reports
 *  those; a stamp must not invent a value. */
export function entryHash(root: string, path: string, entry: ManifestEntryShape): string | null {
  const abs = join(root, path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(abs);
  } catch {
    return null;
  }
  // Raw link bytes: decoding a malformed-UTF-8 target would fold distinct
  // targets onto the replacement character.
  if (stat.isSymbolicLink()) return sha256(readlinkSync(abs, { encoding: "buffer" }));
  if (!stat.isFile()) return null;
  // latin1 round-trips every byte, so the hash covers the file verbatim.
  const content = readFileSync(abs).toString("latin1");
  if (entry.class === "split") {
    // Type narrowing over the untrusted JSON, not a behaviour fork: a
    // non-string begin/end never matches a marker line, so the slicer
    // would return this same null; the check only types its arguments.
    if (typeof entry.begin !== "string" || typeof entry.end !== "string") return null;
    const slice = cleanManagedRegion(content, { begin: entry.begin, end: entry.end });
    return slice === null ? null : sha256(Buffer.from(slice.region, "latin1"));
  }
  return sha256(Buffer.from(content, "latin1"));
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The absolute on-disk location of a manifest path, or null when the
 *  path cannot be trusted for MUTATION: manifest text is target-repo
 *  content on updates, so an absolute or ..-carrying key, or one whose
 *  parent directory really lives outside the rendered root (a symlinked
 *  ancestor), must never be unlinked. Read-only consumers (hashing) keep
 *  their lexical join: this script only writes hash VALUES into the
 *  manifest, so the worst a hostile key gets there is its own file's
 *  hash echoed back - while a wrong unlink is damage. */
function containedForMutation(root: string, path: string): string | null {
  if (path.startsWith("/")) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  const abs = join(root, path);
  let parentReal: string;
  let rootReal: string;
  try {
    parentReal = realpathSync(dirname(abs));
    rootReal = realpathSync(root);
  } catch {
    return null;
  }
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}/`)) return null;
  return join(parentReal, basename(abs));
}

/** Strip the template suffix from every MANAGED manifest-listed symlink's
 *  target: the build branch ships link targets with the suffix kept (a
 *  dangling link anywhere in the tree kills the runner's `uses:` tarball
 *  staging) and copier renders targets verbatim, so the rendered
 *  repository's managed links arrive pointing at the templated twin's
 *  name. Only managed entries are touched - starters are repo-owned after
 *  the first render and unlisted links are repo content, so neither is
 *  ever rewritten, whatever its target - and the rewrite is idempotent.
 *  Returns the rewritten paths. */
export function normalizeSymlinkTargets(
  root: string,
  files: Record<string, ManifestEntryShape>,
): string[] {
  const rewritten: string[] = [];
  for (const [path, entry] of Object.entries(files)) {
    if (entry.class !== "managed") continue;
    const abs = containedForMutation(root, path);
    if (abs === null) continue;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(abs);
    } catch {
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    const target = readlinkSync(abs);
    if (!target.endsWith(JINJA_SUFFIX)) continue;
    unlinkSync(abs);
    symlinkSync(target.slice(0, -JINJA_SUFFIX.length), abs);
    rewritten.push(path);
  }
  return rewritten;
}

/** One entry line's object, or null when the body is not one JSON object:
 *  two entries joined on one line are valid manifest JSON, yet the
 *  greedy entry-line layout reads both as a single body. */
function entryFields(body: string): Record<string, JsonValue> | null {
  try {
    return JSON.parse(body) as Record<string, JsonValue>;
  } catch {
    return null;
  }
}

/** How many `files` entries the line-by-line rewrite never reaches: an
 *  entry spread over several lines, or joined with another on one line.
 *  A count, never the paths - manifest keys are target-repo content that
 *  reaches public logs. */
function unreachedEntries(files: Record<string, unknown>, resolved: string): number {
  const reached = new Set<string>();
  for (const line of resolved.split("\n").map(parseEntry)) {
    if (line !== null && entryFields(line.body) !== null) reached.add(line.path);
  }
  return Object.keys(files).filter((path) => !reached.has(path)).length;
}

/** The diagnosis both modes print for a positive unreachedEntries count. */
function unreachedProblem(unreached: number): string {
  const noun =
    unreached === 1
      ? "files entry not on a one-object line of its own"
      : "files entries not on one-object lines of their own";
  return `has ${unreached} ${noun}, which the stamper cannot rewrite`;
}

/** The text with every reachable entry line's hash token restamped from
 *  the tree at `root`, the self entry's commit slot from the recorded
 *  _commit, and `"withheld": true` (withheldMarkerValid's one shape) on the
 *  hash-null entries of the `withheld` paths. Soft failures only: a text
 *  the parser rejects comes back unchanged with its problem; entries the
 *  line rewrite cannot reach come back unchanged, counted in
 *  `unreachedEntries`. */
export function stampManifestText(
  text: string,
  root: string,
  withheld: ReadonlySet<string> = new Set(),
): { out: string; problem: string | null; unreachedEntries: number } {
  const parsed = parseManifestFiles(text);
  if (parsed.problem !== null) return { out: text, problem: parsed.problem, unreachedEntries: 0 };
  const { files, resolved } = parsed;
  const commit = recordedCommit(root);
  const lines = resolved.split("\n").map((line) => {
    const parsedLine = parseEntry(line);
    if (parsedLine === null) return line;
    const { indent, path, quotedPath, comma } = parsedLine;
    const entry = files[path];
    if (entry === undefined) return line;
    const fields = entryFields(parsedLine.body);
    if (fields === null) return line;
    // Field order is kept. Entries without a hash field (starters, and
    // legacy "mergeable" entries from renders that predate the class's
    // retirement) are left alone apart from a stray marker, which no
    // hash-less entry may carry.
    if (!("hash" in fields)) {
      if (!("withheld" in fields)) return line;
      delete fields.withheld;
      return `${indent}${quotedPath}: ${entryBody(fields)}${comma}`;
    }
    const hash = path === MANIFEST_NAME ? null : entryHash(root, path, entry);
    // A marker is written for a named path when the entry it would produce
    // has the one valid shape, or kept when the ENTRY AS STAMPED already
    // carried a valid one and the file is still absent; judging the
    // original entry (not the recomputed hash) keeps a hand edit that
    // decorates a deleted, once-hashed entry from maturing into the valid
    // shape on the next stamp. The same predicate the validator applies
    // decides both, so the stamper cannot emit a marker it rejects.
    const stillWithheld =
      hash === null &&
      (withheld.has(path)
        ? withheldMarkerValid(path, { ...entry, hash: null, withheld: true })
        : withheldMarkerValid(path, entry) && !existsSync(join(root, path)));
    fields.hash = hash;
    delete fields.withheld;
    if (stillWithheld) fields.withheld = true;
    if (path === MANIFEST_NAME && "commit" in fields) fields.commit = commit;
    return `${indent}${quotedPath}: ${entryBody(fields)}${comma}`;
  });
  return {
    out: lines.join("\n"),
    problem: null,
    unreachedEntries: unreachedEntries(files, resolved),
  };
}

/** The manifest-gated normalization entry main() runs: parse (which
 *  validates - a manifest parseManifestFiles rejects normalizes NOTHING,
 *  so a duplicate-key or malformed manifest can never mutate a link
 *  before the stamp's own rejection reports it) and then rewrite the
 *  managed links. Returns the rewritten paths, or the parse problem with
 *  a guaranteed-empty rewrite. */
export function normalizeFromText(
  text: string,
  root: string,
): { rewritten: string[]; problem: string | null } {
  const parsed = parseManifestFiles(text);
  if (parsed.problem !== null) return { rewritten: [], problem: parsed.problem };
  return { rewritten: normalizeSymlinkTargets(root, parsed.files), problem: null };
}

/** The normalization log line, with every path JSON-QUOTED: manifest keys
 *  are target-controlled on updates, and a raw newline or control byte in
 *  a decoded path printed to the Actions log could forge workflow
 *  commands; the quoted form keeps every escape literal. */
export function describeRewritten(rewritten: string[]): string {
  return `normalized ${rewritten.length} symlink target(s): ${rewritten
    .map((path) => JSON.stringify(path))
    .join(", ")}`;
}

/** The spellings of the declared answers path copier can hand the hook:
 *  the declared one, and the host-separator twin a PurePath prints on
 *  Windows. Exact strings, no normalization: a folded `..` or `./` could
 *  name a different file through a symlink or a backslash-named entry. */
const DECLARED_ANSWERS_SPELLINGS = new Set([ANSWERS_FILE, ANSWERS_FILE.split("/").join(sep)]);

export interface HookArgs {
  root: string | null;
  commit: string | null;
  answers: string | null;
}

const FLAGS = ["--root", "--commit", "--answers"] as const;

/** The hook's arguments, each at most once, in any order. Anything else
 *  is a wiring error in copier.yml or a caller and fails loudly - the
 *  hook's soft contract covers DATA problems, not a broken invocation.
 *  `--answers` must accompany `--commit` and must name ANSWERS_FILE (a
 *  render into another answers file is refused, not stamped). */
export function hookArgs(argv: string[]): HookArgs {
  const usage = `usage: stamp_manifest.ts [--root <dir>] [--commit <40-hex sha> --answers <path>], got: ${argv.join(" ")}`;
  const seen: Partial<Record<(typeof FLAGS)[number], string>> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as (typeof FLAGS)[number];
    const value = argv[i + 1];
    if (!FLAGS.includes(flag) || seen[flag] !== undefined) throw new Error(usage);
    if (value === undefined || value.startsWith("--")) throw new Error(usage);
    seen[flag] = value;
  }
  const { "--root": root = null, "--commit": commit = null, "--answers": answers = null } = seen;
  if (commit !== null && !FULL_SHA_RE.test(commit)) {
    throw new Error(`--commit must be a full 40-hex sha, got '${commit}'`);
  }
  if ((commit === null) !== (answers === null)) {
    throw new Error(`--commit and --answers come together; ${usage}`);
  }
  if (answers !== null && !DECLARED_ANSWERS_SPELLINGS.has(answers)) {
    throw new Error(
      `--answers names '${answers}', but this template records its answers in '${ANSWERS_FILE}': a render into another answers file is outside the template's contract and is not stamped`,
    );
  }
  return { root, commit, answers };
}

/** The self entry's keys as the template renders them, in order. */
const SELF_ENTRY_KEYS = ["class", "hash", "commit"] as const;

/** The self entry's body as the template renders it: the rendered layout
 *  of exactly SELF_ENTRY_KEYS with JSON-encoded values. */
function canonicalSelfBody(entry: Record<string, unknown>): string {
  return `{${SELF_ENTRY_KEYS.map((key) => `"${key}": ${JSON.stringify(entry[key])}`).join(", ")}}`;
}

/** Why manifest `text` cannot take the --commit stamp, or null. Judged
 *  STRUCTURALLY on the entry consumers read - `files[MANIFEST_NAME]` of
 *  the parsed JSON, which must carry exactly SELF_ENTRY_KEYS - and then on
 *  the lines the stamper will rewrite: every line whose path is
 *  MANIFEST_NAME (the stamper rewrites each of them, wherever it sits in
 *  the JSON) must be byte-equal to that entry's canonical rendering, and
 *  there must be at least one (a multi-line entry is never rewritten).
 *  Identifier keys and JSON-encoded values make the first "hash" and
 *  "commit" token on such a line the top-level slot by construction; the
 *  token check then catches a value the rewrite would skip (a hash that is
 *  not 64 hex). Every files entry must be reached by such a one-object
 *  line (unreachedEntries), or the render's provenance stamp would ride a
 *  partial stamp - the soft path stampManifestText keeps for the sync's
 *  argument-free re-stamp. What this cannot see - a decoy line outside
 *  `files` beside a files entry the stamper never reaches - main()'s
 *  structural read-back catches for the self entry after the writes and
 *  rolls back; for any other entry it is the parity check's report. */
export function provenanceSlotProblem(text: string): string | null {
  const parsed = parseManifestFiles(text);
  if (parsed.problem !== null) return parsed.problem;
  const entry = parsed.files[MANIFEST_NAME] as Record<string, unknown> | undefined;
  if (entry === undefined) return `has no ${MANIFEST_NAME} entry under files`;
  const keys = Object.keys(entry);
  if (keys.length !== SELF_ENTRY_KEYS.length || keys.some((key, i) => key !== SELF_ENTRY_KEYS[i])) {
    return `self entry keys are ${JSON.stringify(keys)}, expected exactly ${JSON.stringify(SELF_ENTRY_KEYS)} (the rendered shape)`;
  }
  const canonical = canonicalSelfBody(entry);
  const lines = parsed.resolved
    .split("\n")
    .map(parseEntry)
    .filter((line) => line !== null && line.path === MANIFEST_NAME);
  if (lines.length === 0) return "self entry is not on one line, so the stamper cannot rewrite it";
  if (lines.some((line) => line?.body !== canonical)) {
    return "self entry is not in the rendered layout (the stamper rewrites tokens in place)";
  }
  if (!HASH_RE.test(canonical) || !COMMIT_RE.test(canonical)) {
    return 'self entry spells its "hash" and "commit" slots in a form the stamper cannot rewrite';
  }
  const unreached = unreachedEntries(parsed.files, parsed.resolved);
  return unreached > 0 ? unreachedProblem(unreached) : null;
}

/** The self entry's provenance as consumers read it - `files[MANIFEST_NAME]`
 *  of the parsed JSON - or null when the text does not parse or has no
 *  such entry. `commit` is the recorded provenance, `hash` must be null
 *  (the self entry never carries one: a self-hash would be circular). */
export function stampedProvenance(text: string): { commit: unknown; hash: unknown } | null {
  const parsed = parseManifestFiles(text);
  if (parsed.problem !== null) return null;
  const entry = parsed.files[MANIFEST_NAME] as Record<string, unknown> | undefined;
  if (entry === undefined) return null;
  return { commit: entry.commit, hash: entry.hash };
}

function main(): number {
  const args = hookArgs(process.argv.slice(2));
  const root = resolve(args.root ?? ".");
  const commit = args.commit;
  const manifestPath = join(root, MANIFEST_NAME);
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf-8");
  } catch {
    if (commit !== null) {
      throw new Error(
        `${MANIFEST_NAME} not found under ${root}: the render's provenance cannot be recorded, nothing was written`,
      );
    }
    console.error(
      `warning: ${MANIFEST_NAME} not found under ${root}; nothing to stamp ` +
        "(renders from templates that predate the manifest have none)",
    );
    return 0;
  }
  // Under --commit the pair is written only once BOTH halves are known to
  // take it: the manifest a stampable self entry, the answers file exactly
  // one _commit line; a problem with either mutates nothing.
  const answersPath = join(root, ANSWERS_FILE);
  let originalAnswers: string | null = null;
  let rewrittenAnswers: string | null = null;
  if (commit !== null) {
    const slotProblem = provenanceSlotProblem(text);
    if (slotProblem !== null) {
      throw new Error(
        `${MANIFEST_NAME} ${slotProblem}: the render's provenance cannot be recorded, nothing was written`,
      );
    }
    originalAnswers = readFileSync(answersPath, "utf-8");
    const rewritten = rewriteRecordedCommit(originalAnswers, commit);
    rewrittenAnswers = rewritten === originalAnswers ? null : rewritten;
  }
  // Every check above is pure; the first mutation is below. Normalize the
  // managed symlinks BEFORE stamping: the hash covers the link target, so
  // it must be taken after the rewrite. Parse-gated: a manifest the parser
  // rejects mutates nothing, so the rejection warning below
  // ("normalization skipped too") is always true.
  const normalized = normalizeFromText(text, root);
  if (normalized.rewritten.length > 0) {
    console.log(describeRewritten(normalized.rewritten));
  }
  // The answers file is written first because the manifest hashes it as
  // it sits on disk. Each write is marked ATTEMPTED before it starts, and
  // anything that fails from that moment on - the write itself half done,
  // stamping, the manifest write, the read-back postcondition - restores
  // every attempted file, so the pair is either both written or both as
  // it was.
  let answersWritten = false;
  let manifestWritten = false;
  try {
    if (rewrittenAnswers !== null) {
      answersWritten = true;
      writeFileSync(answersPath, rewrittenAnswers);
    }
    const { out, problem, unreachedEntries: unreached } = stampManifestText(text, root);
    if (problem !== null) {
      if (commit !== null) throw new Error(`${MANIFEST_NAME} ${problem}`);
      console.error(
        `warning: ${MANIFEST_NAME} ${problem}; left unstamped (symlink target ` +
          "normalization skipped too) for validate-template's parity check to report",
      );
      return 0;
    }
    // Reachable on the argument-free re-stamp alone: the --commit
    // preflight refuses such entries above.
    if (unreached > 0) {
      console.error(
        `warning: ${MANIFEST_NAME} ${unreachedProblem(unreached)}; left unstamped for ` +
          "validate-template's parity check to report",
      );
    }
    if (out !== text) {
      manifestWritten = true;
      writeFileSync(manifestPath, out);
    }
    if (commit !== null) {
      // The postcondition the pair exists for, read back from DISK: both
      // halves name the commit the hook was handed.
      const recorded = recordedCommit(root);
      const stamped = stampedProvenance(readFileSync(manifestPath, "utf-8"));
      if (recorded !== commit || stamped?.commit !== commit || stamped.hash !== null) {
        throw new Error(
          `provenance disagrees after stamping: ${ANSWERS_FILE} records ${recorded}, ${MANIFEST_NAME} self entry ${JSON.stringify(stamped)}, expected commit ${commit} with a null hash`,
        );
      }
    }
    if (rewrittenAnswers !== null) console.log(`recorded _commit ${commit} in ${ANSWERS_FILE}`);
    console.log(
      out !== text
        ? `stamped ${MANIFEST_NAME}`
        : `${MANIFEST_NAME} already stamped; nothing to write`,
    );
    return 0;
  } catch (err) {
    // Best-effort restores: a restore that fails must not mask the error
    // that triggered it, so each is attempted and the failures ride along.
    const restoreFailures: string[] = [];
    const restore = (path: string, content: string) => {
      try {
        writeFileSync(path, content);
      } catch (restoreErr) {
        restoreFailures.push(`${path}: ${String(restoreErr)}`);
      }
    };
    if (answersWritten && originalAnswers !== null) restore(answersPath, originalAnswers);
    if (manifestWritten) restore(manifestPath, text);
    if (restoreFailures.length > 0) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}; restoring the original files also failed: ${restoreFailures.join("; ")}`,
        { cause: err },
      );
    }
    throw err;
  }
}

if (import.meta.main) {
  process.exit(main());
}

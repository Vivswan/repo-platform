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
// The hook also OWNS the shape of the recorded provenance: copier writes
// `_commit` from `git describe --tags --always` (an abbreviation, or a
// tag name), so copier.yml passes `--commit {{ _copier_conf.vcs_ref_hash }}`
// - the template clone's full commit hash - and the hook rewrites the
// `_commit:` line to it before stamping. Every producer (the sync,
// onboarding's plain `copier copy`, the goldens, the harnesses) thereby
// records the same 40-hex value with no environment to carry, and the
// manifest's provenance slot follows from the rewritten file.
//
// Only the "hash" tokens - plus the self entry's "commit" provenance slot,
// filled with the render's recorded _commit - are rewritten, in place,
// line by line: the rendered manifest keeps one entry per line (the layout
// manifest.ts's entryLine emits and parseEntry reads back), so a stamped
// manifest differs from the raw render in those token values alone and
// copier's three-way update merge sees minimal local edits. Split entries
// carry their grammar and its begin/end marker lines; the stamper reads
// the marker pair to hash the managed region and passes everything else
// through untouched. An update can still leave inline
// conflict blocks in the manifest (both sides touch the hash lines);
// parseManifestFiles resolves those toward the template ("after updating")
// side before parsing - the direction resolve_copier_conflicts.ts uses -
// and the stamp then rewrites every hash anyway.
//
// Data problems (missing or unparseable manifest) warn and exit 0 on the
// argument-free re-stamp: a stamping gap must never abort an
// otherwise-successful render - validate-template's byte-parity check is
// the enforcement point that reports an unstamped manifest. Under
// --commit the hook OWNS the provenance pair (answers line + manifest
// slot) and the two must never disagree, so a manifest that cannot take
// the stamp fails the render before either file is touched. The
// same division covers metadata: this script refreshes hash VALUES and
// deliberately trusts each entry's class for what to hash (it ships
// standalone, without the validator's ownership tables), so a hand-flipped
// class is not healed here - the validator's roster cross-check is what
// reports it.
//
// Args: `--root <dir>` (the rendered repository; the copier hooks pass
// the destination, the sync passes its target checkout; absent = cwd) and
// `--commit <40-hex sha>` (the copier hooks; the sync's final re-stamp
// passes none and keeps the recorded value). The root is never inferred
// from the environment: an inherited variable once aimed a render's hook
// at another tree.

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { cleanManagedRegion } from "./grammar.ts";
import {
  MANIFEST_NAME,
  type ManifestEntryShape,
  parseEntry,
  parseManifestFiles,
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

/** Stamp the manifest text against the tree at `root`: conflict blocks
 *  resolve toward the template side, then every entry line's hash token is
 *  replaced with the honest value, and the self entry's commit token with
 *  the render's recorded _commit (its hash stays null - see the manifest's
 *  $comment). Returns the input unchanged with a problem message when
 *  parseManifestFiles rejects the text (unparseable, malformed entries,
 *  duplicated entry lines). Reported soft, never thrown: this function's
 *  contract (see the file header) is that a stamping gap warns and lets
 *  the validator's parity check report it in a DELIVERED PR - and this
 *  same code ships standalone as copier's after-hook, where the manifest
 *  being stamped is copier's MERGED result (the exact place a bad
 *  three-way merge corrupts it), so a throw there would fail the render,
 *  turn the sync red, and deliver no PR for a human to fix the corruption
 *  in. */
export function stampManifestText(
  text: string,
  root: string,
): { out: string; problem: string | null } {
  const parsed = parseManifestFiles(text);
  if (parsed.problem !== null) return { out: text, problem: parsed.problem };
  const { files, resolved } = parsed;
  const commit = recordedCommit(root);
  const lines = resolved.split("\n").map((line) => {
    const parsedLine = parseEntry(line);
    if (parsedLine === null) return line;
    const { indent, path, quotedPath, comma } = parsedLine;
    const entry = files[path];
    if (entry === undefined || !HASH_RE.test(parsedLine.body)) return line;
    const hash = path === MANIFEST_NAME ? null : entryHash(root, path, entry);
    let body = parsedLine.body.replace(HASH_RE, `"hash": ${hash === null ? "null" : `"${hash}"`}`);
    if (path === MANIFEST_NAME) {
      body = body.replace(
        COMMIT_RE,
        `"commit": ${commit === null ? "null" : JSON.stringify(commit)}`,
      );
    }
    return `${indent}${quotedPath}: ${body}${comma}`;
  });
  return { out: lines.join("\n"), problem: null };
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

/** The hook's arguments: `--root <dir>` and `--commit <40-hex sha>`, each
 *  at most once, in any order. Anything else is a wiring error in
 *  copier.yml or a caller and fails loudly - the hook's soft contract
 *  covers DATA problems, not a broken invocation. */
export function hookArgs(argv: string[]): { root: string | null; commit: string | null } {
  const usage = `usage: stamp_manifest.ts [--root <dir>] [--commit <40-hex sha>], got: ${argv.join(" ")}`;
  let root: string | null = null;
  let commit: string | null = null;
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(usage);
    if (argv[i] === "--root" && root === null) root = value;
    else if (argv[i] === "--commit" && commit === null) commit = value;
    else throw new Error(usage);
  }
  if (commit !== null && !FULL_SHA_RE.test(commit)) {
    throw new Error(`--commit must be a full 40-hex sha, got '${commit}'`);
  }
  return { root, commit };
}

/** The self entry's keys as the template renders them, in order. */
const SELF_ENTRY_KEYS = ["class", "hash", "commit"] as const;

/** The self entry's body as the template renders it: the rendered layout
 *  of exactly SELF_ENTRY_KEYS with JSON-encoded values. */
function canonicalSelfBody(entry: Record<string, unknown>): string {
  return `{${SELF_ENTRY_KEYS.map((key) => `"${key}": ${JSON.stringify(entry[key])}`).join(", ")}}`;
}

/** Why manifest `text` cannot carry a provenance stamp, or null. Judged
 *  STRUCTURALLY on the entry consumers read - `files[MANIFEST_NAME]` of
 *  the parsed JSON, which must carry exactly SELF_ENTRY_KEYS - and then on
 *  the lines the stamper will rewrite: every line whose path is
 *  MANIFEST_NAME (the stamper rewrites each of them, wherever it sits in
 *  the JSON) must be byte-equal to that entry's canonical rendering, and
 *  there must be at least one (a multi-line entry is never rewritten).
 *  Identifier keys and JSON-encoded values make the first "hash" and
 *  "commit" token on such a line the top-level slot by construction; the
 *  token check then catches a value the rewrite would skip (a hash that is
 *  not 64 hex). What this cannot see - a canonical decoy line beside a
 *  files entry the stamper never reaches - main()'s structural read-back
 *  catches after the writes and rolls back. */
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
  return null;
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
    const { out, problem } = stampManifestText(text, root);
    if (problem !== null) {
      if (commit !== null) throw new Error(`${MANIFEST_NAME} ${problem}`);
      console.error(
        `warning: ${MANIFEST_NAME} ${problem}; left unstamped (symlink target ` +
          "normalization skipped too) for validate-template's parity check to report",
      );
      return 0;
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

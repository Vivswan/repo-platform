#!/usr/bin/env bun
// Stamp per-repo content hashes into the ownership manifest
// (.github/repo-platform-manifest.json) of a rendered repository.
//
// The template renders the manifest with every hash null: hashes are
// per-repo facts that exist only once copier has written the tree. This
// script is the post-render stamping hook - copier.yml wires it into
// _tasks (copy and recopy; copier does not run tasks on update) and into
// _migrations at the 'after' stage (update) - and reusable-template-sync
// runs it once more as the sync leg's final stamping step, after conflict
// resolution and the preserve steps have finished rewriting files. Before
// stamping it also normalizes the manifest-listed symlinks' targets
// (normalizeSymlinkTargets: the build branch ships targets with the
// template suffix kept so no branch link is ever dangling).
//
// STANDALONE BY DESIGN: branch_tree.ts ships this file on the build
// branches next to copier.yml, and copier executes it inside freshly
// rendered repositories where none of this repository's node_modules or
// shared/ helpers exist - node builtins only, no argv subprocesses.
//
// Only the "hash" tokens - plus the self entry's "commit" provenance slot,
// filled with the render's recorded _commit - are rewritten, in place,
// line by line: the rendered manifest keeps one entry per line
// (compose_template.ts's manifestEntryLine - keep ENTRY_LINE_RE below in
// sync with it), so a stamped manifest differs from the raw render in
// those token values alone and copier's three-way update merge sees
// minimal local edits. Split entries also carry declared-grammar fields
// ("grammar", the bounded-region marker strings) for the sync's
// split-file rebuild; this stamper reads only the legacy marker/managed
// pair (derived from the grammar at compose time) and passes the rest
// through untouched. An update can still leave inline conflict blocks in
// the manifest (both sides touch the hash lines); those resolve toward the
// template ("after updating") side before parsing - the direction
// resolve_copier_conflicts.ts uses - and the stamp then rewrites every
// hash anyway.
//
// Data problems (missing or unparseable manifest) warn and exit 0: a
// stamping gap must never
// abort an otherwise-successful render - validate-template's byte-parity
// check is the enforcement point that reports an unstamped manifest. The
// same division covers metadata: this script refreshes hash VALUES and
// deliberately trusts each entry's class for what to hash (it ships
// standalone, without the validator's ownership tables), so a hand-flipped
// class is not healed here - the validator's roster cross-check is what
// reports it.
//
// Env: TARGET_DIR (the rendered repository; default "." - the copier
// hooks run with cwd at the destination, the sync workflow passes
// TARGET_DIR=target).

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

export const MANIFEST_NAME = ".github/repo-platform-manifest.json";

/** The template suffix the build branch's symlink targets keep: links on
 *  the branch point at their templated twin so the `uses:` tarball
 *  staging never sees a dangling link, and copier renders link targets as
 *  strings without stripping the suffix - so this hook normalizes the
 *  rendered targets instead (normalizeSymlinkTargets below). */
const JINJA_SUFFIX = ".jinja";

/** One manifest entry line, as compose_template.ts emits it: indentation,
 *  the JSON-quoted path, the one-line entry object, an optional joining
 *  comma. */
const ENTRY_LINE_RE = /^(\s*)("(?:[^"\\]|\\.)*"): (\{.*\})(,?)$/;

/** The hash token inside an entry object; entries without one (starters,
 *  and legacy "mergeable" entries from renders that predate the class's
 *  retirement) are left alone. */
const HASH_RE = /"hash": (?:null|"[0-9a-f]{64}")/;

/** The provenance token on the manifest's own entry: the render's recorded
 *  _commit, letting the validator tell version skew from entry deletion. */
const COMMIT_RE = /"commit": (?:null|"[^"]*")/;

/** The `_commit` the render recorded in .copier-answers.yml, or null when
 *  the file or key is missing. Read with a line regex, not a YAML parser:
 *  this script ships standalone (no node_modules downstream), copier
 *  writes the key as a plain one-line scalar, and a value the regex cannot
 *  see just leaves provenance null - the validator's skew path. */
export function recordedCommit(root: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(root, ".copier-answers.yml"), "utf-8");
  } catch {
    return null;
  }
  const match = /^_commit:[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^#\n]*?))[ \t]*$/m.exec(text);
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return value === "" ? null : value;
}

// Copier's inline conflict markers, exactly as `copier update` writes them
// (git merge-file labels): anything looser could swallow content lines.
const CONFLICT_START = "<<<<<<< before updating";
const CONFLICT_SEP = "=======";
const CONFLICT_END = ">>>>>>> after updating";

/** Copier's inline conflict blocks resolved toward the template side: the
 *  lines between ======= and >>>>>>> survive, the "before updating" local
 *  lines and the marker lines drop. Only exact, well-sequenced copier
 *  markers count; a malformed block (unterminated, or an END outside a
 *  block) returns the text unchanged - dropping lines on a guess could
 *  silently discard entries, and the parse step then reports the mess. A
 *  bare ======= outside a block is ordinary content. */
export function resolveConflictsTowardAfter(text: string): string {
  const out: string[] = [];
  let state: "keep" | "local" | "template" = "keep";
  for (const line of text.split("\n")) {
    if (line === CONFLICT_START) {
      if (state !== "keep") return text;
      state = "local";
    } else if (line === CONFLICT_SEP && state !== "keep") {
      // A second separator inside a block is malformed; outside any block
      // a bare ======= is ordinary content.
      if (state !== "local") return text;
      state = "template";
    } else if (line === CONFLICT_END) {
      if (state !== "template") return text;
      state = "keep";
    } else if (state !== "local") {
      out.push(line);
    }
  }
  if (state !== "keep") return text;
  return out.join("\n");
}

/** THE marker-line predicate: a line is a split entry's marker line when
 *  its trimmed text equals the marker exactly. One owner for every
 *  splitter in the sync pipeline (this stamper's managedHalf,
 *  preserve_local_content's carries) - three sites once held three
 *  definitions, and the strictest (exact match after CR-strip) sent a
 *  marker line with one trailing space down the appendix path while the
 *  other two still counted it, delivering a tree the validator rejects.
 *  trim semantics on purpose: it is the most tolerant of the three, and
 *  the validator's self-contained twin (validate_generated_files.ts, kept
 *  matching by its own comment) already matches on line.trim(). */
export function isMarkerLine(line: string, marker: string): boolean {
  return line.trim() === marker;
}

/** A split entry's managed half: through the first marker line's newline
 *  for managed "above", from the start of the marker line for "below".
 *  `content` is latin1 text (byte-faithful); null when the marker line is
 *  missing (parity reports that - there is no honest hash to stamp). */
export function managedHalf(
  content: string,
  marker: string,
  managed: "above" | "below",
): string | null {
  let offset = 0;
  for (const line of content.split("\n")) {
    const end = offset + line.length;
    if (isMarkerLine(line, marker)) {
      return managed === "above"
        ? content.slice(0, Math.min(end + 1, content.length))
        : content.slice(offset);
    }
    offset = end + 1;
  }
  return null;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface ManifestEntryShape {
  class: string;
  marker?: unknown;
  managed?: unknown;
  hash?: unknown;
}

/** The manifest's files mapping parsed from `text` (conflict blocks
 *  resolved toward the template side first), or a problem string when the
 *  text cannot be trusted - shared by the symlink normalization and the
 *  stamping, so the two can never read different manifests and every
 *  consumer inherits the SAME validation: no mutation or stamp ever sees
 *  a manifest this function did not clear. Rejected here, value-free
 *  where the value is target-controlled:
 *  - unparseable JSON, or no top-level 'files' mapping;
 *  - an entry value that is not a plain object with a string class (a
 *    null or scalar entry would throw at entry.class in a consumer,
 *    turning the warn-and-continue contract into a hard render failure);
 *  - a duplicated entry for one path (found structurally, by
 *    filesObjectKeys): duplicate JSON keys last-win at parse time, so a
 *    duplicate can flip a path's class with no parse error, and acting
 *    on the parsed value would launder it. The path is named JSON-quoted
 *    rather than decoded: a decoded key could carry real newlines or
 *    control bytes into the problem string, which reaches a public log
 *    via main()'s warning. */
export function parseManifestFiles(text: string):
  | { files: Record<string, ManifestEntryShape>; resolved: string; problem: null }
  | {
      files: null;
      resolved: string;
      problem: string;
    } {
  const resolved = resolveConflictsTowardAfter(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(resolved);
  } catch {
    // Value-free on purpose: a SyntaxError's message quotes manifest text
    // (target-repo content), and this problem string reaches a public log
    // via main()'s warning. Standalone script - no shared/ helpers here.
    return { files: null, resolved, problem: "does not parse as a manifest (invalid JSON)" };
  }
  const manifest = parsed as { files?: unknown } | null;
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    typeof manifest.files !== "object" ||
    manifest.files === null ||
    Array.isArray(manifest.files)
  ) {
    return {
      files: null,
      resolved,
      problem: "does not parse as a manifest (no top-level 'files' mapping)",
    };
  }
  const files = manifest.files as Record<string, unknown>;
  for (const value of Object.values(files)) {
    const entry = value as ManifestEntryShape | null;
    if (entry === null || typeof entry !== "object" || typeof entry.class !== "string") {
      return {
        files: null,
        resolved,
        problem: "carries an entry that is not an object with a string class",
      };
    }
  }
  // Duplicates count STRUCTURALLY: filesObjectKeys walks the (already
  // JSON.parse-validated) text and returns the files object's direct
  // child keys in source order, duplicates preserved - the one thing
  // JSON.parse flattens away. Any duplicate shape is caught this way:
  // mixed null/object lines, re-indented merge artifacts, several keys on
  // one line, and a duplicated top-level "files" mapping itself; a path
  // literally named "files" or "$comment" is never confused with its
  // top-level structural twin.
  const walked = filesObjectKeys(resolved);
  if (walked.filesObjects !== 1) {
    return {
      files: null,
      resolved,
      problem: `carries ${walked.filesObjects} top-level "files" mappings (duplicate keys last-win at parse, so a duplicate can swap the whole entry set silently)`,
    };
  }
  const seenPaths = new Set<string>();
  for (const key of walked.keys) {
    if (seenPaths.has(key)) {
      return {
        files: null,
        resolved,
        problem: `carries more than one entry for ${JSON.stringify(key)} (duplicate keys last-win at parse, so a duplicate can flip its ownership class silently)`,
      };
    }
    seenPaths.add(key);
  }
  return { files: files as Record<string, ManifestEntryShape>, resolved, problem: null };
}

/** The DIRECT child keys of the top-level "files" object, in source order
 *  with duplicates preserved - exactly what JSON.parse flattens away -
 *  plus how many top-level "files" objects the text carries: a duplicated
 *  TOP-LEVEL mapping is the same corruption one level up (JSON.parse
 *  last-wins there too), so the walk reports the count and keeps the LAST
 *  object's keys to match what JSON.parse returned. Called only on text
 *  JSON.parse has already accepted, so this token walk runs over
 *  known-valid JSON and its string/escape/depth tracking cannot desync;
 *  keys nested inside entry values, and the structural top-level keys,
 *  are never counted. */
function filesObjectKeys(resolved: string): { keys: string[]; filesObjects: number } {
  let keys: string[] = [];
  let current: string[] = [];
  let filesObjects = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let lastString: string | null = null;
  let pendingFiles = false;
  let filesDepth = -1;
  for (let i = 0; i < resolved.length; i++) {
    const ch = resolved[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        lastString = resolved.slice(stringStart, i + 1);
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
      pendingFiles = false;
    } else if (ch === ":") {
      if (lastString !== null) {
        const key = JSON.parse(lastString) as string;
        if (depth === 1 && key === "files") {
          pendingFiles = true;
        } else if (filesDepth !== -1 && depth === filesDepth) {
          current.push(key);
        }
        lastString = null;
      }
    } else if (ch === "{") {
      depth++;
      if (pendingFiles && depth === 2) {
        filesObjects++;
        filesDepth = depth;
        current = [];
      }
      pendingFiles = false;
      lastString = null;
    } else if (ch === "[") {
      depth++;
      pendingFiles = false;
      lastString = null;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (filesDepth !== -1 && depth < filesDepth) {
        keys = current;
        filesDepth = -1;
      }
      pendingFiles = false;
      lastString = null;
    } else if (ch !== "," && !/\s/.test(ch)) {
      pendingFiles = false;
      lastString = null;
    }
  }
  return { keys, filesObjects };
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

/** The hash a manifest entry should carry for the file as it sits on disk:
 *  sha256 of the whole content (managed), of the managed half (split), or
 *  of the symlink target. null when the file is missing or its split
 *  marker is gone - the parity check reports those; a stamp must not
 *  invent a value. */
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
    if (
      typeof entry.marker !== "string" ||
      (entry.managed !== "above" && entry.managed !== "below")
    ) {
      return null;
    }
    const half = managedHalf(content, entry.marker, entry.managed);
    return half === null ? null : sha256(Buffer.from(half, "latin1"));
  }
  return sha256(Buffer.from(content, "latin1"));
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
    const match = ENTRY_LINE_RE.exec(line);
    if (!match) return line;
    const path = JSON.parse(match[2]) as string;
    const entry = files[path];
    if (entry === undefined || !HASH_RE.test(match[3])) return line;
    const hash = path === MANIFEST_NAME ? null : entryHash(root, path, entry);
    let body = match[3].replace(HASH_RE, `"hash": ${hash === null ? "null" : `"${hash}"`}`);
    if (path === MANIFEST_NAME) {
      body = body.replace(
        COMMIT_RE,
        `"commit": ${commit === null ? "null" : JSON.stringify(commit)}`,
      );
    }
    return `${match[1]}${match[2]}: ${body}${match[4]}`;
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

function main(): number {
  const root = resolve(process.env.TARGET_DIR || ".");
  const manifestPath = join(root, MANIFEST_NAME);
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf-8");
  } catch {
    console.error(
      `warning: ${MANIFEST_NAME} not found under ${root}; nothing to stamp ` +
        "(renders from templates that predate the manifest have none)",
    );
    return 0;
  }
  // Normalize the managed symlinks BEFORE stamping: the hash covers the
  // link target, so it must be taken after the rewrite. Parse-gated: a
  // manifest the parser rejects mutates nothing, so the rejection warning
  // below ("normalization skipped too") is always true.
  const normalized = normalizeFromText(text, root);
  if (normalized.rewritten.length > 0) {
    console.log(describeRewritten(normalized.rewritten));
  }
  const { out, problem } = stampManifestText(text, root);
  if (problem !== null) {
    console.error(
      `warning: ${MANIFEST_NAME} ${problem}; left unstamped (symlink target ` +
        "normalization skipped too) for validate-template's parity check to report",
    );
    return 0;
  }
  if (out === text) {
    console.log(`${MANIFEST_NAME} already stamped; nothing to write`);
    return 0;
  }
  writeFileSync(manifestPath, out);
  console.log(`stamped ${MANIFEST_NAME}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

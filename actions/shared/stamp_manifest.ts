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
// STANDALONE BY DESIGN: this file lives in actions/shared/, the
// dependency-free zone the build branch ships verbatim, and copier.yml's
// hooks run it from there ({{ _copier_conf.src_path }}/actions/shared/...)
// inside freshly rendered repositories where none of this repository's
// node_modules exist - node builtins and zone-internal imports only, no
// argv subprocesses.
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
const COMMIT_RE = /"commit": (?:null|"[^"]*")/;

/** The `_commit` the render recorded in .github/.copier-answers.yml, or
 *  null when
 *  the file or key is missing. Read with a line regex, not a YAML parser:
 *  this script ships standalone (no node_modules downstream), copier
 *  writes the key as a plain one-line scalar, and a value the regex cannot
 *  see just leaves provenance null - the validator's skew path. */
export function recordedCommit(root: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(root, ".github/.copier-answers.yml"), "utf-8");
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

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
// resolution and the preserve steps have finished rewriting files.
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
// minimal local edits. An update can still leave inline conflict blocks in
// the manifest (both sides touch the hash lines); those resolve toward the
// template ("after updating") side before parsing - the direction
// resolve_copier_conflicts.ts uses - and the stamp then rewrites every
// hash anyway.
//
// Data problems (missing or unparseable manifest) warn and exit 0, like
// the migrations contract in migrations/run.ts: a stamping gap must never
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
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MANIFEST_NAME = ".github/repo-platform-manifest.json";

/** One manifest entry line, as compose_template.ts emits it: indentation,
 *  the JSON-quoted path, the one-line entry object, an optional joining
 *  comma. */
const ENTRY_LINE_RE = /^(\s*)("(?:[^"\\]|\\.)*"): (\{.*\})(,?)$/;

/** The hash token inside an entry object; entries without one (starters,
 *  mergeable baselines) are left alone. */
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
    if (line.trim() === marker) {
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
 *  $comment). Returns the input unchanged with a problem message when the
 *  text does not parse. */
export function stampManifestText(
  text: string,
  root: string,
): { out: string; problem: string | null } {
  const resolved = resolveConflictsTowardAfter(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(resolved);
  } catch {
    // Value-free on purpose: a SyntaxError's message quotes manifest text
    // (target-repo content), and this problem string reaches a public log
    // via main()'s warning. Standalone script - no shared/ helpers here.
    return { out: text, problem: "does not parse as a manifest (invalid JSON)" };
  }
  const manifest = parsed as { files?: unknown } | null;
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    typeof manifest.files !== "object" ||
    manifest.files === null
  ) {
    return { out: text, problem: "does not parse as a manifest (no top-level 'files' mapping)" };
  }
  const files = manifest.files as Record<string, ManifestEntryShape>;
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
  const { out, problem } = stampManifestText(text, root);
  if (problem !== null) {
    console.error(
      `warning: ${MANIFEST_NAME} ${problem}; left unstamped for ` +
        "validate-template's parity check to report",
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

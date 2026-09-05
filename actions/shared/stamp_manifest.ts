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
// The hook also OWNS the shape of the recorded provenance: copier writes
// `_commit` from `git describe --tags --always` (an abbreviation, or a
// tag name), so copier.yml passes `--commit {{ _copier_conf.vcs_ref_hash }}`
// - the template clone's full commit hash - and the hook rewrites the
// `_commit:` line to it before stamping. Every producer (the sync,
// onboarding's plain `copier copy`, the goldens, the harnesses) thereby
// records the same 40-hex value with no environment to carry, and the
// manifest's provenance slot follows from the rewritten file.
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
// TARGET_DIR=target). Args: `--commit <40-hex sha>` (the copier hooks;
// the sync's final re-stamp passes none and keeps the recorded value).

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
import { basename, dirname, join, resolve } from "node:path";
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
 *  $comment). `withheld` names the paths the sync could not deliver (its
 *  push token lacked the Workflows scope, so it removed the added workflow
 *  files before pushing): each of those whose file is indeed absent gets
 *  `"withheld": true`, which validate-template reads as the one legitimate
 *  listed-but-missing state. The marker then stays for as long as the
 *  file stays undelivered (copier update honours the committed absence, so
 *  the entry is still withheld after every later stamp) and is stripped
 *  the moment a stamp can hash the file. Only withholdable paths (the
 *  directory the Workflows scope gates) ever carry it; any other withheld
 *  field - elsewhere, on a hashed entry, or with another value - is a hand
 *  edit and goes. Returns the input unchanged with a problem message when
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
  withheld: ReadonlySet<string> = new Set(),
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
    if (entry === undefined) return line;
    // The body is the one-line object parseManifestFiles already accepted,
    // so it parses; its field order is kept. Entries without a hash field
    // (starters, and legacy "mergeable" entries from renders that predate
    // the class's retirement) are left alone apart from a stray marker,
    // which no hash-less entry may carry.
    const fields = JSON.parse(parsedLine.body) as Record<string, JsonValue>;
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

/** The `--commit` argument, or null when absent. Anything else on argv is
 *  a wiring error in copier.yml and fails loudly - the hook's soft
 *  contract covers DATA problems, not a broken invocation. */
export function commitArg(argv: string[]): string | null {
  if (argv.length === 0) return null;
  if (argv.length !== 2 || argv[0] !== "--commit") {
    throw new Error(`usage: stamp_manifest.ts [--commit <40-hex sha>], got: ${argv.join(" ")}`);
  }
  if (!FULL_SHA_RE.test(argv[1])) {
    throw new Error(`--commit must be a full 40-hex sha, got '${argv[1]}'`);
  }
  return argv[1];
}

function main(): number {
  const root = resolve(process.env.TARGET_DIR || ".");
  const commit = commitArg(process.argv.slice(2));
  if (commit !== null) {
    // --commit is the copier hooks' form, and copier writes the answers
    // file before running them: a missing file or line here means the
    // hook is aimed at the wrong tree, which must fail the render.
    const answersPath = join(root, ANSWERS_FILE);
    const answers = readFileSync(answersPath, "utf-8");
    const rewritten = rewriteRecordedCommit(answers, commit);
    if (rewritten !== answers) {
      writeFileSync(answersPath, rewritten);
      console.log(`recorded _commit ${commit} in ${ANSWERS_FILE}`);
    }
  }
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

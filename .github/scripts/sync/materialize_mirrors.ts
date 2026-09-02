#!/usr/bin/env bun
// Materializes the target repository's declared mirror files after every
// step that rewrites the tree and before the final manifest stamp, so each
// mirror is a byte copy of the file THIS update delivers. The class it
// kills: a repo that must carry byte-identical copies of a rendered file
// at paths the template does not own (the skills repo's per-skill
// LICENSE.md copies - a standalone skill install copies only the skill
// folder, so every folder carries the license and its smoke test enforces
// byte equality). The sync rewrites only the rendered source, so before
// this step every template change to such a file re-broke the copies, and
// the only fix was a hand commit on the generated branch that the next
// resync overwrote.
//
// THE DECLARATION lives in the repo's own .repo-platform.yml - the
// repo-owned registration file the sync already reads for module
// selection, whose repo-added keys ride through `copier update`'s
// three-way merge (the template side never touches them) and through
// validate-template (which checks only the `modules` key):
//
//   mirrors:
//     - source: LICENSE.md
//       targets:
//         - template/LICENSE.md
//         - skills/*/LICENSE.md
//
// TARGET GLOBS: a single `*` matches within one path segment, resolved at
// materialization time against the DELIVERED tree - non-final `*` segments
// match existing directories, a final `*` segment matches existing regular
// files, and a literal final segment is written into every matched
// directory whether or not the file exists yet (a new skill folder gets
// its copy with no declaration edit - the stale-list re-break is the exact
// class this feature exists to end). `**` is refused: nothing in the
// fleet needs recursive matching, and an unbounded walk over a
// target-controlled pattern is risk with no customer.
//
// SAFETY - refusals are loud and hold the PR for review, never red and
// never silent (a red would block the very PR a human fixes the
// declaration in; the refused mirrors are merely stale, everything else
// in the update is sound):
//   - the source must be a file the render just wrote: listed in the
//     ownership manifest as class managed or split, present as a regular
//     file (repo-owned content does not move on sync, so mirroring it is
//     the repository's own job);
//   - no path may escape the repository (absolute, '.'/'..'/empty
//     segments, backslashes, any .git segment) - the declaration is
//     target content, and the check runs on the declared pattern (so the
//     expansion never walks outside the root) AND on every concrete path
//     the expansion produces (so a glob cannot land in .git/);
//   - no target may itself be a manifest-listed path: the template is that
//     path's writer, and a mirror over it would be a second writer whose
//     winner depends on step order;
//   - neither side may sit under .github/workflows/: commit_push.ts
//     restores workflow files from the base branch when the token lacks
//     the Workflows scope, AFTER this step - a workflow-file mirror could
//     ship unequal to what this step wrote and its listing would lie;
//   - no two sources may claim one target, and no planned target may be a
//     path prefix of another (both sides of either conflict are refused -
//     declaration order must never choose the winner);
//   - a symlink at either side's path or among its ancestors is refused -
//     following one would carry the read or the write outside the
//     checkout.
//
// THE DECLARATION IS READ FROM THE TARGET'S HEAD, not the post-update
// working tree: mirrors are repo-owned config, repos change them only
// through commits, and the recovery re-render (recover=recopy) rewrites
// .repo-platform.yml from the template - which would silently drop the
// key from the working tree. When the delivered file lost the key this
// step also restores it (appended, re-serialized), so the repo's
// configuration survives the merge; the restoration is named in the PR
// body.
//
// MANIFEST STANCE: mirror targets get NO manifest entries - they are
// repo-declared, not template-owned, and listing them would hand them to
// the retirement/parity machinery that only the template's own files ride.
// The validator ignores unlisted tree paths (a repo's own content), and
// the tail tripwire iterates only manifest split entries, so mirrors are
// invisible to both by construction; the manifest-listed-target refusal
// above is what keeps that boundary honest from the other side.
//
// Every materialized write is listed in the PR body (the diff must explain
// itself); the listing is informational and never forces review - the
// declaration is repo-owned consent, and holding every LICENSE bump for
// review would defeat the auto-heal this step exists for. Refusals land in
// their own PR-body section, which DOES force the manual-review path.
//
// Usage:
//   bun materialize_mirrors.ts [--root target] [--hide-details true|false]
//     [--note FILE] [--review FILE]
//
// --note / --review default to RUNNER_TEMP/<MIRRORS_*_NAME> - the shared
// section_files.ts constants open_pr.ts reads, so the workflow never names
// the files and the pairs cannot drift.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { ManifestEntryShape } from "../../../actions/shared/manifest.ts";
import { MANIFEST_NAME, parseManifestFiles } from "../../../actions/shared/manifest.ts";
import { parseFlags } from "../shared/flags.ts";
import { requireEnv } from "../shared/gha.ts";
import { headEntry } from "../shared/git_head.ts";
import { capture } from "../shared/proc.ts";
import { clip } from "./preserve_local_content.ts";
import { MIRRORS_NOTE_NAME, MIRRORS_REVIEW_NAME } from "./section_files.ts";

const REGISTRATION = ".repo-platform.yml";

export interface MirrorDecl {
  source: string;
  targets: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `mirrors` list read from parsed .repo-platform.yml data. An absent
 * key is the common fleet case (no mirrors, no output); everything
 * malformed becomes a problem string - a typo'd entry must never silently
 * mirror nothing (the stale-copy class this feature exists to end), so
 * problems flow into the refusal section and hold the PR for review.
 * Well-formed sibling entries still materialize: one bad entry must not
 * stale every good one. `raw` is the key's parsed value verbatim
 * (undefined when absent), for the recovery restoration - repo content is
 * restored as declared, well-formed or not. */
export function readMirrors(
  data: unknown,
  label = REGISTRATION,
): { mirrors: MirrorDecl[]; problems: string[]; raw: unknown } {
  if (!isPlainObject(data)) {
    return { mirrors: [], problems: [`${label}: top level must be a mapping`], raw: undefined };
  }
  const raw = data.mirrors;
  if (raw === undefined) return { mirrors: [], problems: [], raw };
  if (!Array.isArray(raw)) {
    return {
      mirrors: [],
      problems: [`${label}: \`mirrors\` must be a list of {source, targets} entries`],
      raw,
    };
  }
  const mirrors: MirrorDecl[] = [];
  const problems: string[] = [];
  raw.forEach((entry, index) => {
    const where = `${label}: mirrors[${index}]`;
    if (!isPlainObject(entry)) {
      problems.push(`${where}: must be a mapping with \`source\` and \`targets\``);
      return;
    }
    // Unknown keys refuse: a misspelled `targets` would otherwise declare
    // a mirror that silently mirrors nothing.
    const unknown = Object.keys(entry).filter((key) => key !== "source" && key !== "targets");
    if (unknown.length > 0) {
      problems.push(`${where}: unknown key(s) ${unknown.map((k) => clip(k)).join(", ")}`);
      return;
    }
    const { source, targets } = entry;
    if (typeof source !== "string" || source === "") {
      problems.push(`${where}: \`source\` must be a non-empty path string`);
      return;
    }
    if (
      !Array.isArray(targets) ||
      targets.length === 0 ||
      !targets.every((target): target is string => typeof target === "string" && target !== "")
    ) {
      problems.push(`${where}: \`targets\` must be a non-empty list of path strings`);
      return;
    }
    mirrors.push({ source, targets });
  });
  return { mirrors, problems, raw };
}

/** Why `path` cannot be trusted as a mirror path, or null when it is a
 * clean repository-relative path. The declaration is target-repo content,
 * so this boundary is what keeps a mirror read or write inside the
 * checkout; planMirrors applies it to the declared pattern (so the glob
 * expansion never walks outside the root), again to every concrete path
 * the expansion produces (so a `*` cannot land in .git/), and
 * materializeWrites re-checks it at the write boundary. The name checks
 * compare case-folded: a case-insensitive checkout (macOS rehearsals)
 * resolves `.GIT` to `.git`. */
export function mirrorPathProblem(path: string): string | null {
  if (path.startsWith("/")) return "is absolute";
  if (path.includes("\\")) return "contains a backslash";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control bytes in target-controlled paths is this check's job
  if (/[\x00-\x1f\x7f]/.test(path)) {
    // A NUL or other control byte is never a legitimate path component,
    // and letting one reach the filesystem APIs would throw a non-errno
    // error past the refusal handling - a red job steered by target
    // content instead of a review hold.
    return "carries control characters";
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "carries an empty, '.', or '..' segment, so it could escape the repository";
  }
  const folded = segments.map((segment) => segment.toLowerCase());
  if (folded.includes(".git")) return "carries a .git segment";
  if (folded[0] === ".github" && folded[1] === "workflows") {
    return (
      "sits under .github/workflows/ - the push step withholds workflow files when the " +
      "token lacks the Workflows scope, so a workflow-file mirror cannot be promised"
    );
  }
  return null;
}

/** A regex matching one path segment's `*` pattern (never across a `/`),
 * or null for a literal segment. */
function segmentMatcher(segment: string): RegExp | null {
  if (!segment.includes("*")) return null;
  const pattern = segment
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${pattern}$`);
}

/** Whether a filesystem error means "nothing at this path" (ENOENT, or a
 * file where a directory was expected - ENOTDIR). Anything else (EACCES,
 * EIO) is a broken runner, not an absent path, and rethrows: reading a
 * failure to look as "matched nothing" would silently stale a mirror. */
function absentError(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path) ?? null;
  } catch (err) {
    if (absentError(err)) return null;
    throw err;
  }
}

/** Concrete relative paths a target pattern resolves to under `root`,
 * sorted. Non-final `*` segments match existing non-symlink directories,
 * and a final `*` segment matches existing regular files only (a glob
 * cannot invent file names); a literal final segment lands in every
 * matched directory whether or not the file exists yet. EVERY symlink the
 * walk meets - a literal prefix, a glob-matched directory, a glob-matched
 * file - is reported in `symlinkedPrefixes` so the caller can refuse
 * loudly: following one could leave the checkout, and silently dropping
 * the match would ship a stale mirror with an empty explanation (the
 * silent-stale class this feature exists to kill). A pattern with no `*`
 * resolves to itself with no filesystem walk at all. */
export function expandTargetPattern(
  root: string,
  pattern: string,
): { matches: string[]; symlinkedPrefixes: string[] } {
  if (!pattern.includes("*")) return { matches: [pattern], symlinkedPrefixes: [] };
  const segments = pattern.split("/");
  const symlinkedPrefixes: string[] = [];
  let prefixes = [""];
  for (const [index, segment] of segments.entries()) {
    const final = index === segments.length - 1;
    const matcher = segmentMatcher(segment);
    const next: string[] = [];
    for (const prefix of prefixes) {
      const relOf = (name: string) => (prefix === "" ? name : `${prefix}/${name}`);
      if (matcher === null) {
        const rel = relOf(segment);
        if (!final && lstatOrNull(join(root, rel))?.isSymbolicLink()) {
          symlinkedPrefixes.push(rel);
          continue;
        }
        next.push(rel);
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(join(root, prefix)).sort();
      } catch (err) {
        // A literal prefix that does not exist matches nothing; a failure
        // to LOOK must not read the same way (absentError rethrows it).
        if (absentError(err)) continue;
        throw err;
      }
      for (const name of names) {
        if (!matcher.test(name)) continue;
        const stat = lstatOrNull(join(root, relOf(name)));
        if (stat === null) continue;
        if (stat.isSymbolicLink()) {
          // Loud like the literal branch above: a glob-matched symlink
          // (a `skills/legacy -> skills/new` alias, say) silently skipped
          // would ship that folder's mirror stale with nothing to explain
          // it.
          symlinkedPrefixes.push(relOf(name));
          continue;
        }
        if (final ? stat.isFile() : stat.isDirectory()) next.push(relOf(name));
      }
    }
    prefixes = next;
  }
  return { matches: prefixes.sort(), symlinkedPrefixes };
}

export interface MirrorWrite {
  source: string;
  target: string;
}

export interface MirrorPlan {
  writes: MirrorWrite[];
  /** Glob patterns that matched nothing - stated in the PR body so a
   * declaration that stopped matching is visible, but never a refusal
   * (an empty skills directory is a legitimate tree). */
  unmatched: { source: string; pattern: string }[];
  refusals: string[];
}

/** The first symlinked ancestor directory of `rel` under `root`, or null.
 * Same rationale as the split rebuild's writeRegularFile: file APIs follow
 * symlinks, so a linked ancestor carries a read or write outside the
 * checkout with the final component looking clean. */
function symlinkedAncestor(root: string, rel: string): string | null {
  for (let dir = dirname(rel); dir !== "." && dir !== "/"; dir = dirname(dir)) {
    if (lstatOrNull(join(root, dir))?.isSymbolicLink()) return dir;
  }
  return null;
}

/** Resolve the declarations against the delivered tree: the safety
 * refusals live here (see the header), the writes come out concrete,
 * deduplicated, and conflict-free. `manifest` is the delivered tree's
 * ownership manifest mapping; null (with `manifestProblem` saying why)
 * refuses every entry - without it no source can be proven
 * template-rendered and no target proven unowned, and this step never
 * guesses. */
export function planMirrors(
  root: string,
  mirrors: MirrorDecl[],
  manifest: Record<string, ManifestEntryShape> | null,
  manifestProblem: string,
): MirrorPlan {
  const unmatched: MirrorPlan["unmatched"] = [];
  const refusals: string[] = [];
  // Claims are keyed CASE-FOLDED (a case-insensitive checkout resolves
  // `COPY.md` and `copy.md` to one file), each holding every distinct
  // source and spelling that claimed it, in declaration order: the
  // conflict verdict below refuses ALL claims of a contested target, so
  // declaration order can never choose which content wins.
  const claims = new Map<string, { spellings: string[]; sources: string[] }>();
  // The manifest keys case-folded too, for the two-writer refusal: on a
  // case-insensitive checkout `security.md` IS SECURITY.md.
  const foldedManifest =
    manifest === null ? null : new Set(Object.keys(manifest).map((key) => key.toLowerCase()));
  for (const { source, targets } of mirrors) {
    const sourceLabel = `\`${clip(source)}\``;
    if (manifest === null || foldedManifest === null) {
      refusals.push(
        `${sourceLabel}: cannot be verified as a template-rendered file - ${manifestProblem}`,
      );
      continue;
    }
    const sourceProblem = source.includes("*")
      ? "contains a glob - a mirror source names exactly one file"
      : mirrorPathProblem(source);
    if (sourceProblem !== null) {
      refusals.push(`${sourceLabel}: source ${sourceProblem}`);
      continue;
    }
    const entry = manifest[source];
    if (entry === undefined || (entry.class !== "managed" && entry.class !== "split")) {
      refusals.push(
        `${sourceLabel}: not a file this sync's render wrote (the ownership manifest ` +
          `${entry === undefined ? "does not list it" : `lists it as class '${clip(entry.class)}'`}) - ` +
          "mirrors track template updates; copying repo-owned content is the repository's own job",
      );
      continue;
    }
    const linkedSourceDir = symlinkedAncestor(root, source);
    if (linkedSourceDir !== null) {
      refusals.push(
        `${sourceLabel}: source ancestor '${clip(linkedSourceDir)}' is a symbolic link, so the read could leave the checkout`,
      );
      continue;
    }
    const sourceStat = lstatOrNull(join(root, source));
    if (sourceStat === null || !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      refusals.push(
        `${sourceLabel}: missing from the delivered tree, or not a regular file - nothing to copy`,
      );
      continue;
    }
    for (const pattern of targets) {
      const patternLabel = `\`${clip(pattern)}\` (mirror of ${sourceLabel})`;
      const patternProblem = pattern.includes("**")
        ? "uses '**' - only single-segment '*' globs are supported"
        : mirrorPathProblem(pattern);
      if (patternProblem !== null) {
        refusals.push(`${patternLabel}: target ${patternProblem}`);
        continue;
      }
      const { matches, symlinkedPrefixes } = expandTargetPattern(root, pattern);
      for (const prefix of symlinkedPrefixes) {
        refusals.push(
          `${patternLabel}: prefix '${clip(prefix)}' is a symbolic link, so the expansion could leave the checkout`,
        );
      }
      if (matches.length === 0) {
        if (symlinkedPrefixes.length === 0) unmatched.push({ source, pattern });
        continue;
      }
      for (const target of matches) {
        const targetLabel = `\`${clip(target)}\` (mirror of ${sourceLabel})`;
        // Re-validate what the expansion PRODUCED: the pattern check above
        // keeps the walk inside the root, but a `*` segment can still
        // match a name (like .git) the declared pattern never spelled.
        const targetProblem = mirrorPathProblem(target);
        if (targetProblem !== null) {
          refusals.push(`${targetLabel}: target ${targetProblem}`);
          continue;
        }
        if (foldedManifest.has(target.toLowerCase())) {
          refusals.push(
            `${targetLabel}: the target is itself a template-owned path (listed in the ` +
              "ownership manifest), and a mirror over it would be a second writer - declare " +
              "a target the template does not render",
          );
          continue;
        }
        const claim = claims.get(target.toLowerCase()) ?? { spellings: [], sources: [] };
        if (!claim.spellings.includes(target)) claim.spellings.push(target);
        if (!claim.sources.includes(source)) claim.sources.push(source);
        claims.set(target.toLowerCase(), claim);
      }
    }
  }
  // Conflict verdicts over the whole claim set, order-independent: a
  // target claimed by two sources (or under two case spellings, which a
  // case-insensitive checkout folds onto one file) is refused for EVERY
  // claim, and a planned target that is a path prefix of another planned
  // target is refused on both sides (the deeper write would need the
  // shallower one to be a directory - whichever landed first would
  // decide, silently).
  const writes: MirrorWrite[] = [];
  const targetsPlanned = new Set(claims.keys());
  const prefixConflicted = new Set<string>();
  for (const target of targetsPlanned) {
    for (let dir = dirname(target); dir !== "." && dir !== "/"; dir = dirname(dir)) {
      if (targetsPlanned.has(dir)) {
        prefixConflicted.add(target);
        prefixConflicted.add(dir);
      }
    }
  }
  for (const [folded, { spellings, sources }] of claims) {
    const targetLabel = `\`${clip(spellings[0])}\``;
    if (sources.length > 1 || spellings.length > 1) {
      refusals.push(
        spellings.length > 1
          ? `${targetLabel}: also claimed as ${spellings
              .slice(1)
              .map((s) => `\`${clip(s)}\``)
              .join(" and ")} - one file on a case-insensitive checkout; every claim is refused`
          : `${targetLabel}: claimed as a mirror target by ${sources
              .map((s) => `\`${clip(s)}\``)
              .join(" and ")} - one target, one source; every claim is refused`,
      );
      continue;
    }
    if (prefixConflicted.has(folded)) {
      refusals.push(
        `${targetLabel}: one declared mirror target is a path prefix of another - both sides are refused`,
      );
      continue;
    }
    writes.push({ source: sources[0], target: spellings[0] });
  }
  writes.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  return { writes, unmatched, refusals };
}

/** Land the planned byte copies. Write-time refusals (a symlinked target
 * or ancestor, a filesystem failure) join the plan's; a target already
 * byte-equal to its source is reported as current and left untouched, so
 * a steady-state sync shows no mirror diff. */
export function materializeWrites(
  root: string,
  writes: MirrorWrite[],
): { written: MirrorWrite[]; current: MirrorWrite[]; refusals: string[] } {
  const written: MirrorWrite[] = [];
  const current: MirrorWrite[] = [];
  const refusals: string[] = [];
  for (const write of writes) {
    const label = `\`${clip(write.target)}\` (mirror of \`${clip(write.source)}\`)`;
    // Writer-boundary re-validation (defense in depth): planMirrors owns
    // these verdicts, but this writer is separately exported and its input
    // type cannot encode "already validated" - so the one check that keeps
    // a write inside the checkout runs again at the boundary.
    const boundaryProblem = mirrorPathProblem(write.target);
    if (boundaryProblem !== null) {
      refusals.push(`${label}: target ${boundaryProblem}`);
      continue;
    }
    const linkedDir = symlinkedAncestor(root, write.target);
    if (linkedDir !== null) {
      refusals.push(`${label}: ancestor '${clip(linkedDir)}' is a symbolic link`);
      continue;
    }
    const abs = join(root, write.target);
    const stat = lstatOrNull(abs);
    if (stat?.isSymbolicLink()) {
      refusals.push(`${label}: the target is a symbolic link, and the write would follow it`);
      continue;
    }
    if (stat !== null && !stat.isFile()) {
      refusals.push(`${label}: the target exists and is not a regular file`);
      continue;
    }
    const bytes = readFileSync(join(root, write.source));
    if (stat !== null && bytes.equals(readFileSync(abs))) {
      current.push(write);
      continue;
    }
    // A filesystem failure here (a regular file squatting where a parent
    // directory must go, a permission wall) refuses like every other bad
    // declaration shape - loud in the PR body, never a red job.
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "unknown error";
      refusals.push(`${label}: could not be written (${clip(String(code))})`);
      continue;
    }
    written.push(write);
  }
  return { written, current, refusals };
}

// The PR body caps at 64 KiB and every section shares it (see open_pr.ts),
// and entry counts are target-controlled - so both listings are bounded.
const MAX_LIST_LINES = 100;

function boundedList(lines: string[]): string {
  const shown = lines.slice(0, MAX_LIST_LINES);
  const omitted = lines.length - shown.length;
  return shown.join("\n") + (omitted > 0 ? `\n- (${omitted} more - see the diff)` : "");
}

/** The informational PR-body note: every materialized write, the patterns
 * that matched nothing, and the recovery restoration of the declaration
 * key. Empty when there is nothing to explain in the diff. */
export function renderNote(
  written: MirrorWrite[],
  currentCount: number,
  unmatched: MirrorPlan["unmatched"],
  restored = false,
): string {
  if (written.length === 0 && unmatched.length === 0 && !restored) return "";
  const intro =
    "Mirror copies materialized from this repository's own `.repo-platform.yml` " +
    "`mirrors` declaration - each target below is a byte-identical copy of its " +
    "freshly synced source (edit or remove the declaration to stop mirroring):";
  const bullets = [
    ...written.map(({ source, target }) => `- \`${clip(target)}\` <- \`${clip(source)}\``),
    ...unmatched.map(
      ({ source, pattern }) =>
        `- \`${clip(pattern)}\` (mirror of \`${clip(source)}\`): matched nothing in this tree - nothing written`,
    ),
    ...(restored
      ? [
          "- the update dropped the repo-owned `mirrors` key from `.repo-platform.yml` (a recovery re-render does); it was restored from the previous commit's declaration",
        ]
      : []),
  ];
  const tail =
    currentCount > 0
      ? `\n\n(${currentCount} declared target(s) already matched their source byte-for-byte and were left untouched.)`
      : "";
  return `${intro}\n\n${boundedList(bullets)}${tail}\n`;
}

/** The review-forcing PR-body section naming every refusal. */
export function renderRefusals(refusals: string[]): string {
  if (refusals.length === 0) return "";
  return [
    "> [!WARNING]",
    "> REFUSED mirror declaration(s) in `.repo-platform.yml`: nothing was",
    "> written for the entries below, so their mirror copies are stale (or",
    "> absent) in this update. Everything else in the update is unaffected -",
    "> fix the declaration and re-run the sync, or fix the files on this",
    "> branch before merging.",
    "",
    boundedList(refusals.map((refusal) => `- ${refusal}`)),
    "",
  ].join("\n");
}

/** Restore the repo-owned `mirrors` key into a delivered .repo-platform.yml
 * that lost it (the recovery re-render rewrites the file from the
 * template, which never carries the key). Appends the previous commit's
 * declaration re-serialized - content-faithful; comments inside the block
 * are not preserved - and only when the delivered file parses to a mapping
 * WITHOUT the key (anything else is not the clean re-render shape this
 * restoration exists for). Returns whether the file was rewritten. */
export function restoreMirrorsKey(root: string, headRaw: unknown): boolean {
  if (headRaw === undefined) return false;
  const path = join(root, REGISTRATION);
  let text: string;
  let data: unknown;
  try {
    text = readFileSync(path, "utf-8");
    data = parse(text);
  } catch {
    return false;
  }
  if (!isPlainObject(data) || data.mirrors !== undefined) return false;
  writeFileSync(
    path,
    `${text.endsWith("\n") ? text : `${text}\n`}\n${stringify({ mirrors: headRaw })}`,
    "utf-8",
  );
  return true;
}

/** Where the declaration text comes from - the target's HEAD, the
 * repo-owned truth: repos change mirrors only through commits, the
 * template contributes nothing to the key, and the recovery re-render
 * (recover=recopy) rewrites the working-tree file from the template, which
 * would silently drop the declaration. The working-tree copy is used ONLY
 * for a plain tree (local runs, fixtures - probed explicitly, never
 * inferred from a failed read); inside a git repository a HEAD that cannot
 * answer honestly (git failure, no committed copy, a non-file at the path)
 * REFUSES rather than falling back, because the fallback is exactly the
 * possibly-rewritten file this preference exists to avoid. */
export function declarationSource(root: string): { text: string | null; refusal: string | null } {
  // The probe's verdicts are discriminated, never inferred from a bare
  // nonzero exit: only git's definitive answers pick a path, and anything
  // else (a timeout, an unexpected failure) REFUSES - a broken git inside
  // a repository must not read as "plain tree" and fall back to the
  // rewritten working copy (the round-trip this preference exists to
  // avoid).
  const probe = capture(["git", "-C", root, "rev-parse", "--is-inside-work-tree"]);
  const inRepo = probe.exitCode === 0 && probe.stdout.trim() === "true";
  const notRepo =
    (probe.exitCode === 0 && !inRepo) ||
    (!probe.timedOut && probe.exitCode !== 0 && /not a git repository/i.test(probe.stderr));
  if (notRepo) {
    try {
      return { text: readFileSync(join(root, REGISTRATION), "utf-8"), refusal: null };
    } catch {
      return {
        text: null,
        refusal: `${REGISTRATION}: cannot be read, so any mirror declaration was not materialized`,
      };
    }
  }
  if (!inRepo) {
    return {
      text: null,
      refusal: `${REGISTRATION}: git could not answer whether the checkout is a repository, so the repo-owned mirror declaration cannot be verified - nothing was materialized`,
    };
  }
  try {
    const head = headEntry(root, REGISTRATION);
    if (head.kind === "blob") return { text: head.bytes.toString("utf-8"), refusal: null };
    return {
      text: null,
      refusal:
        `${REGISTRATION}: HEAD carries ${head.kind === "absent" ? "no committed copy" : "a non-file"} ` +
        "at this path, so the repo-owned mirror declaration cannot be read - nothing was materialized",
    };
  } catch {
    return {
      text: null,
      refusal: `${REGISTRATION}: HEAD cannot be read (git failure), so the repo-owned mirror declaration cannot be verified - nothing was materialized`,
    };
  }
}

function main(argv: string[]): number {
  const flags = parseFlags(
    argv,
    [] as const,
    ["--root", "--hide-details", "--note", "--review"] as const,
  );
  const root = flags["--root"] ?? "target";
  const hideDetails = flags["--hide-details"] === "true";
  const notePath = flags["--note"] ?? join(requireEnv("RUNNER_TEMP"), MIRRORS_NOTE_NAME);
  const reviewPath = flags["--review"] ?? join(requireEnv("RUNNER_TEMP"), MIRRORS_REVIEW_NAME);

  const { text: declText, refusal: declRefusal } = declarationSource(root);

  // Unreadable or unparseable refuses (hold-for-review), never red:
  // earlier steps already consumed this file, so this is defense in depth,
  // and a red would block the PR the fix belongs in.
  let mirrors: MirrorDecl[] = [];
  let problems: string[] = [];
  let rawDecl: unknown;
  if (declText === null) {
    problems = [declRefusal ?? `${REGISTRATION}: cannot be read`];
  } else {
    try {
      const read = readMirrors(parse(declText));
      mirrors = read.mirrors;
      problems = read.problems;
      rawDecl = read.raw;
    } catch {
      problems = [
        `${REGISTRATION}: cannot be parsed, so any mirror declaration in it was not materialized`,
      ];
    }
  }

  if (mirrors.length === 0 && problems.length === 0) {
    writeFileSync(notePath, "", "utf-8");
    writeFileSync(reviewPath, "", "utf-8");
    console.log("no mirror declarations; nothing to materialize");
    return 0;
  }

  const restored = restoreMirrorsKey(root, rawDecl);

  let manifest: Record<string, ManifestEntryShape> | null = null;
  let manifestProblem = `${MANIFEST_NAME} is missing from the delivered tree`;
  if (existsSync(join(root, MANIFEST_NAME))) {
    const parsed = parseManifestFiles(readFileSync(join(root, MANIFEST_NAME), "utf-8"));
    if (parsed.problem === null) {
      manifest = parsed.files;
    } else {
      manifestProblem = `${MANIFEST_NAME} ${parsed.problem}`;
    }
  }

  const plan = planMirrors(root, mirrors, manifest, manifestProblem);
  const { written, current, refusals: writeRefusals } = materializeWrites(root, plan.writes);
  const refusals = [
    ...problems.map((problem) => clip(problem)),
    ...plan.refusals,
    ...writeRefusals,
  ];

  writeFileSync(notePath, renderNote(written, current.length, plan.unmatched, restored), "utf-8");
  writeFileSync(reviewPath, renderRefusals(refusals), "utf-8");

  // Paths are target file data: a hide-details target gets counts here and
  // the detail only in the PR body, which lives in the private repo.
  if (!hideDetails) {
    for (const { source, target } of written) console.log(`mirrored ${source} -> ${target}`);
    for (const { source, pattern } of plan.unmatched) {
      console.log(`mirror pattern matched nothing: ${pattern} (mirror of ${source})`);
    }
  }
  if (restored) {
    console.log(
      `restored the repo-owned mirrors key into ${REGISTRATION} (the update had dropped it)`,
    );
  }
  console.log(
    `mirrors: ${written.length} written, ${current.length} already current, ` +
      `${plan.unmatched.length} pattern(s) matched nothing, ${refusals.length} refused`,
  );
  if (refusals.length > 0) {
    console.log(
      `::warning::${refusals.length} mirror declaration(s) refused - nothing was written ` +
        "for them and the PR stays manual-review" +
        (hideDetails
          ? " (detail hidden: private repository; listed in the PR body)."
          : " (details in the PR body)."),
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

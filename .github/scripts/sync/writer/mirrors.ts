// Mirrors: byte copies of files this sync wrote, declared in the target's
// registration. A declaration that cannot be written (the rules in
// actions/plan/mirrors.ts, plus what only the checkout shows: a symbolic
// link at the target or above it, a glob landing on a nested or contested
// path, a held source) fails the run before any copy of its pass is
// written, so no PR carries a repository out of sync; whatever else stands
// at a target (a directory, a file where a directory must be, other
// content) is replaced and reported for review.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathProblem } from "../../../../actions/plan/files_config.ts";
import {
  describeMirrorProblem,
  literalPrefix,
  type MirrorProblem,
  type Mirrors,
  mirrorDeclarationProblems,
  mirrorPathProblem,
  nestedWith,
  type OwnedPaths,
  segmentPattern,
} from "../../../../actions/plan/mirrors.ts";
import { lstatOrNull } from "../../shared/fs_probe.ts";
import { type Records, recordedHash, sha256 } from "./manifest.ts";
import { removeFile, removeTree, writeFile } from "./target_files.ts";

export type MirrorRow = { source: string; target: string } & (
  | { outcome: "written" | "current" | "replaced local edits"; detail: "" }
  /** What stood in the copy's way and was removed. */
  | { outcome: "replaced"; detail: string }
);

/** The text a copy replaced and what replaced it, for the report's diff. */
export interface ReplacedText {
  path: string;
  before: string;
  after: string;
}

/** Every declared target the run cannot write, each named with its reason. */
export class MirrorFailure extends Error {
  constructor(readonly failures: MirrorProblem[]) {
    super(failures.map(describeMirrorProblem).join("\n"));
  }
}

/** An ancestor directory a write cannot pass through, and what it is. */
export interface BlockedAncestor {
  dir: string;
  is: "a symbolic link" | "a file";
}

/** The shallowest ancestor of `path` that cannot be written through: a
 *  symbolic link (the write would land outside the checkout) or a file (no
 *  directory can be made of it). Null when every ancestor is a directory or
 *  nothing yet. */
export function blockedAncestor(root: string, path: string): BlockedAncestor | null {
  const segments = path.split("/");
  for (let depth = 1; depth < segments.length; depth++) {
    const dir = segments.slice(0, depth).join("/");
    const stat = lstatOrNull(join(root, dir));
    if (stat === null) return null;
    if (stat.isSymbolicLink()) return { dir, is: "a symbolic link" };
    if (!stat.isDirectory()) return { dir, is: "a file" };
  }
  return null;
}

/** blockedAncestor over the literal directories a pattern names before its
 *  first `*`: a readdir through a link would list names from outside the
 *  checkout, so the whole pattern fails. */
export function blockedPrefix(root: string, pattern: string): BlockedAncestor | null {
  const prefix = literalPrefix(pattern);
  return prefix === "" ? null : blockedAncestor(root, `${prefix}/x`);
}

/** The concrete paths a single-segment `*` pattern names under `root`: a
 *  `*` in a directory segment matches directories, a final `*` matches
 *  existing regular files, a literal final segment lands in every matched
 *  directory. A pattern without `*` is itself.
 *
 *  Symbolic links are matched, never skipped, and never listed through: a
 *  link in a final segment, or one in a directory segment that does not
 *  provably resolve to a file, ends the probing there, and so does a prefix
 *  pathProblem refuses (one grown past the length bound through long
 *  directory names, which a stat could not name). From there the rest of
 *  the pattern rides along literally (`skills/link/sub/*.md`) so
 *  applyMirrors fails the path by its linked ancestor or by name. A link
 *  to a file in a directory segment is no directory and is skipped like a
 *  file. */
export function expandPattern(root: string, pattern: string): string[] {
  if (!pattern.includes("*")) return [pattern];
  const segments = pattern.split("/");
  const out: string[] = [];
  const walk = (prefix: string, index: number, unprobed: boolean): void => {
    if (index === segments.length) {
      out.push(prefix);
      return;
    }
    const segment = segments[index];
    const rel = (name: string) => (prefix === "" ? name : `${prefix}/${name}`);
    if (!segment.includes("*")) {
      const next = rel(segment);
      walk(
        next,
        index + 1,
        unprobed ||
          pathProblem(next) !== null ||
          lstatOrNull(join(root, next))?.isSymbolicLink() === true,
      );
      return;
    }
    if (unprobed) {
      out.push(rel(segments.slice(index).join("/")));
      return;
    }
    const dir = join(root, prefix);
    if (lstatOrNull(dir)?.isDirectory() !== true) return;
    const final = index === segments.length - 1;
    const names = segmentPattern(segment);
    for (const name of readdirSync(dir).sort()) {
      if (!names.test(name)) continue;
      if (pathProblem(rel(name)) !== null) {
        walk(rel(name), index + 1, true);
        continue;
      }
      const stat = lstatOrNull(join(dir, name));
      if (stat === null) continue;
      if (stat.isSymbolicLink()) {
        if (final || !linksToFile(join(dir, name))) walk(rel(name), index + 1, true);
      } else if (final ? stat.isFile() : stat.isDirectory()) {
        walk(rel(name), index + 1, false);
      }
    }
  };
  walk("", 0, false);
  return out.sort();
}

/** Whether the link at `path` provably resolves to a regular file. Any
 *  failure to look (dangling, a loop, a name too long, a directory the
 *  runner may not traverse) is a no: the link is then failed by name
 *  instead of skipped, so no lookup failure can abort the pass. */
function linksToFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** One concrete path a source claims, with the bytes it would copy. */
interface Claim {
  source: string;
  path: string;
  bytes: Buffer;
}

/** Copies every declared mirror. `written` maps the managed and split paths
 *  written this run to their bytes, `owned` is what files.yml claims here
 *  plus the stale records the run retires, and `records` are the previous
 *  sync's, read for the last mirror hash.
 *  Literal targets are written before any `*` pattern expands, so a
 *  directory a literal creates is matched in the same run. Every path of a
 *  pass is judged before the pass writes; a path that cannot be written
 *  throws MirrorFailure with every such path of the pass. */
export function applyMirrors(
  target: string,
  mirrors: Mirrors,
  written: ReadonlyMap<string, Buffer>,
  owned: OwnedPaths,
  records: Records,
): { rows: MirrorRow[]; replaced: ReplacedText[]; hashes: Map<string, string> } {
  const declared = mirrorDeclarationProblems(mirrors, owned);
  if (declared.length > 0) throw new MirrorFailure(declared);
  const rows: MirrorRow[] = [];
  const replaced: ReplacedText[] = [];
  /** Every target's sha256 once its copy holds the source: its record. */
  const hashes = new Map<string, string>();
  /** Each concrete path's one writer. */
  const settled = new Map<string, string>();

  /** The concrete claims of a pass: a literal is its own path; a glob fails
   *  whole when it reads through a link or matches nothing, else expands.
   *  A held source has nothing to copy, so every target of it fails. */
  const claimsOf = (
    patterns: { source: string; pattern: string }[],
    kind: "literal" | "glob",
    failures: MirrorProblem[],
  ): Claim[] => {
    const claims: Claim[] = [];
    for (const { source, pattern } of patterns) {
      const bytes = written.get(source);
      if (bytes === undefined) {
        failures.push({
          source,
          target: pattern,
          problem: "the source was held this run, so there is nothing to copy",
        });
        continue;
      }
      if (kind === "literal") {
        claims.push({ source, path: pattern, bytes });
        continue;
      }
      const blocked = blockedPrefix(target, pattern);
      if (blocked !== null) {
        failures.push({
          source,
          target: pattern,
          problem: `the pattern's ancestor '${blocked.dir}' is ${blocked.is}`,
        });
        continue;
      }
      const paths = expandPattern(target, pattern);
      if (paths.length === 0) {
        failures.push({ source, target: pattern, problem: "the pattern matches nothing" });
        continue;
      }
      for (const path of paths) claims.push({ source, path, bytes });
    }
    return claims;
  };

  /** Why a concrete path cannot be written by anyone, or null. A glob
   *  names files in directories that exist; only a literal creates one. */
  const pathFailure = (path: string, kind: "literal" | "glob"): string | null => {
    const problem = mirrorPathProblem(path, owned);
    if (problem !== null) return `the target ${problem}`;
    const blocked = blockedAncestor(target, path);
    if (blocked?.is === "a symbolic link") {
      return `the target's ancestor '${blocked.dir}' is a symbolic link`;
    }
    if (kind === "glob") {
      if (blocked !== null) return `the target's ancestor '${blocked.dir}' is a file`;
      if (lstatOrNull(join(target, dirname(path)))?.isDirectory() !== true) {
        return `the target's directory '${dirname(path)}' does not exist`;
      }
    }
    const stat = blocked === null ? lstatOrNull(join(target, path)) : null;
    if (stat?.isSymbolicLink()) return "the target is a symbolic link";
    if (stat !== null && !stat.isFile() && !stat.isDirectory()) {
      return "the target is neither a file nor a directory";
    }
    return null;
  };

  /** Settles every path the pass claims: an unwritable path, one nested
   *  with another target (both sides, so declaration order never picks the
   *  winner), or one claimed by two sources fails; the rest are one
   *  source's to write. Throws with every failure of the pass before
   *  anything is written, so the claims it returns are all writable by
   *  their source. */
  const settle = (
    claims: Claim[],
    kind: "literal" | "glob",
    failures: MirrorProblem[],
  ): Claim[] => {
    const claimants = new Map<string, Set<string>>();
    for (const { source, path } of claims) {
      const owner = settled.get(path);
      if (owner !== undefined) {
        if (owner !== source) {
          failures.push({
            source,
            target: path,
            problem: "the target is claimed by more than one source",
          });
        }
        continue;
      }
      const sources = claimants.get(path) ?? new Set<string>();
      sources.add(source);
      claimants.set(path, sources);
    }
    const every = new Set([...settled.keys(), ...claimants.keys()]);
    for (const [path, sources] of claimants) {
      const problems: string[] = [];
      const failure = pathFailure(path, kind);
      if (failure !== null) problems.push(failure);
      const nested = nestedWith(path, every);
      if (nested !== null) {
        problems.push(
          "under" in nested
            ? `the target sits under another target '${nested.under}'`
            : `the target is a path prefix of another target '${nested.above}'`,
        );
      }
      if (sources.size > 1) problems.push("the target is claimed by more than one source");
      for (const source of sources) {
        for (const problem of problems) failures.push({ source, target: path, problem });
      }
      if (problems.length === 0) settled.set(path, [...sources][0]);
    }
    if (failures.length > 0) throw new MirrorFailure(failures);
    return claims;
  };

  /** Writes the settled claims. What stands in the way is removed and
   *  named: a file where a directory must be, a directory at the target;
   *  other content is replaced and kept for the report's diff. Only a
   *  mirror record vouches for the previous copy's bytes: another class's
   *  hash covers something else (a region, a link target). */
  const apply = (claims: Claim[]) => {
    for (const { source, path, bytes } of claims) {
      hashes.set(path, sha256(bytes));
      let detail = "";
      const blocked = blockedAncestor(target, path);
      if (blocked !== null) {
        removeFile(target, blocked.dir);
        detail = `a file stood at ancestor '${blocked.dir}'`;
      }
      const stat = lstatOrNull(join(target, path));
      if (stat?.isDirectory()) {
        removeTree(target, path);
        detail = "a directory stood at the target";
      }
      const found = stat?.isFile() ? readFileSync(join(target, path)) : null;
      if (found?.equals(bytes)) {
        rows.push({ source, target: path, outcome: "current", detail: "" });
        continue;
      }
      const previous = records[path]?.class === "mirror" ? recordedHash(records, path) : null;
      writeFile(target, path, bytes);
      if (detail !== "") {
        rows.push({ source, target: path, outcome: "replaced", detail });
      } else if (found !== null && sha256(found) !== previous) {
        replaced.push({ path, before: found.toString("utf-8"), after: bytes.toString("utf-8") });
        rows.push({ source, target: path, outcome: "replaced local edits", detail: "" });
      } else {
        rows.push({ source, target: path, outcome: "written", detail: "" });
      }
    }
  };

  const patterns = mirrors.flatMap(({ source, targets }) =>
    targets.map((pattern) => ({ source, pattern })),
  );
  for (const kind of ["literal", "glob"] as const) {
    const failures: MirrorProblem[] = [];
    const claims = claimsOf(
      patterns.filter(({ pattern }) => pattern.includes("*") === (kind === "glob")),
      kind,
      failures,
    );
    apply(settle(claims, kind, failures));
  }
  return { rows, replaced, hashes };
}

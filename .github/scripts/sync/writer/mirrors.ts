// A declaration that cannot be written fails the run before any copy of its pass is written, so no PR carries a repository out of
// sync; actions/plan/mirrors.ts holds the declaration rules, and this file adds what only the checkout shows.

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

export interface ReplacedText {
  path: string;
  before: string;
  after: string;
}

export class MirrorFailure extends Error {
  constructor(readonly failures: MirrorProblem[]) {
    super(failures.map(describeMirrorProblem).join("\n"));
  }
}

export interface BlockedAncestor {
  dir: string;
  is: "a symbolic link" | "a file";
}

/** A symbolic link ancestor could land the write outside the checkout; a file ancestor can have no directory made of it. */
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

/** A readdir through a linked ancestor could list names from outside the checkout, so the whole pattern fails. */
export function blockedPrefix(root: string, pattern: string): BlockedAncestor | null {
  const prefix = literalPrefix(pattern);
  return prefix === "" ? null : blockedAncestor(root, `${prefix}/x`);
}

/** Probing stops at a symbolic link, or at a prefix pathProblem refuses, and the rest of the pattern rides along literally
 *  (`skills/link/sub/*.md`) so applyMirrors fails the path by its linked ancestor or by name rather than dropping it silently.
 *    link in a literal segment, or in the final segment            -> rides literally
 *    link matched by a `*` directory segment, not provably a file  -> rides literally
 *    link matched by a `*` directory segment, resolving to a file  -> skipped, like a file */
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

/** Any failure to look (dangling, a loop, a name too long, an untraversable directory) is a no: the link is then failed by name
 *  instead of skipped, so no lookup failure aborts the pass. */
function linksToFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

interface Claim {
  source: string;
  path: string;
  bytes: Buffer;
}

/** Literal targets are written before any `*` pattern expands, so a directory a literal creates is matched in the same run.
 *  `owned` is what files.yml claims here plus the stale records the run retires; `records` are the previous sync's, read for the
 *  last mirror hash. */
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
  const hashes = new Map<string, string>();
  const settled = new Set<string>();

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

  /** Nesting fails both sides, so declaration order never picks the winner. A path an earlier pass settled is this source's own:
   *  mirrorDeclarationProblems refuses every glob that matches another source's literal. */
  const settle = (
    claims: Claim[],
    kind: "literal" | "glob",
    failures: MirrorProblem[],
  ): Claim[] => {
    const claimants = new Map<string, Set<string>>();
    for (const { source, path } of claims) {
      if (settled.has(path)) continue;
      const sources = claimants.get(path) ?? new Set<string>();
      sources.add(source);
      claimants.set(path, sources);
    }
    const every = new Set([...settled, ...claimants.keys()]);
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
      if (problems.length === 0) settled.add(path);
    }
    if (failures.length > 0) throw new MirrorFailure(failures);
    return claims;
  };

  /** Only a mirror record vouches for the previous copy's bytes: a split or link record's hash covers a region or a link target, not the file. */
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

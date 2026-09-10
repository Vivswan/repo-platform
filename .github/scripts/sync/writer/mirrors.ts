// Mirrors: byte copies of files this sync wrote, declared in the target's
// registration. A target that holds anything but the previous mirror (the
// hash of its mirror record) or the new content is refused, never
// overwritten; so is a symbolic link, which a byte copy would write through,
// and a path files.yml writes or retires, which two owners would fight over.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathProblem } from "../../../../actions/plan/files_config.ts";
import type { Registration } from "../../../../actions/plan/registration.ts";
import { lstatOrNull, statOrNull } from "../../shared/fs_probe.ts";
import { type Records, recordedHash, sha256 } from "./manifest.ts";
import { probe, writeFile } from "./target_files.ts";

export interface MirrorRow {
  source: string;
  target: string;
  outcome: "written" | "current" | "refused";
  detail: string;
}

/** Why a declared mirror path cannot be written, or null. `selected` is
 *  every path files.yml writes for this repository, starters included;
 *  `retired` every path it retires (listed or stale). */
export function mirrorPathProblem(
  path: string,
  selected: ReadonlySet<string>,
  retired: ReadonlySet<string> = new Set(),
): string | null {
  const problem = pathProblem(path);
  if (problem !== null) return problem;
  const lower = path.toLowerCase();
  if (lower.startsWith(".github/workflows/")) return "sits under .github/workflows/";
  if (selected.has(path)) return "is a path files.yml writes";
  if (retired.has(path)) return "is a path files.yml retires";
  return null;
}

/** The shallowest symbolic link among the directories above `path`, or
 *  null: a write through one would land outside the checkout. */
export function linkedAncestor(root: string, path: string): string | null {
  const segments = path.split("/");
  for (let depth = 1; depth < segments.length; depth++) {
    const dir = segments.slice(0, depth).join("/");
    if (lstatOrNull(join(root, dir))?.isSymbolicLink()) return dir;
  }
  return null;
}

/** linkedAncestor over the literal directories a pattern names before its
 *  first `*`: a readdir through one would list names from outside the
 *  checkout, so the whole pattern is refused. */
export function linkedPrefix(root: string, pattern: string): string | null {
  const segments = pattern.split("/");
  const star = segments.findIndex((segment) => segment.includes("*"));
  return linkedAncestor(root, star === -1 ? pattern : segments.slice(0, star + 1).join("/"));
}

/** The concrete paths a single-segment `*` pattern names under `root`: a
 *  `*` in a directory segment matches directories, a final `*` matches
 *  existing regular files, a literal final segment lands in every matched
 *  directory. A pattern without `*` is itself.
 *
 *  Symbolic links are matched, never skipped, and never listed through: a
 *  link in a final segment, or one in a directory segment that resolves to
 *  a directory or to nothing, makes the prefix LINKED, and from there the
 *  rest of the pattern rides along literally (`skills/link/sub/*.md`) so
 *  applyMirrors refuses the path by its linked ancestor. A link to a file
 *  in a directory segment is no directory and is skipped like a file. */
export function expandPattern(root: string, pattern: string): string[] {
  if (!pattern.includes("*")) return [pattern];
  const segments = pattern.split("/");
  const out: string[] = [];
  const walk = (prefix: string, index: number, linked: boolean): void => {
    if (index === segments.length) {
      out.push(prefix);
      return;
    }
    const segment = segments[index];
    const rel = (name: string) => (prefix === "" ? name : `${prefix}/${name}`);
    if (!segment.includes("*")) {
      const next = rel(segment);
      walk(next, index + 1, linked || lstatOrNull(join(root, next))?.isSymbolicLink() === true);
      return;
    }
    if (linked) {
      out.push(rel(segments.slice(index).join("/")));
      return;
    }
    const dir = join(root, prefix);
    if (lstatOrNull(dir)?.isDirectory() !== true) return;
    const final = index === segments.length - 1;
    // A mirror glob segment from the repository's .repo-platform.yml, escaped.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const re = new RegExp(`^${segment.split("*").map(escapeRe).join("[^/]*")}$`);
    for (const name of readdirSync(dir).sort()) {
      if (!re.test(name)) continue;
      const stat = lstatOrNull(join(dir, name));
      if (stat === null) continue;
      if (stat.isSymbolicLink()) {
        if (final || statOrNull(join(dir, name))?.isFile() !== true)
          walk(rel(name), index + 1, true);
      } else if (final ? stat.isFile() : stat.isDirectory()) {
        walk(rel(name), index + 1, linked);
      }
    }
  };
  walk("", 0, false);
  return out.sort();
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Claim {
  source: string;
  path: string;
}

/** Copies every declared mirror whose source this sync wrote. `written`
 *  maps the managed and split paths written this run to their bytes,
 *  `selected` is every selected entry path and `retired` every retired one
 *  (no mirror may land on either), and `records` are the previous sync's,
 *  read for the last mirror hash. Literal targets are written before any
 *  `*` pattern expands, so a directory a literal creates is matched in the
 *  same run. */
export function applyMirrors(
  target: string,
  mirrors: NonNullable<Registration["mirrors"]>,
  written: ReadonlyMap<string, Buffer>,
  selected: ReadonlySet<string>,
  records: Records,
  retired: ReadonlySet<string> = new Set(),
): MirrorRow[] {
  const rows: MirrorRow[] = [];
  const refuse = (source: string, path: string, detail: string) =>
    rows.push({ source, target: path, outcome: "refused", detail });
  const targetProblem = (path: string) => mirrorPathProblem(path, selected, retired);
  // Every pattern resolves to concrete targets before any write in its
  // pass, so a target two sources claim is refused for both instead of
  // alternating between them run after run.
  const claimsOf = (
    patterns: { source: string; pattern: string }[],
    kind: "literal" | "glob",
  ): Claim[] => {
    const claims: Claim[] = [];
    for (const { source, pattern } of patterns) {
      const patternProblem = pattern.includes("**") ? "uses '**'" : targetProblem(pattern);
      if (patternProblem !== null) {
        refuse(source, pattern, `the pattern ${patternProblem}`);
        continue;
      }
      const linked = linkedPrefix(target, pattern);
      if (linked !== null) {
        refuse(source, pattern, `the pattern's ancestor '${linked}' is a symbolic link`);
        continue;
      }
      const paths = expandPattern(target, pattern);
      if (paths.length === 0) {
        refuse(source, pattern, "the pattern matches nothing");
        continue;
      }
      for (const path of paths) {
        const problem = targetProblem(path);
        if (problem !== null) {
          refuse(source, path, `the target ${problem}`);
          continue;
        }
        // Judged here, before any write of the pass: a matched path under a
        // linked directory would otherwise abort the run mid-way.
        const linkedDir = linkedAncestor(target, path);
        if (linkedDir !== null) {
          refuse(source, path, `the target's ancestor '${linkedDir}' is a symbolic link`);
          continue;
        }
        // A glob names files in directories that exist; only a literal
        // target creates one.
        if (kind === "glob" && lstatOrNull(join(target, dirname(path)))?.isDirectory() !== true) {
          refuse(source, path, `the target's directory '${dirname(path)}' does not exist`);
          continue;
        }
        claims.push({ source, path });
      }
    }
    return claims;
  };
  const declared = mirrors.flatMap(({ source, targets }) =>
    targets.map((pattern) => ({ source, pattern })),
  );
  // Who owns each concrete target: one source, or CONTESTED once two
  // sources claimed it in the same pass (a later glob cannot take it).
  const CONTESTED = Symbol("contested");
  const owner = new Map<string, string | typeof CONTESTED>();
  const claimAll = (claims: Claim[]) => {
    for (const { source, path } of claims) {
      const current = owner.get(path);
      if (current === undefined) owner.set(path, source);
      else if (current !== source) owner.set(path, CONTESTED);
    }
  };
  const apply = (claims: Claim[]) => {
    for (const { source, path } of claims) {
      if (owner.get(path) !== source) {
        refuse(source, path, "the target is claimed by more than one source");
        continue;
      }
      // Refused per concrete target, so each keeps its previous record.
      const bytes = written.get(source);
      if (bytes === undefined) {
        refuse(source, path, "the source is not a file this sync writes");
        continue;
      }
      const found = probe(target, path);
      if (found.kind === "link") {
        refuse(source, path, "the target is a symbolic link");
        continue;
      }
      if (found.kind === "file" && found.bytes.equals(bytes)) {
        rows.push({ source, target: path, outcome: "current", detail: "" });
        continue;
      }
      // Only a mirror record vouches for the bytes: another class's hash
      // covers something else (a region, a link target).
      const previous = records[path]?.class === "mirror" ? recordedHash(records, path) : null;
      if (found.kind === "file" && sha256(found.bytes) !== previous) {
        refuse(source, path, "the target holds content that is not the previous mirror");
        continue;
      }
      writeFile(target, path, bytes);
      rows.push({ source, target: path, outcome: "written", detail: "" });
    }
  };
  const literal = claimsOf(
    declared.filter(({ pattern }) => !pattern.includes("*")),
    "literal",
  );
  claimAll(literal);
  apply(literal);
  const globbed = claimsOf(
    declared.filter(({ pattern }) => pattern.includes("*")),
    "glob",
  );
  // A target the literal pass settled (owned or contested) stays as it is.
  claimAll(globbed.filter((claim) => !owner.has(claim.path)));
  apply(globbed);
  return rows;
}

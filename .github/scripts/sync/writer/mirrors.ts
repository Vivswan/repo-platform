// Mirrors: byte copies of files this sync wrote, declared in the target's
// registration. A target that holds anything but the previous mirror (the
// hash of its mirror record) or the new content is refused, never
// overwritten; so is a symbolic link, which a byte copy would write through,
// and a path files.yml writes or retires, which two owners would fight over.
// Every target is judged before its pass writes: a path nested with another
// path, or with a file or a directory already there, is refused as a row,
// so one bad declaration never aborts the run for the good ones.

import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathProblem } from "../../../../actions/plan/files_config.ts";
import type { Registration } from "../../../../actions/plan/registration.ts";
import { lstatOrNull } from "../../shared/fs_probe.ts";
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
 *  `retired` every path it retires (listed or stale). A path above or below
 *  one of those is refused like the path itself: the file would have to be
 *  a directory too. */
export function mirrorPathProblem(
  path: string,
  selected: ReadonlySet<string>,
  retired: ReadonlySet<string> = new Set(),
): string | null {
  const problem = pathProblem(path);
  if (problem !== null) return problem;
  const lower = path.toLowerCase();
  if (lower.startsWith(".github/workflows/")) return "sits under .github/workflows/";
  for (const [owned, verb] of [
    [selected, "writes"],
    [retired, "retires"],
  ] as const) {
    if (owned.has(path)) return `is a path files.yml ${verb}`;
    const nested = nestedWith(path, owned);
    if (nested !== null) {
      return "under" in nested
        ? `sits under '${nested.under}', a path files.yml ${verb}`
        : `is a path prefix of '${nested.above}', a path files.yml ${verb}`;
    }
  }
  return null;
}

/** The path among `others` that `path` sits under, or that sits under
 *  `path`; null when it nests with none (itself included). */
function nestedWith(
  path: string,
  others: ReadonlySet<string>,
): { under: string } | { above: string } | null {
  for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
    if (others.has(dir)) return { under: dir };
  }
  for (const other of others) {
    if (other.startsWith(`${path}/`)) return { above: other };
  }
  return null;
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
 *  checkout, so the whole pattern is refused. */
export function blockedPrefix(root: string, pattern: string): BlockedAncestor | null {
  const segments = pattern.split("/");
  const star = segments.findIndex((segment) => segment.includes("*"));
  return blockedAncestor(root, star === -1 ? pattern : segments.slice(0, star + 1).join("/"));
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
 *  applyMirrors refuses the path by its linked ancestor or by name. A link
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
    // A mirror glob segment from the repository's .repo-platform.yml, escaped.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const re = new RegExp(`^${segment.split("*").map(escapeRe).join("[^/]*")}$`);
    for (const name of readdirSync(dir).sort()) {
      if (!re.test(name)) continue;
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
 *  runner may not traverse) is a no: the link is then refused by name
 *  instead of skipped, so no lookup failure can abort the pass. */
function linksToFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Claim {
  source: string;
  path: string;
}

/** What a pass settled for a concrete path: the one source that writes it,
 *  or why no source does. A later pass finds the path settled and leaves it
 *  as it is (its own source may still report it current). */
type Settled = { source: string } | { refused: string };

interface Judged extends Claim {
  state: Settled;
}

/** Copies every declared mirror whose source this sync wrote. `written`
 *  maps the managed and split paths written this run to their bytes,
 *  `selected` is every selected entry path and `retired` every retired one
 *  (no mirror may land on either), and `records` are the previous sync's,
 *  read for the last mirror hash. Literal targets are written before any
 *  `*` pattern expands, so a directory a literal creates is matched in the
 *  same run. Within a pass every concrete path is judged and settled before
 *  the first write, so a bad target is a refused row and never a throw. */
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
  // A source is a path files.yml writes whatever `selected` carries.
  const platform = new Set([...selected, ...written.keys()]);
  const targetProblem = (path: string) => mirrorPathProblem(path, platform, retired);
  const settled = new Map<string, Settled>();

  /** Why a concrete path cannot be written at all, whoever claims it. A
   *  glob names files in directories that exist; only a literal creates one. */
  const pathRefusal = (path: string, kind: "literal" | "glob"): string | null => {
    const problem = targetProblem(path);
    if (problem !== null) return `the target ${problem}`;
    const blocked = blockedAncestor(target, path);
    if (blocked !== null) return `the target's ancestor '${blocked.dir}' is ${blocked.is}`;
    const stat = lstatOrNull(join(target, path));
    if (stat !== null && !stat.isFile() && !stat.isSymbolicLink()) {
      return "the target is a directory";
    }
    if (kind === "glob" && lstatOrNull(join(target, dirname(path)))?.isDirectory() !== true) {
      return `the target's directory '${dirname(path)}' does not exist`;
    }
    return null;
  };

  /** The concrete claims of a pass: a literal is its own path; a glob is
   *  refused whole when it is unsafe, matches nothing, or reads through a
   *  link, else expanded. */
  const claimsOf = (
    patterns: { source: string; pattern: string }[],
    kind: "literal" | "glob",
  ): Claim[] => {
    const claims: Claim[] = [];
    for (const { source, pattern } of patterns) {
      if (kind === "literal") {
        claims.push({ source, path: pattern });
        continue;
      }
      const patternProblem = pattern.includes("**") ? "uses '**'" : targetProblem(pattern);
      if (patternProblem !== null) {
        refuse(source, pattern, `the pattern ${patternProblem}`);
        continue;
      }
      const blocked = blockedPrefix(target, pattern);
      if (blocked !== null) {
        refuse(source, pattern, `the pattern's ancestor '${blocked.dir}' is ${blocked.is}`);
        continue;
      }
      const paths = expandPattern(target, pattern);
      if (paths.length === 0) {
        refuse(source, pattern, "the pattern matches nothing");
        continue;
      }
      for (const path of paths) claims.push({ source, path });
    }
    return claims;
  };

  /** Settles every path the pass claims for the first time: unwritable,
   *  nested with another target (both sides, so declaration order never
   *  picks the winner), claimed by two sources, or one source's to write.
   *  Returns the claims with their path's state, settled now or earlier. */
  const settle = (claims: Claim[], kind: "literal" | "glob"): Judged[] => {
    const claimants = new Map<string, Set<string>>();
    for (const { source, path } of claims) {
      if (settled.has(path)) continue;
      const sources = claimants.get(path) ?? new Set<string>();
      sources.add(source);
      claimants.set(path, sources);
    }
    const refusals = new Map<string, string>();
    for (const path of claimants.keys()) {
      const refusal = pathRefusal(path, kind);
      if (refusal !== null) refusals.set(path, refusal);
    }
    const every = new Set([...settled.keys(), ...claimants.keys()]);
    for (const path of claimants.keys()) {
      if (refusals.has(path)) continue;
      const nested = nestedWith(path, every);
      if (nested === null) continue;
      refusals.set(
        path,
        "under" in nested
          ? `the target sits under another target '${nested.under}'`
          : `the target is a path prefix of another target '${nested.above}'`,
      );
    }
    for (const [path, sources] of claimants) {
      const refusal = refusals.get(path);
      if (refusal !== undefined) settled.set(path, { refused: refusal });
      else if (sources.size > 1) {
        settled.set(path, { refused: "the target is claimed by more than one source" });
      } else settled.set(path, { source: [...sources][0] });
    }
    return claims.map((claim) => {
      const state = settled.get(claim.path);
      if (state === undefined) throw new Error(`${claim.path}: claimed but never settled`);
      return { ...claim, state };
    });
  };

  const apply = (judged: Judged[]) => {
    for (const { source, path, state } of judged) {
      if ("refused" in state) {
        refuse(source, path, state.refused);
        continue;
      }
      if (state.source !== source) {
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

  const declared = mirrors.flatMap(({ source, targets }) =>
    targets.map((pattern) => ({ source, pattern })),
  );
  for (const kind of ["literal", "glob"] as const) {
    const patterns = declared.filter(({ pattern }) => pattern.includes("*") === (kind === "glob"));
    apply(settle(claimsOf(patterns, kind), kind));
  }
  return rows;
}

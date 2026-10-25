import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import {
  type Claim,
  type DeclaredMirrors,
  describeMirrorProblem,
  judgeClaims,
  type Mirror,
  type MirrorKind,
  type MirrorProblem,
  mirrorDeclarationProblems,
  mirrorPathProblem,
  type OwnedPaths,
} from "../../../../actions/plan/mirrors.ts";
import {
  expandPattern,
  literalPrefix,
  type TreeProbe,
} from "../../../../actions/shared/mirror_pattern.ts";
import { sha256 } from "../../../../actions/shared/values.ts";
import { lstatOrNull } from "../../shared/fs_probe.ts";
import {
  type MirrorRecord,
  mirrorKind,
  mirrorRecord,
  type Records,
  readRecord,
} from "./manifest.ts";
import { removeFile, removeTree, writeFile, writeLink } from "./target_files.ts";

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
  /** One line per verdict, each naming the document that declares the pair. */
  readonly lines: string[];

  /** `own` is the repository's own declarations, so each line can name the document its pair came from. */
  constructor(
    readonly failures: MirrorProblem[],
    own: readonly Mirror[],
  ) {
    const lines = failures.map((failure) => describeMirrorProblem(failure, own));
    super(lines.join("\n"));
    this.lines = lines;
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

/** The checkout as the walk sees it. Any failure to look through a link (dangling, a loop, a name too long, an untraversable
 *  directory) is a no: the link is then failed by name instead of skipped, so no lookup failure aborts the pass. */
export function checkoutProbe(root: string): TreeProbe {
  return {
    standing(path) {
      const stat = lstatOrNull(join(root, path));
      if (stat === null) return null;
      if (stat.isSymbolicLink()) return "symlink";
      if (stat.isDirectory()) return "directory";
      return stat.isFile() ? "file" : "other";
    },
    linksToFile(path) {
      try {
        return statSync(join(root, path)).isFile();
      } catch {
        return false;
      }
    },
    list: (dir) => readdirSync(join(root, dir)).sort(),
  };
}

export function linkTarget(path: string, source: string): string {
  return posix.relative(posix.dirname(path), source);
}

/** What the target carries once written: the source's bytes, or the link target. */
type Placement = Claim & { placed: Buffer };

type Standing = { kind: MirrorKind; carries: Buffer } | null;

type Pass = "literal" | "glob";

interface Pattern {
  source: string;
  pattern: string;
  kind: MirrorKind;
}

/** What every pass reads: the checkout, the bytes written this run, the paths files.yml claims, and the last sync's records. */
interface MirrorContext {
  target: string;
  written: ReadonlyMap<string, Buffer>;
  owned: OwnedPaths;
  records: Records;
  probe: TreeProbe;
}

interface MirrorOutcome {
  rows: MirrorRow[];
  replaced: ReplacedText[];
  records: Map<string, MirrorRecord>;
}

function standing(target: string, path: string): Standing {
  const abs = join(target, path);
  const stat = lstatOrNull(abs);
  if (stat?.isSymbolicLink()) {
    return { kind: "symlink", carries: readlinkSync(abs, { encoding: "buffer" }) };
  }
  return stat?.isFile() ? { kind: "copy", carries: readFileSync(abs) } : null;
}

/** Only a mirror record of the kind that stands there vouches for it: a split record's hash covers a region, a symlink
 *  mirror's a link target, not the file. A record of either kind vouches for its own write, so a declaration's kind can change over it. */
function vouched(records: Records, path: string, found: Standing): boolean {
  const record = readRecord(records[path]);
  return (
    found !== null &&
    record?.class === "mirror" &&
    mirrorKind(record) === found.kind &&
    record.hash === sha256(found.carries)
  );
}

/** The paths a pattern claims in its pass, or why it claims none. */
function patternPaths(
  { target, probe }: MirrorContext,
  pattern: string,
  pass: Pass,
): string[] | { problem: string } {
  if (pass === "literal") return [pattern];
  const blocked = blockedPrefix(target, pattern);
  if (blocked !== null) {
    return { problem: `the pattern's ancestor '${blocked.dir}' is ${blocked.is}` };
  }
  const paths = expandPattern(probe, pattern);
  if (paths.length === 0) return { problem: "the pattern matches nothing" };
  return paths;
}

function claimsOf(
  context: MirrorContext,
  patterns: readonly Pattern[],
  pass: Pass,
  failures: MirrorProblem[],
): Placement[] {
  const claims: Placement[] = [];
  for (const { source, pattern, kind } of patterns) {
    const bytes = context.written.get(source);
    if (bytes === undefined) {
      failures.push({
        source,
        target: pattern,
        problem: "the source was held this run, so there is nothing to copy",
      });
      continue;
    }
    const paths = patternPaths(context, pattern, pass);
    if (!Array.isArray(paths)) {
      failures.push({ source, target: pattern, problem: paths.problem });
      continue;
    }
    for (const path of paths) {
      const placed = kind === "symlink" ? Buffer.from(linkTarget(path, source)) : bytes;
      claims.push({ source, target: pattern, path, kind, placed });
    }
  }
  return claims;
}

/** What the checkout shows of the path: a literal makes its directories, a glob's path must find them standing. */
function pathFailure({ target, owned }: MirrorContext, path: string, pass: Pass): string | null {
  const problem = mirrorPathProblem(path, owned);
  if (problem !== null) return problem;
  const blocked = blockedAncestor(target, path);
  if (blocked?.is === "a symbolic link") return `sits under '${blocked.dir}', a symbolic link`;
  if (pass === "glob" && blocked !== null) return `sits under '${blocked.dir}', a file`;
  if (pass === "glob" && lstatOrNull(join(target, dirname(path)))?.isDirectory() !== true) {
    return `sits in '${dirname(path)}', a directory that does not exist`;
  }
  const stat = blocked === null ? lstatOrNull(join(target, path)) : null;
  if (stat !== null && !stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) {
    return "is neither a file nor a directory";
  }
  return null;
}

/** Removes a file standing where an ancestor directory must go, or a directory standing at the path; the detail names what went. */
function clearPath(target: string, path: string): string {
  let detail = "";
  const blocked = blockedAncestor(target, path);
  if (blocked !== null) {
    removeFile(target, blocked.dir);
    detail = `a file stood at ancestor '${blocked.dir}'`;
  }
  if (lstatOrNull(join(target, path))?.isDirectory()) {
    removeTree(target, path);
    detail = "a directory stood at the target";
  }
  return detail;
}

function applyClaims(
  context: MirrorContext,
  claims: readonly Placement[],
  outcome: MirrorOutcome,
): void {
  const { target, records } = context;
  for (const { source, path, kind, placed } of claims) {
    outcome.records.set(path, mirrorRecord(kind, sha256(placed)));
    const detail = clearPath(target, path);
    const found = standing(target, path);
    if (found?.kind === kind && found.carries.equals(placed)) {
      outcome.rows.push({ source, target: path, outcome: "current", detail: "" });
      continue;
    }
    const previous = vouched(records, path, found);
    if (found !== null && found.kind !== kind) removeFile(target, path);
    if (kind === "symlink") writeLink(target, path, placed.toString("utf-8"));
    else writeFile(target, path, placed);
    if (detail !== "") {
      outcome.rows.push({ source, target: path, outcome: "replaced", detail });
    } else if (found !== null && !previous) {
      outcome.replaced.push({
        path,
        before: found.carries.toString("utf-8"),
        after: placed.toString("utf-8"),
      });
      outcome.rows.push({ source, target: path, outcome: "replaced local edits", detail: "" });
    } else {
      outcome.rows.push({ source, target: path, outcome: "written", detail: "" });
    }
  }
}

/** A pass's declaration failures are thrown before any target of that pass is written, so no PR carries a repository half-mirrored. Literal targets
 *  are written before any `*` pattern expands, so a directory a literal creates is matched in the same run. `owned` is what files.yml
 *  claims here plus the stale records the run retires; `records` are the previous sync's, read for the last mirror hash. */
export function applyMirrors(
  target: string,
  { fleet, own }: DeclaredMirrors,
  written: ReadonlyMap<string, Buffer>,
  owned: OwnedPaths,
  records: Records,
): MirrorOutcome {
  const mirrors = [...fleet, ...own];
  const declared = mirrorDeclarationProblems(mirrors, owned);
  if (declared.length > 0) throw new MirrorFailure(declared, own);
  const context: MirrorContext = { target, written, owned, records, probe: checkoutProbe(target) };
  const patterns: Pattern[] = mirrors.flatMap(({ source, targets, kind }) =>
    targets.map((pattern) => ({ source, pattern, kind })),
  );
  const outcome: MirrorOutcome = { rows: [], replaced: [], records: new Map() };
  let settled = new Set<string>();
  for (const pass of ["literal", "glob"] as const) {
    const failures: MirrorProblem[] = [];
    const claims = claimsOf(
      context,
      patterns.filter(({ pattern }) => pattern.includes("*") === (pass === "glob")),
      pass,
      failures,
    );
    const judged = judgeClaims(claims, settled, (path) => pathFailure(context, path, pass));
    failures.push(...judged.problems);
    if (failures.length > 0) throw new MirrorFailure(failures, own);
    settled = judged.settled;
    applyClaims(context, claims, outcome);
  }
  return outcome;
}

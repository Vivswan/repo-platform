// Judged twice: by the plan on every PR of a managed repository, so a declaration that can never be written never lands, and by the sync writer before it copies any mirror.

import { basename, dirname } from "node:path";
import { MANIFEST_NAME, REGISTRATION_PATH } from "../shared/platform.ts";
import { pathProblem } from "../shared/repo_path.ts";
import type { Selection } from "../shared/selection.ts";
import { type FilesConfig, selectEntries } from "./files_config.ts";
import type { Registration } from "./registration.ts";

export type Mirrors = NonNullable<Registration["mirrors"]>;
export type Mirror = Mirrors[number];
export type MirrorKind = Mirror["kind"];

const KIND_NAME: Record<MirrorKind, string> = { copy: "a copy", symlink: "a symbolic link" };

export interface OwnedPaths {
  /** The managed and split entry paths: the only files a mirror may copy. */
  sources: ReadonlySet<string>;
  writes: ReadonlySet<string>;
  retires: ReadonlySet<string>;
  /** Every recorded path the run retires as no longer selected: the
   *  writer's alone (it reads the manifest), empty at the plan. */
  stale: ReadonlySet<string>;
}

export function ownedPaths(
  config: Pick<FilesConfig, "files" | "retired">,
  selection: Selection,
): OwnedPaths {
  const entries = selectEntries(config, selection);
  return {
    sources: new Set(
      entries
        .filter((entry) => entry.class === "managed" || entry.class === "split")
        .map((entry) => entry.path),
    ),
    writes: new Set([...entries.map((entry) => entry.path), MANIFEST_NAME]),
    retires: new Set(config.retired.map((entry) => entry.path)),
    stale: new Set(),
  };
}

function reserved(owned: OwnedPaths): [ReadonlySet<string>, string][] {
  return [
    [owned.writes, "a path files.yml writes"],
    [owned.retires, "a path files.yml retires"],
    [owned.stale, "a path a stale manifest record retires"],
  ];
}

/** An exact match is not nesting: `path` itself among `others` is null here, and the caller judges equality first. */
export function nestedWith(
  path: string,
  others: ReadonlySet<string>,
): { under: string } | { above: string } | null {
  for (let dir = dirname(path); dir !== "." && dir !== "/"; dir = dirname(dir)) {
    if (others.has(dir)) return { under: dir };
  }
  for (const other of others) {
    if (other.startsWith(`${path}/`)) return { above: other };
  }
  return null;
}

/** A path above or below one files.yml writes or retires is as impossible as the path itself: the file would have to be
 *  a directory too. The registration is the one repo-owned file the sync reads, so a copy over it, or a directory made
 *  of it, would unregister the repository. */
export function mirrorPathProblem(path: string, owned: OwnedPaths): string | null {
  const problem = pathProblem(path);
  if (problem !== null) return problem;
  if (path === REGISTRATION_PATH) return "is the registration itself";
  if (path.startsWith(`${REGISTRATION_PATH}/`)) return "sits under the registration";
  if (path.toLowerCase().startsWith(".github/workflows/")) return "sits under .github/workflows/";
  for (const [paths, what] of reserved(owned)) {
    if (paths.has(path)) return `is ${what}`;
    const nested = nestedWith(path, paths);
    if (nested !== null) {
      return "under" in nested
        ? `sits under '${nested.under}', ${what}`
        : `is a path prefix of '${nested.above}', ${what}`;
    }
  }
  return null;
}

export interface MirrorProblem {
  source: string;
  target: string;
  problem: string;
}

export function describeMirrorProblem({ source, target, problem }: MirrorProblem): string {
  return `${REGISTRATION_PATH}: mirrors: source '${source}', target '${target}': ${problem}`;
}

export function literalPrefix(pattern: string): string {
  const segments = pattern.split("/");
  const star = segments.findIndex((segment) => segment.includes("*"));
  return star === -1 ? pattern : segments.slice(0, star).join("/");
}

/** The writer lists directories through this and the plan matches known paths with it, so the two agree. */
export function segmentPattern(segment: string): RegExp {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A mirror glob segment from the repository's registration, escaped.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`^${segment.split("*").map(literal).join("[^/]*")}$`);
}

/** What the writer would expand the pattern to, if `path` were a file in the checkout. */
export function patternMatches(pattern: string, path: string): boolean {
  const segments = pattern.split("/");
  const parts = path.split("/");
  return (
    segments.length === parts.length &&
    segments.every((segment, index) => segmentPattern(segment).test(parts[index]))
  );
}

/** What the writer's expandPattern is certain to push whatever the checkout holds. The literal pass writes every literal
 *  target before any pattern expands, so those targets and their ancestor directories are the part of the tree the plan
 *  knows; the walk here is the writer's over that part alone, and an entry it does not know is left out, never assumed.
 *  A literal segment landing on a linked target, or on a path the grammar refuses, stops the probing as it does there:
 *  the rest of the pattern rides along verbatim. */
export function guaranteedExpansion(
  pattern: string,
  literals: ReadonlyMap<string, MirrorKind>,
): string[] {
  const known = new Map<string, MirrorKind | "directory">(literals);
  for (const literal of literals.keys()) {
    for (let dir = dirname(literal); dir !== "."; dir = dirname(dir)) known.set(dir, "directory");
  }
  const segments = pattern.split("/");
  const out = new Set<string>();
  const walk = (prefix: string, index: number, unprobed: boolean): void => {
    if (index === segments.length) {
      out.add(prefix);
      return;
    }
    const segment = segments[index];
    const rel = (name: string) => (prefix === "" ? name : `${prefix}/${name}`);
    if (!segment.includes("*")) {
      const next = rel(segment);
      walk(
        next,
        index + 1,
        unprobed || pathProblem(next) !== null || known.get(next) === "symlink",
      );
      return;
    }
    if (unprobed) {
      out.add(rel(segments.slice(index).join("/")));
      return;
    }
    if (prefix !== "" && known.get(prefix) !== "directory") return;
    const final = index === segments.length - 1;
    const names = segmentPattern(segment);
    for (const [path, kind] of known) {
      if (dirname(path) !== (prefix === "" ? "." : prefix) || !names.test(basename(path))) continue;
      if (kind === "directory" ? !final : final) walk(path, index + 1, false);
    }
  };
  walk("", 0, false);
  return [...out].sort();
}

function nestedProblem(nested: { under: string } | { above: string }): string {
  return "under" in nested
    ? `sits under another target '${nested.under}'`
    : `is a path prefix of another target '${nested.above}'`;
}

/** docs/sync.md lists the rules. A target the grammar refuses is judged by that alone: the nesting and matching walks need a clean relative path. */
export function mirrorDeclarationProblems(
  mirrors: readonly Mirror[],
  owned: OwnedPaths,
): MirrorProblem[] {
  const problems: MirrorProblem[] = [];
  const declared = mirrors.flatMap(({ source, targets, kind }) =>
    targets.map((target) => ({ source, target, kind })),
  );
  const isGlob = (target: string) => target.includes("*");
  const clean: typeof declared = [];
  for (const { source, target, kind } of declared) {
    if (!owned.sources.has(source)) {
      problems.push({
        source,
        target,
        problem: "the source is not a managed or split file files.yml writes for this repository",
      });
    }
    const what = isGlob(target) ? "pattern" : "target";
    const problem = target.includes("**") ? "uses '**'" : mirrorPathProblem(target, owned);
    if (problem !== null) problems.push({ source, target, problem: `the ${what} ${problem}` });
    else clean.push({ source, target, kind });
  }
  const literals = clean.filter(({ target }) => !isGlob(target));
  const claims = new Map<string, { source: string; kind: MirrorKind }[]>();
  for (const { source, target, kind } of literals) {
    claims.set(target, [...(claims.get(target) ?? []), { source, kind }]);
  }
  const literalPaths = new Set(claims.keys());
  const literalKinds = new Map(literals.map(({ target, kind }) => [target, kind]));
  for (const { source, target } of literals) {
    if ((claims.get(target) ?? []).length > 1) {
      problems.push({ source, target, problem: "the target is declared more than once" });
    }
    const nested = nestedWith(target, literalPaths);
    if (nested !== null) {
      problems.push({ source, target, problem: `the target ${nestedProblem(nested)}` });
    }
  }
  const known: [ReadonlySet<string>, string][] = [
    [new Set([REGISTRATION_PATH]), "the registration"],
    ...reserved(owned),
  ];
  const reached = new Map<string, { source: string; target: string; kind: MirrorKind }[]>();
  for (const { source, target, kind } of clean) {
    if (!isGlob(target)) continue;
    const prefix = literalPrefix(target);
    if (prefix !== "") {
      const nested = literalPaths.has(prefix)
        ? { under: prefix }
        : nestedWith(prefix, literalPaths);
      if (nested !== null && "under" in nested) {
        problems.push({
          source,
          target,
          problem: `the pattern's ancestor '${nested.under}' is another target`,
        });
      }
    }
    for (const [paths, what] of known) {
      for (const path of [...paths].filter((path) => patternMatches(target, path)).sort()) {
        problems.push({ source, target, problem: `the pattern matches '${path}', ${what}` });
      }
    }
    for (const path of guaranteedExpansion(target, literalKinds)) {
      const claimants = claims.get(path);
      if (claimants !== undefined) {
        const otherKind = claimants.find((claim) => claim.kind !== kind)?.kind;
        const problem = claimants.some((claim) => claim.source !== source)
          ? "a target of another source"
          : otherKind === undefined
            ? null
            : `a target the source declares as ${KIND_NAME[otherKind]}`;
        if (problem !== null) {
          problems.push({ source, target, problem: `the pattern matches '${path}', ${problem}` });
        }
        continue;
      }
      if (known.some(([paths]) => paths.has(path))) continue;
      const problem = mirrorPathProblem(path, owned);
      if (problem !== null) {
        problems.push({
          source,
          target,
          problem: `the pattern expands to '${path}', which ${problem}`,
        });
      }
      reached.set(path, [...(reached.get(path) ?? []), { source, target, kind }]);
    }
  }
  const every = new Set([...literalPaths, ...reached.keys()]);
  for (const [path, claimants] of reached) {
    const nested = nestedWith(path, every);
    const shared =
      new Set(claimants.map((claim) => claim.source)).size > 1
        ? "claimed by more than one source"
        : new Set(claimants.map((claim) => claim.kind)).size > 1
          ? "claimed as a copy and as a symbolic link"
          : null;
    // One pattern declared under both kinds is one declaration to the reader.
    const declarations = new Map(
      claimants.map((claim) => [`${claim.source}\n${claim.target}`, claim]),
    );
    for (const { source, target } of declarations.values()) {
      if (nested !== null) {
        problems.push({
          source,
          target,
          problem: `the pattern expands to '${path}', which ${nestedProblem(nested)}`,
        });
      }
      if (shared !== null) {
        problems.push({
          source,
          target,
          problem: `the pattern expands to '${path}', a path ${shared}`,
        });
      }
    }
  }
  return problems;
}

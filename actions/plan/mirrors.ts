// The mirror rules files.yml alone decides, judged twice: by the plan on
// every PR of a managed repository (so a declaration that can never be
// written never lands) and by the sync writer before it copies anything.
// The writer adds the rules only the checkout can answer (mirrors.ts).

import { dirname } from "node:path";
import { MANIFEST_NAME, REGISTRATION_PATH } from "../shared/platform.ts";
import { pathProblem } from "../shared/repo_path.ts";
import type { Selection } from "../shared/selection.ts";
import { type FilesConfig, selectEntries } from "./files_config.ts";
import type { Registration } from "./registration.ts";

export type Mirrors = NonNullable<Registration["mirrors"]>;
export type Mirror = Mirrors[number];
export type MirrorKind = Mirror["kind"];
/** The paths a declaration claims; its kind never changes where a target may land. */
export type Declared = Pick<Mirror, "source" | "targets">;

/** What files.yml claims in one repository. */
export interface OwnedPaths {
  /** The managed and split entry paths: the only files a mirror may copy. */
  sources: ReadonlySet<string>;
  /** Every selected entry path, the manifest included. */
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

/** Every declared target files.yml alone proves unwritable, each with its
 *  reason (docs/sync.md lists the rules). A target the grammar refuses is
 *  judged by that alone: the nesting and matching walks need a clean
 *  relative path. */
export function mirrorDeclarationProblems(
  mirrors: readonly Declared[],
  owned: OwnedPaths,
): MirrorProblem[] {
  const problems: MirrorProblem[] = [];
  const declared = mirrors.flatMap(({ source, targets }) =>
    targets.map((target) => ({ source, target })),
  );
  const isGlob = (target: string) => target.includes("*");
  const clean: { source: string; target: string }[] = [];
  for (const { source, target } of declared) {
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
    else clean.push({ source, target });
  }
  const literals = clean.filter(({ target }) => !isGlob(target));
  const claims = new Map<string, string[]>();
  for (const { source, target } of literals) {
    claims.set(target, [...(claims.get(target) ?? []), source]);
  }
  const literalPaths = new Set(claims.keys());
  for (const { source, target } of literals) {
    if ((claims.get(target) ?? []).length > 1) {
      problems.push({ source, target, problem: "the target is declared more than once" });
    }
    const nested = nestedWith(target, literalPaths);
    if (nested !== null) {
      problems.push({
        source,
        target,
        problem:
          "under" in nested
            ? `the target sits under another target '${nested.under}'`
            : `the target is a path prefix of another target '${nested.above}'`,
      });
    }
  }
  const known: [ReadonlySet<string>, string][] = [
    [new Set([REGISTRATION_PATH]), "the registration"],
    ...reserved(owned),
  ];
  for (const { source, target } of clean) {
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
    for (const [path, sources] of claims) {
      if (sources.some((other) => other !== source) && patternMatches(target, path)) {
        problems.push({
          source,
          target,
          problem: `the pattern matches '${path}', a target of another source`,
        });
      }
    }
  }
  return problems;
}

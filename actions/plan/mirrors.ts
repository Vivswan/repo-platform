// The mirror rules files.yml alone decides, judged twice: by the plan on
// every PR of a managed repository (so a declaration that can never be
// written never lands) and by the sync writer before it copies anything.
// The writer adds the rules only the checkout can answer (mirrors.ts).

import { dirname } from "node:path";
import { MANIFEST_NAME } from "../shared/manifest.ts";
import { type FilesConfig, pathProblem, type Selection, selectEntries } from "./files_config.ts";
import { REGISTRATION_PATH, type Registration } from "./registration.ts";

export type Mirrors = NonNullable<Registration["mirrors"]>;

/** What files.yml claims in one repository. */
export interface OwnedPaths {
  /** The managed and split entry paths: the only files a mirror may copy. */
  sources: ReadonlySet<string>;
  /** Every selected entry path, the manifest included. */
  writes: ReadonlySet<string>;
  /** Every path files.yml retires. */
  retires: ReadonlySet<string>;
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
  };
}

/** The path among `others` that `path` sits under, or that sits under
 *  `path`; null when it nests with none (itself included). */
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

/** Why `path` can never be a mirror target whatever the checkout holds, or
 *  null. A path above or below one files.yml writes or retires is as
 *  impossible as the path itself: the file would have to be a directory
 *  too. The registration is the one repo-owned file the sync reads, so a
 *  copy over it, or a directory made of it, would unregister the repository. */
export function mirrorPathProblem(path: string, owned: OwnedPaths): string | null {
  const problem = pathProblem(path);
  if (problem !== null) return problem;
  if (path === REGISTRATION_PATH) return "is the registration itself";
  if (path.startsWith(`${REGISTRATION_PATH}/`)) return "sits under the registration";
  if (path.toLowerCase().startsWith(".github/workflows/")) return "sits under .github/workflows/";
  for (const [paths, verb] of [
    [owned.writes, "writes"],
    [owned.retires, "retires"],
  ] as const) {
    if (paths.has(path)) return `is a path files.yml ${verb}`;
    const nested = nestedWith(path, paths);
    if (nested !== null) {
      return "under" in nested
        ? `sits under '${nested.under}', a path files.yml ${verb}`
        : `is a path prefix of '${nested.above}', a path files.yml ${verb}`;
    }
  }
  return null;
}

/** One declared target that cannot be written, and why. */
export interface MirrorProblem {
  source: string;
  target: string;
  problem: string;
}

export function describeMirrorProblem({ source, target, problem }: MirrorProblem): string {
  return `${REGISTRATION_PATH}: mirrors: source '${source}', target '${target}': ${problem}`;
}

/** The literal directories a pattern names before its first `*`, "" when
 *  it starts with one. */
export function literalPrefix(pattern: string): string {
  const segments = pattern.split("/");
  const star = segments.findIndex((segment) => segment.includes("*"));
  return star === -1 ? pattern : segments.slice(0, star).join("/");
}

/** Every declared target files.yml alone proves unwritable: a source it
 *  does not write here as managed or split; a `**`; a target (or pattern
 *  text) the grammar refuses, under `.github/workflows/`, or nested with a
 *  path files.yml writes or retires; a literal target declared twice or
 *  nested with another (both sides, whatever their sources); a pattern
 *  whose literal prefix a literal target would make a file of. A target
 *  the grammar refuses is judged by that alone: the nesting walks need a
 *  clean relative path. */
export function mirrorDeclarationProblems(mirrors: Mirrors, owned: OwnedPaths): MirrorProblem[] {
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
  const claims = new Map<string, number>();
  for (const { target } of literals) claims.set(target, (claims.get(target) ?? 0) + 1);
  const literalPaths = new Set(claims.keys());
  for (const { source, target } of literals) {
    if ((claims.get(target) ?? 0) > 1) {
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
  for (const { source, target } of clean) {
    if (!isGlob(target)) continue;
    const prefix = literalPrefix(target);
    if (prefix === "") continue;
    const nested = literalPaths.has(prefix) ? { under: prefix } : nestedWith(prefix, literalPaths);
    if (nested !== null && "under" in nested) {
      problems.push({
        source,
        target,
        problem: `the pattern's ancestor '${nested.under}' is another target`,
      });
    }
  }
  return problems;
}

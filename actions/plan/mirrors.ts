// Judged twice: by the plan on every PR of a managed repository, so a declaration that can never be written never lands, and by the sync writer before it copies any mirror.

import { basename, dirname } from "node:path";
import {
  expandPattern,
  segmentPattern,
  type TreeEntry,
  type TreeProbe,
} from "../shared/mirror_pattern.ts";
import { MANIFEST_NAME, REGISTRATION_PATH } from "../shared/platform.ts";
import { pathProblem } from "../shared/repo_path.ts";
import type { Selection } from "../shared/selection.ts";
import { type FilesConfig, selectEntries } from "./files_config.ts";
import type { Registration } from "./registration.ts";

export type Mirrors = NonNullable<Registration["mirrors"]>;
export type Mirror = Mirrors[number];
export type MirrorKind = Mirror["kind"];

export interface OwnedPaths {
  /** The managed and split entry paths: the only files a mirror may copy. */
  sources: ReadonlySet<string>;
  /** Every path no mirror may land at, under, or above, by what claims it. */
  reserved: ReadonlyMap<string, string>;
}

/** `stale` is every recorded path the run retires as no longer selected: the writer's (it reads the manifest), empty at the plan. */
export function ownedPaths(
  config: Pick<FilesConfig, "files">,
  selection: Selection,
  stale: Iterable<string> = [],
): OwnedPaths {
  const entries = selectEntries(config, selection);
  const reserved = new Map<string, string>();
  const claim = (paths: Iterable<string>, what: string) => {
    for (const path of paths) if (!reserved.has(path)) reserved.set(path, what);
  };
  claim([...entries.map((entry) => entry.path), MANIFEST_NAME], "a path files.yml writes");
  claim(stale, "a path a stale manifest record retires");
  claim(selection.except ?? [], "a path the registration excepts");
  return {
    sources: new Set(
      entries
        .filter((entry) => entry.class === "managed" || entry.class === "split")
        .map((entry) => entry.path),
    ),
    reserved,
  };
}

/** An exact match is not nesting: `path` itself among `others` is null here, and the caller judges equality first. */
export function nestedWith(
  path: string,
  others: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): { under: string } | { above: string } | null {
  for (let dir = dirname(path); dir !== "." && dir !== "/"; dir = dirname(dir)) {
    if (others.has(dir)) return { under: dir };
  }
  for (const other of others.keys()) {
    if (other.startsWith(`${path}/`)) return { above: other };
  }
  return null;
}

/** A path above or below one files.yml writes or a stale record retires is as impossible as the path itself: the file would have to be
 *  a directory too. The registration is the one repo-owned file the sync reads, so a copy over it, or a directory made
 *  of it, would unregister the repository. */
export function mirrorPathProblem(path: string, owned: OwnedPaths): string | null {
  const problem = pathProblem(path);
  if (problem !== null) return problem;
  if (path === REGISTRATION_PATH) return "is the registration itself";
  if (path.startsWith(`${REGISTRATION_PATH}/`)) return "sits under the registration";
  if (path.toLowerCase().startsWith(".github/workflows/")) return "sits under .github/workflows/";
  const what = owned.reserved.get(path);
  if (what !== undefined) return `is ${what}`;
  const nested = nestedWith(path, owned.reserved);
  if (nested === null) return null;
  return "under" in nested
    ? `sits under '${nested.under}', ${owned.reserved.get(nested.under)}`
    : `is a path prefix of '${nested.above}', ${owned.reserved.get(nested.above)}`;
}

export interface MirrorProblem {
  source: string;
  target: string;
  problem: string;
}

export function describeMirrorProblem({ source, target, problem }: MirrorProblem): string {
  return `${REGISTRATION_PATH}: mirrors: source '${source}', target '${target}': ${problem}`;
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

/** A claim on one path: `target` as the registration declares it, `path` where the claim lands. A literal claims itself;
 *  a pattern claims each path it expands to. The plan alone also claims a pattern's own text, since two declarations of
 *  one text expand alike; the writer has the expansions themselves. */
export interface Claim {
  source: string;
  target: string;
  path: string;
  kind: MirrorKind;
}

/** Every claim of a pass judged before any is written, nesting failing both sides so declaration order never picks the
 *  winner. A `settled` path is an earlier pass's, its source's own of its kind (mirrorDeclarationProblems refuses every
 *  pattern certain to reach another source's literal, or its own literal of the other kind), so a claim on it is current
 *  and not judged again. `pathProblem` is what the caller can see of the path itself. */
export function judgeClaims(
  claims: readonly Claim[],
  settled: ReadonlySet<string>,
  pathProblem: (path: string) => string | null,
): { problems: MirrorProblem[]; settled: Set<string> } {
  const byPath = new Map<string, Claim[]>();
  for (const claim of claims) {
    if (settled.has(claim.path)) continue;
    byPath.set(claim.path, [...(byPath.get(claim.path) ?? []), claim]);
  }
  const every = new Set([...settled, ...byPath.keys()]);
  // A pattern's claim on its own text stands for every path it expands to. It nests with a plain path as written, and
  // with another text only where the shorter ends in a literal segment: that segment lands as a file wherever the longer
  // pattern needs a directory. A text ending in `*` claims files at its depth; what meets below it is the checkout's to show.
  // Two different texts are nested as written, never by what they can match (`tests/*/foo` and `tests/a*/foo/bar` pass
  // here and fail at the writer on any checkout with a `tests/a*` directory): their conflicts fall to sync time.
  const texts = new Set(
    [...byPath]
      .filter(([, cs]) =>
        cs.some((claim) => claim.path === claim.target && claim.target.includes("*")),
      )
      .map(([path]) => path),
  );
  const literalEnd = (path: string) => !basename(path).includes("*");
  const partners = (path: string): ReadonlySet<string> =>
    texts.has(path)
      ? new Set(
          [...every].filter(
            (other) => !texts.has(other) || literalEnd(other.length < path.length ? other : path),
          ),
        )
      : every;
  const problems: MirrorProblem[] = [];
  const now = new Set(settled);
  for (const [path, claimants] of byPath) {
    const verdicts: string[] = [];
    const own = pathProblem(path);
    if (own !== null) verdicts.push(own);
    const nested = nestedWith(path, partners(path));
    if (nested !== null) {
      verdicts.push(
        "under" in nested
          ? `sits under another target '${nested.under}'`
          : `is a path prefix of another target '${nested.above}'`,
      );
    }
    if (new Set(claimants.map((claim) => claim.source)).size > 1) {
      verdicts.push("is claimed by more than one source");
    }
    if (new Set(claimants.map((claim) => claim.kind)).size > 1) {
      verdicts.push("is claimed as a copy and as a symbolic link");
    }
    // Two globs of one source and kind meeting at a path write it once; a literal spelled twice is a slip, refused at its
    // own declaration alone.
    const literals = claimants.filter((claim) => claim.target === path && !texts.has(path));
    const spellings = literals.map((claim) => `${claim.source}\n${claim.kind}`);
    const spelledTwice = new Set(
      literals
        .filter((_, index) => spellings.indexOf(spellings[index]) !== index)
        .map((claim) => claim.source),
    );
    const declarations = new Map(
      claimants.map((claim) => [`${claim.source}\n${claim.target}`, claim]),
    );
    for (const { source, target } of declarations.values()) {
      const what =
        path !== target
          ? `the pattern expands to '${path}', which`
          : target.includes("*")
            ? "the pattern"
            : "the target";
      const own =
        target === path && spelledTwice.has(source)
          ? [...verdicts, "is declared more than once"]
          : verdicts;
      for (const verdict of own) problems.push({ source, target, problem: `${what} ${verdict}` });
    }
    if (verdicts.length === 0 && spelledTwice.size === 0) now.add(path);
  }
  return { problems, settled: now };
}

/** The part of the tree the literal pass is certain to leave: every literal target of its kind, every ancestor a directory.
 *  A link's target is its source, written that same run, so it resolves to a file; nothing else is known, so nothing else
 *  is listed. */
export function knownProbe(literals: ReadonlyMap<string, MirrorKind>): TreeProbe {
  const known = new Map<string, TreeEntry>();
  for (const [path, kind] of literals) known.set(path, kind === "copy" ? "file" : "symlink");
  for (const path of literals.keys()) {
    for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) known.set(dir, "directory");
  }
  return {
    standing: (path) => (path === "" ? "directory" : (known.get(path) ?? null)),
    linksToFile: () => true,
    list: (dir) =>
      [...known.keys()]
        .filter((path) => dirname(path) === (dir === "" ? "." : dir))
        .map((path) => basename(path))
        .sort(),
  };
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
  const literalKinds = new Map(literals.map(({ target, kind }) => [target, kind]));
  const probe = knownProbe(literalKinds);
  const known = new Map([...owned.reserved, [REGISTRATION_PATH, "the registration"]]);
  const claims: Claim[] = literals.map((literal) => ({ ...literal, path: literal.target }));
  for (const { source, target, kind } of clean) {
    if (!isGlob(target)) continue;
    for (const path of [...known.keys()].filter((path) => patternMatches(target, path)).sort()) {
      problems.push({
        source,
        target,
        problem: `the pattern matches '${path}', ${known.get(path)}`,
      });
    }
    for (const path of [target, ...expandPattern(probe, target)]) {
      if (!known.has(path)) claims.push({ source, target, path, kind });
    }
  }
  const judged = judgeClaims(claims, new Set(), (path) => mirrorPathProblem(path, owned));
  return [...problems, ...judged.problems];
}

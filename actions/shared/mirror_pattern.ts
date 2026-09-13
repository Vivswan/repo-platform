// One walk expands a mirror pattern for both readers: the sync writer over the checkout, and the plan over the tree the
// literal targets guarantee, so what the plan refuses on the PR is exactly what the writer would refuse at sync time.
//
// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

import { pathProblem } from "./repo_path.ts";

export type TreeEntry = "file" | "directory" | "symlink" | "other";

/** What the walk asks of a tree; an answer it cannot give is null, never a guess. */
export interface TreeProbe {
  /** As lstat sees it: a link is a link, whatever it points at. */
  standing(path: string): TreeEntry | null;
  /** Through the link, as stat sees it; any failure to look is a no. */
  linksToFile(path: string): boolean;
  /** The names in the directory, sorted; "" is the root. */
  list(dir: string): string[];
}

export function literalPrefix(pattern: string): string {
  const segments = pattern.split("/");
  const star = segments.findIndex((segment) => segment.includes("*"));
  return star === -1 ? pattern : segments.slice(0, star).join("/");
}

export function segmentPattern(segment: string): RegExp {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A mirror glob segment from the repository's registration, escaped.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`^${segment.split("*").map(literal).join("[^/]*")}$`);
}

/** Probing stops at a symbolic link, or at a prefix pathProblem refuses, and the rest of the pattern rides along literally
 *  (`skills/link/sub/*.md`) so the claim's judge fails the path by its linked ancestor or by name rather than dropping it silently.
 *    link in a literal segment, or in the final segment            -> rides literally
 *    link matched by a `*` directory segment, not provably a file  -> rides literally
 *    link matched by a `*` directory segment, resolving to a file  -> skipped, like a file */
export function expandPattern(probe: TreeProbe, pattern: string): string[] {
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
        unprobed || pathProblem(next) !== null || probe.standing(next) === "symlink",
      );
      return;
    }
    if (unprobed) {
      out.push(rel(segments.slice(index).join("/")));
      return;
    }
    if (probe.standing(prefix) !== "directory") return;
    const final = index === segments.length - 1;
    const names = segmentPattern(segment);
    for (const name of probe.list(prefix)) {
      if (!names.test(name)) continue;
      const path = rel(name);
      if (pathProblem(path) !== null) {
        walk(path, index + 1, true);
        continue;
      }
      const standing = probe.standing(path);
      if (standing === null) continue;
      if (standing === "symlink") {
        if (final || !probe.linksToFile(path)) walk(path, index + 1, true);
      } else if (final ? standing === "file" : standing === "directory") {
        walk(path, index + 1, false);
      }
    }
  };
  walk("", 0, false);
  return out.sort();
}

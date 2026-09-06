// copier.yml's landing rules as path matchers: the _skip_if_exists globs
// (the one gitwildmatch-subset implementation), the generated _exclude
// list, and the filename gates a rendered path carries.

import { parse as parseYaml } from "yaml";

/** copier.yml's _skip_if_exists globs as path matchers reproducing
 *  copier's gitignore-style semantics (pathspec gitwildmatch): a pattern
 *  containing "/" is anchored to the render root, a bare filename matches
 *  at any depth, and `*` stays within one component. Only that subset is
 *  implemented; a pattern using more (`**`, `?`, character classes,
 *  negation, edge slashes, and gitwildmatch's comment/whitespace line
 *  forms) throws rather than guessing what copier does. */
export function skipIfExistsPatterns(
  copierYamlText: string,
): { pattern: string; matcher: RegExp }[] {
  const skip = (parseYaml(copierYamlText) as { _skip_if_exists?: unknown } | null)?._skip_if_exists;
  if (!Array.isArray(skip) || skip.length === 0 || !skip.every((p) => typeof p === "string")) {
    throw new Error(
      "copier.yml: _skip_if_exists is missing or not a list of strings - the " +
        "starter consistency check needs it to keep repo-owned starters exempt",
    );
  }
  return skip.map((pattern) => ({ pattern, matcher: compileSkipIfExistsPattern(pattern) }));
}

/** One _skip_if_exists pattern compiled to the shared matcher - the ONLY
 *  implementation of the gitwildmatch subset, so the composer's starter
 *  checks and the sync's retirement filter (retired_paths.ts) can never
 *  disagree about what a skip pattern protects. Throws on features beyond
 *  the subset (fail closed - a guessed match could either delete a
 *  repo-owned starter or leave a retired file undead). */
export function compileSkipIfExistsPattern(pattern: string): RegExp {
  if (
    /[?[\]\\!]/.test(pattern) ||
    pattern.includes("**") ||
    pattern.startsWith("/") ||
    pattern.endsWith("/") ||
    pattern.startsWith("#") ||
    pattern.trim() !== pattern ||
    pattern === ""
  ) {
    throw new Error(
      `copier.yml: _skip_if_exists pattern '${pattern}' uses gitwildmatch ` +
        "features beyond the implemented subset (bare names, root-anchored " +
        "paths, single *) - extend compileSkipIfExistsPattern alongside it",
    );
  }
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  // A gitwildmatch pattern that matches a directory also covers every
  // descendant, hence the optional /... tail.
  const tail = "(?:/.*)?$";
  return new RegExp(pattern.includes("/") ? `^${body}${tail}` : `(?:^|/)${body}${tail}`);
}

/** The matchers alone, for consumers that never need the pattern text. */
export function skipIfExistsMatchers(copierYamlText: string): RegExp[] {
  return skipIfExistsPatterns(copierYamlText).map(({ matcher }) => matcher);
}

/** copier.yml's _exclude list, verbatim: the generated conditional-landing
 *  patterns (compose/exclude.ts's excludePatterns via scripts/generate.ts).
 *  Throws when the list is missing or malformed - the composed tree carries
 *  plain filenames, so a copier.yml without the generated excludes would
 *  land every conditional file unconditionally. */
export function readExcludeList(copierYamlText: string): string[] {
  const exclude = (parseYaml(copierYamlText) as { _exclude?: unknown } | null)?._exclude;
  if (!Array.isArray(exclude) || !exclude.every((pattern) => typeof pattern === "string")) {
    throw new Error(
      "copier.yml: _exclude is missing or not a list of strings - the generated " +
        "conditional-landing patterns live there (run `bun run generate`)",
    );
  }
  return exclude;
}

const FILENAME_GATE_RE = /^\{% if (.+?) %\}(.*)\{% endif %\}$/;

/** The path a render lands, with any filename gates stripped and their
 *  conditions collected (in path order). Input is the rendered path (the
 *  .jinja suffix already removed). */
export function landedPathAndGates(renderedPath: string): { path: string; gates: string[] } {
  const gates: string[] = [];
  const path = renderedPath
    .split("/")
    .map((segment) => {
      const match = FILENAME_GATE_RE.exec(segment);
      if (!match) return segment;
      gates.push(match[1]);
      return match[2];
    })
    .join("/");
  return { path, gates };
}

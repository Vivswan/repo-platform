import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { isMapping } from "../../shared/values.ts";
import { isRegularFile } from "./readers.ts";

/** yamllint's config lookup, in its order. */
const CONFIG_NAMES = [".yamllint", ".yamllint.yaml", ".yamllint.yml"];

/** `d` is set when the match ended at a directory boundary: the path is under a matched directory rather than the
 *  matched file itself (pathspec's ps_d group). */
const DIR_MARK = "(?<d>/)";
const DIR_MARK_OPT = `(?:${DIR_MARK}|$)`;

interface Pattern {
  regex: RegExp;
  /** false for a `!` pattern: a match re-includes the path. */
  include: boolean;
}

/** Whether the walk skips an entry: a file the list ignores, or a directory it ignores while no `!` pattern could
 *  re-include a file under it (yamllint matches files, so a negation reaches under an ignored directory). */
export type Skips = (rel: string, directory: boolean) => boolean;

/** What yamllint skips is not YAML to the repository (a writer's templates with their placeholder tokens), so the scan
 *  skips it too. The patterns are read as the pinned yamllint reads them: pathspec's GitIgnoreSpec, ported below
 *  (its regex translation and its precedence: the last pattern matching the file itself decides, else the last
 *  matching a parent directory). Only the config's own `ignore` key is read, never `ignore-from-file` or an extended
 *  file's. */
export function yamllintIgnore(root: string): Skips {
  const found = readConfig(root);
  if (found === null) return () => false;
  const patterns = found.entries.flatMap((entry) => {
    const pattern = compile(entry);
    if (pattern === undefined)
      throw new Error(`${found.name}: invalid ignore pattern ${JSON.stringify(entry)}`);
    return pattern === null ? [] : [pattern];
  });
  const prunable = patterns.every((pattern) => pattern.include);
  const decide = (path: string): { include: boolean; directory: boolean } | null => {
    let decided: { include: boolean; directory: boolean } | null = null;
    for (let i = patterns.length - 1; i >= 0; i--) {
      const match = patterns[i].regex.exec(path);
      if (match === null) continue;
      const directory = match.groups?.d !== undefined;
      if (decided === null || (decided.directory && !directory)) {
        decided = { include: patterns[i].include, directory };
      }
      if (!directory) break;
    }
    return decided;
  };
  // A directory is probed as the prefix every file under it carries; only a match that ended at its slash (the
  // directory mark) is one every file under it repeats, so a match that consumed the slash inside a class does not prune.
  return (rel, directory) => {
    const decided = decide(directory ? `${rel}/` : rel);
    return decided !== null && decided.include && (!directory || (prunable && decided.directory));
  };
}

function readConfig(root: string): { name: string; entries: string[] } | null {
  const name = CONFIG_NAMES.find((candidate) => isRegularFile(join(root, candidate)));
  if (name === undefined) return null;
  let config: unknown;
  try {
    // merge: yamllint loads with PyYAML, which honours `<<` merge keys.
    config = parse(readFileSync(join(root, name), "utf-8"), { merge: true });
  } catch (exc) {
    const message = exc instanceof Error ? exc.message.split("\n")[0] : String(exc);
    throw new Error(`${name}: does not parse as YAML (${message})`);
  }
  const ignore = isMapping(config) ? config.ignore : undefined;
  if (ignore === undefined) return { name, entries: [] };
  const entries = typeof ignore === "string" ? ignore.split(/\r?\n/) : ignore;
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name}: ignore should contain file patterns`);
  }
  return { name, entries: entries as string[] };
}

/** pathspec's pattern_to_regex: null for a no-op line (a blank, a comment, a lone slash, or a class with no closing
 *  bracket, which git and pathspec 1.1 discard whole), undefined for a pattern it refuses. A trailing space survives
 *  only escaped. */
function compile(line: string): Pattern | null | undefined {
  const pattern = line.endsWith("\\ ") ? line : line.trimEnd();
  if (pattern === "" || pattern.startsWith("#") || pattern === "/") return null;
  const include = !pattern.startsWith("!");
  const segments = (include ? pattern : pattern.slice(1)).split("/");
  const directoryPattern = segments[segments.length - 1] === "";
  const normalized = normalize(directoryPattern, segments);
  if (normalized === undefined) return undefined;
  const source =
    typeof normalized === "string" ? normalized : translate(directoryPattern, normalized);
  if (source === undefined || source === null) return source;
  try {
    return { regex: new RegExp(source, "u"), include };
  } catch {
    return undefined;
  }
}

/** A regex string is an override for the whole pattern; undefined is a pattern normalized to nothing. */
function normalize(directoryPattern: boolean, segments: string[]): string[] | string | undefined {
  if (segments[0] === "") segments.shift();
  else if (segments.length === 1 || (segments.length === 2 && segments[1] === "")) {
    if (segments[0] !== "**") segments.unshift("**");
  }
  if (segments.length === 0) return undefined;
  if (segments[segments.length - 1] === "") segments[segments.length - 1] = "**";
  for (let i = segments.length - 1; i > 0; i--) {
    if (segments[i - 1] === "**" && segments[i] === "**") segments.splice(i, 1);
  }
  const is = (...shape: string[]) =>
    segments.length === shape.length && shape.every((segment, i) => segments[i] === segment);
  if (is("**")) return directoryPattern ? DIR_MARK : ".";
  if (is("**", "*")) return ".";
  if (is("**", "*", "**")) return directoryPattern ? DIR_MARK : "/";
  return segments;
}

function translate(directoryPattern: boolean, segments: string[]): string | null | undefined {
  const parts: string[] = [];
  let needSlash = false;
  const end = segments.length - 1;
  for (const [i, segment] of segments.entries()) {
    if (segment === "**") {
      if (i === 0) parts.push("^(?:.+/)?");
      else if (i < end) {
        parts.push("(?:/.+)?");
        needSlash = true;
      } else parts.push(directoryPattern ? DIR_MARK : "/");
      continue;
    }
    if (i === 0) parts.push("^");
    if (needSlash) parts.push("/");
    if (segment === "*") parts.push("[^/]+");
    else {
      const glob = segmentGlob(segment);
      if (glob === undefined || glob === null) return glob;
      parts.push(glob);
    }
    if (i === end) parts.push(DIR_MARK_OPT);
    needSlash = true;
  }
  return parts.join("");
}

/** Only the syntax characters, since the `u` flag (one code point per `?` and class, as Python matches) refuses any
 *  other escape. */
const literal = (char: string): string => ("\\^$.*+?()[]{}|/".includes(char) ? `\\${char}` : char);

/** One path segment's glob as a regex: `*` and `?` stay inside the segment, `[...]` is a class (`!` or `^` negates,
 *  a leading `]` is literal: Python reads it so, JavaScript needs it escaped), a backslash escapes the next character. */
function segmentGlob(segment: string): string | null | undefined {
  let regex = "";
  let escaped = false;
  let i = 0;
  const end = segment.length;
  while (i < end) {
    const char = segment[i];
    i += 1;
    if (escaped) {
      escaped = false;
      regex += literal(char);
    } else if (char === "\\") escaped = true;
    else if (char === "*") regex += "[^/]*";
    else if (char === "?") regex += "[^/]";
    else if (char === "[") {
      let j = i;
      if (j < end && (segment[j] === "!" || segment[j] === "^")) j += 1;
      if (j < end && segment[j] === "]") j += 1;
      while (j < end && segment[j] !== "]") j += 1;
      if (j < end) {
        j += 1;
        let expr = "[";
        if (segment[i] === "!" || segment[i] === "^") {
          expr += "^";
          i += 1;
        }
        expr += segment.slice(i, j).replaceAll("\\", "\\\\").replace(/^\]/, "\\]");
        regex += expr;
        i = j;
      } else return null;
    } else regex += literal(char);
  }
  return escaped ? undefined : regex;
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ignore from "ignore";
import { parse } from "yaml";
import { isMapping } from "../../shared/values.ts";
import { isRegularFile } from "./readers.ts";

/** yamllint's config lookup, in its order. */
const CONFIG_NAMES = [".yamllint", ".yamllint.yaml", ".yamllint.yml"];

/** Whether the walk skips an entry: a file the list ignores, or a directory it ignores, under which nothing can be
 *  re-included (git's rule; yamllint's own reader, pathspec, lets a `!` pattern reach under an ignored directory). */
export type Skips = (rel: string, directory: boolean) => boolean;

/** What yamllint skips is not YAML to the repository (a writer's templates with their placeholder tokens), so the scan
 *  skips it too. The patterns are gitignore patterns, matched by case as yamllint matches them (the library's default
 *  folds case). Only the config's own `ignore` key is read, never `ignore-from-file` or an extended file's. */
export function yamllintIgnore(root: string): Skips {
  const found = readConfig(root);
  if (found === null) return () => false;
  const matcher = ignore({ ignorecase: false }).add(found.entries);
  return (rel, directory) => matcher.ignores(directory ? `${rel}/` : rel);
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
  const ignored = isMapping(config) ? config.ignore : undefined;
  if (ignored === undefined) return { name, entries: [] };
  const entries = typeof ignored === "string" ? ignored.split(/\r?\n/) : ignored;
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name}: ignore should contain file patterns`);
  }
  return { name, entries: entries as string[] };
}

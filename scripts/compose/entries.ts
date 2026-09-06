// Source collection for the composer: the Entry shapes, the folder walk,
// and the per-folder file and fragment collectors. The constants every
// compose module shares (the suffix, the manifest and fragment names) live
// here because collection is where they are first applied.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { SETTINGS_LAYER_NAMES } from "../ownership.ts";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

export const JINJA_SUFFIX = ".jinja";
export const MANIFEST_NAME = "module.yml";
export const OWNERSHIP_NAME = "ownership.yml";
export const FRAGMENTS_DIR = "fragments";

// One collected source file: regular bytes or a symlink target (emitted as a
// link with the target rewritten).
export type Entry = { kind: "symlink"; target: string } | { kind: "file"; data: Buffer };

export type SourcedEntry =
  | { origin: "base"; entry: Entry }
  | { origin: "module"; module: string; gate: string; entry: Entry };

export function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function relToRepo(path: string): string {
  return path.startsWith(`${REPO_ROOT}/`) ? path.slice(REPO_ROOT.length + 1) : path;
}

function readEntry(path: string): Entry {
  if (lstatSync(path).isSymbolicLink()) return { kind: "symlink", target: readlinkSync(path) };
  return { kind: "file", data: readFileSync(path) };
}

/** All non-directory entries below `dir` as relative paths, sorted. */
function walkFiles(dir: string): string[] {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(dir, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(childRel);
      else if (stat.isSymbolicLink() || stat.isFile()) found.push(childRel);
    }
  };
  visit("");
  return found.sort();
}

/** Logical path -> Entry for a source folder (skips the manifest, the base
 *  ownership declarations, and fragments - none of them land in renders). */
export function collectFiles(folder: string): Map<string, Entry> {
  const files = new Map<string, Entry>();
  for (const rel of walkFiles(folder)) {
    if (rel.split("/")[0] === FRAGMENTS_DIR || rel === MANIFEST_NAME || rel === OWNERSHIP_NAME) {
      continue;
    }
    if (SETTINGS_LAYER_NAMES.has(rel)) continue;
    files.set(rel, readEntry(join(folder, rel)));
  }
  return files;
}

/** Anchor name -> fragment bytes for a module folder. */
export function collectFragments(folder: string): Map<string, Buffer> {
  const fragments = new Map<string, Buffer>();
  const fragDir = join(folder, FRAGMENTS_DIR);
  if (!existsSync(fragDir) || !lstatSync(fragDir).isDirectory()) return fragments;
  for (const name of readdirSync(fragDir).sort()) {
    const path = join(fragDir, name);
    if (!lstatSync(path).isFile()) continue;
    if (!name.endsWith(JINJA_SUFFIX)) {
      die(
        `error: ${relToRepo(path)}: fragment files must end in ` +
          `${JINJA_SUFFIX} (the composer strips it to get the anchor name); ` +
          `rename the file to <anchor>${JINJA_SUFFIX} or move it out of ${FRAGMENTS_DIR}/`,
      );
    }
    fragments.set(name.slice(0, -JINJA_SUFFIX.length), readFileSync(path));
  }
  return fragments;
}

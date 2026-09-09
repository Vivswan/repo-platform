// The comparison behind the module-render verdict: a fresh render's managed
// content against the tree's, entry by entry off the render's own ownership
// manifest, hashed the way the stamp hook hashes (entryHash), so the check
// and the sync agree on what a managed byte is.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPERATOR_REPO } from "../../shared/build_sha.ts";
import {
  MANIFEST_NAME,
  type ManifestEntryShape,
  parseManifestFiles,
} from "../../shared/manifest.ts";
import { entryHash } from "../../shared/stamp_manifest.ts";

export type CompareResult =
  | { kind: "compared"; stale: string[]; retired: string[]; compared: number }
  | { kind: "unreadable"; problem: string };

type Entries = Record<string, ManifestEntryShape>;

function manifestOf(root: string, label: string): { files: Entries } | { problem: string } {
  let text: string;
  try {
    text = readFileSync(join(root, MANIFEST_NAME), "utf-8");
  } catch {
    return { problem: `${label} carries no ${MANIFEST_NAME}` };
  }
  const parsed = parseManifestFiles(text);
  if (parsed.problem !== null) return { problem: `${label}'s ${MANIFEST_NAME} ${parsed.problem}` };
  return { files: parsed.files };
}

/** Whether an entry is content the sync writes: managed files and split
 *  files' managed regions. Starters are repo-owned after their first
 *  render, and the manifest's own entry is the sum of the others. */
function syncWritten(path: string, entry: ManifestEntryShape): boolean {
  return path !== MANIFEST_NAME && (entry.class === "managed" || entry.class === "split");
}

/** `stale`: every sync-written path of the render whose bytes (a managed
 *  file whole, a symlink's target, a split file's managed region) differ
 *  from the tree's, or are missing there. `retired`: every sync-written
 *  path the tree's manifest lists that the render no longer carries - a
 *  deselected module's file the sync would delete. Both sorted. */
export function compareManaged(renderRoot: string, treeRoot: string): CompareResult {
  const rendered = manifestOf(renderRoot, "the render");
  if ("problem" in rendered) return { kind: "unreadable", problem: rendered.problem };
  const tree = manifestOf(treeRoot, "the repository");
  if ("problem" in tree) return { kind: "unreadable", problem: tree.problem };
  const stale: string[] = [];
  let compared = 0;
  for (const [path, entry] of Object.entries(rendered.files)) {
    if (!syncWritten(path, entry)) continue;
    compared++;
    const expected = entryHash(renderRoot, path, entry);
    const actual = entryHash(treeRoot, path, entry);
    if (expected === null || actual === null || expected !== actual) stale.push(path);
  }
  const retired = Object.entries(tree.files)
    .filter(([path, entry]) => syncWritten(path, entry) && !(path in rendered.files))
    .map(([path]) => path);
  return { kind: "compared", stale: stale.sort(), retired: retired.sort(), compared };
}

/** The sync dispatch that renders the selection onto the pull request's
 *  branch: the branch input is what makes the sync push there instead of
 *  opening its own PR (sync-repos.yml). */
export function remedyLine(repository: string, headRef: string): string {
  const branch = headRef === "" ? "<the pull request's head branch>" : shellWord(headRef);
  return `gh workflow run sync-repos.yml -R ${OPERATOR_REPO} -f repo=${repository} -f branch=${branch}`;
}

/** `value` as one shell word: bare when it is only path-safe characters
 *  (a branch like feat/fuzzer-1), else single-quoted (a valid branch name
 *  may carry parentheses or spaces the pasted command would misparse). */
export function shellWord(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

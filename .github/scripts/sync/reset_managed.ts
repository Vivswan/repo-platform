#!/usr/bin/env bun
// Delivers every managed-class file of the clean render into the target
// tree whole, the ownership contract docs/compose.md states for the class.
// copier's update merges managed files three-way, so a local edit that
// merges cleanly (a trailing comment) survives the update and the stamp
// records it. Managed entries of render-new's manifest are copied byte for
// byte and symlinks re-linked to the render's target; split files
// (preserve_local_content.ts), starters (repo-owned), and retired files
// (retired_cleanup.ts) are never touched. The replaced paths go to the PR
// body (MANAGED_REPLACED_NAME), so the reviewer sees which local edits
// vanished; the PR diff shows the lines.
//
// Env: RUNNER_TEMP; TARGET_DIR (default target); plus, when the renders
// are not already materialized, ensureRenders' inputs (OLD_SHA, TARGET_REF,
// MODULES, PRIVATE, DESCRIPTION, HOMEPAGE, TOPICS, SRC_PATH).

import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  MANIFEST_NAME,
  type ManifestEntryShape,
  parseManifestFiles,
} from "../../../actions/shared/manifest.ts";
import { lstatOrNull } from "../shared/fs_probe.ts";
import { env, fail, requireEnv } from "../shared/gha.ts";
import { ensureRenders } from "./clean_renders.ts";
import { isCleanRelativePath } from "./head_manifest.ts";
import { MANAGED_REPLACED_NAME } from "./section_files.ts";

export interface ResetReport {
  /** Managed paths whose tree copy differed from the render (or was missing), sorted. */
  replaced: string[];
  /** The replaced paths that carried a LOCAL EDIT: every replaced file, and
   * the manifest only when it differed beyond the fields the stamp derives
   * (hash, commit), a hand-flipped class or grammar say. Sorted. */
  edited: string[];
  /** Managed paths already byte-equal to the render (symlinks: same target). */
  matched: number;
}

/** A manifest's declarations without the stamp-derived fields, for
 * comparing what a human could have edited. */
function declared(files: Record<string, ManifestEntryShape>): string {
  return JSON.stringify(
    Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, entry]) => [
        path,
        Object.entries(entry)
          .filter(([field]) => field !== "hash" && field !== "commit")
          .sort(([a], [b]) => (a < b ? -1 : 1)),
      ]),
  );
}

/** Whether the tree's manifest differs from the render's beyond hashes and
 * provenance. A tree manifest that does not parse counts as edited. */
function manifestEdited(render: Record<string, ManifestEntryShape>, treeText: string): boolean {
  const tree = parseManifestFiles(treeText);
  return tree.problem !== null || declared(tree.files) !== declared(render);
}

/** Whether the tree already carries the render's bytes at `path`: the same
 * link target for a symlink, the same file bytes for a regular file. */
function alreadyDelivered(renderAbs: string, treeAbs: string): boolean {
  const render = lstatSync(renderAbs);
  const tree = lstatOrNull(treeAbs);
  if (tree === null) return false;
  if (render.isSymbolicLink()) {
    return (
      tree.isSymbolicLink() &&
      readlinkSync(renderAbs, { encoding: "buffer" }).equals(
        readlinkSync(treeAbs, { encoding: "buffer" }),
      )
    );
  }
  return (
    tree.isFile() && !tree.isSymbolicLink() && readFileSync(renderAbs).equals(readFileSync(treeAbs))
  );
}

/** Copy every managed entry of `renderDir`'s manifest into `targetDir`
 * whole. Throws when the render's manifest cannot be read or names a
 * managed file the render does not carry. */
export function resetManaged(renderDir: string, targetDir: string): ResetReport {
  const parsed = parseManifestFiles(readFileSync(join(renderDir, MANIFEST_NAME), "utf-8"));
  if (parsed.problem !== null) {
    throw new Error(`${renderDir}/${MANIFEST_NAME} ${parsed.problem}`);
  }
  const replaced: string[] = [];
  const edited: string[] = [];
  let matched = 0;
  for (const [path, entry] of Object.entries(parsed.files)) {
    if (entry.class !== "managed") continue;
    // Manifest keys become paths under the target root: a key that could
    // escape it is refused before anything is written.
    if (!isCleanRelativePath(path)) {
      throw new Error(`${renderDir}/${MANIFEST_NAME} declares a managed entry at an unsafe path`);
    }
    const renderAbs = join(renderDir, path);
    if (lstatOrNull(renderAbs) === null) {
      throw new Error(
        `${MANIFEST_NAME} in ${renderDir} declares a managed entry for ${path}, but the render has no such file - manifest and render disagree`,
      );
    }
    const treeAbs = join(targetDir, path);
    if (alreadyDelivered(renderAbs, treeAbs)) {
      matched++;
      continue;
    }
    // The manifest's hashes follow the other files and the final stamp
    // rewrites them; only a difference in what it DECLARES is an edit.
    const treeStat = lstatOrNull(treeAbs);
    const isEdit =
      path !== MANIFEST_NAME ||
      treeStat === null ||
      !treeStat.isFile() ||
      manifestEdited(parsed.files, readFileSync(treeAbs, "utf-8"));
    if (isEdit) edited.push(path);
    // Remove first: copyFileSync would follow a symlink sitting at the
    // path and overwrite its target instead of replacing the link.
    rmSync(treeAbs, { force: true });
    mkdirSync(dirname(treeAbs), { recursive: true });
    if (lstatSync(renderAbs).isSymbolicLink()) {
      symlinkSync(readlinkSync(renderAbs, { encoding: "buffer" }), treeAbs);
    } else {
      copyFileSync(renderAbs, treeAbs);
    }
    replaced.push(path);
  }
  return { replaced: replaced.sort(), edited: edited.sort(), matched };
}

/** The PR-body report over the replaced local edits; "" when there were none. */
export function replacedReport(edited: string[]): string {
  if (edited.length === 0) return "";
  return [
    "> [!WARNING]",
    "> These managed files carried local edits that copier's merge kept; this",
    "> update replaces each file whole with the clean render (docs/compose.md,",
    "> ownership classes). The PR diff shows the removed lines; content that",
    "> must survive belongs in a repository-owned file.",
    "",
    ...edited.map((path) => `- \`${path}\``),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const { renderNew } = ensureRenders();
  let report: ResetReport;
  try {
    report = resetManaged(renderNew, env("TARGET_DIR", "target"));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  writeFileSync(
    join(requireEnv("RUNNER_TEMP"), MANAGED_REPLACED_NAME),
    replacedReport(report.edited),
  );
  // Paths come from the clean render, never the target's tree, and the
  // workflow runs this step under run_hidden.ts.
  for (const path of report.replaced) console.log(`reset ${path}`);
  console.log(
    `delivered ${report.replaced.length} managed file(s) whole from the clean render (${report.matched} already matched)`,
  );
}

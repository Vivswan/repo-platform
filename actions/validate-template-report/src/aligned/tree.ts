// Where the fetched build tree and the validator's report files live under
// the integrity leg's scratch directory. The fetch step lays the tree out,
// the judge step reads it, and action.yml names the tree's .bun-version
// for the setup-bun step in between, so the layout is spelled once here.

import { join } from "node:path";

export const TREE_DIR = "tree";
/** This action's directory in the fetched tree: the one package (lockfile
 *  and bun pin) the validator script under it installs and runs from. */
export const ACTION_DIR = "actions/validate-template-report";
export const VALIDATOR_SCRIPT = "validator/validate_generated_files.ts";
export const BUN_VERSION_FILE = ".bun-version";

export function treeOf(alignedDir: string): string {
  return join(alignedDir, TREE_DIR);
}

export function actionOf(alignedDir: string): string {
  return join(treeOf(alignedDir), ACTION_DIR);
}

export function reportFilesOf(alignedDir: string): { findings: string; advisories: string } {
  return {
    findings: join(alignedDir, "findings.md"),
    advisories: join(alignedDir, "advisories.md"),
  };
}

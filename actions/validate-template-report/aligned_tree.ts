// Where the fetched build tree and the validator's report files live under
// the integrity leg's scratch directory. The fetch step lays the tree out,
// the judge step reads it, and action.yml names the tree's .bun-version
// for the setup-bun step in between, so the layout is spelled once here.

import { join } from "node:path";

export const TREE_DIR = "tree";
export const VALIDATOR_DIR = "actions/validate-template";
export const VALIDATOR_SCRIPT = "validate_generated_files.ts";
export const BUN_VERSION_FILE = ".bun-version";

export function treeOf(alignedDir: string): string {
  return join(alignedDir, TREE_DIR);
}

export function validatorOf(alignedDir: string): string {
  return join(treeOf(alignedDir), VALIDATOR_DIR);
}

export function reportFilesOf(alignedDir: string): { findings: string; advisories: string } {
  return {
    findings: join(alignedDir, "findings.md"),
    advisories: join(alignedDir, "advisories.md"),
  };
}

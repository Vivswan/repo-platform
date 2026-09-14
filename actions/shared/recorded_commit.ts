// What the fleet action's read-commit step and this repository's `bun run validate` check out repo-platform at; the
// writer reads the same field from its parsed records (sync/writer/manifest.ts recordedCommit) under its own stamp rule.
// Every problem string is value-free, since the manifest is target-repository content and the action's log is public.
//
// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifestFiles } from "./manifest.ts";
import { MANIFEST_NAME } from "./platform.ts";

const RESYNC = "dispatch a sync";
const REVERT = `revert the edit (git history has the stamped original) or ${RESYNC}`;

/** The full sha the manifest at `root` records, or why none can be read. */
export function recordedCommit(root: string): { commit: string } | { problem: string } {
  let text: string;
  try {
    text = readFileSync(join(root, MANIFEST_NAME), "utf-8");
  } catch (error) {
    // Only an absent file is "missing"; an unreadable one (a directory at the path, a permission) is its own problem,
    // named by the error code alone.
    const code = (error as { code?: string }).code ?? "unknown error";
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return {
        problem: `${MANIFEST_NAME} cannot be read (${code}); restore the file from git history or ${RESYNC}`,
      };
    }
    return {
      problem: `${MANIFEST_NAME} is missing; every sync writes it, so restore it from git history or ${RESYNC}`,
    };
  }
  const parsed = parseManifestFiles(text);
  if (parsed.problem !== null) return { problem: `${MANIFEST_NAME} ${parsed.problem}; ${REVERT}` };
  const commit = parsed.files[MANIFEST_NAME]?.commit;
  if (commit === undefined) {
    return { problem: `no synced commit recorded; merge the pending sync PR or ${RESYNC}` };
  }
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    return {
      problem: `${MANIFEST_NAME} records a synced commit that is not a full 40-hex sha; ${REVERT}`,
    };
  }
  return { commit };
}

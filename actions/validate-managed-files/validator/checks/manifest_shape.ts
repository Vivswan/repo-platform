import { unknownEntryFields } from "../../../shared/manifest.ts";
import { MANIFEST_NAME, PLATFORM_NAME } from "../../../shared/platform.ts";
import type { Context } from "../context.ts";
import { error, type Finding } from "../findings.ts";

export const RESYNC = `re-run the sync (dispatch sync-repos.yml in ${PLATFORM_NAME} with repo=<owner>/<name>), which replaces platform files whole`;
/** The writer refuses a manifest record it cannot read before writing anything (sync.ts), so no resync restamps one. */
export const REPAIR =
  "the sync refuses a record it cannot read, so revert the entry (git history has the stamped original)";

/** The manifest is itself a managed file, so every managed repository carries it. The guarantee is VISIBILITY, not
 *  tamper-proofing, and nothing lists the selection's paths against the keys.
 *    caught here or at parity  -> a field outside the vocabulary or on a class that does not carry it, a damaged self
 *                                 entry, a class other than the one files.yml writes the path under for this
 *                                 repository, a hash or marker pair the file does not verify
 *    not caught                -> an entry removed whole */
export function checkManifestShape(ctx: Context): Finding[] {
  switch (ctx.manifest.state) {
    case "absent":
      return [
        error(
          `${MANIFEST_NAME} is missing - every sync writes it, so this is ` +
            `deletion or damage; restore it from git history or ${RESYNC}`,
        ),
      ];
    case "conflicted":
      return [];
    case "malformed":
      return [
        error(
          `${MANIFEST_NAME}: ${ctx.manifest.problem} - the file is managed; revert ` +
            `the edit (git history has the stamped original) or ${RESYNC}`,
        ),
      ];
    case "parsed":
      break;
  }
  const { records, refused } = ctx.manifest;
  const findings: Finding[] = [];
  for (const { key, problem } of refused) {
    findings.push(
      error(
        `${MANIFEST_NAME}: entry '${key}' is not a repository path the sync writes (the path ${problem}) - ` +
          "a hand edit, and no class can be judged for it; delete the entry (git history has the stamped original)",
      ),
    );
  }
  // No emitter writes a field outside the vocabulary, so one is a hand edit. The writer rewrites the manifest's own
  // entry without reading it (sync.ts skips it), so a resync heals that one alone.
  for (const { path, fields } of unknownEntryFields(records)) {
    const remedy =
      path === MANIFEST_NAME
        ? `revert the edit (git history has the stamped original) or ${RESYNC}`
        : REPAIR;
    findings.push(
      error(
        `${MANIFEST_NAME}: entry '${path}' carries field(s) ${fields
          .map((field) => JSON.stringify(field))
          .join(", ")} outside the manifest's vocabulary - no sync writes them; ${remedy}`,
      ),
    );
  }
  if (records[MANIFEST_NAME] === undefined) {
    findings.push(
      error(
        `${MANIFEST_NAME}: does not list itself - the manifest is a managed ` +
          `file like any other; ${RESYNC}`,
      ),
    );
  }
  return findings;
}

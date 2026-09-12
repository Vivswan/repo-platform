import { unknownEntryFields } from "../../../shared/manifest.ts";
import { MANIFEST_NAME, PLATFORM_NAME } from "../../../shared/platform.ts";
import { pathProblem } from "../../../shared/repo_path.ts";
import type { Context } from "../context.ts";
import { error, type Finding } from "../findings.ts";

export const RESYNC = `re-run the sync (dispatch sync-repos.yml in ${PLATFORM_NAME} with repo=<owner>/<name>), which replaces platform files whole`;

/** The manifest is itself a managed file, so managed repositories carry it and the platform itself must NOT (self mode
 *  inverts). The guarantee is VISIBILITY, not tamper-proofing, and nothing lists the selection's paths against the keys.
 *    caught here or at parity  -> a field outside the vocabulary or on a class that does not carry it, a damaged self
 *                                 entry, a class other than the one files.yml writes the path under for this
 *                                 repository, a hash or marker pair the file does not verify
 *    not caught                -> an entry removed whole */
export function checkManifestShape(ctx: Context): Finding[] {
  if (ctx.mode === "self") {
    if (ctx.manifest.state === "absent") return [];
    return [
      error(
        `${MANIFEST_NAME}: exists in the operator repository - the ownership ` +
          "manifest lands only in the repositories the sync writes; delete it",
      ),
    ];
  }
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
  const files = ctx.manifest.files;
  const findings: Finding[] = [];
  // A key the sync would never write (`./x`, `a//b`) still resolves to the
  // declared file on disk while matching no declaration, so the class gate
  // in manifest_parity never sees it; the sync ignores such a record.
  for (const path of Object.keys(files)) {
    const problem = pathProblem(path);
    if (problem === null) continue;
    findings.push(
      error(
        `${MANIFEST_NAME}: entry '${path}' is not a repository path the sync writes (the path ${problem}) - ` +
          "a hand edit; the sync ignores such a record and no class can be judged for it; delete the entry " +
          `(git history has the stamped original) or ${RESYNC}`,
      ),
    );
  }
  // No emitter writes a field outside the vocabulary, so one is a hand
  // edit; the next sync drops it.
  for (const { path, fields } of unknownEntryFields(files)) {
    findings.push(
      error(
        `${MANIFEST_NAME}: entry '${path}' carries field(s) ${fields
          .map((field) => JSON.stringify(field))
          .join(", ")} outside the manifest's vocabulary - no sync writes them; revert the ` +
          `edit (git history has the stamped original) or ${RESYNC}`,
      ),
    );
  }
  const self = files[MANIFEST_NAME];
  if (self === undefined) {
    findings.push(
      error(
        `${MANIFEST_NAME}: does not list itself - the manifest is a managed ` +
          `file like any other; ${RESYNC}`,
      ),
    );
    return findings;
  }
  // The self entry records the build the writer copied from: null before
  // the first sync stamps it, else the build commit's full sha.
  const commit = "commit" in self ? self.commit : null;
  if (commit !== null && !(typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit))) {
    findings.push(
      error(
        `${MANIFEST_NAME}: its self entry's commit must be null or the build's full 40-hex ` +
          `sha, the value the sync writes; revert the edit or ${RESYNC}`,
      ),
    );
  }
  return findings;
}

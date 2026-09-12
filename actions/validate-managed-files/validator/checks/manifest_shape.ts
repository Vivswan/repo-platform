import { MANIFEST_NAME, unknownEntryFields } from "../../../shared/manifest.ts";
import type { Context } from "../context.ts";
import { error, type Finding } from "../findings.ts";

export const RESYNC =
  "re-run the sync (dispatch sync-repos.yml in Vivswan/repo-platform with repo=<owner>/<name>), which replaces platform files whole";

/** The manifest is itself a managed file, so managed repositories carry it and repo-platform itself must NOT (self mode
 *  inverts). The guarantee is VISIBILITY, not tamper-proofing: a hand-edited manifest is caught here or at parity, and
 *  the next sync restamps it. */
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
  // No emitter writes a field outside the vocabulary, so one is a hand
  // edit; the next sync drops it.
  for (const { path, fields } of unknownEntryFields(files)) {
    findings.push(
      error(
        `${MANIFEST_NAME}: entry '${path}' carries field(s) ${fields
          .map((field) => JSON.stringify(field))
          .join(", ")} outside the manifest's vocabulary - no sync writes them; the next ` +
          "sync restamps the entry without them, or revert the edit",
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

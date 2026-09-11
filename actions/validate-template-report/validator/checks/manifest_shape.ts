import { MANIFEST_NAME, unknownEntryFields } from "../../../shared/manifest.ts";
import type { Context } from "../context.ts";
import { advisory, error, type Finding } from "../findings.ts";
import { coveredPaths } from "../ownership.ts";

/** The one repair for a damaged managed file: the operator has no recovery mode. */
export const RESYNC =
  "re-run the sync (gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<name>), which replaces platform files whole";

/** The ownership manifest's shape and trust model. The manifest is itself
 *  a managed render, so clients carry it and the template repo must NOT
 *  (self mode inverts); absence, unparsable text, and a provenance stamp
 *  differing from the answers file's recorded _commit are errors. Ownership METADATA is
 *  not trusted for roster paths: the sync BASELINES local manifest edits,
 *  so a hand-flipped class would disable parity permanently and invisibly;
 *  roster and manifest come from one template commit, so disagreement is
 *  a hand edit. The guarantee is VISIBILITY, not tamper-proofing. */
export function checkManifestShape(ctx: Context): Finding[] {
  if (ctx.mode === "self") {
    if (!ctx.manifestPresent) return [];
    return [
      error(
        `${MANIFEST_NAME}: exists in the template repository - the ownership ` +
          "manifest lands only in generated repos (this repo dogfoods " +
          "individual template twins, never a full render of itself); delete it",
      ),
    ];
  }
  switch (ctx.manifest.state) {
    case "absent":
      return [
        error(
          `${MANIFEST_NAME} is missing - every build ships it, so this is ` +
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
  // edit; the next stamp drops it.
  for (const { path, fields } of unknownEntryFields(files)) {
    findings.push(
      error(
        `${MANIFEST_NAME}: entry '${path}' carries field(s) ${fields
          .map((field) => JSON.stringify(field))
          .join(", ")} outside the manifest's vocabulary - no sync writes them; the next ` +
          "template sync restamps the entry without them, or revert the edit",
      ),
    );
  }
  if (!(MANIFEST_NAME in files)) {
    findings.push(
      error(
        `${MANIFEST_NAME}: does not list itself - the manifest is a managed ` +
          "render like any other; run a template sync to regenerate it",
      ),
    );
  }
  // Provenance: while the answers file exists, the stamped commit on the
  // self entry must EQUAL its recorded _commit; once the sync writer has
  // retired the answers file, the self entry is the one record and its
  // shape is the registration check's report. Once a provenance error is
  // reported, a missing roster entry is an advisory naming that error
  // instead of a second error per path on the same cause; `absenceCaveat`
  // (null = strict) carries the name. A tree recording no build commit is
  // the registration check's error, and nothing can be compared against
  // it: the stamp is left unjudged and absence takes the same caveat.
  const answersCommit = ctx.answers?.commit ?? null;
  const rawSelfCommit = files[MANIFEST_NAME]?.commit;
  const manifestCommit = typeof rawSelfCommit === "string" ? rawSelfCommit : null;
  const recordedCommit = ctx.buildRecord?.commit ?? null;
  let absenceCaveat: string | null = null;
  if (ctx.answers === null) {
    if (recordedCommit === null) {
      absenceCaveat =
        "its own entry records no build commit to judge the roster against (the registration check's error)";
    }
  } else if (answersCommit === null) {
    absenceCaveat =
      "the render records no _commit to compare against (the registration check's error)";
  } else if (manifestCommit === null) {
    findings.push(
      error(
        `${MANIFEST_NAME}: its provenance stamp is null but the render ` +
          `records _commit ${answersCommit}, which the stamper always ` +
          `writes - tampering or a failed stamp; revert the edit or ${RESYNC}`,
      ),
    );
    absenceCaveat = "its provenance stamp is unusable (error above)";
  } else if (manifestCommit !== answersCommit) {
    findings.push(
      error(
        `${MANIFEST_NAME}: its stamped provenance (self-entry commit ` +
          `'${manifestCommit}') does not match the recorded render ${answersCommit} - ` +
          "the stamper always writes the recorded value, so this is " +
          `tampering or a failed stamp; revert the edit or ${RESYNC}`,
      ),
    );
    absenceCaveat = "its provenance stamp is unusable (error above)";
  }
  // Roster cross-check: the manifest's class metadata must agree with this
  // validator's own tables for every path they cover. Entry values are
  // objects with a string class (the shared parser rejected everything
  // else); every other field is validated where it is used.
  const metadataError = (rel: string, claim: string, declared: string) =>
    error(
      `${MANIFEST_NAME}: entry '${rel}' ${claim} but this validator's ` +
        `ownership tables declare it ${declared} - a hand edit here would ` +
        "silently disable or skew byte parity, and sync baselines manifest " +
        "edits instead of healing them; revert the entry (git history has " +
        `the stamped original) or ${RESYNC}`,
    );
  for (const { path, kind, begin, end } of ctx.ownership) {
    const entry = files[path];
    if (entry === undefined) {
      const declaredBy = "this validator's ownership tables declare";
      findings.push(
        absenceCaveat === null
          ? error(
              `${MANIFEST_NAME} does not list '${path}', which ${declaredBy} - the ` +
                `sync writes every entry of its build (${recordedCommit}), so ` +
                "the entry was deleted by hand, and sync baselines manifest edits; " +
                `revert it (git history has the stamped original) or ${RESYNC}`,
            )
          : advisory(
              `${MANIFEST_NAME} does not list '${path}', which ${declaredBy} - ` +
                `${absenceCaveat} (a hand-deleted entry needs reverting; sync baselines manifest edits)`,
            ),
      );
      continue;
    }
    // A class-only path may be a symlink render (the agent-file aliases),
    // which the sync records as a link; the parity check then demands a
    // symlink on disk, so the record cannot exempt a regular file.
    const declared = kind === "region" ? "split" : "managed";
    const accepted = kind === "class-only" ? [declared, "link"] : [declared];
    if (!accepted.includes(entry.class)) {
      findings.push(
        metadataError(
          path,
          `claims class ${JSON.stringify(entry.class)}`,
          kind === "class-only" ? "managed (link for a symlink render)" : declared,
        ),
      );
      continue;
    }
    // A present grammar must name the one grammar with the declared marker
    // pair; a MISSING grammar field is a shape problem the parity check
    // reports once (every render stamps the field), not doubled here.
    if (
      kind === "region" &&
      (entry.begin !== begin ||
        entry.end !== end ||
        ("grammar" in entry && entry.grammar !== "managed-region"))
    ) {
      findings.push(
        metadataError(
          path,
          "carries split metadata outside its declared managed-region grammar",
          `split with the managed region between '${begin}' and '${end}'`,
        ),
      );
    }
  }
  // An entry for a table-covered path whose render condition is off (an
  // unselected module's workflow, a public-only file on a private render)
  // cannot come from the template; it is manifest drift.
  const expected = new Set(ctx.ownership.map((f) => f.path));
  const covered = coveredPaths({
    isPrivateRender: ctx.isPrivateRender,
    selectedModules: ctx.selectedModules,
    registeredByAnswers: ctx.registeredByAnswers,
  });
  for (const rel of Object.keys(files)) {
    if (covered.has(rel) && !expected.has(rel)) {
      findings.push(
        error(
          `${MANIFEST_NAME}: entry '${rel}' should not exist for this render ` +
            "(its module is unselected or its render condition is off) - " +
            "manifest drift, which sync baselines rather than heals; revert " +
            `the entry or ${RESYNC}`,
        ),
      );
    }
  }
  return findings;
}

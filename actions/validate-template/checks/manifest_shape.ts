import { join } from "node:path";
import { MANIFEST_NAME } from "../../shared/manifest.ts";
import { ANSWERS_PATH, type Context } from "../context.ts";
import { advisory, error, type Finding } from "../findings.ts";
import { coveredPaths } from "../ownership.ts";
import { pathExists } from "../readers.ts";

const RECOVERY = "run a recovery sync (recover=recopy)";

/** The ownership manifest's shape and trust model. The manifest is itself
 *  a managed render, so client repos carry it and the template repo must
 *  NOT (self mode inverts - repo-platform is not a render of itself); a
 *  conflict-marked manifest is the conflict-marker check's report. Every
 *  build ships the manifest and the stamper writes the render's recorded
 *  _commit into the self entry verbatim, so absence, an unparseable file,
 *  and a provenance stamp differing from the recorded value are errors.
 *  The manifest's ownership METADATA is not trusted for the paths this
 *  validator's roster covers: the sync BASELINES non-conflicting local
 *  manifest edits rather than healing them, so a hand-flipped class
 *  (managed -> starter) would otherwise disable parity for that path
 *  permanently and invisibly. A class or split-metadata mismatch, an entry
 *  whose render condition is off, and a roster path the manifest does not
 *  list while its file still exists are errors. No in-repo signal
 *  can be tamper-proof against the repo's own owner; the guarantee is
 *  VISIBILITY, and a tampered _commit both self-heals on the next sync and
 *  breaks the repo's own update base loudly. */
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
            `deletion or damage; restore it from git history or ${RECOVERY}`,
        ),
      ];
    case "conflicted":
      return [];
    case "malformed":
      return [
        error(
          `${MANIFEST_NAME}: ${ctx.manifest.problem} - the file is managed; revert ` +
            `the edit (git history has the stamped original) or ${RECOVERY}`,
        ),
      ];
    case "parsed":
      break;
  }
  const files = ctx.manifest.files;
  const findings: Finding[] = [];
  if (!(MANIFEST_NAME in files)) {
    findings.push(
      error(
        `${MANIFEST_NAME}: does not list itself - the manifest is a managed ` +
          "render like any other; run a template sync to regenerate it",
      ),
    );
  }
  // Provenance: the stamped commit on the self entry must EQUAL the
  // recorded answers _commit (null exactly when the answers record none).
  // Once a provenance error is reported, a missing roster entry is an
  // advisory naming that error instead of a second error per path on the
  // same cause; `absenceCaveat` (null = strict) carries the name.
  const answersCommit = ctx.answers?.commit ?? null;
  const rawSelfCommit = files[MANIFEST_NAME]?.commit;
  const manifestCommit = typeof rawSelfCommit === "string" ? rawSelfCommit : null;
  let absenceCaveat: string | null = null;
  if (manifestCommit === null && answersCommit !== null) {
    findings.push(
      error(
        `${MANIFEST_NAME}: its provenance stamp is null but the render ` +
          `records _commit ${answersCommit}, which the stamper always ` +
          `writes - tampering or a failed stamp; revert the edit or ${RECOVERY}`,
      ),
    );
    absenceCaveat = "its provenance stamp is unusable (error above)";
  } else if (manifestCommit !== null && manifestCommit !== answersCommit) {
    findings.push(
      error(
        `${MANIFEST_NAME}: its stamped provenance (self-entry commit ` +
          `'${manifestCommit}') does not match the recorded render ` +
          `${answersCommit === null ? `(no _commit in ${ANSWERS_PATH})` : answersCommit} - ` +
          "the stamper always writes the recorded value, so this is " +
          `tampering or a failed stamp; revert the edit or ${RECOVERY}`,
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
        `the stamped original) or ${RECOVERY}, ` +
        "which re-renders the manifest without a merge",
    );
  for (const { path, kind, begin, end } of ctx.ownership) {
    const entry = files[path];
    if (entry === undefined) {
      const declaredBy = "this validator's ownership tables declare";
      // The strict deletion error requires the FILE to still exist: the
      // stealth attack parity guards against is an unlisted path whose
      // file lives on for quiet editing. An absent file is a version split
      // the fleet legitimately produces (withheld workflow files pin an
      // older ci.yml; client validators float at main, ahead of the
      // render), where a retired or not-yet-delivered table path has no
      // file - erroring there would be false.
      findings.push(
        absenceCaveat === null && pathExists(join(ctx.root, path))
          ? error(
              `${MANIFEST_NAME} does not list '${path}', which ${declaredBy} - the ` +
                `stamper writes every entry of its render (${answersCommit}), so ` +
                "the entry was deleted by hand, and sync baselines manifest edits; " +
                `revert it (git history has the stamped original) or ${RECOVERY}`,
            )
          : advisory(
              `${MANIFEST_NAME} does not list '${path}', which ${declaredBy} - ` +
                `${
                  absenceCaveat ??
                  "the path is absent from the repo too, so this is a retired " +
                    "or not-yet-delivered path seen by a validator of a " +
                    "different vintage, not stealth drift"
                } (a hand-deleted entry needs reverting; sync baselines manifest edits)`,
            ),
      );
      continue;
    }
    const declared = kind === "region" ? "split" : "managed";
    if (entry.class !== declared) {
      findings.push(metadataError(path, `claims class ${JSON.stringify(entry.class)}`, declared));
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
  const covered = coveredPaths(ctx.selectedModules);
  for (const rel of Object.keys(files)) {
    if (covered.has(rel) && !expected.has(rel)) {
      findings.push(
        error(
          `${MANIFEST_NAME}: entry '${rel}' should not exist for this render ` +
            "(its module is unselected or its render condition is off) - " +
            "manifest drift, which sync baselines rather than heals; revert " +
            `the entry or ${RECOVERY}`,
        ),
      );
    }
  }
  return findings;
}

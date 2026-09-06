import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanManagedRegion, knownGrammar } from "../../shared/grammar.ts";
import { MANIFEST_NAME, withheldMarkerValid } from "../../shared/manifest.ts";
import type { Context } from "../context.ts";
import { advisory, error, type Finding } from "../findings.ts";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Ownership-manifest byte parity, entry by entry: every managed or split
 *  entry's recorded sha256 matches the file on disk (split files: the
 *  managed region alone, from the entry's BEGIN marker line through its
 *  END marker line). Drift means the file changed since the last stamp;
 *  the next sync replaces it. A listed file missing from the repo is
 *  deletion damage and errors, with one exception the sync itself
 *  records: a workflow file it could not deliver (the push token lacks the
 *  Workflows scope) is removed from the pushed tree and its entry
 *  restamped hash-null with `"withheld": true` (stamp_manifest.ts owns the
 *  marker: it writes it for the withheld paths, keeps it while the file
 *  stays undelivered, and strips it once it can hash the file). That entry
 *  is an advisory naming the withheld cause; hash-null and absent without
 *  the marker is a deleted managed file. The marker is valid only under
 *  .github/workflows/, the one directory that scope gates, so a marker
 *  anywhere else cannot launder a deletion. The roster cross-check
 *  (manifest_shape) has already judged the class metadata of every roster
 *  path; this check reads each entry's fields as they stand. */
export function checkManifestParity(ctx: Context): Finding[] {
  if (ctx.mode === "self" || ctx.manifest.state !== "parsed") return [];
  const findings: Finding[] = [];
  for (const [rel, entry] of Object.entries(ctx.manifest.files)) {
    const where = `${MANIFEST_NAME}: entry '${rel}'`;
    // The marker has one shape: `true` on a hash-null managed or split
    // entry under .github/workflows/. The stamper writes nothing else, so
    // any other combination is a hand edit; judged before the class
    // dispatch so a starter or the self entry cannot carry it unseen.
    if ("withheld" in entry && !withheldMarkerValid(rel, entry)) {
      findings.push(
        error(
          `${where} carries a withheld marker outside its one shape (\`true\` on a hash-null ` +
            "managed or split entry under .github/workflows/) - the sync writes the marker only " +
            "for a workflow it could not deliver; revert the entry (git history has the stamped " +
            "original) or run a recovery sync (recover=recopy)",
        ),
      );
      continue;
    }
    // The self entry's invariant comes before any class dispatch: a
    // corrupted class (say, starter) must not slip past it. Its commit slot
    // holds the provenance stamp (null or a string; manifest_shape judges
    // the value).
    if (rel === MANIFEST_NAME) {
      if (
        entry.class !== "managed" ||
        entry.hash !== null ||
        ("commit" in entry && entry.commit !== null && typeof entry.commit !== "string")
      ) {
        findings.push(
          error(
            `${where} must be managed with hash null (its content includes ` +
              "every other hash, so a self-hash would be circular) and a " +
              "null-or-string provenance commit; run a template sync to " +
              "regenerate it",
          ),
        );
      }
      continue;
    }
    if (entry.class === "starter") {
      if ("hash" in entry) {
        findings.push(
          error(
            `${where} is a starter carrying a hash - starters are repo-owned ` +
              "after the first render, so sync makes no byte-parity promise " +
              "about them; run a template sync to regenerate the manifest",
          ),
        );
      }
      continue;
    }
    if (entry.class === "mergeable") {
      // Retired class: settings.yml, its only member, is a repo-owned
      // starter now, and its baseline is computed centrally at apply time.
      findings.push(
        error(
          `${where} has class "mergeable", which is retired - the next template ` +
            "sync re-renders the manifest (settings.yml became a repo-owned starter)",
        ),
      );
      continue;
    }
    if (entry.class !== "managed" && entry.class !== "split") {
      findings.push(
        error(
          `${where} has unknown class ${JSON.stringify(entry.class)} (expected ` +
            "managed, split, or starter); run a template sync to " +
            "regenerate the manifest",
        ),
      );
      continue;
    }
    const hash = "hash" in entry ? entry.hash : undefined;
    if (hash !== null && !(typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) {
      findings.push(
        error(
          `${where}: hash must be null or a lowercase sha256 hex digest; ` +
            "run a template sync to regenerate and restamp the manifest",
        ),
      );
      continue;
    }
    let split: { begin: string; end: string } | null = null;
    if (entry.class === "split") {
      // Every render stamps the grammar field; the marker strings alone
      // cannot say which grammar the sync rebuild uses, so a split entry
      // without one is a hand edit (or a manifest older than the stamped
      // grammar itself). Checked BEFORE the marker-string shape: an
      // older-vintage entry should draw the vintage diagnosis, not a
      // field-shape complaint.
      if (!("grammar" in entry)) {
        findings.push(
          error(
            `${where} lacks the split grammar field every render stamps - a hand ` +
              "edit, and sync baselines manifest edits instead of healing them; " +
              "revert the entry (git history has the stamped original) or run a " +
              "recovery sync (recover=recopy)",
          ),
        );
        continue;
      }
      // A RETIRED grammar (tail-marker, the four-marker bounded-region) is
      // older than this validator, and reading it by guess would verify the
      // wrong region - loud refusal, mirroring the sync's own refusals.
      if (knownGrammar(entry.grammar) === null) {
        findings.push(
          error(
            `${where} declares split grammar ${JSON.stringify(entry.grammar)}, which this ` +
              "validator does not read (one grammar exists: managed-region) - the " +
              "manifest predates this validator; run a template sync to restamp it",
          ),
        );
        continue;
      }
      if (typeof entry.begin !== "string" || typeof entry.end !== "string") {
        findings.push(
          error(
            `${where} is split but lacks its begin/end marker-line strings; ` +
              "run a template sync to regenerate the manifest",
          ),
        );
        continue;
      }
      split = { begin: entry.begin, end: entry.end };
    }
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(join(ctx.root, rel));
    } catch {
      stat = null;
    }
    if (stat === null) {
      if (entry.withheld === true) {
        findings.push(
          advisory(
            `${rel}: listed as ${entry.class} in ${MANIFEST_NAME} but withheld from the ` +
              "repo - the sync's push token lacked the Workflows scope, so it could not " +
              "create the workflow file; grant Workflows read/write to the sync token and " +
              "run a recovery sync (recover=recopy), which re-renders it",
          ),
        );
      } else {
        findings.push(
          error(
            `${rel}: listed as ${entry.class} in ${MANIFEST_NAME} but missing from the ` +
              "repo - a managed file deleted outside a sync; restore it from git history " +
              "or run a recovery sync (recover=recopy)",
          ),
        );
      }
      continue;
    }
    if (hash === null) {
      findings.push(
        error(
          `${rel}: ${MANIFEST_NAME} records no hash for it (unstamped) - the ` +
            "render's stamp hook did not run; run a template sync (or bun " +
            "stamp_manifest.ts from the build branch) to stamp it",
        ),
      );
      continue;
    }
    let actual: string;
    if (stat.isSymbolicLink()) {
      // Raw link bytes: decoding a malformed-UTF-8 target would fold
      // distinct targets onto the replacement character.
      actual = sha256(readlinkSync(join(ctx.root, rel), { encoding: "buffer" }));
    } else if (!stat.isFile()) {
      findings.push(
        error(
          `${rel}: listed in ${MANIFEST_NAME} but is neither a regular file ` +
            "nor a symlink; run a template sync to restore the managed render",
        ),
      );
      continue;
    } else {
      const content = readFileSync(join(ctx.root, rel)).toString("latin1");
      if (split !== null) {
        // The STRICT slice, shared with the stamper and the sync writers:
        // duplicated, buried, or reordered markers make the region
        // ambiguous, so there is nothing honest to verify parity against.
        // Fail closed: a corrupted manifest reclassifying a file as split
        // must not silently exempt it.
        const slice = cleanManagedRegion(content, split);
        if (slice === null) {
          findings.push(
            error(
              `${rel}: the managed-region marker lines ('${split.begin}' ... ` +
                `'${split.end}') recorded in ${MANIFEST_NAME} are missing, duplicated, ` +
                "or out of order in the file, so managed-region parity cannot be " +
                "verified - restore the single marker pair or run a template sync",
            ),
          );
          continue;
        }
        actual = sha256(Buffer.from(slice.region, "latin1"));
      } else {
        actual = sha256(Buffer.from(content, "latin1"));
      }
    }
    if (actual !== hash) {
      findings.push(
        error(
          `${rel}: ${split !== null ? "its managed region does" : "content does"} ` +
            `not match the sha256 recorded in ${MANIFEST_NAME} - the file ` +
            "drifted from the last stamped sync state; local edits to " +
            `${split !== null ? "the managed region" : "a managed file"} are ` +
            "replaced by the next template sync (move them to a repo-owned " +
            "location), and intended template-side updates restamp on that sync",
        ),
      );
    }
  }
  return findings;
}

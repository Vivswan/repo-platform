import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanManagedRegion, knownGrammar } from "../../../shared/grammar.ts";
import { isRecordedClass, MANIFEST_NAME, RECORDED_CLASSES } from "../../../shared/manifest.ts";
import type { Context } from "../context.ts";
import { error, type Finding } from "../findings.ts";
import { RESYNC } from "./manifest_shape.ts";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function checkManifestParity(ctx: Context): Finding[] {
  if (ctx.mode === "self" || ctx.manifest.state !== "parsed") return [];
  const findings: Finding[] = [];
  for (const [rel, entry] of Object.entries(ctx.manifest.files)) {
    const where = `${MANIFEST_NAME}: entry '${rel}'`;
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
              "null-or-string provenance commit; re-run the sync to " +
              "regenerate it",
          ),
        );
      }
      continue;
    }
    if (!isRecordedClass(entry.class)) {
      findings.push(
        error(
          `${where} has unknown class ${JSON.stringify(entry.class)} (expected one of ` +
            `${RECORDED_CLASSES.join(", ")}); re-run the sync to regenerate the manifest`,
        ),
      );
      continue;
    }
    // The class decides what parity verifies (a starter: nothing), so it is
    // judged before any dispatch, against the declaration the selection
    // makes live. A path no live declaration writes (a mirror target, a
    // retired path, a deselected module's file) is dispatched as recorded.
    const declared = ctx.classes?.get(rel);
    if (declared !== undefined && declared !== entry.class) {
      findings.push(
        error(
          `${where} is recorded as ${entry.class} but files.yml declares the path ` +
            `${declared} - the class decides what parity verifies, and the ` +
            "sync records the declared one; revert a hand edit (git history has the stamped " +
            "original: the sync holds a drifted file whose record it cannot verify, never " +
            "restamps it), merge the pending sync PR when the platform changed the path's class " +
            "since the last sync (a row that PR holds keeps the old record until it is resolved), " +
            "or, when this registration's module change flips it (a mirror target a newly " +
            "selected entry writes, say), land the edit that retires the old record first " +
            "(docs/new-repo.md, PR edits modules)",
        ),
      );
      continue;
    }
    if (entry.class === "starter") {
      if ("hash" in entry) {
        findings.push(
          error(
            `${where} is a starter carrying a hash - starters are repo-owned ` +
              "after the first write, so sync makes no byte-parity promise " +
              "about them; re-run the sync to regenerate the manifest",
          ),
        );
      }
      continue;
    }
    // A mirror is a byte copy the sync wrote, its hash the whole file's,
    // so it is verified exactly like a managed file. A link is a symlink
    // the sync placed, its hash the target string's.
    const hash = "hash" in entry ? entry.hash : undefined;
    if (hash !== null && !(typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) {
      findings.push(
        error(
          `${where}: hash must be null or a lowercase sha256 hex digest; ` +
            "re-run the sync to regenerate and restamp the manifest",
        ),
      );
      continue;
    }
    let split: { begin: string; end: string } | null = null;
    if (entry.class === "split") {
      // Every sync stamps the grammar field; the marker strings alone
      // cannot say which grammar the writer uses, so a split entry
      // without one is a hand edit. Checked BEFORE the marker-string shape
      // so the grammar diagnosis comes first, not a field-shape complaint.
      if (!("grammar" in entry)) {
        findings.push(
          error(
            `${where} lacks the split grammar field every sync stamps - a hand ` +
              "edit, and the sync records manifest edits instead of healing them; " +
              `revert the entry (git history has the stamped original) or ${RESYNC}`,
          ),
        );
        continue;
      }
      // A grammar outside GRAMMAR_IDS cannot be read by guess without verifying the wrong region.
      if (knownGrammar(entry.grammar) === null) {
        findings.push(
          error(
            `${where} declares split grammar ${JSON.stringify(entry.grammar)}, which this ` +
              "validator does not read (one grammar exists: managed-region); re-run " +
              "the sync to restamp the manifest",
          ),
        );
        continue;
      }
      if (typeof entry.begin !== "string" || typeof entry.end !== "string") {
        findings.push(
          error(
            `${where} is split but lacks its begin/end marker-line strings; ` +
              "re-run the sync to regenerate the manifest",
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
      findings.push(
        error(
          `${rel}: listed as ${entry.class} in ${MANIFEST_NAME} but missing from the ` +
            `repo - a managed file deleted outside a sync; restore it from git history or ${RESYNC}`,
        ),
      );
      continue;
    }
    if (hash === null) {
      findings.push(
        error(
          `${rel}: ${MANIFEST_NAME} records no hash for it (unstamped) - the ` +
            "sync writes every hash it records, so this is a hand edit; re-run the sync to stamp it",
        ),
      );
      continue;
    }
    let actual: string;
    if (stat.isSymbolicLink()) {
      // Raw link bytes: decoding a malformed-UTF-8 target would fold distinct targets onto the replacement character.
      // Any class hashes a link this way.
      actual = sha256(readlinkSync(join(ctx.root, rel), { encoding: "buffer" }));
    } else if (entry.class === "link") {
      findings.push(
        error(
          `${rel}: recorded as a link in ${MANIFEST_NAME} but is not a symbolic link - ` +
            "the sync writes a relative symlink there and never reads through one, so " +
            "a regular file at the path is a local replacement; restore the link from " +
            "git history or re-run the sync",
        ),
      );
      continue;
    } else if (!stat.isFile()) {
      findings.push(
        error(
          `${rel}: listed in ${MANIFEST_NAME} but is neither a regular file ` +
            "nor a symlink; re-run the sync to restore the managed file",
        ),
      );
      continue;
    } else {
      const content = readFileSync(join(ctx.root, rel)).toString("latin1");
      if (split !== null) {
        // The STRICT slice, shared with the sync writer:
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
                "verified - restore the single marker pair or re-run the sync",
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
            "drifted from the last sync; local edits to " +
            `${split !== null ? "the managed region" : "a managed file"} are ` +
            "replaced by the next sync (move them to a repo-owned " +
            "location), and platform-side updates restamp on that sync",
        ),
      );
    }
  }
  return findings;
}

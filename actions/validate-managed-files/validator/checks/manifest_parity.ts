import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanManagedRegion, knownGrammar } from "../../../shared/grammar.ts";
import {
  isEntryField,
  isRecordedClass,
  RECORD_FIELDS,
  RECORDED_CLASSES,
  SELF_ENTRY_FIELDS,
  strayFields,
} from "../../../shared/manifest.ts";
import { MANIFEST_NAME } from "../../../shared/platform.ts";
import type { Context } from "../context.ts";
import { error, type Finding } from "../findings.ts";
import { REPAIR, RESYNC } from "./manifest_shape.ts";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function checkManifestParity(ctx: Context): Finding[] {
  if (ctx.manifest.state !== "parsed") return [];
  const findings: Finding[] = [];
  for (const [rel, entry] of Object.entries(ctx.manifest.records)) {
    const where = `${MANIFEST_NAME}: entry '${rel}'`;
    // The self entry's invariant comes before any class dispatch: a
    // corrupted class (say, starter) must not slip past it. Its commit slot
    // holds the provenance stamp (null or a string; manifest_shape judges
    // the value).
    if (rel === MANIFEST_NAME) {
      const stray = strayFields(SELF_ENTRY_FIELDS, entry).filter(isEntryField);
      if (stray.length > 0) {
        findings.push(
          error(
            `${where} carries ${stray.map((field) => JSON.stringify(field)).join(", ")}, which the ` +
              "sync never records on the manifest's own entry; revert the edit (git history has " +
              `the stamped original) or ${RESYNC}`,
          ),
        );
        continue;
      }
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
    // A key outside the vocabulary is manifest_shape's report, and the writer refuses the record, so no remedy below
    // applies to it; this names a vocabulary field on the wrong class.
    if (Object.keys(entry).some((key) => !isEntryField(key))) continue;
    const stray = isRecordedClass(entry.class)
      ? strayFields(RECORD_FIELDS[entry.class], entry)
      : [];
    if (stray.length > 0) {
      findings.push(
        error(
          `${where} carries ${stray.map((field) => JSON.stringify(field)).join(", ")}, which the ` +
            `sync never records on a ${entry.class} entry; ${REPAIR}`,
        ),
      );
      continue;
    }
    if (!isRecordedClass(entry.class)) {
      findings.push(
        error(
          `${where} has unknown class ${JSON.stringify(entry.class)} (expected one of ` +
            `${RECORDED_CLASSES.join(", ")}); ${REPAIR}`,
        ),
      );
      continue;
    }
    if (entry.class === "mirror" && "kind" in entry && entry.kind !== "symlink") {
      findings.push(
        error(
          `${where} carries kind ${JSON.stringify(entry.kind)} - the sync records only "symlink" ` +
            `as a mirror's kind; ${REPAIR}`,
        ),
      );
      continue;
    }
    // Readability first: every remedy below assumes a record the writer reads, and the writer refuses one it cannot.
    // A starter carries no hash, so null here means "nothing to verify" once the class verdict is in.
    let hash: string | null = null;
    let split: { begin: string; end: string } | null = null;
    if (entry.class !== "starter") {
      const stamped = "hash" in entry ? entry.hash : undefined;
      if (typeof stamped !== "string" || !/^[0-9a-f]{64}$/.test(stamped)) {
        findings.push(error(`${where}: hash must be a lowercase sha256 hex digest; ${REPAIR}`));
        continue;
      }
      hash = stamped;
      if (entry.class === "split") {
        // Every sync stamps the grammar field; the marker strings alone
        // cannot say which grammar the writer uses, so a split entry
        // without one is a hand edit. Checked BEFORE the marker-string shape
        // so the grammar diagnosis comes first, not a field-shape complaint.
        if (!("grammar" in entry)) {
          findings.push(
            error(
              `${where} lacks the split grammar field every sync stamps - a hand edit; ${REPAIR}`,
            ),
          );
          continue;
        }
        // A grammar outside GRAMMAR_IDS cannot be read by guess without verifying the wrong region.
        if (knownGrammar(entry.grammar) === null) {
          findings.push(
            error(
              `${where} declares split grammar ${JSON.stringify(entry.grammar)}, which this ` +
                `validator does not read (one grammar exists: managed-region); ${REPAIR}`,
            ),
          );
          continue;
        }
        if (typeof entry.begin !== "string" || typeof entry.end !== "string") {
          findings.push(
            error(`${where} is split but lacks its begin/end marker-line strings; ${REPAIR}`),
          );
          continue;
        }
        split = { begin: entry.begin, end: entry.end };
      }
    }
    // The class decides what parity verifies (a starter: nothing), so it is
    // judged before any dispatch, against the declaration the selection
    // makes live. A path no live declaration writes (a mirror target, a
    // deselected module's file) is dispatched as recorded.
    const declared = ctx.classes?.get(rel);
    if (declared !== undefined && declared !== entry.class) {
      findings.push(
        error(
          `${where} is recorded as ${entry.class} but files.yml declares the path ` +
            `${declared} - the class decides what parity verifies, and the ` +
            "sync records the declared one; revert a hand edit (git history has the stamped " +
            "original: the sync judges a file under a stale class record as an unrecorded file by the " +
            "declared class and restamps a successful outcome; only a write it must hold keeps the old record), merge the " +
            "pending sync PR when the platform changed the path's class " +
            "since the last sync (a row that PR holds keeps the old record until it is resolved), " +
            "or, when this registration's module change flips it (a mirror target a newly " +
            "selected entry writes, say), land the edit that retires the old record first " +
            "(docs/new-repo.md, PR edits modules)",
        ),
      );
      continue;
    }
    if (hash === null) continue;
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
    // The occupant's kind is judged before its hash. A directory is judged before the recorded kind: the mirror
    // writer treats it alike under both kinds. A mirror remedy never says to remove a reached occupant first (the
    // writer replaces a wrong-kind file or link itself, and removing a pattern's only match fails the run); it says
    // what the re-run does at every path a record can sit on, since the validator reads no mirror declaration.
    const linkRecorded =
      entry.class === "link" || (entry.class === "mirror" && entry.kind === "symlink");
    const removeThenResync = `or remove what stands at the path and ${RESYNC}`;
    const mirrorReached =
      `${RESYNC} and read its report: a target a declaration reaches is rewritten (unless it already carries the ` +
      "mirror) and restamped";
    const mirrorFails =
      "; a run the writer cannot finish (a declaration it cannot honour, a directory or a symbolic-link ancestor at " +
      "a path it must probe) fails by name instead";
    const mirrorResync = `${mirrorReached}; a record none reaches is dropped${mirrorFails}`;
    const mirrorDirectoryResync =
      `${mirrorReached}, except under a * in the pattern's last segment, which matches files and links alone and ` +
      `passes a directory by (the run fails when it is the pattern's only match); a record none reaches is dropped${mirrorFails}`;
    const resync = entry.class === "mirror" ? `or ${mirrorResync}` : removeThenResync;
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      findings.push(
        error(
          `${rel}: listed in ${MANIFEST_NAME} but is neither a regular file nor a symlink; ` +
            `restore the ${linkRecorded ? "link" : "file"} from git history, ` +
            (entry.class === "mirror" ? `or ${mirrorDirectoryResync}` : removeThenResync),
        ),
      );
      continue;
    }
    if (linkRecorded && !stat.isSymbolicLink()) {
      findings.push(
        error(
          `${rel}: recorded as ${entry.class === "link" ? "a link" : "a symlink mirror"} in ` +
            `${MANIFEST_NAME} but is not a symbolic link - the record (a link target's hash) can ` +
            `verify a link alone; restore the link from git history, ${resync}`,
        ),
      );
      continue;
    }
    if (!linkRecorded && stat.isSymbolicLink()) {
      findings.push(
        error(
          `${rel}: recorded as ${entry.class} in ${MANIFEST_NAME} but is a symbolic link - the ` +
            "record (a file's content hash) cannot verify a link, which the sync never reads through; " +
            `restore the file from git history, ${resync}`,
        ),
      );
      continue;
    }
    let actual: string;
    if (linkRecorded) {
      // Raw link bytes: decoding a malformed-UTF-8 target would fold distinct targets onto the replacement character.
      actual = sha256(readlinkSync(join(ctx.root, rel), { encoding: "buffer" }));
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
      const what =
        split !== null
          ? "its managed region"
          : stat.isSymbolicLink()
            ? "its link target"
            : "content";
      findings.push(
        error(
          `${rel}: ${what} does not match the sha256 recorded in ${MANIFEST_NAME} - the ` +
            `${stat.isSymbolicLink() ? "link" : "file"} drifted from the last sync; local edits to ` +
            `${split !== null ? "the managed region" : stat.isSymbolicLink() ? "the link" : "a managed file"} are ` +
            "replaced by the next sync (move them to a repo-owned " +
            "location), and platform-side updates restamp on that sync",
        ),
      );
    }
  }
  return findings;
}

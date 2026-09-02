#!/usr/bin/env bun
// Defense-in-depth tripwire on repository-owned content, run after the
// manifest stamp and before validation: for every split entry in the
// post-sync manifest, the repository-owned half of the working-tree copy
// must still contain every non-blank line the repository-owned half held
// at the target's HEAD. HEAD's copy is split with HEAD's OWN manifest
// markers (git show HEAD:.github/repo-platform-manifest.json), so a
// marker rename in the update cannot mis-split the previous copy. The
// manifest exists fleet-wide, so there is no pre-manifest splitting
// fallback: a HEAD without a usable manifest makes its split files
// UNVERIFIABLE, which trips the wire rather than passing silently.
//
// After preserve_local_content.ts's structural rebuild this should never
// fire - that is the point: a trip means the rebuild (or a step after it)
// dropped repository-owned bytes, i.e. a sync bug. A trip WARNS, never
// fails the job: a blocked delivery would hide the very diff the reviewer
// needs. The findings land in --report as a PR-body section; open_pr.ts
// appends it and forces the manual-review path.
//
// Scope: only paths split in BOTH manifests are compared. A path absent
// from HEAD has no previous half to lose; a path HEAD's manifest did not
// class as split claimed no repository-owned half there (ownership flips
// have their own review machinery). Each side is split by its OWN
// declaration, and BOTH sides must carry the grammar union (tail-marker
// or bounded-region; splitEntries fails closed on anything else): the
// fleet is fully post-grammar (censused 2026-09, every manifest's split
// entries stamped with the field), so the legacy fallback that re-read a
// bare marker/managed pair is retired. A HEAD manifest still presenting
// that shape is REFUSED loudly - every split file goes unverifiable
// (manual review) with the refusal's actionable message (run a recovery
// sync to restamp the manifest), never split by a guessed grammar. When
// the two sides claim the same grammar the check is half against half;
// when a template flips a file's grammar, the two declarations draw
// different repository-owned boundaries, so the file is UNVERIFIABLE
// (manual review) - never checked against a whole-file universe, which
// was blind to a line duplicated across the local body and the managed
// scaffolding. The line
// check is multiset membership, not a positional diff: moved lines are not
// lost content. All file content is read as latin1 (one code unit per
// byte, the stamp_manifest.ts convention) - a utf-8 decode would fold
// non-UTF-8 bytes onto U+FFFD and could hide or invent a mismatch; the
// manifests themselves are JSON and decode as utf-8 so their path keys
// compare correctly.
//
// Usage:
//   bun tail_tripwire.ts [--report FILE] [--root target]
//     [--hide-details true|false]
//
// --report defaults to RUNNER_TEMP/<TAIL_SHRANK_NAME> - the shared
// constant open_pr.ts reads the section from, so the workflow never names
// the file and the pair cannot drift.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { grammarSpec } from "../../../actions/shared/grammar.ts";
import { MANIFEST_NAME } from "../../../actions/shared/manifest.ts";
import { managedHalf } from "../../../actions/shared/stamp_manifest.ts";
import { cleanLocalRegion } from "../../../scripts/gitignore_local.ts";
import { parseFlags } from "../shared/flags.ts";
import { requireEnv } from "../shared/gha.ts";
import { headEntry } from "../shared/git_head.ts";
import { hasDuplicateJsonKeys } from "../shared/json.ts";
import {
  clip,
  fenceFor,
  missingLines,
  type SplitEntry,
  splitEntries,
} from "./preserve_local_content.ts";
import { TAIL_SHRANK_NAME } from "./section_files.ts";

// One definition each for the whole pipeline: preserve_local_content.ts
// owns the missing-line multiset and the PR-body excerpt hygiene (clip's
// control-byte escaping, fenceFor's unclosable fence); this wire
// re-exports them for its own consumers.
export { clip, fenceFor, missingLines };

/** The complement of stamp_manifest's managedHalf: managedHalf returns a
 * prefix ("above") or a suffix ("below"), so the repository-owned side of
 * a marker-line split is the exact byte remainder. Null when the marker
 * line is missing - there is no honest split to check. */
function markerComplement(
  content: string,
  marker: string,
  managed: "above" | "below",
): string | null {
  const half = managedHalf(content, marker, managed);
  if (half === null) return null;
  return managed === "above"
    ? content.slice(half.length)
    : content.slice(0, content.length - half.length);
}

/** The side of a split file the repository owns, by the entry's declared
 * grammar: the byte complement of the GRAMMAR row's managed side at the
 * marker line (tail-marker), or the local region body between the entry's
 * begin/end lines (bounded-region, located with cleanLocalRegion's strict
 * exactly-once rules - a copy whose region cannot be honestly located is
 * unverifiable, never guessed at). Exhaustive over GrammarId (SplitEntry
 * derives from the GRAMMAR table): a new grammar member must fail
 * compilation here, not silently ride an existing locator. Exported for
 * preserve_repo_owned.ts's removed-split-file hold, which names the
 * repository-owned content a deletion takes with it. */
export function repoOwnedHalf(content: string, entry: SplitEntry): string | null {
  switch (entry.grammar) {
    case "tail-marker":
      return markerComplement(content, entry.marker, grammarSpec(entry.grammar).side);
    case "bounded-region":
      return cleanLocalRegion(content, entry)?.body ?? null;
    default: {
      // Unreachable by construction (see the header note above); the
      // throw only backstops data smuggled past the type system.
      const unhandled: never = entry;
      throw new Error(`unhandled split grammar: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Every class any manifest vintage has stamped: the current three plus
 * the retired mergeable era (settings_layering.ts and the validator carry
 * the same roster). An entry spelling anything else ("spllt") is damage
 * that could be hiding a split declaration, so the whole manifest is
 * rejected to the callers' fail-closed path. */
const KNOWN_HEAD_CLASSES = new Set(["managed", "split", "starter", "mergeable"]);

/** How HEAD's manifest declares a split: the same strict grammar parse as
 * the post-sync manifest (splitEntries), behind two HEAD-manifest-only
 * checks the strict parse does not make. Every entry's ownership class
 * must be on the known roster - reading a damaged class ("spllt") as
 * merely non-split would drop that file from the candidates and let a
 * retirement delete its repo-owned half. And every split entry must carry
 * the grammar field: the fleet is fully post-grammar (censused 2026-09),
 * the legacy fallback that re-read a bare marker/managed pair is retired,
 * and a manifest still presenting that shape gets this loud, actionable
 * refusal instead - the callers route the throw to their fail-closed
 * paths (unverifiable findings here, the held-for-review deletion axis in
 * preserve_repo_owned.ts), never to a guessed split. */
export function headSplitEntries(text: string, where: string): Map<string, SplitEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Value-free: a SyntaxError's message quotes manifest text (target
    // content) and this error can reach warning paths.
    throw new Error(`${where} does not parse as JSON`);
  }
  if (hasDuplicateJsonKeys(text)) {
    throw new Error(
      `${where} declares the same key twice in one object - JSON.parse keeps only the ` +
        "last duplicate, so a duplicate entry could flip a path's ownership class silently",
    );
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  // An array passes `typeof === "object"` with zero-or-index entries -
  // that would fail OPEN (no split declarations, nothing checked); reject
  // any non-mapping shape like the strict parse does.
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new Error(`${where} has no top-level 'files' mapping`);
  }
  for (const [path, entry] of Object.entries(files as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      // Fail closed like the strict parse: a damaged entry must route the
      // manifest to the unverifiable path, not silently skip its file.
      throw new Error(`${where}: entry for ${path} is not an object`);
    }
    const shaped = entry as Record<string, unknown>;
    // Every entry's class is validated, not just the split ones: reading a
    // damaged class ("spllt") as merely non-split would drop that file
    // from the candidates and let a retirement delete its repo-owned half.
    if (typeof shaped.class !== "string" || !KNOWN_HEAD_CLASSES.has(shaped.class)) {
      throw new Error(
        `${where}: entry for ${path} declares no ownership class this sync knows - the ` +
          "damage could be hiding a split declaration",
      );
    }
    if (shaped.class === "split" && !("grammar" in shaped)) {
      // The path rides LAST: callers clip this message into PR-body
      // excerpts, and a long target-controlled path must truncate itself,
      // never the diagnosis or the recovery advice.
      throw new Error(
        `${where}: a split entry declares no grammar - this manifest predates the ` +
          "stamped split grammar, which this sync no longer reads; run a recovery " +
          `sync (recover=recopy) against this repository to restamp its manifest. The entry is ${path}`,
      );
    }
  }
  return new Map(splitEntries(text, where).map((entry) => [entry.path, entry]));
}

export type Finding =
  | { path: string; kind: "shrank"; missing: string[] }
  | { path: string; kind: "unverifiable"; reason: string };

/** One path's verdict, each side split by its own declared grammar: null
 * means every non-blank line of HEAD's repository-owned half survives in
 * the delivered repository-owned half. When the two sides claim DIFFERENT
 * grammars the file is unverifiable (manual review), never compared
 * across boundaries or against a whole-file universe - see below. */
export function compareHalves(
  entry: SplitEntry,
  head: SplitEntry,
  headCopy: string,
  delivered: string,
): Finding | null {
  const path = entry.path;
  const previousHalf = repoOwnedHalf(headCopy, head);
  if (previousHalf === null) {
    return {
      path,
      kind: "unverifiable",
      reason:
        "the previous commit's copy does not split at its own manifest's declared " +
        "marker lines, so its repository-owned half cannot be located",
    };
  }
  const deliveredHalf = repoOwnedHalf(delivered, entry);
  if (deliveredHalf === null) {
    return {
      path,
      kind: "unverifiable",
      reason:
        "the delivered copy does not split at the post-sync manifest's declared " +
        "marker lines, so its repository-owned half cannot be located",
    };
  }
  if (head.grammar === entry.grammar) {
    const missing = missingLines(previousHalf, deliveredHalf);
    return missing.length === 0 ? null : { path, kind: "shrank", missing };
  }
  // Grammar change (a template flipped this file's split shape between the
  // two refs): the two declarations draw different repository-owned
  // boundaries, so no half-against-half comparison is honest - and a
  // whole-file survival check is blind to a line duplicated across the
  // local body and the managed scaffolding. Unverifiable, full stop: a
  // grammar flip is a rare template event, and one round of manual review
  // fleet-wide is the honest price on a warn-only wire. (The re-split
  // narrowing that once served the legacy managed-below transition left
  // with the legacy fallback: it could falsely clear a flip whose
  // HEAD-declared half lost lines.)
  return {
    path,
    kind: "unverifiable",
    reason:
      "the previous commit's manifest claims a different split grammar than the " +
      "post-sync manifest, so the two repository-owned halves are not comparable",
  };
}

// PR bodies cap at 64 KiB and gh fails outright past it (see open_pr.ts),
// and the report shares the body with every other section - so the
// excerpt is bounded three ways: lines per file, characters per line (one
// minified line must not blow the body; clip in preserve_local_content.ts
// owns the per-line bound and the control-byte escaping), and total bytes
// across the whole report. The previous commit holds whatever the excerpt
// omits.
const MAX_REPORT_LINES = 40;
const MAX_REPORT_BYTES = 16384;

const REPORT_INTRO = [
  "> [!WARNING]",
  "> TAIL TRIPWIRE: this update could not prove every split file's",
  "> repository-owned half intact. The structural split-file rebuild is",
  "> supposed to make that impossible, so treat a listing below as a sync",
  "> bug (report it on Vivswan/repo-platform) AND restore the listed",
  "> content on this branch before merging. Auto-merge is off.",
  "",
];

/** The shrank-section heading fragment. Exported for rehearse_fleet's
 * row wording: a report containing it carries at least one CONFIRMED
 * line loss; a report without it is unverifiable-only (integrity
 * unproven, nothing proven lost). One constant, so the classifier can
 * never drift from the heading renderReport writes. */
export const SHRANK_PHRASE =
  "non-blank line(s) of the repository-owned half at the previous commit are missing from this update's copy";

export function renderReport(findings: Finding[]): string {
  if (findings.length === 0) return "";
  let budget = MAX_REPORT_BYTES;
  const sections = findings.map((finding) => {
    if (finding.kind === "unverifiable") {
      return `- \`${finding.path}\`: ${clip(finding.reason)} - review this file's full diff against the previous commit before merging.`;
    }
    const shown: string[] = [];
    for (const line of finding.missing) {
      if (shown.length >= MAX_REPORT_LINES) break;
      const clipped = clip(line);
      const cost = Buffer.byteLength(clipped, "utf-8") + 3;
      if (cost > budget) break;
      budget -= cost;
      shown.push(clipped);
    }
    const heading = `- \`${finding.path}\`: ${finding.missing.length} ${SHRANK_PHRASE}`;
    if (shown.length === 0) {
      return `${heading} (excerpt omitted: report size limit; compare against the previous commit's copy).`;
    }
    const omitted = finding.missing.length - shown.length;
    const tail = omitted > 0 ? `\n  (${omitted} more; see the previous commit's copy)` : "";
    const fence = fenceFor(shown);
    return (
      `${heading}:\n\n` +
      `  ${fence}text\n${shown.map((line) => `  ${line}`).join("\n")}\n  ${fence}${tail}`
    );
  });
  return [...REPORT_INTRO, ...sections, ""].join("\n");
}

function main(argv: string[]): number {
  const flags = parseFlags(argv, [] as const, ["--report", "--root", "--hide-details"] as const);
  const report = flags["--report"] ?? join(requireEnv("RUNNER_TEMP"), TAIL_SHRANK_NAME);
  const root = flags["--root"] ?? "target";
  const hideDetails = flags["--hide-details"] === "true";

  const manifestPath = join(root, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    // Our own pipeline just stamped this file; its absence is a broken
    // input, and broken inputs go red (unlike a trip, which warns).
    throw new Error(
      `${manifestPath} is missing; the tripwire runs after the stamp, on a tree that must carry the ownership manifest`,
    );
  }
  const entries = splitEntries(readFileSync(manifestPath, "utf-8"), manifestPath);

  // HEAD's manifest, for splitting HEAD's copies with HEAD's own
  // declarations. A missing or unusable one - a pre-grammar manifest's
  // loud refusal included - is a target-state anomaly, not this run's:
  // every previously-present split file becomes unverifiable (manual
  // review) instead of failing the job - going red here would block the
  // very sync that could deliver the fix. The refusal's message rides
  // into the finding's reason so the PR body names the fix (it can carry
  // target paths, which is where such detail belongs - see
  // docs/private-repos.md). A non-blob at the manifest path (a symlinked
  // manifest, say) is as unusable as a damaged one: `git show` would
  // answer with the link target or a tree listing, not manifest text, so
  // only a blob is ever parsed.
  const headManifest = headEntry(root, MANIFEST_NAME);
  let headEntries: Map<string, SplitEntry> | null = null;
  let headManifestDetail = "";
  if (headManifest.kind === "blob") {
    try {
      headEntries = headSplitEntries(headManifest.bytes.toString("utf-8"), `HEAD:${MANIFEST_NAME}`);
    } catch (err) {
      headEntries = null;
      headManifestDetail = ` (${clip(err instanceof Error ? err.message : String(err))})`;
    }
  }

  const findings: Finding[] = [];
  // The loop iterates the POST-SYNC manifest's splits, so the mirror
  // boundary is deliberate: a path split at HEAD but absent from the
  // freshly stamped post-sync manifest is never visited - the template
  // retired it (or flipped its class), and retirements ride their own
  // review machinery, not this wire.
  for (const entry of entries) {
    const headCopy = headEntry(root, entry.path);
    // Absent at HEAD: no previous repository-owned half to lose.
    if (headCopy.kind === "absent") continue;
    if (headEntries === null) {
      findings.push({
        path: entry.path,
        kind: "unverifiable",
        reason:
          "the previous commit has no usable ownership manifest" +
          `${headManifestDetail}, so its repository-owned half cannot be located`,
      });
      continue;
    }
    // Not split at HEAD per its own manifest: HEAD claimed no
    // repository-owned half for this path, so there is nothing whose loss
    // this wire guards (an ownership flip has its own review machinery).
    const headDecl = headEntries.get(entry.path);
    if (headDecl === undefined) continue;
    // A non-blob at HEAD has no file content: there is no previous copy to
    // split, and `git show`'s answer (a tree listing, a symlink's target)
    // must never stand in for one - unverifiable, like every other shape
    // whose repository-owned half cannot be honestly located.
    if (headCopy.kind === "non-blob") {
      findings.push({
        path: entry.path,
        kind: "unverifiable",
        reason:
          `the previous commit carries a ${headCopy.object} at this path, not a regular ` +
          "file, so it has no repository-owned half to locate",
      });
      continue;
    }
    const deliveredPath = join(root, entry.path);
    if (!existsSync(deliveredPath)) {
      findings.push({
        path: entry.path,
        kind: "unverifiable",
        reason: "the post-sync manifest declares it split but the working tree has no such file",
      });
      continue;
    }
    const finding = compareHalves(
      entry,
      headDecl,
      headCopy.bytes.toString("latin1"),
      readFileSync(deliveredPath).toString("latin1"),
    );
    if (finding !== null) findings.push(finding);
  }

  // utf-8 write of latin1 code units: every previous byte survives as a
  // code point (lossless, unlike U+FFFD folding), and the report stays
  // valid utf-8 for gh's PR-body argument.
  writeFileSync(report, renderReport(findings), "utf-8");

  if (findings.length === 0) {
    console.log(
      "tail tripwire clear: every split file's repository-owned half holds every non-blank line it had at HEAD",
    );
    return 0;
  }
  // Paths and content are target file data: a hide-details target gets a
  // count here and the detail only in the PR body, which lives in the
  // private repo.
  if (!hideDetails) {
    for (const finding of findings) {
      console.log(
        finding.kind === "shrank"
          ? `${finding.path}: ${finding.missing.length} repository-owned line(s) missing from the delivered copy`
          : `${finding.path}: repository-owned half unverifiable (${finding.reason})`,
      );
    }
  }
  console.log(
    `::warning::tail tripwire: ${findings.length} split file(s) could not be proven to keep ` +
      "their repository-owned half intact - this should be impossible after the structural " +
      "rebuild, so treat it as a sync bug. The PR stays manual-review" +
      (hideDetails
        ? " (paths hidden: private repository; details in the PR body)."
        : " (details above and in the PR body)."),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

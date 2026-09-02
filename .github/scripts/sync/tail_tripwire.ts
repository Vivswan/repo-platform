#!/usr/bin/env bun
// Defense-in-depth tripwire on repository-owned content, run after the
// manifest stamp and before validation: for every split entry in the
// post-sync manifest, the repository-owned content of the working-tree
// copy (outside the BEGIN/END managed region) must still contain every
// non-blank line the repository-owned content held at the target's HEAD.
// HEAD's copy is split with HEAD's OWN manifest declaration (git show
// HEAD:.github/repo-platform-manifest.json), so a marker rename in the
// update cannot mis-split the previous copy - and during the one-grammar
// transition HEAD may still declare a RETIRED shape (tail-marker, the old
// four-marker bounded-region): head_manifest.ts reads those vintages and
// locates their repo-owned sides, so the DESIGNED conversion (a tail
// re-seated below the new END marker, the old LOCAL area re-seated above
// BEGIN) VERIFIES here instead of alarming - each side is split by its own
// declaration and the line check is side-agnostic (the multiset spans
// above and below), so a byte-preserving move between sides is not a loss.
// The conversion's one deliberate SUBTRACTION - the platform-authored
// relic lines the retired shapes left on the repository's side
// (head_manifest.ts's closed CONVERSION_RELIC_LINES) - is subtracted from
// the expected multiset explicitly, on retired vintages only: the designed
// strip stays verifiable rather than reading as lost repo-owned lines, and
// any OTHER missing line still fires.
// The manifest exists fleet-wide, so there is no pre-manifest splitting
// fallback, and a HEAD manifest declaring a grammar this sync does not
// read (neither current nor a retired vintage the transition converts) is
// REFUSED loudly by headSplitEntries - every split file goes unverifiable
// (manual review) with the refusal's actionable message, never split by a
// guessed grammar.
//
// After preserve_local_content.ts's structural rebuild this should never
// fire - that is the point: a trip means the rebuild (or a step after it)
// dropped repository-owned bytes, i.e. a sync bug. A trip WARNS, never
// fails the job: a blocked delivery would hide the very diff the reviewer
// needs. The findings land in --report as a PR-body section; open_pr.ts
// appends it and forces the manual-review path.
//
// Scope: only paths split in BOTH manifests are compared. A path absent
// from HEAD has no previous content to lose; a path HEAD's manifest did
// not class as split claimed no repository-owned content there (ownership
// flips have their own review machinery). The line check is multiset
// membership, not a positional diff: moved lines are not lost content.
// All file content is read as latin1 (one code unit per byte, the
// stamp_manifest.ts convention) - a utf-8 decode would fold non-UTF-8
// bytes onto U+FFFD and could hide or invent a mismatch; the manifests
// themselves are JSON and decode as utf-8 so their path keys compare
// correctly.
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
import { MANIFEST_NAME } from "../../../actions/shared/manifest.ts";
import { parseFlags } from "../shared/flags.ts";
import { requireEnv } from "../shared/gha.ts";
import { headEntry } from "../shared/git_head.ts";
import {
  carriedRepoOwnedText,
  type HeadSplit,
  headSplitEntries,
  repoOwnedText,
} from "./head_manifest.ts";
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
// control-byte escaping, fenceFor's unclosable fence), head_manifest.ts
// owns the HEAD-manifest vintages and the repo-owned locator; this wire
// re-exports the shared pieces for its own consumers.
export { clip, fenceFor, headSplitEntries, missingLines, repoOwnedText };

export type Finding =
  | { path: string; kind: "shrank"; missing: string[] }
  | { path: string; kind: "unverifiable"; reason: string };

/** One path's verdict, each side split by its own declaration: null means
 * every non-blank line of HEAD's repository-owned content survives in the
 * delivered copy's repository-owned content. The comparison spans both
 * sides of the managed region as one multiset, so the designed transition
 * (a tail moving below the new END marker) verifies; a copy whose
 * repository-owned content cannot be honestly located on either side is
 * unverifiable (manual review), never guessed at. */
export function compareHalves(
  entry: SplitEntry,
  head: HeadSplit,
  headCopy: string,
  delivered: string,
): Finding | null {
  const path = entry.path;
  // carriedRepoOwnedText, not repoOwnedText: head_manifest.ts is the
  // single owner of what a declaration's repo-owned side BECOMES under
  // the carry, so the conversion's DESIGNED relic strip (its closed
  // CONVERSION_RELIC_LINES, on retired vintages only) is subtracted from
  // the expected multiset here by the same code that subtracted it in the
  // rebuild - the strip stays verifiable instead of reading as lost
  // repo-owned lines, every OTHER previous line stays guarded, and the
  // two sites cannot drift on what "designed" means.
  const previousOwned = carriedRepoOwnedText(headCopy, head);
  if (previousOwned === null) {
    return {
      path,
      kind: "unverifiable",
      reason:
        "the previous commit's copy does not split at its own manifest's declared " +
        "marker lines, so its repository-owned content cannot be located",
    };
  }
  const deliveredOwned = repoOwnedText(delivered, {
    vintage: "managed-region",
    path,
    begin: entry.begin,
    end: entry.end,
  });
  if (deliveredOwned === null) {
    return {
      path,
      kind: "unverifiable",
      reason:
        "the delivered copy does not split at the post-sync manifest's declared " +
        "marker lines, so its repository-owned content cannot be located",
    };
  }
  // The conversion's DESIGNED relic strip is already subtracted above (by
  // carriedRepoOwnedText, the shared owner); everything left in the
  // expected text is content this sync promised to keep.
  const missing = missingLines(previousOwned, deliveredOwned);
  return missing.length === 0 ? null : { path, kind: "shrank", missing };
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
  "> repository-owned content intact. The structural split-file rebuild is",
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
  "non-blank line(s) of the repository-owned content at the previous commit are missing from this update's copy";

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
  // declarations. A missing or unusable one - a pre-grammar or
  // unknown-grammar manifest's loud refusal included - is a target-state
  // anomaly, not this run's: every previously-present split file becomes
  // unverifiable (manual review) instead of failing the job - going red
  // here would block the very sync that could deliver the fix. The
  // refusal's message rides into the finding's reason so the PR body
  // names the fix (it can carry target paths, which is where such detail
  // belongs - see docs/private-repos.md). A non-blob at the manifest path
  // (a symlinked manifest, say) is as unusable as a damaged one: `git
  // show` would answer with the link target or a tree listing, not
  // manifest text, so only a blob is ever parsed.
  const headManifest = headEntry(root, MANIFEST_NAME);
  let headEntries: Map<string, HeadSplit> | null = null;
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
    // Absent at HEAD: no previous repository-owned content to lose.
    if (headCopy.kind === "absent") continue;
    if (headEntries === null) {
      findings.push({
        path: entry.path,
        kind: "unverifiable",
        reason:
          "the previous commit has no usable ownership manifest" +
          `${headManifestDetail}, so its repository-owned content cannot be located`,
      });
      continue;
    }
    // Not split at HEAD per its own manifest: HEAD claimed no
    // repository-owned content for this path, so there is nothing whose
    // loss this wire guards (an ownership flip has its own review
    // machinery).
    const headDecl = headEntries.get(entry.path);
    if (headDecl === undefined) continue;
    // A non-blob at HEAD has no file content: there is no previous copy to
    // split, and `git show`'s answer (a tree listing, a symlink's target)
    // must never stand in for one - unverifiable, like every other shape
    // whose repository-owned content cannot be honestly located.
    if (headCopy.kind === "non-blob") {
      findings.push({
        path: entry.path,
        kind: "unverifiable",
        reason:
          `the previous commit carries a ${headCopy.object} at this path, not a regular ` +
          "file, so it has no repository-owned content to locate",
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
      "tail tripwire clear: every split file's repository-owned content holds every non-blank line it had at HEAD",
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
          : `${finding.path}: repository-owned content unverifiable (${finding.reason})`,
      );
    }
  }
  console.log(
    `::warning::tail tripwire: ${findings.length} split file(s) could not be proven to keep ` +
      "their repository-owned content intact - this should be impossible after the structural " +
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

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
// declaration: the post-sync manifest always carries the grammar union
// (tail-marker or bounded-region; splitEntries fails closed on anything
// else), while a HEAD manifest stamped by a pre-grammar template declares
// only a marker/managed pair and is split by exactly that claim - never
// by a guessed grammar. When the two sides claim the same shape the check
// is half against half; when they differ (a legacy managed-below claim
// covers region scaffolding the bounded-region body excludes), HEAD's
// copy is re-split under the post-sync grammar when one exactly-once
// clean region exists there - otherwise the file is UNVERIFIABLE (manual
// review), never checked against a whole-file universe, which was blind
// to a line duplicated across the local body and the managed scaffolding.
// The line
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
import { cleanLocalRegion } from "../../../scripts/gitignore_local.ts";
import { parseFlags } from "../shared/flags.ts";
import { requireEnv } from "../shared/gha.ts";
import { headBytes } from "../shared/git_head.ts";
import { ASCII_MARKER_RE, type SplitEntry, splitEntries } from "./preserve_local_content.ts";
import { TAIL_SHRANK_NAME } from "./section_files.ts";
import { MANIFEST_NAME, managedHalf } from "./stamp_manifest.ts";

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
 * grammar: everything below the marker line (tail-marker), or the local
 * region body between the entry's begin/end lines (bounded-region, located
 * with cleanLocalRegion's strict exactly-once rules - a copy whose region
 * cannot be honestly located is unverifiable, never guessed at).
 * Exhaustive: a new grammar member must fail compilation here, not
 * silently ride an existing locator. */
export function repoOwnedHalf(content: string, entry: SplitEntry): string | null {
  switch (entry.grammar) {
    case "tail-marker":
      return markerComplement(content, entry.marker, "above");
    case "bounded-region":
      return cleanLocalRegion(content, entry)?.body ?? null;
    default: {
      const unhandled: never = entry;
      throw new Error(`unhandled split grammar: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** How HEAD's manifest declares a split: the grammar union (post-grammar
 * templates) or the bare marker/managed pair (manifests stamped before the
 * grammar field existed). */
export type HeadSplit =
  | { kind: "grammar"; entry: SplitEntry }
  | { kind: "legacy"; path: string; marker: string; managed: "above" | "below" };

/** HEAD's split declarations, keyed by path. The strict grammar parse is
 * tried first; a manifest that predates the grammar field falls back to
 * its own marker/managed pairs. The fallback exists ONLY for pre-grammar
 * manifests: a split entry that carries any grammar field (unknown value
 * included) is not legacy, and guessing would mis-split - it throws, and
 * the caller routes the whole manifest to the unverifiable path. */
export function headSplitEntries(text: string, where: string): Map<string, HeadSplit> {
  try {
    return new Map(
      splitEntries(text, where).map((entry) => [entry.path, { kind: "grammar", entry }]),
    );
  } catch {
    // Fall through to the legacy shape below.
  }
  const files = (JSON.parse(text) as { files?: unknown } | null)?.files;
  // An array passes `typeof === "object"` with zero-or-index entries -
  // that would fail OPEN (no split declarations, nothing checked); reject
  // any non-mapping shape like the strict parse does.
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new Error(`${where} has no top-level 'files' mapping`);
  }
  const out = new Map<string, HeadSplit>();
  for (const [path, entry] of Object.entries(files as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      // Fail closed like the strict parse: a damaged entry must route the
      // manifest to the unverifiable path, not silently skip its file.
      throw new Error(`${where}: entry for ${path} is not an object`);
    }
    const shaped = entry as Record<string, unknown>;
    if (shaped.class !== "split") continue;
    if ("grammar" in shaped) {
      throw new Error(
        `${where}: split entry for ${path} carries a grammar field the strict parse rejected - not a pre-grammar manifest, refusing to guess`,
      );
    }
    if (
      typeof shaped.marker !== "string" ||
      // splitEntries' own constraint: an EMPTY marker would match the
      // synthetic empty line at EOF (managedHalf compares line.trim()),
      // read the previous repo-owned half as empty, and report CLEAR
      // while every local line vanished. Damaged legacy markers fail
      // closed to the unverifiable path like every other damaged entry.
      !ASCII_MARKER_RE.test(shaped.marker) ||
      (shaped.managed !== "above" && shaped.managed !== "below")
    ) {
      throw new Error(`${where}: split entry for ${path} lacks a valid marker/managed pair`);
    }
    out.set(path, { kind: "legacy", path, marker: shaped.marker, managed: shaped.managed });
  }
  return out;
}

/** HEAD's repository-owned side, per HEAD's own declaration. */
function headRepoOwnedHalf(content: string, head: HeadSplit): string | null {
  return head.kind === "grammar"
    ? repoOwnedHalf(content, head.entry)
    : markerComplement(content, head.marker, head.managed);
}

/** Whether HEAD's declaration and the post-sync entry claim the same
 * repository-owned shape, making half-against-half comparison honest. A
 * legacy "above" pair and the tail-marker grammar draw the same boundary;
 * a legacy "below" pair claims region scaffolding (marker lines, text
 * outside the region) that the bounded-region body excludes. */
function sameShape(head: HeadSplit, entry: SplitEntry): boolean {
  if (head.kind === "grammar") return head.entry.grammar === entry.grammar;
  return head.managed === "above" && entry.grammar === "tail-marker";
}

/** Previous non-blank lines the delivered text no longer holds, counted
 * as a MULTISET: each previous occurrence consumes one delivered
 * occurrence, so a line held twice and delivered once is one missing line
 * - a plain Set would lose occurrence counts and pass exactly the shrink
 * this wire exists to catch. */
export function missingLines(previous: string, delivered: string): string[] {
  const kept = new Map<string, number>();
  for (const line of delivered.split("\n")) {
    kept.set(line, (kept.get(line) ?? 0) + 1);
  }
  return previous.split("\n").filter((line) => {
    if (line.trim() === "") return false;
    const remaining = kept.get(line) ?? 0;
    if (remaining === 0) return true;
    kept.set(line, remaining - 1);
    return false;
  });
}

export type Finding =
  | { path: string; kind: "shrank"; missing: string[] }
  | { path: string; kind: "unverifiable"; reason: string };

/** One path's verdict, each side split by its own declaration: null means
 * every non-blank line of HEAD's repository-owned half survives in the
 * delivered repository-owned half. When the two sides claim DIFFERENT
 * shapes, the previous copy is re-split under the post-sync grammar when
 * that is honestly possible; otherwise the file is unverifiable (manual
 * review), never compared against a whole-file universe - see below. */
export function compareHalves(
  entry: SplitEntry,
  head: HeadSplit,
  headCopy: string,
  delivered: string,
): Finding | null {
  const path = entry.path;
  const previousHalf = headRepoOwnedHalf(headCopy, head);
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
  if (sameShape(head, entry)) {
    const missing = missingLines(previousHalf, deliveredHalf);
    return missing.length === 0 ? null : { path, kind: "shrank", missing };
  }
  // Shape mismatch (a legacy managed-below claim vs the bounded-region
  // body, or a grammar change). The old whole-file fallback was BLIND to
  // a colliding duplicate: a line living in both the local body and the
  // managed scaffolding read as "present anywhere in the file" while its
  // local copy vanished. Narrow honestly instead: when the post-sync
  // grammar is bounded-region and HEAD's copy carries one
  // exactly-once-clean region under the SAME markers, that body is the
  // honest previous half; anything else is unverifiable (manual review).
  // A genuine marker rename now reads unverifiable rather than silently
  // passing - acceptable for a warn-only wire.
  if (entry.grammar === "bounded-region") {
    const headRegion = cleanLocalRegion(headCopy, entry);
    if (headRegion !== null) {
      const missing = missingLines(headRegion.body, deliveredHalf);
      return missing.length === 0 ? null : { path, kind: "shrank", missing };
    }
  }
  return {
    path,
    kind: "unverifiable",
    reason:
      "the previous commit's manifest claims a different split shape than the " +
      "post-sync manifest, and the previous copy cannot be honestly re-split " +
      "under the new grammar",
  };
}

// PR bodies cap at 64 KiB and gh fails outright past it (see open_pr.ts),
// and the report shares the body with every other section - so the
// excerpt is bounded three ways: lines per file, characters per line (one
// minified line must not blow the body), and total bytes across the whole
// report. The previous commit holds whatever the excerpt omits.
const MAX_REPORT_LINES = 40;
const MAX_LINE_CHARS = 300;
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

/** One display line, bounded and control-free: a missing line or an
 * unverifiable reason can embed target-controlled text (repository
 * content, HEAD-manifest marker strings), so one enormous value must not
 * blow the body cap - and C0 control bytes must not survive into the
 * report: a NUL riding latin1 all the way to open_pr's --body argv kills
 * the spawn (OS argv cannot carry NUL), turning this warn-only wire into
 * the thing that BLOCKS PR creation. Escaped as visible \\xNN (lossless);
 * tab stays literal. */
function clip(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control bytes to escape them is this regex's whole job
  const printable = text.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, (control) => {
    return `\\x${control.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
  return printable.length > MAX_LINE_CHARS
    ? `${printable.slice(0, MAX_LINE_CHARS)} [clipped]`
    : printable;
}

/** A fence long enough that no shown line can close it early. */
function fenceFor(lines: string[]): string {
  let longest = 3;
  for (const line of lines) {
    for (const match of line.matchAll(/`+/g)) {
      longest = Math.max(longest, match[0].length);
    }
  }
  return "`".repeat(longest + 1);
}

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
  // declarations. A missing or unusable one is a target-state anomaly,
  // not this run's: every previously-present split file becomes
  // unverifiable (manual review) instead of failing the job - going red
  // here would block the very sync that could deliver the fix.
  const headManifestBytes = headBytes(root, MANIFEST_NAME);
  let headEntries: Map<string, HeadSplit> | null = null;
  if (headManifestBytes !== null) {
    try {
      headEntries = headSplitEntries(headManifestBytes.toString("utf-8"), `HEAD:${MANIFEST_NAME}`);
    } catch {
      headEntries = null;
    }
  }

  const findings: Finding[] = [];
  // The loop iterates the POST-SYNC manifest's splits, so the mirror
  // boundary is deliberate: a path split at HEAD but absent from the
  // freshly stamped post-sync manifest is never visited - the template
  // retired it (or flipped its class), and retirements ride their own
  // review machinery, not this wire.
  for (const entry of entries) {
    const headCopy = headBytes(root, entry.path);
    // Absent at HEAD: no previous repository-owned half to lose.
    if (headCopy === null) continue;
    if (headEntries === null) {
      findings.push({
        path: entry.path,
        kind: "unverifiable",
        reason:
          "the previous commit has no usable ownership manifest, so its repository-owned half cannot be located",
      });
      continue;
    }
    // Not split at HEAD per its own manifest: HEAD claimed no
    // repository-owned half for this path, so there is nothing whose loss
    // this wire guards (an ownership flip has its own review machinery).
    const headEntry = headEntries.get(entry.path);
    if (headEntry === undefined) continue;
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
      headEntry,
      headCopy.toString("latin1"),
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

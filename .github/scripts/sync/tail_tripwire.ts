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
// lines are checked for survival anywhere in the delivered file - loss
// still fires, relocation across a grammar change does not. The line
// check is set membership, not a positional diff: moved lines are not
// lost content. All file content is read as latin1 (one code unit per
// byte, the stamp_manifest.ts convention) - a utf-8 decode would fold
// non-UTF-8 bytes onto U+FFFD and could hide or invent a mismatch; the
// manifests themselves are JSON and decode as utf-8 so their path keys
// compare correctly.
//
// Usage:
//   bun tail_tripwire.ts --report FILE [--root target]
//     [--hide-details true|false]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanLocalRegion } from "../../../scripts/gitignore_local.ts";
import { parseFlags } from "../shared/flags.ts";
import { type SplitEntry, splitEntries } from "./preserve_local_content.ts";
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
 * cannot be honestly located is unverifiable, never guessed at). */
export function repoOwnedHalf(content: string, entry: SplitEntry): string | null {
  if (entry.grammar === "tail-marker") {
    return markerComplement(content, entry.marker, "above");
  }
  return cleanLocalRegion(content, entry)?.body ?? null;
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
  if (typeof files !== "object" || files === null) {
    throw new Error(`${where} has no top-level 'files' mapping`);
  }
  const out = new Map<string, HeadSplit>();
  for (const [path, entry] of Object.entries(files as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) {
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

/** Non-blank lines of `previous` absent from `delivered`, byte-exact.
 * Membership, not a diff: a moved or deduplicated line is still present,
 * and only genuinely vanished content should trip the wire. Blank lines
 * (whitespace-only) never count as lost. */
export function missingLines(previous: string, delivered: string): string[] {
  const kept = new Set(delivered.split("\n"));
  return previous.split("\n").filter((line) => line.trim() !== "" && !kept.has(line));
}

export type Finding =
  | { path: string; kind: "shrank"; missing: string[] }
  | { path: string; kind: "unverifiable"; reason: string };

/** One path's verdict, each side split by its own declaration: null means
 * every non-blank line of HEAD's repository-owned half survives - in the
 * delivered repository-owned half when both sides claim the same shape,
 * anywhere in the delivered file when they do not. */
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
  const universe = sameShape(head, entry) ? deliveredHalf : delivered;
  const missing = missingLines(previousHalf, universe);
  return missing.length === 0 ? null : { path, kind: "shrank", missing };
}

/** The file's bytes at the target's HEAD, or null when the path is
 * genuinely absent there. Same probe semantics as
 * preserve_local_content.ts's private twin: `git ls-tree HEAD -- rel`
 * distinguishes an absent path (exit 0, empty output) from a broken
 * repository (nonzero exit, which throws - reading damage as "absent"
 * would silently skip the check). Returns raw bytes so each caller picks
 * the honest decode (latin1 for file content, utf-8 for the manifest). */
function headBytes(root: string, rel: string): Buffer | null {
  const probe = Bun.spawnSync(["git", "-C", root, "ls-tree", "HEAD", "--", rel], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (probe.exitCode !== 0) {
    throw new Error(
      `git ls-tree HEAD -- ${rel} failed in ${root}: ${probe.stderr.toString().trim()}`,
    );
  }
  if (probe.stdout.toString().trim() === "") return null;
  const proc = Bun.spawnSync(["git", "-C", root, "show", `HEAD:${rel}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git show HEAD:${rel} failed in ${root}: ${proc.stderr.toString().trim()}`);
  }
  return Buffer.from(proc.stdout);
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

/** One display line, bounded: a missing line or an unverifiable reason
 * can embed target-controlled text (repository content, HEAD-manifest
 * marker strings), and one enormous value must not blow the body cap. */
function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)} [clipped]` : text;
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
    const heading = `- \`${finding.path}\`: ${finding.missing.length} non-blank line(s) of the repository-owned half at the previous commit are missing from this update's copy`;
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
  const flags = parseFlags(argv, ["--report"] as const, ["--root", "--hide-details"] as const);
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
  writeFileSync(flags["--report"], renderReport(findings), "utf-8");

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

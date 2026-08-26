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
// have their own review machinery). The line check is set membership, not
// a positional diff: moved lines are not lost content. All file content is
// read as latin1 (one code unit per byte, the stamp_manifest.ts
// convention) - a utf-8 decode would fold non-UTF-8 bytes onto U+FFFD and
// could hide or invent a mismatch; the manifests themselves are JSON and
// decode as utf-8 so their path keys compare correctly.
//
// Usage:
//   bun tail_tripwire.ts --report FILE [--root target]
//     [--hide-details true|false]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "../shared/flags.ts";
import { type SplitEntry, splitEntries } from "./preserve_local_content.ts";
import { MANIFEST_NAME, managedHalf } from "./stamp_manifest.ts";

/** The complement of a split entry's managed half: everything below the
 * marker line for managed "above", everything above it for "below". Null
 * when the marker line is missing - there is no honest split to check.
 * managedHalf returns a prefix for "above" and a suffix for "below", so
 * the repository-owned half is the exact byte remainder. */
export function repoOwnedHalf(
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

/** One path's verdict, with each side split by its own manifest entry:
 * null means the delivered repository-owned half still holds every
 * non-blank line the previous one had. */
export function compareHalves(
  path: string,
  newEntry: Pick<SplitEntry, "marker" | "managed">,
  headEntry: Pick<SplitEntry, "marker" | "managed">,
  headCopy: string,
  delivered: string,
): Finding | null {
  const previousHalf = repoOwnedHalf(headCopy, headEntry.marker, headEntry.managed);
  if (previousHalf === null) {
    return {
      path,
      kind: "unverifiable",
      reason:
        "the previous commit's copy has no marker line matching its own manifest " +
        `(${JSON.stringify(headEntry.marker)}), so its repository-owned half cannot be located`,
    };
  }
  const deliveredHalf = repoOwnedHalf(delivered, newEntry.marker, newEntry.managed);
  if (deliveredHalf === null) {
    return {
      path,
      kind: "unverifiable",
      reason:
        "the delivered copy has no marker line matching the post-sync manifest " +
        `(${JSON.stringify(newEntry.marker)}), so its repository-owned half cannot be located`,
    };
  }
  const missing = missingLines(previousHalf, deliveredHalf);
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
// so the per-file excerpt is bounded; the previous commit holds the rest.
const MAX_REPORT_LINES = 40;

const REPORT_INTRO = [
  "> [!WARNING]",
  "> TAIL TRIPWIRE: this update could not prove every split file's",
  "> repository-owned half intact. The structural split-file rebuild is",
  "> supposed to make that impossible, so treat a listing below as a sync",
  "> bug (report it on Vivswan/repo-platform) AND restore the listed",
  "> content on this branch before merging. Auto-merge is off.",
  "",
];

export function renderReport(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const sections = findings.map((finding) => {
    if (finding.kind === "unverifiable") {
      return `- \`${finding.path}\`: ${finding.reason} - review this file's full diff against the previous commit before merging.`;
    }
    const shown = finding.missing.slice(0, MAX_REPORT_LINES);
    const omitted = finding.missing.length - shown.length;
    const tail = omitted > 0 ? `\n  (${omitted} more; see the previous commit's copy)` : "";
    return (
      `- \`${finding.path}\`: ${finding.missing.length} non-blank line(s) of the repository-owned half at the previous commit are missing from this update's copy:\n\n` +
      `  \`\`\`\`text\n${shown.map((line) => `  ${line}`).join("\n")}\n  \`\`\`\`${tail}`
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

  // HEAD's manifest, for splitting HEAD's copies with HEAD's own markers.
  // A missing or unparseable one is a target-state anomaly, not this
  // run's: every previously-present split file becomes unverifiable
  // (manual review) instead of failing the job - going red here would
  // block the very sync that could deliver the fix.
  const headManifestBytes = headBytes(root, MANIFEST_NAME);
  let headEntries: Map<string, SplitEntry> | null = null;
  if (headManifestBytes !== null) {
    try {
      headEntries = new Map(
        splitEntries(headManifestBytes.toString("utf-8"), `HEAD:${MANIFEST_NAME}`).map((entry) => [
          entry.path,
          entry,
        ]),
      );
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
      entry.path,
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

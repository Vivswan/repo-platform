#!/usr/bin/env bun
// Rebuilds the sanctioned repository-local regions of split-class files,
// in one of two modes:
//
// RENDER MODE (--render-dir; the PRIMARY path, run on every normal sync):
// after `copier update`, the merged result for every split-class file is
// DISCARDED and the file is rebuilt structurally - the managed half from
// the clean render at the new template ref, the repository-local half
// byte-for-byte from the pre-update HEAD. The file list, marker line, and
// managed side come from the new render's own ownership manifest
// (.github/repo-platform-manifest.json class "split" entries), so the
// rebuild can never miss a file the template splits. The merge never
// touches mixed-ownership content: a template retraction cannot eat a
// local tail, and a local tail cannot resurrect retracted managed lines.
// The deliberate flip side: local edits INSIDE a managed half no longer
// survive by merge luck - they are RESET to the fresh render on every
// sync, loudly (a reset note in the summary plus the needs-review flag).
// Edits are detected against the OLD ref's clean render (--old-render-dir),
// so a routine template change to the managed half does not read as a
// local edit.
//
// SENTINEL-SCAN MODE (no --render-dir; the recovery path): a recovery
// re-render (recover=recopy) has no usable old ref, so there are no clean
// renders to consume - the recopy result in the working tree IS the fresh
// render. This mode walks the rendered tree for the known split grammars
// (the repo-platform:local-section sentinel, the prefix docs, .gitignore's
// LOCAL region) and splices the repository-local content back over it.
//
// Both modes share the same carries. Loud beats lossy: NO shape of
// previous copy may lose content without a disposition in the summary -
// when a previous copy cannot be split into managed content and local
// tail (it predates the sentinel, or was hand-edited past recognition),
// the WHOLE previous copy is appended below a marked recovery-appendix
// comment instead of being dropped. Rules:
//
// - Sentinel files and prefix docs share one carry: a target that
//   startsWith the render is kept whole; else the target's content after
//   its FIRST sentinel line is re-appended below the render (which must
//   end at a sentinel to be used as the managed half - splitting at the
//   first target sentinel keeps everything after it, so a stale duplicate
//   marker can only ever ADD reviewable lines, never drop them); else
//   keep BOTH (render, then the marked appendix). A sentinel-bearing
//   target whose tail is blank was never customized and keeps the render.
// - A render without the sentinel is routed to this carry only for the
//   prefix docs in sentinel-scan mode (their mechanism is prefix-ness,
//   not the sentinel) and for manifest-declared entries in render mode;
//   for every other scanned file it means the template dropped the
//   mechanism and the tail is not resurrected.
// - .gitignore (and any managed-below split entry): the target's LOCAL
//   section body replaces the render's. A previous copy without a single
//   cleanly-locatable LOCAL region (markers missing, duplicated - even as
//   mid-line text - or reversed) is preserved INSIDE the fresh LOCAL
//   section below a recovery-appendix comment, every carried line
//   commented out (the carry must not silently activate or rewrite ignore
//   patterns) and marker text dash-joined so the validator's exactly-once
//   rule holds; a render without the region keeps the render (the
//   mechanism left the template).
//
// The carried files land in --summary as markdown for the PR body; for a
// hide-details target the log prints counts only (paths and dispositions
// are target data). Carries that need human review - an appendix, reset
// managed-half edits, duplicate sentinel markers - are listed in the
// --needs-review flag file, which open_pr.ts turns into the manual-review
// path; kept-whole, clean tail-appends, and clean LOCAL splices stay
// auto-merge-eligible.
//
// Usage:
//   bun preserve_local_content.ts --summary FILE [--root target]
//     [--hide-details true|false] [--needs-review FILE]
//     [--rebuilt-paths FILE] [--render-dir DIR --old-render-dir DIR]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOCAL_BEGIN,
  LOCAL_END,
  localRegion,
  splitLines,
  stripCr,
} from "../../../scripts/gitignore_local.ts";
import { parseFlags } from "../shared/flags.ts";
import { MANIFEST_NAME, managedHalf } from "./stamp_manifest.ts";
import { walkFiles } from "./walk.ts";

const HTML_SENTINEL = "<!-- repo-platform:local-section -->";
const HASH_SENTINEL = "# repo-platform:local-section";
const SENTINELS = [HTML_SENTINEL, HASH_SENTINEL];
const MANAGED_BEGIN = "# BEGIN REPO-PLATFORM MANAGED";
const MANAGED_END = "# END REPO-PLATFORM MANAGED";
const GITIGNORE_MARKERS = [LOCAL_BEGIN, LOCAL_END, MANAGED_BEGIN, MANAGED_END];
const PREFIX_DOCS = new Set(["SECURITY.md", "CONTRIBUTING.md", "LICENSE.md"]);

function lastLineIndex(
  lines: ReturnType<typeof splitLines>,
  match: (text: string) => boolean,
): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (match(stripCr(lines[i].text))) return i;
  }
  return -1;
}

function isSentinel(text: string): boolean {
  return SENTINELS.includes(text);
}

function hasSentinelLine(content: string): boolean {
  return splitLines(content).some((line) => isSentinel(stripCr(line.text)));
}

/** Content split at the FIRST sentinel line: head runs through the
 * sentinel (newline included), tail is everything below it. Splitting at
 * the first keeps every later line - including any further sentinel, so a
 * stale duplicate marker adds reviewable lines instead of dropping the
 * content between the markers; extraSentinels flags that for the summary. */
function splitAtFirstSentinel(
  content: string,
): { head: string; tail: string; extraSentinels: boolean } | null {
  const lines = splitLines(content);
  const first = lines.findIndex((line) => isSentinel(stripCr(line.text)));
  if (first === -1) return null;
  const extraSentinels = lines.some(
    (line, index) => index > first && isSentinel(stripCr(line.text)),
  );
  return {
    head: content.slice(0, lines[first].end),
    tail: content.slice(lines[first].end),
    extraSentinels,
  };
}

function withTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

/** The keep-both fallback: render, then the previous copy in full below a
 * marked comment. Hash-comment spelling for files whose sentinel is the
 * hash form (.gitattributes - an HTML comment there would parse as
 * attribute patterns - .editorconfig, and .github/CODEOWNERS), the HTML
 * comment otherwise. */
function withAppendix(renderNl: string, target: string): string {
  const hashStyle = splitLines(renderNl).some((line) => stripCr(line.text) === HASH_SENTINEL);
  const explanation = [
    "The template sync's re-render could not tell this file's",
    "repository-local tail apart from its managed content, so the previous",
    "copy is preserved in full below. Keep what is repository-local, drop",
    "what the content above already covers, then delete this comment.",
  ];
  const appendix = hashStyle
    ? ["# repo-platform:recovery-appendix", ...explanation.map((line) => `# ${line}`)].join("\n")
    : ["<!-- repo-platform:recovery-appendix", `${explanation.join("\n")} -->`].join("\n");
  return `${renderNl}\n${appendix}\n\n${withTrailingNewline(target)}`;
}

export type TailCarry =
  | {
      kind: "kept-whole";
      content: string;
      /** The target carried more than one sentinel line; everything after
       * the first was kept, so the tail may hold a stale duplicate to
       * review. */
      extraSentinels: boolean;
    }
  | {
      kind: "tail-appended";
      content: string;
      extraSentinels: boolean;
      /** The target's managed half (above its sentinel) differed from the
       * fresh render's, so in-place edits there were NOT carried. In
       * sentinel-scan mode this is the loudness signal; render mode
       * recomputes the signal against the OLD render instead (a template
       * change to the managed half is not a local edit). */
      managedHalfDiffers: boolean;
    }
  | { kind: "appendix"; content: string };

/** Managed-content carry, shared by the sentinel files and the prefix
 * docs: the render is the managed content, the target's local tail is
 * re-appended below it. Null means keep the render (the target never
 * diverged below the managed content). */
export function carryManagedTail(render: string, target: string): TailCarry | null {
  const renderNl = withTrailingNewline(render);
  if (target === render || target === renderNl) return null;
  // Unchanged managed content: the target IS render + tail; keep it whole.
  if (target.startsWith(renderNl)) {
    return {
      kind: "kept-whole",
      content: target,
      extraSentinels: splitAtFirstSentinel(target)?.extraSentinels ?? false,
    };
  }
  // The render is usable as the managed half only when it ENDS at a
  // recognized sentinel line; anchoring a split on an arbitrary final
  // line would guess. Then the target's content after its FIRST sentinel
  // is the repository tail.
  const renderLines = splitLines(render);
  const finalIndex = lastLineIndex(renderLines, (text) => text.trim() !== "");
  if (finalIndex !== -1 && isSentinel(stripCr(renderLines[finalIndex].text))) {
    const split = splitAtFirstSentinel(target);
    if (split !== null) {
      // Blank tail below the target's sentinel: never customized.
      if (split.tail.trim() === "") return null;
      return {
        kind: "tail-appended",
        content: renderNl + split.tail,
        extraSentinels: split.extraSentinels,
        managedHalfDiffers: splitAtFirstSentinel(renderNl)?.head !== split.head,
      };
    }
  }
  // No recognizable split (the previous copy predates the sentinel, or
  // was hand-edited past recognition). Keep BOTH: silently losing the
  // repository's content is the defect this script exists to fix, and an
  // appendix carry forces manual review, so a marked duplicate is
  // acceptable.
  return { kind: "appendix", content: withAppendix(renderNl, target) };
}

export interface GitignoreCarry {
  content: string;
  disposition: "spliced" | "appendix";
}

/** Count of lines whose CR-stripped text equals the marker. */
function markerLineCount(content: string, marker: string): number {
  return splitLines(content).filter((line) => stripCr(line.text) === marker).length;
}

/** Substring occurrences, the way validate_generated_files counts. */
function substringCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

/** Previous-copy lines carried into the appendix are commented out (the
 * carry must not silently activate or rewrite ignore patterns - inert and
 * loud, like the .md appendices) and marker text inside them is
 * dash-joined so validate_generated_files' exactly-once substring rule
 * holds on the result. */
function inertPreviousCopy(content: string): string {
  let neutralized = content;
  for (const marker of GITIGNORE_MARKERS) {
    neutralized = neutralized.replaceAll(marker, marker.slice(2).replaceAll(" ", "-"));
  }
  return splitLines(neutralized)
    .map((line) => (stripCr(line.text) === "" ? line.text : `# ${line.text}`))
    .join("\n");
}

/** .gitignore carry: the target's LOCAL section body inside the render's
 * markers. The clean shape requires each LOCAL marker exactly once BOTH
 * as an exact line and as a substring (the validator counts substrings,
 * so a marker buried in surrounding text is a duplicate too), ordered,
 * with no marker text inside the body. Any other shape with non-blank
 * previous content is preserved, commented out, inside the fresh LOCAL
 * section - dropping it would silently lose whatever local entries it
 * held. Null means keep the render: the render has no region (the
 * mechanism left the template), the bodies already match, or an
 * unsplittable previous copy is blank. */
export function carryGitignoreLocal(render: string, target: string): GitignoreCarry | null {
  const renderRegion = localRegion(render);
  if (renderRegion === null) return null;
  const clean = [LOCAL_BEGIN, LOCAL_END].every(
    (marker) => markerLineCount(target, marker) === 1 && substringCount(target, marker) === 1,
  );
  const targetRegion = clean ? localRegion(target) : null;
  if (
    targetRegion !== null &&
    !GITIGNORE_MARKERS.some((marker) => targetRegion.body.includes(marker))
  ) {
    if (renderRegion.body === targetRegion.body) return null;
    return {
      content: renderRegion.before + targetRegion.body + renderRegion.after,
      disposition: "spliced",
    };
  }
  if (target.trim() === "") return null;
  const explanation = [
    "# repo-platform:recovery-appendix",
    "# The template sync's re-render could not locate a single",
    "# REPOSITORY LOCAL section in this file's previous copy, so the",
    "# previous copy is preserved below, commented out, with marker text",
    "# neutralized. Move what is repository-local up into this section",
    "# (uncommented), drop the rest, then delete this block.",
  ].join("\n");
  return {
    content:
      renderRegion.before +
      renderRegion.body +
      `${explanation}\n${withTrailingNewline(inertPreviousCopy(target))}` +
      renderRegion.after,
    disposition: "appendix",
  };
}

export interface Carried {
  content: string;
  note: string;
}

const TAIL_NOTES: Record<TailCarry["kind"], string> = {
  "kept-whole": "repository copy kept whole (its managed content matches the render)",
  "tail-appended": "repository tail re-appended below the fresh managed content",
  appendix:
    "managed content not recognized in the repository's previous copy; the previous " +
    "copy is preserved in full below a repo-platform:recovery-appendix comment - " +
    "reconcile manually",
};

const EXTRA_SENTINELS_NOTE =
  "; the previous copy carried more than one local-section marker, and everything " +
  "after its first marker was kept - review the tail for stale duplicates";

const MANAGED_HALF_NOTE =
  "; the managed half above the marker differed from the fresh render; those " +
  "differences are not carried - review the diff";

const MANAGED_RESET_NOTE =
  "local edits INSIDE the managed half were RESET to the fresh render - managed " +
  "halves are template-owned and rebuilt on every sync; content that must survive " +
  "belongs in the repository-local half (below the marker, or inside .gitignore's " +
  "REPOSITORY LOCAL section)";

const MANAGED_UNVERIFIABLE_NOTE =
  "the previous copy's managed half could not be located (its marker line is " +
  "missing there, or the file has no old-render baseline), so local edits inside " +
  "it cannot be ruled out - the fresh render stands; review the diff for content " +
  "that belongs in the repository-local half";

const GITIGNORE_NOTES: Record<GitignoreCarry["disposition"], string> = {
  spliced: "REPOSITORY LOCAL section restored from the repository's copy",
  appendix:
    "no single REPOSITORY LOCAL section in the repository's previous copy; the " +
    "previous copy is preserved, commented out, inside the fresh LOCAL section " +
    "below a repo-platform:recovery-appendix comment (its entries do not apply " +
    "until restored) - reconcile manually",
};

function tailNote(carry: TailCarry, mode: "scan" | "render"): string {
  switch (carry.kind) {
    case "kept-whole":
      return TAIL_NOTES[carry.kind] + (carry.extraSentinels ? EXTRA_SENTINELS_NOTE : "");
    case "tail-appended":
      // Render mode reports managed-half drift against the OLD render (the
      // reset note, appended by the caller); against the NEW render every
      // routine template change would read as dropped local edits.
      return (
        TAIL_NOTES[carry.kind] +
        (carry.extraSentinels ? EXTRA_SENTINELS_NOTE : "") +
        (mode === "scan" && carry.managedHalfDiffers ? MANAGED_HALF_NOTE : "")
      );
    case "appendix":
      return TAIL_NOTES[carry.kind];
  }
}

/** Repository-local content of the pre-render target spliced into the
 * fresh render, or null when the render is already right. Sentinel-scan
 * routing: .gitignore by name, the prefix docs by name, everything else by
 * a sentinel line in the render. */
export function carryLocalContent(rel: string, render: string, target: string): Carried | null {
  if (render === target) return null;
  let carried: Carried | null = null;
  if (rel === ".gitignore") {
    const carry = carryGitignoreLocal(render, target);
    if (carry !== null) {
      carried = { content: carry.content, note: GITIGNORE_NOTES[carry.disposition] };
    }
  } else if (PREFIX_DOCS.has(rel) || hasSentinelLine(render)) {
    const carry = carryManagedTail(render, target);
    if (carry !== null) {
      carried = { content: carry.content, note: tailNote(carry, "scan") };
    }
  }
  return carried;
}

export interface SplitEntry {
  path: string;
  marker: string;
  managed: "above" | "below";
}

/** The class "split" entries of a render's ownership manifest - the single
 * source of which files the template splits and where each marker sits.
 * Malformed data throws: silently skipping an entry would hand that file
 * back to the merge result this mode exists to discard. */
export function splitEntries(manifestText: string, where: string): SplitEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new Error(`${where} does not parse as JSON`);
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (typeof files !== "object" || files === null) {
    throw new Error(`${where} has no top-level 'files' mapping`);
  }
  const out: SplitEntry[] = [];
  for (const [path, entry] of Object.entries(files as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${where}: entry for ${path} is not an object`);
    }
    const shaped = entry as { class?: unknown; marker?: unknown; managed?: unknown };
    if (shaped.class !== "split") continue;
    if (
      typeof shaped.marker !== "string" ||
      (shaped.managed !== "above" && shaped.managed !== "below")
    ) {
      throw new Error(`${where}: split entry for ${path} lacks a valid marker/managed pair`);
    }
    out.push({ path, marker: shaped.marker, managed: shaped.managed });
  }
  return out;
}

/** Fail closed before any per-file HEAD read: a missing repository or an
 * unborn HEAD must abort the carry, not read as "every file is new". */
function requireHead(root: string): void {
  const proc = Bun.spawnSync(["git", "-C", root, "rev-parse", "--verify", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`cannot resolve HEAD in ${root}: ${proc.stderr.toString().trim()}`);
  }
}

/** The file's pre-render content at the target's HEAD, or null when the
 * path is genuinely absent there. The probe is `git ls-tree HEAD -- rel`:
 * exit 0 with empty output means absent, exit 0 with output means
 * present, and ANY nonzero exit is a real git failure and throws -
 * cat-file -e cannot make that distinction (it exits 128 for a missing
 * path and for fatal errors alike), and reading damage as "every file is
 * new" would silently skip the carry. */
function headContent(root: string, rel: string): string | null {
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
  return proc.stdout.toString();
}

const SENTINEL_BUFFERS = SENTINELS.map((sentinel) => Buffer.from(sentinel));

interface FileOutcome {
  rel: string;
  note: string;
  /** Reasons this carry needs human review (empty = auto-merge-eligible). */
  reviewReasons: string[];
}

/** Render mode, per split entry: DISCARD the working tree's merged copy
 * and rebuild from (clean new render, HEAD copy); detect managed-half
 * edits against the OLD render. Returns the outcome when the file carried
 * content or needs review; null when the clean rebuild needs no human
 * attention (that includes every routine template change). */
function rebuildSplitFile(
  root: string,
  renderDir: string,
  oldRenderDir: string,
  entry: SplitEntry,
): FileOutcome | null {
  const rel = entry.path;
  const renderPath = join(renderDir, rel);
  if (!existsSync(renderPath)) {
    throw new Error(
      `${MANIFEST_NAME} in ${renderDir} declares a split entry for ${rel}, but the render has no such file - manifest and render disagree`,
    );
  }
  const render = readFileSync(renderPath, "utf-8");
  const target = headContent(root, rel);

  let content = render;
  let note: string | null = null;
  let appendixCarry = false;
  const reviewReasons: string[] = [];
  if (target !== null) {
    if (entry.managed === "below") {
      const carry = carryGitignoreLocal(render, target);
      if (carry !== null) {
        content = carry.content;
        note = GITIGNORE_NOTES[carry.disposition];
        appendixCarry = carry.disposition === "appendix";
        if (appendixCarry) reviewReasons.push("recovery-appendix");
      }
    } else {
      const carry = carryManagedTail(render, target);
      if (carry !== null) {
        content = carry.content;
        note = tailNote(carry, "render");
        if (carry.kind === "appendix") {
          appendixCarry = true;
          reviewReasons.push("recovery-appendix");
        } else if (carry.extraSentinels) {
          reviewReasons.push("duplicate local-section markers");
        }
      }
    }
    // Did the rebuild drop bytes from the previous managed half? Compare
    // HEAD's half against the DELIVERED content's half (byte-equal means
    // nothing was dropped, however the carry got there), then classify a
    // drop against the OLD render's half: equal means the drop IS the
    // template update (routine, silent), different means local edits were
    // reset (loud, manual review). A half that cannot be located on any
    // side is UNVERIFIABLE, not clean - a mangled marker must not slip a
    // content drop past review. An appendix carry skips all of this: it
    // preserves the full previous copy below the render and is already
    // manual.
    if (!appendixCarry) {
      const targetHalf = managedHalf(target, entry.marker, entry.managed);
      const deliveredHalf = managedHalf(content, entry.marker, entry.managed);
      if (targetHalf !== null && deliveredHalf !== null && targetHalf === deliveredHalf) {
        // Nothing from the previous managed half was dropped.
      } else {
        const oldRenderPath = join(oldRenderDir, rel);
        const oldHalf = existsSync(oldRenderPath)
          ? managedHalf(readFileSync(oldRenderPath, "utf-8"), entry.marker, entry.managed)
          : null;
        if (targetHalf === null || deliveredHalf === null || oldHalf === null) {
          note =
            note === null ? MANAGED_UNVERIFIABLE_NOTE : `${note}; ${MANAGED_UNVERIFIABLE_NOTE}`;
          reviewReasons.push("managed half unverifiable");
        } else if (targetHalf !== oldHalf) {
          note = note === null ? MANAGED_RESET_NOTE : `${note}; ${MANAGED_RESET_NOTE}`;
          reviewReasons.push("managed-half edits reset");
        }
      }
    }
  }
  // Unconditional write: the working tree holds copier's merged result,
  // which this mode exists to discard - even a byte-identical rewrite is
  // the correct statement of ownership.
  writeFileSync(join(root, rel), content);
  return note === null ? null : { rel, note, reviewReasons };
}

const RENDER_INTRO = [
  "Split-class files were rebuilt structurally over this update: the managed",
  "half comes from a clean render at the new template ref, the",
  "repository-local half byte-for-byte from the previous commit, and",
  "copier's merged result for these files was discarded. Local edits inside",
  "a managed half do NOT survive this rebuild (managed halves are",
  "template-owned); such edits are reset and flagged below. Verify each",
  "file's diff before merging:",
];

const SCAN_INTRO = [
  "Repo-local content carried over the recovery re-render - the re-render",
  "has no three-way merge and had reset these sanctioned repository-local",
  "regions; verify each file's diff before merging:",
];

function main(argv: string[]): number {
  const flags = parseFlags(
    argv,
    ["--summary"] as const,
    [
      "--root",
      "--hide-details",
      "--render-dir",
      "--old-render-dir",
      "--needs-review",
      "--rebuilt-paths",
    ] as const,
  );
  const root = flags["--root"] ?? "target";
  const hideDetails = flags["--hide-details"] === "true";
  const renderDir = flags["--render-dir"];
  const oldRenderDir = flags["--old-render-dir"];
  if ((renderDir === undefined) !== (oldRenderDir === undefined)) {
    throw new Error(
      "--render-dir and --old-render-dir come together: the rebuild takes the managed half from the new render and detects managed-half edits against the old one",
    );
  }
  requireHead(root);

  const outcomes: FileOutcome[] = [];
  // Every file this script WROTE, for the conflict resolver's --skip list:
  // a carried repository half may legitimately contain conflict-marker-shaped
  // text, and the resolver must not rewrite what the rebuild just delivered.
  const rebuiltRels: string[] = [];
  if (renderDir !== undefined && oldRenderDir !== undefined) {
    const manifestPath = join(renderDir, MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
      throw new Error(
        `${renderDir} has no ${MANIFEST_NAME}; the split-file rebuild needs the new render's manifest to know which files are split`,
      );
    }
    const entries = splitEntries(readFileSync(manifestPath, "utf-8"), manifestPath);
    for (const entry of entries) {
      const outcome = rebuildSplitFile(root, renderDir, oldRenderDir, entry);
      rebuiltRels.push(entry.path);
      if (outcome !== null) outcomes.push(outcome);
    }
  } else {
    for (const rel of walkFiles(root)) {
      // Byte-level pre-filter (binaries never decode): only the
      // LOCAL-marker gitignore, the prefix docs, and sentinel-bearing
      // files can carry local content.
      const data = readFileSync(join(root, rel));
      if (
        rel !== ".gitignore" &&
        !PREFIX_DOCS.has(rel) &&
        !SENTINEL_BUFFERS.some((sentinel) => data.includes(sentinel))
      ) {
        continue;
      }
      const render = data.toString("utf-8");
      const target = headContent(root, rel);
      if (target === null) continue;
      const carried = carryLocalContent(rel, render, target);
      if (carried === null) continue;
      writeFileSync(join(root, rel), carried.content);
      rebuiltRels.push(rel);
      outcomes.push({ rel, note: carried.note, reviewReasons: [] });
    }
  }

  for (const { rel, note } of outcomes) {
    // Paths and dispositions are target file data: a hide-details target
    // gets a count here and the detail only in the PR body, which lives
    // in the private repo.
    if (!hideDetails) console.log(`${rel}: ${note}`);
  }

  let summary = "";
  if (outcomes.length > 0) {
    summary = [
      ...(renderDir !== undefined ? RENDER_INTRO : SCAN_INTRO),
      "",
      ...outcomes.map(({ rel, note }) => `- \`${rel}\`: ${note}`),
      "",
    ].join("\n");
    if (hideDetails) {
      console.log(
        `carried repo-local content back into ${outcomes.length} file(s) ` +
          "(paths hidden: private repository; listed in the PR body)",
      );
    }
  } else {
    console.log("no repo-local content needed carrying over the re-render");
  }
  writeFileSync(flags["--summary"], summary, "utf-8");

  const needsReviewFile = flags["--needs-review"];
  if (needsReviewFile !== undefined) {
    const lines = outcomes
      .filter(({ reviewReasons }) => reviewReasons.length > 0)
      .map(({ rel, reviewReasons }) => `${rel}: ${reviewReasons.join(", ")}`);
    writeFileSync(needsReviewFile, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf-8");
    if (lines.length > 0) {
      console.log(
        hideDetails
          ? `${lines.length} carried file(s) need review; the PR stays manual (details in the PR body)`
          : `${lines.length} carried file(s) need review; the PR stays manual`,
      );
    }
  }

  const rebuiltPathsFile = flags["--rebuilt-paths"];
  if (rebuiltPathsFile !== undefined) {
    writeFileSync(
      rebuiltPathsFile,
      rebuiltRels.length > 0 ? `${rebuiltRels.join("\n")}\n` : "",
      "utf-8",
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

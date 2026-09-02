#!/usr/bin/env bun
// Rebuilds the sanctioned repository-local regions of split-class files,
// in one of two modes. In BOTH modes the file list and each file's split
// GRAMMAR come from an ownership manifest's class "split" entries
// (.github/repo-platform-manifest.json) - nothing here hardcodes marker
// lines or file names, so a future module with a different marker or
// grammar rides the same carries instead of silently degrading:
//
// - tail-marker grammar: one marker line ends the sync-owned top; the
//   repository owns everything below it (carryManagedTail).
// - bounded-region grammar: a BEGIN/END-bounded repository-local region
//   sits above the sync-owned half (.gitignore's shape; carryLocalRegion
//   via the shared slicer in scripts/gitignore_local.ts).
//
// RENDER MODE (--render-dir; the PRIMARY path, run on every normal sync):
// after `copier update`, the merged result for every split-class file is
// DISCARDED and the file is rebuilt structurally - the managed half from
// the clean render at the new template ref, the repository-local half
// byte-for-byte from the pre-update HEAD. The split entries come from the
// new render's own manifest, so the rebuild can never miss a file the
// template splits. The merge never touches mixed-ownership content: a
// template retraction cannot eat a local tail, and a local tail cannot
// resurrect retracted managed lines. The deliberate flip side: local
// edits INSIDE a managed half no longer survive by merge luck - they are
// RESET to the fresh render on every sync, loudly (a reset note in the
// summary plus the needs-review flag). Edits are detected against the OLD
// ref's clean render (--old-render-dir), so a routine template change to
// the managed half does not read as a local edit.
//
// RECOPY MODE (no --render-dir; the recovery path): a recovery re-render
// (recover=recopy) has no usable old ref, so there are no clean renders to
// consume - the recopy result in the working tree IS the fresh render,
// manifest included. The split entries come from that manifest, the
// pre-recovery content from HEAD, and the same carries splice the
// repository-local content back over the re-render.
//
// Both modes share the same carries. All file content is handled as
// latin1 text (one code unit per byte, the stamp_manifest.ts convention):
// the repo-owned half is promised byte-for-byte, and a utf-8 decode would
// fold any non-UTF-8 byte onto U+FFFD - silent corruption. The markers are
// ASCII, so matching is unaffected. Loud beats lossy: NO shape of
// previous copy may lose content without a disposition in the summary -
// when a previous copy cannot be split into managed content and local
// tail (it predates the marker, or was hand-edited past recognition),
// the WHOLE previous copy is appended below a marked recovery-appendix
// comment instead of being dropped. Rules:
//
// - Tail-marker files: a target that startsWith the render is kept whole;
//   else the target's content after its FIRST marker line is re-appended
//   below the render (which must end at the marker to be used as the
//   managed half - splitting at the first target marker keeps everything
//   after it, so a stale duplicate marker can only ever ADD reviewable
//   lines, never drop them); else keep BOTH (render, then the marked
//   appendix). A marker-bearing target with an EMPTY tail was never
//   customized and keeps the render; a whitespace-only tail is carried
//   like any other (byte-owned).
// - Bounded-region files: the target's local region body replaces the
//   render's. A previous copy without a single cleanly-locatable region
//   (markers missing, duplicated - even as mid-line text - or reversed)
//   is preserved INSIDE the fresh local region below a recovery-appendix
//   comment, every carried line commented out (the carry must not
//   silently activate or rewrite ignore patterns) and marker text
//   dash-joined so the validator's exactly-once rule holds; a render
//   without the region keeps the render (the mechanism left the template).
//
// The carried files land in --summary as markdown for the PR body; for a
// hide-details target the log prints counts only (paths and dispositions
// are target data). Carries that need human review - an appendix, reset
// managed-half edits, duplicate markers - are listed in the
// --needs-review flag file, which open_pr.ts turns into the manual-review
// path; kept-whole, clean tail-appends, and clean region splices stay
// auto-merge-eligible.
//
// Usage:
//   bun preserve_local_content.ts --summary FILE [--root target]
//     [--hide-details true|false] [--needs-review FILE]
//     [--rebuilt-paths FILE] [--render-dir DIR --old-render-dir DIR]

import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  GRAMMAR,
  type GrammarId,
  grammarSpec,
  grammarWireMarker,
  knownGrammar,
  type RegionSplit,
  type SplitShapes,
} from "../../../actions/shared/grammar.ts";
import {
  MANIFEST_NAME,
  type ManifestEntryShape,
  parseManifestFiles,
} from "../../../actions/shared/manifest.ts";
import { isMarkerLine, managedHalf } from "../../../actions/shared/stamp_manifest.ts";
import {
  allRegionMarkers,
  cleanLocalRegion,
  localRegion,
  splitLines,
  stripCr,
  substringCount,
} from "../../../scripts/gitignore_local.ts";
import { isCommentMarker, isHashMarker } from "../../../scripts/ownership.ts";
import { parseFlags } from "../shared/flags.ts";
import { type HeadNonBlobKind, headEntry } from "../shared/git_head.ts";
import { capture } from "../shared/proc.ts";

function lastLineIndex(
  lines: ReturnType<typeof splitLines>,
  match: (text: string) => boolean,
): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (match(stripCr(lines[i].text))) return i;
  }
  return -1;
}

/** Content split at the FIRST marker line: head runs through the marker
 * (newline included), tail is everything below it. Marker lines match via
 * the shared isMarkerLine predicate (stamp_manifest.ts) - the stamper, the
 * validator's twin, and this carry must agree on what a marker line IS, or
 * a line only some of them count (one with a stray trailing space, say)
 * splits the file differently at each site. Splitting at the first keeps
 * every later line - including any further marker, so a stale duplicate
 * adds reviewable lines instead of dropping the content between the
 * markers; extraMarkers flags that for the summary. */
function splitAtFirstMarker(
  content: string,
  marker: string,
): { head: string; tail: string; extraMarkers: boolean } | null {
  const lines = splitLines(content);
  const first = lines.findIndex((line) => isMarkerLine(line.text, marker));
  if (first === -1) return null;
  const extraMarkers = lines.some(
    (line, index) => index > first && isMarkerLine(line.text, marker),
  );
  return {
    head: content.slice(0, lines[first].end),
    tail: content.slice(lines[first].end),
    extraMarkers,
  };
}

function withTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

/** The declared marker text made inert for an appendix carry: spaces
 * dash-joined; a space-free marker gets a dash right after its comment
 * opener ("<!--" or the leading "#"), so the inert form still reads as a
 * comment in the marker's own syntax but no longer counts as a marker line
 * anywhere - the stamper, the validator, and this module's own splitter
 * all match markers per isMarkerLine, and a verbatim re-appended marker
 * line would double the validator's exactly-once count. */
function inertTailMarker(marker: string): string {
  const inert = marker.replaceAll(" ", "-");
  if (inert !== marker) return inert;
  const opener = marker.startsWith("<!--") ? "<!--" : marker.slice(0, 1);
  return `${opener}-${marker.slice(opener.length)}`;
}

/** Whether a latin1-decoded line is a marker line to ANY pipeline reader:
 * this module and the stamper match the latin1 view, but the validator
 * decodes UTF-8 - a marker line carrying, say, a UTF-8 NBSP (0xC2 0xA0)
 * beside the marker trims clean only under the UTF-8 view, so a carry
 * that left it verbatim would deliver a tree the validator counts two
 * markers in. Neutralization must cover the union. */
function isMarkerLineAnyView(latin1Line: string, marker: string): boolean {
  if (isMarkerLine(latin1Line, marker)) return true;
  return isMarkerLine(Buffer.from(latin1Line, "latin1").toString("utf-8"), marker);
}

/** The previous copy with its marker LINES neutralized (mid-line mentions
 * are not marker lines to any consumer and stay verbatim). */
function neutralizeMarkerLines(content: string, marker: string): string {
  const inert = inertTailMarker(marker);
  return splitLines(content)
    .map((line) =>
      isMarkerLineAnyView(line.text, marker) ? line.text.replaceAll(marker, inert) : line.text,
    )
    .join("\n");
}

/** The keep-both fallback: render, then the previous copy below a marked
 * comment - with any marker line in the previous copy neutralized (the
 * fresh render's marker must stay the file's ONLY marker line, or the
 * recovery output itself fails validation with advice pointing away from
 * the real cause). The comment spelling follows the entry's marker form:
 * an HTML comment for HTML-comment markers, hash comments otherwise
 * (.gitattributes, .editorconfig, .github/CODEOWNERS - an HTML comment
 * there would parse as file content). */
function withAppendix(renderNl: string, target: string, marker: string): string {
  const htmlStyle = marker.startsWith("<!--");
  const explanation = [
    "The template sync's re-render could not tell this file's",
    "repository-local tail apart from its managed content, so the previous",
    "copy is preserved in full below (any marker line in it is dash-joined",
    "to stay inert). Keep what is repository-local, drop what the content",
    "above already covers, then delete this comment.",
  ];
  const appendix = htmlStyle
    ? ["<!-- repo-platform:recovery-appendix", `${explanation.join("\n")} -->`].join("\n")
    : ["# repo-platform:recovery-appendix", ...explanation.map((line) => `# ${line}`)].join("\n");
  return `${renderNl}\n${appendix}\n\n${withTrailingNewline(neutralizeMarkerLines(target, marker))}`;
}

/** Previous non-blank lines the delivered text no longer holds, counted
 * as a MULTISET: each previous occurrence consumes one delivered
 * occurrence, so a line held twice and delivered once is one missing line
 * - a plain Set would lose occurrence counts and pass exactly the shrink
 * this comparison exists to catch. Shared with tail_tripwire.ts (which
 * re-exports it): the tripwire's loss check and the reset itemization
 * below must count "missing" identically. */
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

export type TailCarry =
  | {
      kind: "kept-whole";
      content: string;
      /** The target carried more than one marker line; everything after
       * the first was kept, so the tail may hold a stale duplicate to
       * review. */
      extraMarkers: boolean;
    }
  | {
      kind: "tail-appended";
      content: string;
      extraMarkers: boolean;
      /** The target's managed half (above its marker) differed from the
       * fresh render's, so in-place edits there were NOT carried. In
       * recopy mode this is the loudness signal; render mode recomputes
       * the signal against the OLD render instead (a template change to
       * the managed half is not a local edit). */
      managedHalfDiffers: boolean;
    }
  | { kind: "appendix"; content: string };

/** Tail-marker carry: the render is the managed content, the target's
 * local tail is re-appended below it. Null means keep the render (the
 * target never diverged below the managed content). */
export function carryManagedTail(render: string, target: string, marker: string): TailCarry | null {
  const renderNl = withTrailingNewline(render);
  if (target === render || target === renderNl) return null;
  // Unchanged managed content: the target IS render + tail; keep it whole.
  if (target.startsWith(renderNl)) {
    return {
      kind: "kept-whole",
      content: target,
      extraMarkers: splitAtFirstMarker(target, marker)?.extraMarkers ?? false,
    };
  }
  // The render is usable as the managed half only when it ENDS at the
  // declared marker line; anchoring a split on an arbitrary final line
  // would guess. Then the target's content after its FIRST marker is the
  // repository tail.
  const renderLines = splitLines(render);
  const finalIndex = lastLineIndex(renderLines, (text) => text.trim() !== "");
  if (finalIndex !== -1 && isMarkerLine(renderLines[finalIndex].text, marker)) {
    const split = splitAtFirstMarker(target, marker);
    if (split !== null) {
      // Empty tail below the target's marker: never customized. A
      // whitespace-only tail is still carried - the tail is byte-owned by
      // the repository, and nothing may drop silently, not even blanks.
      if (split.tail === "") return null;
      return {
        kind: "tail-appended",
        content: renderNl + split.tail,
        extraMarkers: split.extraMarkers,
        managedHalfDiffers: splitAtFirstMarker(renderNl, marker)?.head !== split.head,
      };
    }
  }
  // No recognizable split (the previous copy predates the marker, or
  // was hand-edited past recognition). Keep BOTH: silently losing the
  // repository's content is the defect this script exists to fix, and an
  // appendix carry forces manual review, so a marked duplicate is
  // acceptable.
  return { kind: "appendix", content: withAppendix(renderNl, target, marker) };
}

export interface RegionCarry {
  content: string;
  disposition: "spliced" | "appendix";
}

/** Previous-copy lines carried into the appendix are commented out (the
 * carry must not silently activate or rewrite ignore patterns - inert and
 * loud, like the .md appendices) and the grammar's marker text inside them
 * is dash-joined so validate_generated_files' exactly-once substring rule
 * holds on the result. */
function inertPreviousCopy(content: string, markers: RegionSplit): string {
  let neutralized = content;
  for (const marker of allRegionMarkers(markers)) {
    let inert = (marker.startsWith("# ") ? marker.slice(2) : marker).replaceAll(" ", "-");
    // A space-free marker dash-joins to itself; break the substring anyway.
    if (inert.includes(marker)) inert = `${inert.slice(0, 1)}-${inert.slice(1)}`;
    neutralized = neutralized.replaceAll(marker, inert);
  }
  return splitLines(neutralized)
    .map((line) => (stripCr(line.text) === "" ? line.text : `# ${line.text}`))
    .join("\n");
}

/** Bounded-region carry: the target's local region body inside the
 * render's markers. The target's region must be exactly-once clean per
 * cleanLocalRegion (scripts/gitignore_local.ts - the shared definition, so
 * this carry and the self-output regenerator can never slice the same
 * malformed file differently). Any other shape with non-blank previous
 * content is preserved, commented out, inside the fresh local region -
 * dropping it would silently lose whatever local entries it held. Null
 * means keep the render: the render has no region (the mechanism left the
 * template), the bodies already match, or an unsplittable previous copy is
 * blank. */
export function carryLocalRegion(
  render: string,
  target: string,
  markers: RegionSplit,
): RegionCarry | null {
  const renderRegion = localRegion(render, markers);
  if (renderRegion === null) return null;
  const targetRegion = cleanLocalRegion(target, markers);
  if (targetRegion !== null) {
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
    "# repository-local region in this file's previous copy, so the",
    "# previous copy is preserved below, commented out, with marker text",
    "# neutralized. Move what is repository-local up into this section",
    "# (uncommented), drop the rest, then delete this block.",
  ].join("\n");
  const content =
    renderRegion.before +
    renderRegion.body +
    `${explanation}\n${withTrailingNewline(inertPreviousCopy(target, markers))}` +
    renderRegion.after;
  // Postcondition: neutralization must not have re-created any marker (a
  // replacement product could collide with a sibling marker). The declared
  // markers are schema-constrained against containing each other, so a
  // violation here means adversarially colliding markers - fail loudly
  // rather than deliver a file the validator's exactly-once rule rejects.
  for (const marker of allRegionMarkers(markers)) {
    if (substringCount(content, marker) !== substringCount(render, marker)) {
      throw new Error(
        `appendix neutralization would change the '${marker}' marker's occurrence ` +
          "count - the declared region markers collide under neutralization; " +
          "declare markers whose neutralized forms cannot recreate each other",
      );
    }
  }
  return { content, disposition: "appendix" };
}

const TAIL_NOTES: Record<TailCarry["kind"], string> = {
  "kept-whole": "repository copy kept whole (its managed content matches the render)",
  "tail-appended": "repository tail re-appended below the fresh managed content",
  appendix:
    "managed content not recognized in the repository's previous copy; the previous " +
    "copy is preserved in full below a repo-platform:recovery-appendix comment - " +
    "reconcile manually",
};

const EXTRA_MARKERS_NOTE =
  "; the previous copy carried more than one split marker line, and everything " +
  "after its first marker was kept - review the tail for stale duplicates";

const MANAGED_HALF_NOTE =
  "; the managed half above the marker differed from the fresh render; those " +
  "differences are not carried - review the diff";

const MANAGED_RESET_NOTE =
  "local edits INSIDE the managed half were RESET to the fresh render - managed " +
  "halves are template-owned and rebuilt on every sync; content that must survive " +
  "belongs in the repository-local half (below the marker, or inside the " +
  "repository-local region)";

const MANAGED_UNVERIFIABLE_NOTE =
  "the previous copy's managed half could not be located (its marker line is " +
  "missing there, or the file has no old-render baseline), so local edits inside " +
  "it cannot be ruled out - the fresh render stands; review the diff for content " +
  "that belongs in the repository-local half";

const REGION_NOTES: Record<RegionCarry["disposition"], string> = {
  spliced: "repository-local region restored from the repository's copy",
  appendix:
    "no single repository-local region in the repository's previous copy; the " +
    "previous copy is preserved, commented out, inside the fresh local region " +
    "below a repo-platform:recovery-appendix comment (its entries do not apply " +
    "until restored) - reconcile manually",
};

function tailNote(carry: TailCarry, mode: "recopy" | "render"): string {
  switch (carry.kind) {
    case "kept-whole":
      return TAIL_NOTES[carry.kind] + (carry.extraMarkers ? EXTRA_MARKERS_NOTE : "");
    case "tail-appended":
      // Render mode reports managed-half drift against the OLD render (the
      // reset note, appended by the caller); against the NEW render every
      // routine template change would read as dropped local edits.
      return (
        TAIL_NOTES[carry.kind] +
        (carry.extraMarkers ? EXTRA_MARKERS_NOTE : "") +
        (mode === "recopy" && carry.managedHalfDiffers ? MANAGED_HALF_NOTE : "")
      );
    case "appendix":
      return TAIL_NOTES[carry.kind];
  }
}

/** One parsed split entry: the manifest path plus the grammar's own
 * declaration fields, DERIVED from the GRAMMAR table's SplitShapes - so
 * the entry union's grammar arm set IS GrammarId by construction. The sync
 * leg cannot know a grammar the table lacks, nor silently miss one it has:
 * a new table row makes this union grow, and every exhaustive dispatch
 * below (the per-grammar parsers, the carries) goes red at tsc until it
 * answers for the new arm. */
export type SplitEntry = { [K in GrammarId]: { path: string } & SplitShapes[K] }[GrammarId];

/** Markers are matched against latin1-decoded file bytes, so a non-ASCII
 * marker (utf-8 in the manifest, one code unit per byte in the file) could
 * never match and the carry would silently degrade; the declaration schema
 * forbids it, and this boundary re-checks what it consumes. NON-EMPTY is
 * load-bearing too: managedHalf matches line.trim() === marker, so an
 * empty marker selects the synthetic empty line at EOF and reads a whole
 * file as one half. */
const ASCII_MARKER_RE = /^[\x20-\x7e]+$/;

/** Manifest keys become filesystem paths under the target root, so a key
 * that could escape it (absolute, or carrying .. segments) is refused at
 * this boundary - the declaration schema upstream never emits one, but the
 * manifest text rides through a checkout this script must not trust.
 * Exported for starter_pin_rollout.ts, which walks manifest keys at the
 * same trust boundary and must refuse the same escapes. */
export function isCleanRelativePath(path: string): boolean {
  return (
    path !== "" &&
    !/[\r\n]/.test(path) &&
    !path.startsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** The per-grammar split-entry parsers, total over GrammarId BY TYPE: a
 * GRAMMAR table row with no parser here is a tsc error, never a runtime
 * fallthrough. Each parser re-checks what the manifest text claims for
 * its grammar (the declaration schema upstream never emits a violation,
 * but the text rides through a checkout this script must not trust):
 * the managed side must equal the GRAMMAR row's side column, every
 * marker string must be printable ASCII, and every marker must open in
 * the comment syntax the recovery appendix writes - a tail marker as a
 * hash or complete HTML comment, bounded-region markers as hash comments
 * (the appendix comments carried lines with #). The wireExtras column
 * names the extra marker-string fields, so the field list is stated once
 * (the validator's manifest check reads the same column). */
const SPLIT_PARSERS: {
  [K in GrammarId]: (
    where: string,
    path: string,
    marker: string,
    shaped: ManifestEntryShape,
  ) => { path: string } & SplitShapes[K];
} = {
  "tail-marker": (where, path, marker, shaped) => {
    if (shaped.managed !== GRAMMAR["tail-marker"].side) {
      throw new Error(
        `${where}: split entry for ${path} declares the tail-marker grammar with a ` +
          `managed side other than '${GRAMMAR["tail-marker"].side}' - the manifest is inconsistent`,
      );
    }
    if (!isCommentMarker(marker)) {
      throw new Error(
        `${where}: split entry for ${path} declares tail marker ` +
          `'${marker}', which is not a hash comment or a complete HTML ` +
          "comment line - the recovery appendix writes comments in the marker's " +
          "syntax; the manifest is damaged",
      );
    }
    return { path, grammar: "tail-marker", marker };
  },
  "bounded-region": (where, path, marker, shaped) => {
    const spec = GRAMMAR["bounded-region"];
    const regionStrings = spec.wireExtras.map((field) => shaped[field]);
    if (
      shaped.managed !== spec.side ||
      !regionStrings.every((value) => typeof value === "string" && ASCII_MARKER_RE.test(value))
    ) {
      throw new Error(
        `${where}: split entry for ${path} declares the bounded-region grammar ` +
          `without a '${spec.side}' managed side and its printable-ASCII region marker ` +
          "strings - the manifest is inconsistent",
      );
    }
    for (const value of [marker, ...(regionStrings as string[])]) {
      if (!isHashMarker(value)) {
        throw new Error(
          `${where}: split entry for ${path} declares bounded-region marker ` +
            `'${value}', which does not open as a hash comment - the appendix ` +
            "comments carried lines with #; the manifest is damaged",
        );
      }
    }
    return {
      path,
      grammar: "bounded-region",
      managed_begin: marker,
      managed_end: shaped.managed_end as string,
      local_begin: shaped.local_begin as string,
      local_end: shaped.local_end as string,
    };
  },
};

/** The class "split" entries of a render's ownership manifest - the single
 * source of which files the template splits and each file's grammar and
 * marker lines. Malformed data throws, an unknown or missing grammar
 * included: silently skipping an entry (or guessing its grammar) would
 * hand that file back to the merge result this mode exists to discard.
 * Read through the shared parser (actions/shared/manifest.ts), which also
 * rejects duplicated keys - raw JSON.parse would last-win them, and a
 * duplicated class field could silently declassify a split entry out of
 * every carry. */
export function splitEntries(manifestText: string, where: string): SplitEntry[] {
  const parsed = parseManifestFiles(manifestText);
  if (parsed.problem !== null) {
    throw new Error(`${where} ${parsed.problem}`);
  }
  const out: SplitEntry[] = [];
  for (const [path, shaped] of Object.entries(parsed.files)) {
    if (shaped.class !== "split") continue;
    if (!isCleanRelativePath(path)) {
      throw new Error(
        `${where}: split entry path '${path}' is not a clean relative path - it ` +
          "could escape the target root at the rebuild's write; the manifest is damaged",
      );
    }
    if (typeof shaped.marker !== "string" || !ASCII_MARKER_RE.test(shaped.marker)) {
      throw new Error(
        `${where}: split entry for ${path} lacks a printable-ASCII marker line ` +
          "(markers are matched against latin1-decoded file bytes)",
      );
    }
    const grammar = knownGrammar(shaped.grammar);
    if (grammar === null) {
      // Reachable on purpose (the manifest text is untrusted): the typed
      // dispatch below cannot fall through, so unknown grammars must be
      // refused HERE, before any carry could guess. Registered in
      // scripts/guard_registry.ts (split-entries-unknown-grammar-refusal).
      throw new Error(
        `${where}: split entry for ${path} declares ${
          "grammar" in shaped ? `unknown grammar ${JSON.stringify(shaped.grammar)}` : "no grammar"
        } - this carry refuses to guess (a new grammar needs its own carry here)`,
      );
    }
    out.push(SPLIT_PARSERS[grammar](where, path, shaped.marker, shaped));
  }
  return out;
}

/** Fail closed before any per-file HEAD read: a missing repository or an
 * unborn HEAD must abort the carry, not read as "every file is new". */
function requireHead(root: string): void {
  const proc = capture(["git", "-C", root, "rev-parse", "--verify", "HEAD"]);
  if (proc.exitCode !== 0) {
    throw new Error(`cannot resolve HEAD in ${root}: ${proc.stderr.trim()}`);
  }
}

/** The file's pre-render state at the target's HEAD (headEntry owns the
 * probe semantics): decoded content for a regular file, the bare non-blob
 * kind for a directory/symlink/submodule (which has NO file content to
 * carry - `git show`'s answer for those is a tree listing or the link
 * target, never a previous copy), or absent. latin1, not utf-8: the
 * pre-render copy is the byte-owned repo half. */
type HeadContent =
  | { kind: "blob"; content: string }
  | { kind: "non-blob"; object: HeadNonBlobKind }
  | { kind: "absent" };

function headContent(root: string, rel: string): HeadContent {
  const entry = headEntry(root, rel);
  return entry.kind === "blob" ? { kind: "blob", content: entry.bytes.toString("latin1") } : entry;
}

/** The outcome note for a split path whose previous copy is not a regular
 * file: nothing could be split out or carried, so the clean render stands
 * and the note routes the PR to manual review. */
function nonBlobNote(object: HeadNonBlobKind): string {
  return (
    `the previous commit carries a ${object} at this path, not a regular file - no ` +
    "repository-local content could be split out or carried, and the fresh render " +
    "replaces it; reconcile against the previous copy in git history manually"
  );
}

/** Land `content` as a REGULAR file at `rel` under `root`. writeFileSync
 * follows an existing symlink, so a split path a repo replaced with a link
 * would have its TARGET overwritten - possibly outside the checkout; the
 * rebuild owns the manifest path itself, so a symlink there is removed
 * first. The same traversal exists one level up: a symlinked ANCESTOR
 * directory (a repo committing `.github -> elsewhere`) would carry the
 * write outside the checkout with the final component looking clean, so
 * every ancestor is lstat'd and a link among them refuses loudly (the
 * rebuild does not own directories, so it never replaces one). latin1:
 * the content is byte-owned (see the header). A directory at the path is
 * left for writeFileSync to fail on loudly. */
function writeRegularFile(root: string, rel: string, content: string): void {
  let ancestor = dirname(rel);
  for (; ancestor !== "." && ancestor !== "/"; ancestor = dirname(ancestor)) {
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(join(root, ancestor));
    } catch {
      stat = null;
    }
    if (stat?.isSymbolicLink()) {
      throw new Error(
        `refusing to write ${rel}: its ancestor '${ancestor}' is a symbolic link, ` +
          "so the write would land outside the checkout's own tree",
      );
    }
  }
  const path = join(root, rel);
  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(path);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink()) rmSync(path);
  writeFileSync(path, Buffer.from(content, "latin1"));
}

interface FileOutcome {
  rel: string;
  note: string;
  /** Reasons this carry needs human review (empty = auto-merge-eligible). */
  reviewReasons: string[];
  /** For a managed-half reset: the local-edit lines the rebuild dropped
   * (in HEAD's managed half, in neither the old render's half nor the
   * delivered one), itemized in the summary the way the conflict resolver
   * itemizes dropped hunks - a reviewer restoring an edit needs the lines,
   * not just the fact of the reset. */
  resetLines?: string[];
}

/** One split entry's carry over (render, target): the delivered content
 * plus its summary note and review reasons, dispatched on the entry's
 * grammar. Null content change (carry === null) keeps the render.
 * Exhaustive: a new grammar member must fail compilation here, not
 * silently ride an existing carry. */
function carrySplitEntry(
  entry: SplitEntry,
  render: string,
  target: string,
  mode: "recopy" | "render",
): { content: string; note: string | null; appendixCarry: boolean; reviewReasons: string[] } {
  const reviewReasons: string[] = [];
  switch (entry.grammar) {
    case "bounded-region": {
      // The manifest and the render are generated together: a declared
      // region the render does not carry means one of them is damaged, and
      // keeping the render here would silently drop HEAD's local body.
      if (localRegion(render, entry) === null) {
        throw new Error(
          `the manifest declares a bounded-region split for ${entry.path}, but the ` +
            "render carries no such local region - manifest and render disagree",
        );
      }
      const carry = carryLocalRegion(render, target, entry);
      if (carry === null) {
        return { content: render, note: null, appendixCarry: false, reviewReasons };
      }
      if (carry.disposition === "appendix") reviewReasons.push("recovery-appendix");
      return {
        content: carry.content,
        note: REGION_NOTES[carry.disposition],
        appendixCarry: carry.disposition === "appendix",
        reviewReasons,
      };
    }
    case "tail-marker": {
      const carry = carryManagedTail(render, target, entry.marker);
      if (carry === null) {
        return { content: render, note: null, appendixCarry: false, reviewReasons };
      }
      if (carry.kind === "appendix") {
        reviewReasons.push("recovery-appendix");
      } else if (carry.extraMarkers) {
        reviewReasons.push("duplicate split markers");
      }
      return {
        content: carry.content,
        note: tailNote(carry, mode),
        appendixCarry: carry.kind === "appendix",
        reviewReasons,
      };
    }
    default: {
      // Unreachable by construction: SplitEntry derives from the GRAMMAR
      // table's SplitShapes, so a new grammar makes `entry` non-never here
      // and this switch a tsc error until it carries its own arm. The
      // throw only backstops data smuggled past the type system.
      const unhandled: never = entry;
      throw new Error(`unhandled split grammar: ${JSON.stringify(unhandled)}`);
    }
  }
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
  const render = readFileSync(renderPath).toString("latin1");
  const target = headContent(root, rel);

  let content = render;
  let note: string | null = null;
  let appendixCarry = false;
  let resetLines: string[] | undefined;
  const reviewReasons: string[] = [];
  if (target.kind === "non-blob") {
    // No previous file content exists to split or carry, and embedding
    // `git show`'s non-blob answer as a "previous copy preserved in full"
    // would be false - the clean render stands, the note routes the PR to
    // manual review, and the tail tripwire independently flags the shape.
    note = nonBlobNote(target.object);
    reviewReasons.push("previous copy not a regular file");
  } else if (target.kind === "blob") {
    const carried = carrySplitEntry(entry, render, target.content, "render");
    content = carried.content;
    note = carried.note;
    appendixCarry = carried.appendixCarry;
    reviewReasons.push(...carried.reviewReasons);
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
      // The GRAMMAR row's side column: which half managedHalf calls
      // managed for this entry's grammar.
      const side = grammarSpec(entry.grammar).side;
      const marker = grammarWireMarker(entry.grammar, entry);
      const targetHalf = managedHalf(target.content, marker, side);
      const deliveredHalf = managedHalf(content, marker, side);
      if (targetHalf !== null && deliveredHalf !== null && targetHalf === deliveredHalf) {
        // Nothing from the previous managed half was dropped.
      } else {
        const oldRenderPath = join(oldRenderDir, rel);
        const oldHalf = existsSync(oldRenderPath)
          ? managedHalf(readFileSync(oldRenderPath).toString("latin1"), marker, side)
          : null;
        if (targetHalf === null || deliveredHalf === null || oldHalf === null) {
          note =
            note === null ? MANAGED_UNVERIFIABLE_NOTE : `${note}; ${MANAGED_UNVERIFIABLE_NOTE}`;
          reviewReasons.push("managed half unverifiable");
        } else if (targetHalf !== oldHalf) {
          note = note === null ? MANAGED_RESET_NOTE : `${note}; ${MANAGED_RESET_NOTE}`;
          reviewReasons.push("managed-half edits reset");
          // The reviewer restores from lines, not from the fact of a
          // reset: itemize the local ADDITIONS (in HEAD's half beyond the
          // old render's) the delivered half no longer carries. Both
          // sides are taken relative to the OLD render so multiset counts
          // stay honest - comparing HEAD's additions against the whole
          // delivered half would let a baseline occurrence of a line
          // absorb the dropped local duplicate of the same line.
          resetLines = missingLines(
            missingLines(targetHalf, oldHalf).join("\n"),
            missingLines(deliveredHalf, oldHalf).join("\n"),
          );
        }
      }
    }
  }
  // Unconditional write: the working tree holds copier's merged result,
  // which this mode exists to discard - even a byte-identical rewrite is
  // the correct statement of ownership.
  writeRegularFile(root, rel, content);
  return note === null ? null : { rel, note, reviewReasons, resetLines };
}

const RENDER_INTRO = [
  "Split-class files were rebuilt structurally over this update: the managed",
  "half comes from a clean render at the new template ref, the",
  "repository-local half byte-for-byte from the previous commit, and",
  "copier's merged result for these files was discarded. Local edits inside",
  "a managed half do NOT survive this rebuild (managed halves are",
  "template-owned); such edits are reset and flagged below. Each bullet",
  "names its file's actual disposition (not every file has previous content",
  "to carry); verify each file's diff before merging:",
];

const RECOPY_INTRO = [
  "Repo-local content carried over the recovery re-render - the re-render",
  "has no three-way merge and had reset these sanctioned repository-local",
  "regions. Each bullet names its file's actual disposition (not every file",
  "has previous content to carry); verify each file's diff before merging:",
];

// The summary shares the PR body with every other section, and gh fails
// outright past the 64 KiB body cap (see open_pr.ts) - so the reset-line
// excerpts are bounded three ways, like tail_tripwire's report: lines per
// file, characters per line via clip (a minified line must not blow the
// body), and total bytes across ALL files' excerpts (many reset files
// must not add up past the cap). The full diff is in the PR itself; the
// excerpt is the itemized starting point.
const MAX_EXCERPT_LINES = 40;
const MAX_LINE_CHARS = 300;
const MAX_EXCERPT_BYTES = 16384;

/** Control bytes escaped as visible \\xNN (lossless) - a raw NUL
 * reaching gh's --body argv kills the spawn and the delivery channel.
 * Tab stays literal; `keepNewlines` keeps LF and CR literal too, for
 * multi-line blocks where they are structure, not content. */
export function escapeControlBytes(text: string, keepNewlines = false): string {
  const re = keepNewlines
    ? // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control bytes to escape them is this regex's whole job
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
    : // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control bytes to escape them is this regex's whole job
      /[\x00-\x08\x0a-\x1f\x7f]/g;
  return text.replace(re, (control) => {
    return `\\x${control.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

/** One display line for a PR-body excerpt: escapeControlBytes plus a
 * per-line length cap (one enormous target-controlled value must not blow
 * the body budget). tail_tripwire.ts and preserve_repo_owned.ts reuse it. */
export function clip(text: string): string {
  const printable = escapeControlBytes(text);
  return printable.length > MAX_LINE_CHARS
    ? `${printable.slice(0, MAX_LINE_CHARS)} [clipped]`
    : printable;
}

/** A fence long enough that no shown line can close it early. */
export function fenceFor(lines: string[]): string {
  let longest = 3;
  for (const line of lines) {
    for (const match of line.matchAll(/`+/g)) {
      longest = Math.max(longest, match[0].length);
    }
  }
  return "`".repeat(longest + 1);
}

/** A markdown-fenced excerpt of dropped lines, charged against the shared
 * budget by its COMPLETE rendered size - a backtick-run line inflates the
 * fences far past the line bytes alone. Sheds trailing lines until the
 * true total fits; null when nothing fits (the caller writes a count-only
 * note). Exported for its unit tests. */
export function fencedResetExcerpt(
  lines: string[],
  budget: number,
): { text: string; cost: number } | null {
  const shown: string[] = [];
  let spent = 0;
  for (const line of lines) {
    if (shown.length >= MAX_EXCERPT_LINES) break;
    const clipped = clip(line);
    const lineCost = Buffer.byteLength(clipped, "utf-8") + 3;
    if (spent + lineCost > budget) break;
    spent += lineCost;
    shown.push(clipped);
  }
  const render = () => {
    const fence = fenceFor(shown);
    const omitted = lines.length - shown.length;
    const tail = omitted > 0 ? `\n  (${omitted} more; see this file's diff)` : "";
    return `  ${fence}text\n${shown.map((line) => `  ${line}`).join("\n")}\n  ${fence}${tail}`;
  };
  // The line loop only approximates: verify the true rendered size and
  // shed lines until it fits (popping a backtick-heavy line also shrinks
  // the fence, so this always converges).
  while (shown.length > 0) {
    const text = render();
    const cost = Buffer.byteLength(text, "utf-8");
    if (cost <= budget) return { text, cost };
    shown.pop();
  }
  return null;
}

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
    // Recopy mode: the working tree IS the fresh render, its manifest
    // included - recover=recopy re-renders at the current template, which
    // always ships the manifest.
    const manifestPath = join(root, MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
      throw new Error(
        `${root} has no ${MANIFEST_NAME}; the recovery carry needs the recopied render's manifest to know which files are split`,
      );
    }
    for (const entry of splitEntries(readFileSync(manifestPath, "utf-8"), manifestPath)) {
      const renderPath = join(root, entry.path);
      if (!existsSync(renderPath)) {
        throw new Error(
          `${manifestPath} declares a split entry for ${entry.path}, but the recopied tree has no such file - manifest and render disagree`,
        );
      }
      const render = readFileSync(renderPath).toString("latin1");
      const target = headContent(root, entry.path);
      if (target.kind === "absent") continue;
      if (target.kind === "non-blob") {
        // Same statement as render mode: no previous file content exists,
        // the recopied render stands as a regular file, and the note goes
        // to the recovery PR (recopy runs are manual wholesale).
        writeRegularFile(root, entry.path, render);
        rebuiltRels.push(entry.path);
        outcomes.push({ rel: entry.path, note: nonBlobNote(target.object), reviewReasons: [] });
        continue;
      }
      const carried = carrySplitEntry(entry, render, target.content, "recopy");
      if (carried.note === null) continue;
      writeRegularFile(root, entry.path, carried.content);
      rebuiltRels.push(entry.path);
      // Recovery PRs take the manual path wholesale (recover=recopy is a
      // hand-driven run), so recopy-mode outcomes carry no review reasons.
      outcomes.push({ rel: entry.path, note: carried.note, reviewReasons: [] });
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
    let excerptBudget = MAX_EXCERPT_BYTES;
    summary = [
      ...(renderDir !== undefined ? RENDER_INTRO : RECOPY_INTRO),
      "",
      ...outcomes.map(({ rel, note, resetLines }) => {
        if (resetLines === undefined || resetLines.length === 0) {
          return `- \`${rel}\`: ${note}`;
        }
        const excerpt = fencedResetExcerpt(resetLines, excerptBudget);
        if (excerpt === null) {
          return `- \`${rel}\`: ${note}. The reset dropped ${resetLines.length} line(s) (excerpt omitted: report size limit; see this file's diff).`;
        }
        excerptBudget -= excerpt.cost;
        return `- \`${rel}\`: ${note}. The reset dropped these line(s):\n\n${excerpt.text}\n`;
      }),
      "",
    ].join("\n");
    if (hideDetails) {
      // Neutral counting, not "carried": a non-blob disposition carried
      // nothing, and this line must stay true for every outcome kind.
      console.log(
        `${outcomes.length} split file(s) carry a disposition note ` +
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
          ? `${lines.length} split file(s) need review; the PR stays manual (details in the PR body)`
          : `${lines.length} split file(s) need review; the PR stays manual`,
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

#!/usr/bin/env bun
// Rebuilds split-class files structurally, in one of two modes. In BOTH
// modes the file list and each file's split markers come from an ownership
// manifest's class "split" entries (.github/repo-platform-manifest.json) -
// nothing here hardcodes marker lines or file names, so a future file with
// different markers rides the same carry instead of silently degrading.
//
// ONE grammar (managed-region): every split file is [optional repo-owned
// content above] BEGIN marker line, managed content, END marker line,
// [optional repo-owned content below]. The rebuild delivers the target's
// own sides byte-for-byte around the fresh render's managed region. The
// retired split shapes (tail-marker, the old four-marker bounded-region
// .gitignore shape) are no longer converted: the fleet is censused fully
// post-conversion, head_manifest.ts refuses their manifests loudly with
// recovery advice, and a straggler's old-shaped copy rides the recovery
// appendix (manual review) instead of a conversion.
//
// RENDER MODE (--render-dir; the PRIMARY path, run on every normal sync):
// after `copier update`, the merged result for every split-class file is
// DISCARDED and the file is rebuilt structurally - the managed region from
// the clean render at the new template ref, the repository-owned sides
// byte-for-byte from the pre-update HEAD. The split entries come from the
// new render's own manifest, so the rebuild can never miss a file the
// template splits. The merge never touches mixed-ownership content: a
// template retraction cannot eat a local side, and a local side cannot
// resurrect retracted managed lines. The deliberate flip side: local
// edits INSIDE the managed region no longer survive by merge luck - they
// are RESET to the fresh render on every sync, loudly (a reset note in the
// summary plus the needs-review flag). Edits are detected against the OLD
// ref's clean render (--old-render-dir), so a routine template change to
// the managed region does not read as a local edit.
//
// RECOPY MODE (no --render-dir; the recovery path): a recovery re-render
// (recover=recopy) has no usable old ref, so there are no clean renders to
// consume - the recopy result in the working tree IS the fresh render,
// manifest included. The split entries come from that manifest, the
// pre-recovery content from HEAD, and the same carry splices the
// repository-owned content back over the re-render.
//
// Both modes share the same carry. All file content is handled as
// latin1 text (one code unit per byte, the stamp_manifest.ts convention):
// the repo-owned sides are promised byte-for-byte, and a utf-8 decode would
// fold any non-UTF-8 byte onto U+FFFD - silent corruption. The markers are
// ASCII, so matching is unaffected. Loud beats lossy: NO shape of
// previous copy may lose content without a disposition in the summary -
// when a previous copy cannot be trusted to split (its declared markers
// are missing, duplicated - even as mid-line text - or reversed, or
// HEAD's manifest exists but is unusable, so no declaration for it can be
// read at all), the WHOLE previous copy is appended below the managed
// region's END marker under a marked recovery-appendix comment, marker
// text dash-joined so the validator's exactly-once rule holds, instead of
// being dropped.
//
// The carried files land in --summary as markdown for the PR body; for a
// hide-details target the log prints counts only (paths and dispositions
// are target data). Carries that need human review - an appendix, reset
// managed-region edits - are listed in the --needs-review flag file, which
// open_pr.ts turns into the manual-review path; clean side-restores stay
// auto-merge-eligible.
//
// Usage:
//   bun preserve_local_content.ts --summary FILE [--root target]
//     [--hide-details true|false] [--needs-review FILE]
//     [--rebuilt-paths FILE] [--render-dir DIR --old-render-dir DIR]

import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cleanManagedRegion,
  GRAMMAR,
  type GrammarId,
  knownGrammar,
  type SplitShapes,
  substringCount,
} from "../../../actions/shared/grammar.ts";
import {
  MANIFEST_NAME,
  type ManifestEntryShape,
  parseManifestFiles,
} from "../../../actions/shared/manifest.ts";
import { isCommentMarker } from "../../../scripts/ownership.ts";
import { parseFlags } from "../shared/flags.ts";
import { type HeadNonBlobKind, headEntry } from "../shared/git_head.ts";
import { capture } from "../shared/proc.ts";
import {
  type HeadSplit,
  headSplitEntries,
  isCleanRelativePath,
  managedPart,
  repoOwnedSides,
} from "./head_manifest.ts";

function withTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

/** A declared marker made inert for an appendix carry: spaces dash-joined;
 * a space-free marker gets a dash right after its comment opener ("<!--"
 * or the leading "#"), so the inert form still reads as a comment in the
 * marker's own syntax but no longer counts as the marker anywhere - the
 * validator and the region slicers count substrings, and a verbatim
 * re-appended marker would double the exactly-once count. */
function inertMarker(marker: string): string {
  const inert = marker.replaceAll(" ", "-");
  if (inert !== marker) return inert;
  const opener = marker.startsWith("<!--") ? "<!--" : marker.slice(0, 1);
  return `${opener}-${marker.slice(opener.length)}`;
}

/** The keep-both fallback: render, then the previous copy below the
 * managed region's END marker (repository-owned space) under a marked
 * comment - with every occurrence of the entry's markers in the previous
 * copy neutralized (the fresh render's pair must stay the file's ONLY
 * marker occurrences, or the recovery output itself fails validation with
 * advice pointing away from the real cause). The comment spelling follows
 * the entry's marker syntax: an HTML comment for HTML-comment markers,
 * hash comments otherwise (.gitattributes, .editorconfig,
 * .github/CODEOWNERS - an HTML comment there would parse as file
 * content). */
function withRegionAppendix(
  render: string,
  target: string,
  markers: { begin: string; end: string },
): string {
  const htmlStyle = markers.begin.startsWith("<!--");
  const explanation = [
    "The template sync's re-render could not tell this file's",
    "repository-owned content apart from its managed region, so the",
    "previous copy is preserved in full below (any managed-region marker",
    "text in it is dash-joined to stay inert). Keep what is",
    "repository-owned, drop what the managed region above already covers,",
    "then delete this comment.",
  ];
  const appendix = htmlStyle
    ? ["<!-- repo-platform:recovery-appendix", `${explanation.join("\n")} -->`].join("\n")
    : ["# repo-platform:recovery-appendix", ...explanation.map((line) => `# ${line}`)].join("\n");
  let neutralized = target;
  for (const marker of [markers.begin, markers.end]) {
    neutralized = neutralized.replaceAll(marker, inertMarker(marker));
  }
  const content = `${withTrailingNewline(render)}\n${appendix}\n\n${withTrailingNewline(neutralized)}`;
  // Postcondition: neutralization must not have re-created any marker (a
  // replacement product could collide with the sibling marker). The
  // declared markers are schema-constrained against containing each other,
  // so a violation here means adversarially colliding markers - fail
  // loudly rather than deliver a file the validator's exactly-once rule
  // rejects.
  for (const marker of [markers.begin, markers.end]) {
    if (substringCount(content, marker) !== substringCount(render, marker)) {
      throw new Error(
        `appendix neutralization would change the '${marker}' marker's occurrence ` +
          "count - the declared region markers collide under neutralization; " +
          "declare markers whose neutralized forms cannot recreate each other",
      );
    }
  }
  return content;
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

export type RegionCarry =
  | {
      kind: "sides-restored";
      content: string;
    }
  | { kind: "appendix"; content: string };

/** The managed-region carry: the fresh render's managed region, the
 * previous copy's repository-owned sides byte-for-byte around it. The
 * previous copy is split by `headDecl` - its OWN manifest's declaration -
 * falling back to the new entry's markers only when HEAD's manifest is
 * usable and simply does not declare the path (an ownership flip).
 * "unusable" means HEAD's declarations exist but cannot be trusted (a
 * refused manifest - retired-grammar, pre-grammar, damaged - or a non-blob
 * at the manifest path): splitting such a copy by the NEW markers would be
 * a guess - an old-shaped copy whose repo-owned content happens to carry
 * one clean marker pair would hand the bytes between them to the managed
 * discard - so the whole copy rides the appendix instead. Null means keep
 * the render with nothing to say: the previous copy never diverged
 * (delivered content would equal the render), or an unsplittable previous
 * copy is blank. Throws when the RENDER has no clean region - manifest and
 * render are generated together, so that is damage, and keeping the merged
 * result would hand the file back to the merge this rebuild exists to
 * discard. */
export function carryManagedRegion(
  render: string,
  target: string,
  entry: SplitEntry,
  headDecl: HeadSplit | "unusable" | undefined,
): RegionCarry | null {
  const renderSlice = cleanManagedRegion(render, entry);
  if (renderSlice === null) {
    throw new Error(
      `the manifest declares a managed-region split for ${entry.path}, but the ` +
        "render carries no clean BEGIN/END region - manifest and render disagree",
    );
  }
  // A previous copy byte-identical to the fresh render has nothing to
  // lose under ANY declaration state - keeping the render is exact even
  // when HEAD's manifest is unusable, and skipping here keeps an unusable
  // manifest from spraying appendixes over every unchanged split file.
  if (target === render) return null;
  const sides =
    headDecl === "unusable"
      ? null
      : repoOwnedSides(
          target,
          headDecl ?? { path: entry.path, begin: entry.begin, end: entry.end },
        );
  if (sides === null) {
    // No trustworthy split (the previous copy was hand-edited past
    // recognition, or HEAD's manifest is unusable and no declaration can
    // be trusted). Keep BOTH unless the previous copy is blank: silently
    // losing the repository's content is the defect this script exists to
    // fix, and an appendix carry forces manual review, so a marked
    // duplicate is acceptable.
    if (target.trim() === "") return null;
    return { kind: "appendix", content: withRegionAppendix(render, target, entry) };
  }
  // A render whose END line has no trailing newline still joins cleanly:
  // the seam newline belongs to the join, not to the byte-owned side.
  const region = sides.below !== "" ? withTrailingNewline(renderSlice.region) : renderSlice.region;
  const content = sides.above + region + sides.below;
  if (content === render) return null;
  return { kind: "sides-restored", content };
}

const CARRY_NOTES: Record<RegionCarry["kind"], string> = {
  "sides-restored":
    "repository-owned content outside the managed region restored from the repository's copy",
  appendix:
    "managed region not recognized in the repository's previous copy; the previous " +
    "copy is preserved in full below the END marker under a " +
    "repo-platform:recovery-appendix comment - reconcile manually",
};

const MANAGED_REGION_DIFFERS_NOTE =
  "; the managed content differed from the fresh render; those differences are " +
  "not carried - review the diff";

const MANAGED_RESET_NOTE =
  "local edits INSIDE the managed region were RESET to the fresh render - managed " +
  "regions are template-owned and rebuilt on every sync; content that must survive " +
  "belongs outside the BEGIN/END markers (above the region, or below it)";

const MANAGED_UNVERIFIABLE_NOTE =
  "the previous copy's managed content could not be located (its marker lines are " +
  "missing there, or the file has no old-render baseline), so local edits inside " +
  "it cannot be ruled out - the fresh render stands; review the diff for content " +
  "that belongs outside the managed region";

function carryNote(carry: RegionCarry, mode: "recopy" | "render", managedDiffers: boolean): string {
  switch (carry.kind) {
    case "sides-restored":
      // Render mode reports managed-region drift against the OLD render
      // (the reset note, appended by the caller); against the NEW render
      // every routine template change would read as dropped local edits.
      return (
        CARRY_NOTES["sides-restored"] +
        (mode === "recopy" && managedDiffers ? MANAGED_REGION_DIFFERS_NOTE : "")
      );
    case "appendix":
      return CARRY_NOTES.appendix;
  }
}

/** One parsed split entry: the manifest path plus the grammar's own
 * declaration fields, DERIVED from the GRAMMAR table's SplitShapes - so
 * the entry union's grammar arm set IS GrammarId by construction. The sync
 * leg cannot know a grammar the table lacks, nor silently miss one it has:
 * a new table row makes this union grow, and every dispatch below goes red
 * at tsc until it answers for the new arm. */
export type SplitEntry = { [K in GrammarId]: { path: string } & SplitShapes[K] }[GrammarId];

/** Markers are matched against latin1-decoded file bytes, so a non-ASCII
 * marker (utf-8 in the manifest, one code unit per byte in the file) could
 * never match and the carry would silently degrade; the declaration schema
 * forbids it, and this boundary re-checks what it consumes. NON-EMPTY is
 * load-bearing too: the marker-line predicate matches line.trim() ===
 * marker, so an empty marker selects the synthetic empty line at EOF. */
const ASCII_MARKER_RE = /^[\x20-\x7e]+$/;

// isCleanRelativePath moved to head_manifest.ts (the shared manifest-key
// trust boundary); re-exported for starter_pin_rollout.ts and the tests.
export { isCleanRelativePath };

/** The per-grammar split-entry parsers, total over GrammarId BY TYPE: a
 * GRAMMAR table row with no parser here is a tsc error, never a runtime
 * fallthrough. The parser re-checks what the manifest text claims (the
 * declaration schema upstream never emits a violation, but the text rides
 * through a checkout this script must not trust): every marker string must
 * be printable ASCII, open in a comment syntax the recovery appendix can
 * write (a hash or complete HTML comment), and the pair must be mutually
 * substring-free (the exactly-once counting and the appendix
 * neutralization count substrings). The wireFields column names the
 * fields, so the field list is stated once (the validator's manifest
 * check reads the same column). */
const SPLIT_PARSERS: {
  [K in GrammarId]: (
    where: string,
    path: string,
    shaped: ManifestEntryShape,
  ) => { path: string } & SplitShapes[K];
} = {
  "managed-region": (where, path, shaped) => {
    const spec = GRAMMAR["managed-region"];
    const strings = spec.wireFields.map((field) => shaped[field]);
    if (!strings.every((value) => typeof value === "string" && ASCII_MARKER_RE.test(value))) {
      throw new Error(
        `${where}: split entry for ${path} lacks printable-ASCII begin/end marker ` +
          "strings (markers are matched against latin1-decoded file bytes) - the " +
          "manifest is damaged",
      );
    }
    const [begin, end] = strings as [string, string];
    for (const value of [begin, end]) {
      if (!isCommentMarker(value)) {
        throw new Error(
          `${where}: split entry for ${path} declares region marker '${value}', ` +
            "which is not a hash comment or a complete HTML comment line - the " +
            "recovery appendix writes comments in the markers' syntax; the manifest is damaged",
        );
      }
    }
    if (begin === end || begin.includes(end) || end.includes(begin)) {
      throw new Error(
        `${where}: split entry for ${path} declares region markers that contain ` +
          "each other - exactly-once counting and appendix neutralization count " +
          "substrings, so the pair must be substring-free; the manifest is damaged",
      );
    }
    return { path, grammar: "managed-region", begin, end };
  },
};

/** The class "split" entries of a render's ownership manifest - the single
 * source of which files the template splits and each file's marker lines.
 * Malformed data throws, an unknown or missing grammar included: silently
 * skipping an entry (or guessing its grammar) would hand that file back to
 * the merge result this mode exists to discard. Read through the shared
 * parser (actions/shared/manifest.ts), which also rejects duplicated keys
 * - raw JSON.parse would last-win them, and a duplicated class field could
 * silently declassify a split entry out of every carry. */
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
    out.push(SPLIT_PARSERS[grammar](where, path, shaped));
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

/** HEAD's split declarations for splitting HEAD's copies with HEAD's own
 * manifest. Three states, because the two failure shapes must not blur:
 * - a Map when the manifest is usable (a path absent from it falls back to
 *   the new entry's markers - an ownership flip, with its own review
 *   machinery);
 * - "unusable" when a manifest EXISTS at HEAD but cannot be trusted (a
 *   non-blob at the path, or headSplitEntries' loud refusal: pre-grammar,
 *   retired-grammar, damaged) - declarations exist that the carry cannot
 *   read, so every previous copy rides the appendix rather than a
 *   guessed split, and the tail tripwire independently reports the
 *   refusal with its recovery advice;
 * - null when no manifest exists at HEAD at all (nothing ever declared a
 *   split, so the new entries' markers are the only truth available and
 *   the carry falls back to them). */
type HeadDecls = Map<string, HeadSplit> | "unusable" | null;

function readHeadDecls(root: string): HeadDecls {
  const headManifest = headEntry(root, MANIFEST_NAME);
  if (headManifest.kind === "absent") return null;
  if (headManifest.kind !== "blob") return "unusable";
  try {
    return headSplitEntries(headManifest.bytes.toString("utf-8"), `HEAD:${MANIFEST_NAME}`);
  } catch {
    return "unusable";
  }
}

/** One path's declaration under the three HeadDecls states. */
function headDeclFor(headDecls: HeadDecls, path: string): HeadSplit | "unusable" | undefined {
  if (headDecls === null) return undefined;
  if (headDecls === "unusable") return "unusable";
  return headDecls.get(path);
}

/** The file's pre-render state at the target's HEAD (headEntry owns the
 * probe semantics): decoded content for a regular file, the bare non-blob
 * kind for a directory/symlink/submodule (which has NO file content to
 * carry - `git show`'s answer for those is a tree listing or the link
 * target, never a previous copy), or absent. latin1, not utf-8: the
 * pre-render copy carries the byte-owned repo sides. */
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
    "repository-owned content could be split out or carried, and the fresh render " +
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
  /** For a managed-region reset: the local-edit lines the rebuild dropped
   * (in HEAD's managed content, in neither the old render's nor the
   * delivered one), itemized in the summary the way the conflict resolver
   * itemizes dropped hunks - a reviewer restoring an edit needs the lines,
   * not just the fact of the reset. */
  resetLines?: string[];
}

/** One split entry's carry over (render, target): the delivered content
 * plus its summary note and review reasons. Null note keeps the render. */
function carrySplitEntry(
  entry: SplitEntry,
  render: string,
  target: string,
  headDecl: HeadSplit | "unusable" | undefined,
  mode: "recopy" | "render",
): { content: string; note: string | null; appendixCarry: boolean; reviewReasons: string[] } {
  const reviewReasons: string[] = [];
  const carry = carryManagedRegion(render, target, entry, headDecl);
  if (carry === null) {
    return { content: render, note: null, appendixCarry: false, reviewReasons };
  }
  if (carry.kind === "appendix") {
    reviewReasons.push("recovery-appendix");
  }
  const entryDecl: HeadSplit = { path: entry.path, begin: entry.begin, end: entry.end };
  const previousDecl = typeof headDecl === "object" ? headDecl : entryDecl;
  const managedDiffers =
    managedPart(target, previousDecl) !== managedPart(carry.content, entryDecl);
  return {
    content: carry.content,
    note: carryNote(carry, mode, managedDiffers),
    appendixCarry: carry.kind === "appendix",
    reviewReasons,
  };
}

/** Render mode, per split entry: DISCARD the working tree's merged copy
 * and rebuild from (clean new render, HEAD copy); detect managed-region
 * edits against the OLD render. Returns the outcome when the file carried
 * content or needs review; null when the clean rebuild needs no human
 * attention (that includes every routine template change). */
function rebuildSplitFile(
  root: string,
  renderDir: string,
  oldRenderDir: string,
  entry: SplitEntry,
  headDecl: HeadSplit | "unusable" | undefined,
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
    const carried = carrySplitEntry(entry, render, target.content, headDecl, "render");
    content = carried.content;
    note = carried.note;
    appendixCarry = carried.appendixCarry;
    reviewReasons.push(...carried.reviewReasons);
    // Did the rebuild drop bytes from the previous managed content? Each
    // copy is split by ITS OWN declaration - HEAD's copy and the OLD
    // render by the previous commit's manifest declaration, the delivered
    // copy by the new entry. Byte-equal parts mean nothing was dropped; a
    // drop that equals the template update (HEAD's part == the old
    // render's part) is routine and silent; a drop past that means local
    // edits were reset (loud, manual review).
    // A part that cannot be located on any side is UNVERIFIABLE, not
    // clean - a mangled marker must not slip a content drop past review.
    // An appendix carry skips all of this: it preserves the full previous
    // copy below the render and is already manual.
    if (!appendixCarry) {
      const entryDecl: HeadSplit = { path: rel, begin: entry.begin, end: entry.end };
      const previousDecl = typeof headDecl === "object" ? headDecl : entryDecl;
      const targetPart = managedPart(target.content, previousDecl);
      const deliveredPart = managedPart(content, entryDecl);
      if (targetPart !== null && deliveredPart !== null && targetPart === deliveredPart) {
        // Nothing from the previous managed content was dropped.
      } else {
        const oldRenderPath = join(oldRenderDir, rel);
        const oldPart = existsSync(oldRenderPath)
          ? managedPart(readFileSync(oldRenderPath).toString("latin1"), previousDecl)
          : null;
        if (targetPart === null || deliveredPart === null || oldPart === null) {
          note =
            note === null ? MANAGED_UNVERIFIABLE_NOTE : `${note}; ${MANAGED_UNVERIFIABLE_NOTE}`;
          reviewReasons.push("managed region unverifiable");
        } else if (targetPart !== oldPart) {
          note = note === null ? MANAGED_RESET_NOTE : `${note}; ${MANAGED_RESET_NOTE}`;
          reviewReasons.push("managed-region edits reset");
          // The reviewer restores from lines, not from the fact of a
          // reset: itemize the local ADDITIONS (in HEAD's managed content
          // beyond the old render's) the delivered copy no longer
          // carries. Both sides are taken relative to the OLD render so
          // multiset counts stay honest - comparing HEAD's additions
          // against the whole delivered region would let a baseline
          // occurrence of a line absorb the dropped local duplicate of
          // the same line.
          resetLines = missingLines(
            missingLines(targetPart, oldPart).join("\n"),
            missingLines(deliveredPart, oldPart).join("\n"),
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
  "region comes from a clean render at the new template ref, the",
  "repository-owned content outside it byte-for-byte from the previous",
  "commit, and copier's merged result for these files was discarded. Local",
  "edits inside a managed region do NOT survive this rebuild (managed",
  "regions are template-owned); such edits are reset and flagged below.",
  "Each bullet names its file's actual disposition (not every file has",
  "previous content to carry); verify each file's diff before merging:",
];

const RECOPY_INTRO = [
  "Repo-owned content carried over the recovery re-render - the re-render",
  "has no three-way merge and had reset these sanctioned repository-owned",
  "sides. Each bullet names its file's actual disposition (not every file",
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
      "--render-dir and --old-render-dir come together: the rebuild takes the managed region from the new render and detects managed-region edits against the old one",
    );
  }
  requireHead(root);
  const headDecls = readHeadDecls(root);

  const outcomes: FileOutcome[] = [];
  // Every file this script WROTE, for the conflict resolver's --skip list:
  // a carried repository side may legitimately contain conflict-marker-shaped
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
      const outcome = rebuildSplitFile(
        root,
        renderDir,
        oldRenderDir,
        entry,
        headDeclFor(headDecls, entry.path),
      );
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
      const carried = carrySplitEntry(
        entry,
        render,
        target.content,
        headDeclFor(headDecls, entry.path),
        "recopy",
      );
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

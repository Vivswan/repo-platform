#!/usr/bin/env bun
// HEAD-manifest split declarations: how the PREVIOUS commit of a target
// repository declared its split files, every vintage the fleet can
// present. The post-sync manifest knows one grammar (managed-region:
// repo-owned content above a BEGIN marker line and below an END marker
// line, sync owning the bounded region between them); HEAD manifests are
// older by exactly one sync, so during the one-grammar transition they can
// still declare the two RETIRED grammars:
//
// - tail-marker: one marker line ended the sync-owned top; the repository
//   owned everything below it. Repo-owned sides: above is empty, below is
//   everything after the FIRST marker line (splitting at the first keeps
//   every later line, so a stale duplicate marker can only ever ADD
//   reviewable lines, never drop them).
// - bounded-region (the four-marker .gitignore shape): the managed half
//   ran from its BEGIN marker line ("marker" on the wire) to end of file.
//   Repo-owned sides: above is everything above that line (the old LOCAL
//   region, its marker lines included, rides through as ordinary
//   repo-owned bytes), below is empty.
//
// TRANSITION SHIM, deliberately scoped: reading the retired vintages out
// of HEAD is what lets the sync CONVERT a tail-marker or old-bounded file
// to the managed-region shape with its repo-owned bytes preserved exactly
// - dropping them instead would be live-state destruction, the one thing
// that justifies a shim. Once the fleet is censused all-converted, delete
// the legacy arms here and let the unknown-grammar refusal below cover
// them (the same lifecycle the pre-grammar manifest fallback followed:
// carried for one transition, then retired with a loud refusal).
//
// Everything here fails CLOSED: a manifest this module cannot read in
// full throws with an actionable message, and the callers route the throw
// to their fail-closed paths (unverifiable tripwire findings, the
// held-for-review deletion axis, the recovery appendix) - never to a
// guessed split.

import {
  cleanManagedRegion,
  isMarkerLine,
  knownGrammar,
  markerLineCount,
  splitLines,
  substringCount,
} from "../../../actions/shared/grammar.ts";
import { hasDuplicateJsonKeys } from "../shared/json.ts";

/** Markers are matched against latin1-decoded file bytes, so a non-ASCII
 * marker (utf-8 in the manifest, one code unit per byte in the file) could
 * never match and the split would silently degrade; every vintage's
 * markers are re-checked at this trust boundary. NON-EMPTY is load-bearing
 * too: an empty marker would select the synthetic empty line at EOF. */
const ASCII_MARKER_RE = /^[\x20-\x7e]+$/;

function requireAsciiMarker(where: string, path: string, value: unknown, field: string): string {
  if (typeof value !== "string" || !ASCII_MARKER_RE.test(value)) {
    throw new Error(
      `${where}: split entry for ${path} lacks a printable-ASCII '${field}' marker ` +
        "string (markers are matched against latin1-decoded file bytes) - the manifest is damaged",
    );
  }
  return value;
}

/** Manifest keys become filesystem paths under the target root, so a key
 * that could escape it (absolute, or carrying .. segments) is refused at
 * this trust boundary - and a tampered key could never match the
 * post-sync manifest's clean key, so accepting one would silently skip
 * the real file's check. One definition for every manifest-key walker:
 * preserve_local_content.ts and starter_pin_rollout.ts re-use it. */
export function isCleanRelativePath(path: string): boolean {
  return (
    path !== "" &&
    !/[\r\n]/.test(path) &&
    !path.startsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** One HEAD split declaration, discriminated by manifest vintage. */
export type HeadSplit =
  | { vintage: "managed-region"; path: string; begin: string; end: string }
  | { vintage: "tail-marker"; path: string; marker: string }
  | { vintage: "bounded-region"; path: string; managed_begin: string };

/** Every class any manifest vintage has stamped: the current three plus
 * the retired mergeable era. An entry spelling anything else ("spllt") is
 * damage that could be hiding a split declaration, so the whole manifest
 * is rejected to the callers' fail-closed path. */
const KNOWN_HEAD_CLASSES = new Set(["managed", "split", "starter", "mergeable"]);

/** The RETIRED split grammars this reader still converts (see the shim
 * note above). */
const LEGACY_GRAMMARS = new Set(["tail-marker", "bounded-region"]);

/** How HEAD's manifest declares its splits, strictly parsed per vintage.
 * Every entry's ownership class must be on the known roster - reading a
 * damaged class ("spllt") as merely non-split would drop that file from
 * the candidates and let a retirement delete its repo-owned half. Every
 * split entry must carry the grammar field: the fleet is fully
 * post-grammar (censused 2026-09), the pre-grammar fallback that re-read
 * a bare marker/managed pair is retired, and a manifest still presenting
 * that shape gets this loud, actionable refusal instead. A grammar that
 * is neither current nor a retired vintage this shim converts is refused
 * the same way - never split by a guessed grammar. */
export function headSplitEntries(text: string, where: string): Map<string, HeadSplit> {
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
  // any non-mapping shape.
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new Error(`${where} has no top-level 'files' mapping`);
  }
  const out = new Map<string, HeadSplit>();
  for (const [path, entry] of Object.entries(files as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      // Fail closed: a damaged entry must route the manifest to the
      // callers' unverifiable paths, not silently skip its file.
      throw new Error(`${where}: entry for ${path} is not an object`);
    }
    const shaped = entry as Record<string, unknown>;
    if (typeof shaped.class !== "string" || !KNOWN_HEAD_CLASSES.has(shaped.class)) {
      throw new Error(
        `${where}: entry for ${path} declares no ownership class this sync knows - the ` +
          "damage could be hiding a split declaration",
      );
    }
    if (shaped.class !== "split") continue;
    if (!isCleanRelativePath(path)) {
      throw new Error(
        `${where}: split entry path '${path}' is not a clean relative path - it could ` +
          "never match the post-sync manifest's clean key, so reading it would skip " +
          "the real file's check; the manifest is damaged",
      );
    }
    if (!("grammar" in shaped)) {
      // The path rides LAST: callers clip this message into PR-body
      // excerpts, and a long target-controlled path must truncate itself,
      // never the diagnosis or the recovery advice.
      throw new Error(
        `${where}: a split entry declares no grammar - this manifest predates the ` +
          "stamped split grammar, which this sync no longer reads; run a recovery " +
          `sync (recover=recopy) against this repository to restamp its manifest. The entry is ${path}`,
      );
    }
    if (knownGrammar(shaped.grammar) === "managed-region") {
      out.set(path, {
        vintage: "managed-region",
        path,
        begin: requireAsciiMarker(where, path, shaped.begin, "begin"),
        end: requireAsciiMarker(where, path, shaped.end, "end"),
      });
      continue;
    }
    if (shaped.grammar === "tail-marker") {
      // The retired wire is re-checked in FULL: the old emitter always
      // wrote the side as "above" for this grammar, so a contradicting
      // side is damage - reading it as managed-above anyway could hand a
      // repo-owned top to the managed discard.
      if (shaped.managed !== "above") {
        throw new Error(
          `${where}: a split entry declares the retired tail-marker grammar with a ` +
            "managed side other than 'above' - the manifest is inconsistent; run a " +
            `recovery sync (recover=recopy) to restamp it. The entry is ${path}`,
        );
      }
      out.set(path, {
        vintage: "tail-marker",
        path,
        marker: requireAsciiMarker(where, path, shaped.marker, "marker"),
      });
      continue;
    }
    if (shaped.grammar === "bounded-region") {
      // The old wire carried the managed BEGIN line as "marker", the side
      // as "below", and three more marker strings. Only the BEGIN line is
      // needed to locate the repo-owned side (everything above it), but
      // the whole retired shape is validated - a partial shape is damage,
      // not a vintage.
      if (shaped.managed !== "below") {
        throw new Error(
          `${where}: a split entry declares the retired bounded-region grammar with a ` +
            "managed side other than 'below' - the manifest is inconsistent; run a " +
            `recovery sync (recover=recopy) to restamp it. The entry is ${path}`,
        );
      }
      for (const field of ["managed_end", "local_begin", "local_end"]) {
        requireAsciiMarker(where, path, shaped[field], field);
      }
      out.set(path, {
        vintage: "bounded-region",
        path,
        managed_begin: requireAsciiMarker(where, path, shaped.marker, "marker"),
      });
      continue;
    }
    throw new Error(
      `${where}: a split entry declares split grammar ${JSON.stringify(shaped.grammar)}, ` +
        "which this sync does not read (one grammar exists: managed-region, plus the " +
        `retired vintages the transition converts: ${[...LEGACY_GRAMMARS].join(", ")}) - ` +
        "refusing to guess a split boundary; run a recovery sync (recover=recopy) " +
        `against this repository to restamp its manifest. The entry is ${path}`,
    );
  }
  return out;
}

/** The repository-owned sides of a previous copy, located by ITS OWN
 * declaration: above and below the managed area, byte-for-byte. Null when
 * the copy does not split honestly at the declared markers (missing,
 * duplicated - even as mid-line text for the region vintages - or
 * reversed): a copy whose boundary cannot be honestly located is never
 * guessed at. `extraMarkers` flags a tail-marker copy carrying more than
 * one marker line (everything after the FIRST rides in `below`, so a
 * stale duplicate adds reviewable lines rather than dropping content). */
export function repoOwnedSides(
  content: string,
  decl: HeadSplit,
): { above: string; below: string; extraMarkers: boolean } | null {
  switch (decl.vintage) {
    case "managed-region": {
      const slice = cleanManagedRegion(content, decl);
      if (slice === null) return null;
      return { above: slice.above, below: slice.below, extraMarkers: false };
    }
    case "tail-marker": {
      const lines = splitLines(content);
      const first = lines.findIndex((line) => isMarkerLine(line.text, decl.marker));
      if (first === -1) return null;
      const extraMarkers = lines.some(
        (line, index) => index > first && isMarkerLine(line.text, decl.marker),
      );
      return { above: "", below: content.slice(lines[first].end), extraMarkers };
    }
    case "bounded-region": {
      // Strict exactly-once: splitting at the FIRST of several BEGIN lines
      // would fold the content between duplicates into the managed half,
      // which the rebuild DISCARDS - unlocatable beats lossy.
      if (
        markerLineCount(content, decl.managed_begin) !== 1 ||
        substringCount(content, decl.managed_begin) !== 1
      ) {
        return null;
      }
      const lines = splitLines(content);
      const begin = lines.findIndex((line) => isMarkerLine(line.text, decl.managed_begin));
      const start = begin === 0 ? 0 : lines[begin - 1].end;
      return { above: content.slice(0, start), below: "", extraMarkers: false };
    }
    default: {
      const unhandled: never = decl;
      throw new Error(`unhandled HEAD split vintage: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** The sync-owned part of a copy, by its own declaration: the managed
 * region (current vintage), the top through the marker line (tail-marker),
 * or the BEGIN line to end of file (old bounded-region). Null when the
 * markers are missing. The managed-half drop check compares these across
 * HEAD, the old render, and the delivered copy. */
export function managedPart(content: string, decl: HeadSplit): string | null {
  const sides = repoOwnedSides(content, decl);
  if (sides === null) return null;
  return content.slice(sides.above.length, content.length - sides.below.length);
}

/** The repository-owned content as ONE text (above and below joined on a
 * newline when both are non-empty), for line-multiset checks and PR-body
 * excerpts. Null when the copy does not split at its declaration. */
export function repoOwnedText(content: string, decl: HeadSplit): string | null {
  const sides = repoOwnedSides(content, decl);
  if (sides === null) return null;
  if (sides.above === "") return sides.below;
  if (sides.below === "") return sides.above;
  return `${sides.above}\n${sides.below}`;
}

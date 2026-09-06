#!/usr/bin/env bun
// HEAD-manifest split declarations: how the PREVIOUS commit of a target
// repository declared its split files. ONE grammar exists (managed-region:
// repo-owned content above a BEGIN marker line and below an END marker
// line, sync owning the bounded region between them), and HEAD manifests
// ride the same strict vocabulary as post-sync ones: a manifest declaring
// any other grammar, or no grammar, is refused with recovery advice
// (recover=recopy) - never read, never split by a guessed boundary. The
// sync carries no tolerance for shapes it no longer stamps; a transition
// that needs one is a migration ladder rung (docs/migrations.md).
//
// Everything here fails CLOSED: a manifest this module cannot read in
// full throws with an actionable message, and the callers route the throw
// to their fail-closed paths (unverifiable tripwire findings, the
// held-for-review deletion axis, the recovery appendix) - never to a
// guessed split.

import { cleanManagedRegion, knownGrammar } from "../../../actions/shared/grammar.ts";
import { hasDuplicateJsonKeys } from "../shared/json.ts";

/** Markers are matched against latin1-decoded file bytes, so a non-ASCII
 * marker (utf-8 in the manifest, one code unit per byte in the file) could
 * never match and the split would silently degrade; the markers are
 * re-checked at this trust boundary. NON-EMPTY is load-bearing too: an
 * empty marker would select the synthetic empty line at EOF. */
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
 * preserve_local_content.ts re-uses it. */
export function isCleanRelativePath(path: string): boolean {
  return (
    path !== "" &&
    !/[\r\n]/.test(path) &&
    !path.startsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** One HEAD split declaration: the entry's path and its managed-region
 * marker pair. */
export type HeadSplit = { path: string; begin: string; end: string };

/** The ownership classes the stamp writes. An entry spelling anything else
 * ("spllt") is damage that could be hiding a split declaration, so the
 * whole manifest is rejected to the callers' fail-closed path. */
const KNOWN_HEAD_CLASSES = new Set(["managed", "split", "starter"]);

/** How HEAD's manifest declares its splits, strictly parsed. Every entry's
 * ownership class must be on the known roster - reading a damaged class
 * ("spllt") as merely non-split would drop that file from the candidates
 * and let a retirement delete its repo-owned half. Every split entry must
 * carry the managed-region grammar; anything else gets this loud,
 * actionable refusal - never a split by a guessed grammar. */
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
          "damage could be hiding a split declaration; run a recovery sync (recover=recopy) " +
          "against this repository to restamp its manifest",
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
        `${where}: a split entry declares no grammar, so this sync cannot read it; run a ` +
          "recovery sync (recover=recopy) against this repository to restamp its manifest. " +
          `The entry is ${path}`,
      );
    }
    if (knownGrammar(shaped.grammar) === "managed-region") {
      out.set(path, {
        path,
        begin: requireAsciiMarker(where, path, shaped.begin, "begin"),
        end: requireAsciiMarker(where, path, shaped.end, "end"),
      });
      continue;
    }
    // Kept SHORT on purpose - callers clip this message into PR-body
    // excerpts (300 chars), and the recovery advice must survive the clip,
    // with the target-controlled values (the entry path, then the declared
    // grammar) riding last so they truncate themselves, never the diagnosis
    // or the advice. The prose stays tight enough that a normal-length path
    // and grammar both fit inside the clip.
    throw new Error(
      `${where}: a split entry declares a grammar this sync does not read ` +
        "(only managed-region) - refusing to guess; run a recovery sync " +
        `(recover=recopy) to restamp it. Entry ${path}, split grammar ` +
        JSON.stringify(shaped.grammar),
    );
  }
  return out;
}

/** The repository-owned sides of a previous copy, located by ITS OWN
 * declaration: above and below the managed region, byte-for-byte. Null
 * when the copy does not split honestly at the declared markers (missing,
 * duplicated - even as mid-line text - or reversed): a copy whose boundary
 * cannot be honestly located is never guessed at. */
export function repoOwnedSides(
  content: string,
  decl: HeadSplit,
): { above: string; below: string } | null {
  const slice = cleanManagedRegion(content, decl);
  if (slice === null) return null;
  return { above: slice.above, below: slice.below };
}

/** The sync-owned part of a copy, by its own declaration: the managed
 * region between its marker lines, both lines included. Null when the
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

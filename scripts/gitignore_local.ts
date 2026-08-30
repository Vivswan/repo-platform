// The bounded-region local-content grammar, shared by the writers that
// must agree on it: scripts/build_gitignore.ts (regenerates this repo's
// own .gitignore around the existing LOCAL body) and
// .github/scripts/sync/preserve_local_content.ts (splices a target repo's
// local region body into a fresh render). One owner on purpose: a
// duplicate that drifted would let one writer mis-slice what the other
// produced. The .gitignore marker constants below are the grammar's
// default instance; the sync carry passes each split entry's DECLARED
// markers instead, so a future bounded-region file with different marker
// lines slices with the same one definition.
//
// actions/validate-template deliberately does NOT import this module: the
// action ships standalone and enforces its own marker rules.

import { GRAMMAR, type RegionSplit } from "../actions/shared/grammar.ts";

export const LOCAL_BEGIN = "# BEGIN REPOSITORY LOCAL";
export const LOCAL_END = "# END REPOSITORY LOCAL";
export const MANAGED_BEGIN = "# BEGIN REPO-PLATFORM MANAGED";
export const MANAGED_END = "# END REPO-PLATFORM MANAGED";
export const GITIGNORE_MARKERS = [LOCAL_BEGIN, LOCAL_END, MANAGED_BEGIN, MANAGED_END];

/** Every marker line a grammar instance owns, for the
 *  no-marker-text-inside-the-body rule and appendix neutralization -
 *  read from the GRAMMAR row's markers column, so a grammar instance can
 *  never disagree with its own roster. */
export function allRegionMarkers(markers: RegionSplit): readonly string[] {
  return GRAMMAR["bounded-region"].markers(markers);
}

export const GITIGNORE_REGION: RegionSplit = {
  local_begin: LOCAL_BEGIN,
  local_end: LOCAL_END,
  managed_begin: MANAGED_BEGIN,
  managed_end: MANAGED_END,
};

export interface Line {
  text: string;
  /** Index just past the line's newline (or end of content). */
  end: number;
}

export function splitLines(content: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      out.push({ text: content.slice(start, i), end: i + 1 });
      start = i + 1;
    }
  }
  if (start < content.length) out.push({ text: content.slice(start), end: content.length });
  return out;
}

export function stripCr(text: string): string {
  return text.replace(/\r+$/, "");
}

/** The local region split line-anchored on the grammar's BEGIN/END marker
 * lines: before runs through the BEGIN line, body sits between the
 * markers, after starts at the END line. Null when no ordered BEGIN/END
 * line pair exists. This is the raw slice; writers slicing an EXISTING
 * file must use cleanLocalRegion below, which rejects malformed shapes
 * instead of guessing. */
export function localRegion(
  content: string,
  markers: RegionSplit,
): { before: string; body: string; after: string } | null {
  const lines = splitLines(content);
  const begin = lines.findIndex((line) => stripCr(line.text) === markers.local_begin);
  if (begin === -1) return null;
  const end = lines.findIndex(
    (line, index) => index > begin && stripCr(line.text) === markers.local_end,
  );
  if (end === -1) return null;
  const bodyStart = lines[begin].end;
  const bodyEnd = lines[end - 1].end;
  return {
    before: content.slice(0, bodyStart),
    body: content.slice(bodyStart, bodyEnd),
    after: content.slice(bodyEnd),
  };
}

/** Count of lines whose CR-stripped text equals the marker. */
export function markerLineCount(content: string, marker: string): number {
  return splitLines(content).filter((line) => stripCr(line.text) === marker).length;
}

/** Substring occurrences, the way validate_generated_files counts. */
export function substringCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

/** The local region of an EXISTING file, or null when the file is not
 * exactly-once clean: each REGION marker (begin/end) must appear once as a
 * whole line AND once as a substring (the validator counts substrings, so
 * marker text buried mid-line is a duplicate too), in order, with none of
 * the grammar's marker text inside the body (a body carrying MANAGED
 * marker text would duplicate it next to the regenerated managed section).
 * The managed markers OUTSIDE the body go unchecked on purpose: they sit
 * in the half the caller discards and rebuilds from the render, so they
 * cannot reach the delivered file. One definition for every writer that
 * slices an existing file - the sync carry and the self-output
 * regenerator must never split the same malformed file differently. */
export function cleanLocalRegion(
  content: string,
  markers: RegionSplit,
): { before: string; body: string; after: string } | null {
  const clean = [markers.local_begin, markers.local_end].every(
    (marker) => markerLineCount(content, marker) === 1 && substringCount(content, marker) === 1,
  );
  if (!clean) return null;
  const region = localRegion(content, markers);
  if (region === null) return null;
  if (allRegionMarkers(markers).some((marker) => region.body.includes(marker))) return null;
  return region;
}

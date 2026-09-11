// The split-grammar descriptor table: every per-grammar behavior the
// platform dispatches on, stated once as columns keyed by grammar id. ONE
// grammar exists, managed-region: [repo-owned above] BEGIN line, managed
// content, END line, [repo-owned below]; sync owns the bounded region only.
// A manifest naming any other grammar is refused loudly with recovery
// advice (head_manifest.ts, the validator's parity check), and
// scripts/ownership/declarations.ts welds GrammarId to the zod schema's
// grammar union, so a schema arm without a table row (or the reverse) is a
// compile error.
//
// This module also owns the split-file LINE SEMANTICS (marker predicate,
// region slicers) shared by every splitter. One owner on purpose: three
// sites once held three marker-line definitions, and the strictest sent a
// marker line with one trailing space down a different path than the others.
//
// DEPENDENCY-FREE ZONE: actions/shared/ ships on the build branch and runs
// where no node_modules exist (composite actions before their own
// installs), so node builtins and
// zone-internal relative imports only; tests/actions/shared_zone.test.ts
// enforces it.

/** The managed-region declaration's grammar fields, structurally (the zod
 *  schema in scripts/ownership/declarations.ts stays the validation owner; these shapes
 *  exist so this zone needs no zod). The BEGIN and END marker lines bound
 *  the sync-owned region; the repository owns everything outside it, on
 *  both sides. */
export interface ManagedRegionSplit {
  grammar: "managed-region";
  begin: string;
  end: string;
}

/** Grammar id -> the declaration fields that grammar owns. */
export type SplitShapes = {
  "managed-region": ManagedRegionSplit;
};

export type GrammarId = keyof SplitShapes;

/** A managed-region grammar instance without its discriminant: the two
 *  marker strings alone - the shape the region slicers below and the
 *  validator's region tables consume. Derived, never restated: the fields
 *  are ManagedRegionSplit's own. */
export type RegionMarkers = Omit<ManagedRegionSplit, "grammar">;

/** The one marker vocabulary, per comment syntax. These are the shipped
 *  spellings every declaration uses (declarations restate them as data -
 *  YAML cannot import - and the schema validates the syntax); the
 *  contradiction scan in scripts/ownership/decoration_checks.ts unions these constants with
 *  the live declarations so it stays armed even when a declaration
 *  changes its marker text. */
export const HASH_REGION_MARKERS: RegionMarkers = {
  begin: "# BEGIN REPO-PLATFORM MANAGED",
  end: "# END REPO-PLATFORM MANAGED",
};

export const HTML_REGION_MARKERS: RegionMarkers = {
  begin: "<!-- BEGIN REPO-PLATFORM MANAGED -->",
  end: "<!-- END REPO-PLATFORM MANAGED -->",
};

/** A type that compiles only when `T` is never: the exhaustiveness pin for
 *  each wire-field tuple below (a declaration field missing from its tuple
 *  is a compile error, not a runtime gap). */
export type AssertNever<T extends never> = T;

/** The managed-region declaration's wire fields as a tuple: `satisfies`
 *  refuses a stranger, the AssertNever pin refuses an omission. */
export const MANAGED_REGION_WIRE_FIELDS = ["begin", "end"] as const satisfies readonly Exclude<
  keyof ManagedRegionSplit,
  "grammar"
>[];
/** Compile-time only. @public */
export type ManagedRegionWireFieldsExhaustive = AssertNever<
  Exclude<Exclude<keyof ManagedRegionSplit, "grammar">, (typeof MANAGED_REGION_WIRE_FIELDS)[number]>
>;

/** The grammar ids the manifest may name, as runtime data for the
 *  UNTRUSTED-input check below. */
export const GRAMMAR_IDS: readonly GrammarId[] = ["managed-region"];

/** Table membership for UNTRUSTED data (manifest text riding through a
 *  target checkout): the value narrowed to a GrammarId, or null. One
 *  narrowing owner, so the sync parse and the validator cannot disagree
 *  on what counts as a known grammar. */
export function knownGrammar(value: unknown): GrammarId | null {
  return typeof value === "string" && (GRAMMAR_IDS as readonly string[]).includes(value)
    ? (value as GrammarId)
    : null;
}

// --- split-file line semantics ------------------------------------------------

/** THE marker-line predicate: a line is a split entry's marker line when
 *  its trimmed text equals the marker exactly. One owner for every
 *  splitter in the pipeline (the stamper's hash slice, the validator's
 *  parity check, and the sync rebuild's carries). trim semantics on
 *  purpose: it is the most tolerant of the definitions it replaced, so a
 *  marker line with a stray trailing space splits the same way at every
 *  site. */
export function isMarkerLine(line: string, marker: string): boolean {
  return line.trim() === marker;
}

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

/** Count of lines that are the marker per isMarkerLine. */
export function markerLineCount(content: string, marker: string): number {
  return splitLines(content).filter((line) => isMarkerLine(line.text, marker)).length;
}

/** Substring occurrences, the way validate_generated_files counts. */
export function substringCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

/** A split file sliced at its declaration's marker LINES: above ends at
 *  the first BEGIN line, region runs from it through the first END line
 *  after it (newline included, when present), below is the remainder.
 *  Region is the sync-owned half the stamped hash covers. Null when either
 *  marker line is missing: there is no honest split. This is the raw
 *  slice; writers slicing an EXISTING repository copy must use
 *  cleanManagedRegion, which rejects malformed shapes instead of guessing. */
export interface RegionSlice {
  above: string;
  region: string;
  below: string;
}

export function splitManagedRegion(content: string, markers: RegionMarkers): RegionSlice | null {
  const lines = splitLines(content);
  const begin = lines.findIndex((line) => isMarkerLine(line.text, markers.begin));
  if (begin === -1) return null;
  const end = lines.findIndex(
    (line, index) => index > begin && isMarkerLine(line.text, markers.end),
  );
  if (end === -1) return null;
  const regionStart = begin === 0 ? 0 : lines[begin - 1].end;
  return {
    above: content.slice(0, regionStart),
    region: content.slice(regionStart, lines[end].end),
    below: content.slice(lines[end].end),
  };
}

/** The region slice of an EXISTING file, or null when the file is not
 *  exactly-once clean: each marker must appear once as a whole line AND
 *  once as a substring (the validator counts substrings, so marker text
 *  buried mid-line is a duplicate too), in order. One definition for
 *  every writer that slices an existing file - the sync carry and the
 *  gitignore self-output regenerator must never split the same malformed
 *  file differently. */
export function cleanManagedRegion(content: string, markers: RegionMarkers): RegionSlice | null {
  const clean = [markers.begin, markers.end].every(
    (marker) => markerLineCount(content, marker) === 1 && substringCount(content, marker) === 1,
  );
  if (!clean) return null;
  return splitManagedRegion(content, markers);
}

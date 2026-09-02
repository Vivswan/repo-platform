// The split-grammar descriptor table: every per-grammar behavior the
// platform dispatches on, stated once as columns keyed by grammar id.
//
// ONE grammar exists: managed-region. Every split file has the shape
// [optional repo-owned content above] BEGIN marker line, managed content,
// END marker line, [optional repo-owned content below] - the repository
// owns both sides, sync owns the bounded region. The two retired split
// grammars (tail-marker: managed top above one marker line; the
// four-marker bounded-region shape with a dedicated LOCAL region) were
// collapsed into this one; the fleet's transition is complete (censused
// 2026-09), and a HEAD manifest still declaring a retired vintage is
// refused loudly with recovery advice
// (.github/scripts/sync/head_manifest.ts).
//
// scripts/ownership.ts welds GrammarId to the zod schema's grammar union
// at the type level, so adding a schema arm without a full table row (or a
// row without a schema arm) is a compile error, and every consumer reads
// its answer from the row instead of guessing.
//
// This module also owns the split-file LINE SEMANTICS: the marker-line
// predicate and the region slicers every splitter in the pipeline shares
// (the stamper's hash, the sync rebuild's carries, the validator's parity
// check). One owner on purpose - three sites once held three marker-line
// definitions, and the strictest sent a marker line with one trailing
// space down a different path than the other two.
//
// DEPENDENCY-FREE ZONE: actions/shared/ ships on the build branch and is
// imported by code that runs where no node_modules exist (copier's stamp
// hook inside freshly rendered repositories, the composite actions before
// their own installs). Node builtins and zone-internal relative imports
// only - tests/actions/shared_zone.test.ts enforces it.

/** The managed-region declaration's grammar fields, structurally (the zod
 *  schema in scripts/ownership.ts stays the validation owner; these shapes
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
 *  contradiction scan in scripts/ownership.ts unions these constants with
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

/** One grammar's behavior columns. Every column is total on purpose: a new
 *  grammar must answer each question explicitly, never inherit a
 *  fallthrough. The declaration-reading columns take the fields WITHOUT
 *  the discriminant, so a caller holding the marker strings alone reads
 *  the same row. */
export interface GrammarSpec<Declaration> {
  /** Every marker string a declaration of this grammar owns, in the
   *  grammar's in-file order. */
  markers: (declaration: Omit<Declaration, "grammar">) => readonly string[];
  /** The declaration's marker-string fields in the manifest wire's field
   *  order: the emitter (actions/shared/manifest.ts) writes them under
   *  these names, and the sync parse plus the validator's manifest check
   *  require each as a string - so no spelling of the split fields exists
   *  outside this table. */
  wireFields: readonly Exclude<keyof Declaration, "grammar">[];
}

export const GRAMMAR: { [K in GrammarId]: GrammarSpec<SplitShapes[K]> } = {
  "managed-region": {
    markers: (declaration) => [declaration.begin, declaration.end],
    wireFields: ["begin", "end"],
  },
};

/** The one row lookup, loud on a miss: the type bridge makes a missing row
 *  a compile error, so a miss at runtime means data reached here past the
 *  type system (a cast, raw JSON) and must never fall through quietly.
 *  Own-property lookup: an inherited name ("constructor") must read as
 *  unknown, not as an Object.prototype function. */
export function grammarSpec<K extends GrammarId>(grammar: K): GrammarSpec<SplitShapes[K]> {
  const spec = Object.hasOwn(GRAMMAR, grammar) ? GRAMMAR[grammar] : undefined;
  if (spec === undefined) {
    throw new Error(
      `unknown split grammar '${String(grammar)}' - add its row to the GRAMMAR ` +
        "table (actions/shared/grammar.ts) together with its ownership-schema arm",
    );
  }
  return spec;
}

/** The marker strings a split declaration owns, via its grammar's row. */
export function grammarMarkers<K extends GrammarId>(
  grammar: K,
  declaration: SplitShapes[K],
): readonly string[] {
  return grammarSpec(grammar).markers(declaration);
}

/** Table membership for UNTRUSTED data (manifest text riding through a
 *  target checkout): the value narrowed to a GrammarId, or null. One
 *  narrowing owner, so the sync parse and the validator cannot disagree
 *  on what counts as a known grammar. Own-property lookup, like
 *  grammarSpec. */
export function knownGrammar(value: unknown): GrammarId | null {
  return typeof value === "string" && Object.hasOwn(GRAMMAR, value) ? (value as GrammarId) : null;
}

/** How many opening lines may hold the managed header: template sources
 *  keep it at the top, at most below a short jinja preamble that rendering
 *  collapses. One constant for the template-side decoration checks
 *  (scripts/ownership.ts) and the validator's rendered-file check. */
export const HEADER_WINDOW = 10;

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

export function stripCr(text: string): string {
  return text.replace(/\r+$/, "");
}

/** Count of lines that are the marker per isMarkerLine. */
export function markerLineCount(content: string, marker: string): number {
  return splitLines(content).filter((line) => isMarkerLine(line.text, marker)).length;
}

/** Substring occurrences, the way validate_generated_files counts. */
export function substringCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

/** A split file sliced at its declaration's marker LINES: above runs to
 *  the start of the first BEGIN line, region runs from that line through
 *  the first END line after it (its newline included, when present),
 *  below is the remainder. above and below are the repository-owned
 *  sides; region is the sync-owned half the stamped hash covers. Null
 *  when either marker line is missing - there is no honest split. This is
 *  the raw slice; writers slicing an EXISTING repository copy must use
 *  cleanManagedRegion below, which rejects malformed shapes instead of
 *  guessing. */
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

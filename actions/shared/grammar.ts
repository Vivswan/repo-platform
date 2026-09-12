// ONE grammar exists, managed-region: [repo-owned above] BEGIN line, managed content, END line, [repo-owned below];
// sync owns the bounded region only.
//
// DEPENDENCY-FREE ZONE: actions/shared/ ships on the build branch and runs where no node_modules exist (composite
// actions before their own installs), so node builtins and zone-internal relative imports only;
// tests/actions/shared_zone.test.ts enforces it.

export interface ManagedRegionSplit {
  grammar: "managed-region";
  begin: string;
  end: string;
}

export type SplitShapes = {
  "managed-region": ManagedRegionSplit;
};

export type GrammarId = keyof SplitShapes;

export type RegionMarkers = Omit<ManagedRegionSplit, "grammar">;

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

/** Manifest text rides through a target checkout, so a grammar id is validated here before the cast. */
export function knownGrammar(value: unknown): GrammarId | null {
  return typeof value === "string" && (GRAMMAR_IDS as readonly string[]).includes(value)
    ? (value as GrammarId)
    : null;
}

// --- split-file line semantics ------------------------------------------------

/** trim on purpose: a marker line with a stray trailing space must split the same way at every splitter
 *  (the writer's split and retire carries, the validator's parity check, the gitignore regenerator). */
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

export function markerLineCount(content: string, marker: string): number {
  return splitLines(content).filter((line) => isMarkerLine(line.text, marker)).length;
}

/** Substring occurrences, the way validate_managed_files counts. */
export function substringCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

/** `region` is the sync-owned half the stamped hash covers. splitManagedRegion is the raw slice; writers slicing an
 *  EXISTING repository copy use cleanManagedRegion, which rejects malformed shapes instead of guessing. */
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

/** Once as a substring too, not only as a line: the validator counts substrings, so marker text buried mid-line is a
 *  duplicate. The sync carries and the gitignore self-output regenerator all slice through here, so they never split
 *  the same malformed file differently. */
export function cleanManagedRegion(content: string, markers: RegionMarkers): RegionSlice | null {
  const clean = [markers.begin, markers.end].every(
    (marker) => markerLineCount(content, marker) === 1 && substringCount(content, marker) === 1,
  );
  if (!clean) return null;
  return splitManagedRegion(content, markers);
}

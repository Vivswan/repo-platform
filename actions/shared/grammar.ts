// The split-grammar descriptor table: every per-grammar behavior the
// platform dispatches on, stated once as columns keyed by grammar id.
//
// Before the table, each consumer decided grammar behavior with its own
// conditional - managedSide defaulted the side for grammars it did not
// recognise, the roster builders skipped them, ownMarkers returned empty -
// so a grammar added to the ownership schema fell through every site
// SILENTLY except the one that threw. Now scripts/ownership.ts welds
// GrammarId to the zod schema's grammar union at the type level, so adding
// a schema arm without a full table row (or a row without a schema arm) is
// a compile error, and every site reads its answer from the row instead of
// guessing.
//
// DEPENDENCY-FREE ZONE: actions/shared/ ships on the build branch and is
// imported by code that runs where no node_modules exist (copier's stamp
// hook inside freshly rendered repositories, the composite actions before
// their own installs). Node builtins and zone-internal relative imports
// only - tests/actions/shared_zone.test.ts enforces it.

/** The tail-marker declaration's grammar fields, structurally (the zod
 *  schema in scripts/ownership.ts stays the validation owner; these shapes
 *  exist so this zone needs no zod). One marker line ends the sync-owned
 *  top; the repository owns everything below it. */
export interface TailMarkerSplit {
  grammar: "tail-marker";
  marker: string;
}

/** The bounded-region declaration's grammar fields: a BEGIN/END-bounded
 *  repository-local region sits above the sync-owned half, which runs from
 *  its own BEGIN marker line to end of file. */
export interface BoundedRegionSplit {
  grammar: "bounded-region";
  managed_begin: string;
  managed_end: string;
  local_begin: string;
  local_end: string;
}

/** Grammar id -> the declaration fields that grammar owns. */
export type SplitShapes = {
  "tail-marker": TailMarkerSplit;
  "bounded-region": BoundedRegionSplit;
};

export type GrammarId = keyof SplitShapes;

/** The two marker vocabularies a source can claim ownership with; the
 *  foreign-marker scan keeps one roster of declared marker strings per
 *  kind. */
export type MarkerKind = "tail" | "region";

/** One grammar's behavior columns. Every column is total on purpose: a new
 *  grammar must answer each question explicitly (null is an explicit
 *  answer), never inherit a fallthrough. */
export interface GrammarSpec<Declaration> {
  /** Every marker string a declaration of this grammar owns, in the
   *  grammar's in-file order. */
  markers: (declaration: Declaration) => readonly string[];
  /** Which foreign-marker roster the grammar's markers join; null keeps
   *  them off both rosters. */
  roster: MarkerKind | null;
  /** Which half of the split file sync owns; null for a grammar with no
   *  single managed side. */
  side: "above" | "below" | null;
  /** How the validator's per-file ownership tables enforce the grammar:
   *  "marker" entries require the (single) marker line, "header" entries
   *  the managed header; null means the grammar has dedicated tables
   *  instead (bounded-region: the region tables). */
  enforce: "header" | "marker" | null;
}

export const GRAMMAR: { [K in GrammarId]: GrammarSpec<SplitShapes[K]> } = {
  "tail-marker": {
    markers: (declaration) => [declaration.marker],
    roster: "tail",
    side: "above",
    enforce: "marker",
  },
  "bounded-region": {
    markers: (declaration) => [
      declaration.local_begin,
      declaration.local_end,
      declaration.managed_begin,
      declaration.managed_end,
    ],
    roster: "region",
    side: "below",
    enforce: null,
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

/** How many opening lines may hold the managed header: template sources
 *  keep it at the top, at most below a short jinja preamble that rendering
 *  collapses. One constant for the template-side decoration checks
 *  (scripts/ownership.ts) and the validator's rendered-file check. */
export const HEADER_WINDOW = 10;

/** A bounded-region split grammar in the validator tables' dialect: the
 *  repo-owned local region's BEGIN/END lines above the managed half, which
 *  runs from managedBegin to end of file (managedEnd included). */
export interface RegionSplitGrammar {
  managedBegin: string;
  managedEnd: string;
  localBegin: string;
  localEnd: string;
}

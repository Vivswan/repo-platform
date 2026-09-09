// The decoration checks: a template source's managed header and region
// marker lines validated against its DECLARED class, with the foreign-marker
// scan stated once for every class.

import {
  grammarMarkers,
  HASH_REGION_MARKERS,
  HEADER_WINDOW,
  HTML_REGION_MARKERS,
} from "../../actions/shared/grammar.ts";
import type { OwnershipDeclaration } from "./declarations.ts";

/** The managed ownership header in template sources, anchored on the
 *  header sentence's canonical trailing period with no repo-name character
 *  (GitHub allows [A-Za-z0-9._-]) after it, so neither a negated
 *  look-alike ("is not managed by") nor a longer repo name
 *  ("/repo-platform_fork", "/repo-platform.fork") counts; the
 *  validator's checks/headers.ts (actions/validate-template-report/validator) applies the same anchoring
 *  to rendered files. */
export const MANAGED_HEADER_RE =
  /This file is managed by \{\{ github_username \}\}\/repo-platform\.(?![A-Za-z0-9._-])/;

/** The managed-region marker texts the fleet actually ships, kept as a
 *  CONSTANT set beside the derived set. Deriving from current declarations
 *  alone is self-disarming: retiring the last declaration using a spelling
 *  would empty the derived set and silence the contradiction scan on
 *  exactly the flip the scan exists to catch. The union of constant and
 *  derived is what gets scanned. The spellings come from the grammar
 *  table's own vocabulary constants, so this set cannot drift from what
 *  the templates ship. */
export const REGION_MARKER_LINES = new Set([
  HASH_REGION_MARKERS.begin,
  HASH_REGION_MARKERS.end,
  HTML_REGION_MARKERS.begin,
  HTML_REGION_MARKERS.end,
]);

/** Whether a template source opens with the managed header (decoration;
 *  the class itself is declared, never inferred from this). */
export function hasManagedHeader(source: string): boolean {
  return MANAGED_HEADER_RE.test(source.split("\n", HEADER_WINDOW).join("\n"));
}

/** Every marker string the declared split grammars own. The schema accepts
 *  arbitrary marker text, so the shipped constants alone would miss a
 *  custom declared marker copied into a managed or starter source;
 *  declarationTextErrors unions this derived list with
 *  REGION_MARKER_LINES. Deriving ALONE is self-disarming and the union
 *  must stay: the constants are what keep the scan armed when no
 *  declaration using a spelling is left in the tree. */
export function declaredMarkerTexts(declarations: Iterable<OwnershipDeclaration>): string[] {
  const out = new Set<string>();
  for (const declaration of declarations) {
    if (declaration.class !== "split") continue;
    for (const marker of grammarMarkers(declaration.grammar, declaration)) {
      out.add(marker);
    }
  }
  return [...out];
}

// --- the foreign-marker rule, stated once -------------------------------------

/** The markers a declaration itself owns. managed and starter own none -
 *  which is exactly what makes every marker in the tree foreign to them. */
function ownMarkers(declaration: OwnershipDeclaration): readonly string[] {
  if (declaration.class !== "split") return [];
  return grammarMarkers(declaration.grammar, declaration);
}

/** How a declaration names itself inside a contradiction message. */
function declaredAs(declaration: OwnershipDeclaration): string {
  switch (declaration.class) {
    case "starter":
      return "a starter";
    case "managed":
      return "managed";
    case "split":
      return "split (managed-region)";
    default:
      return String((declaration as { class: unknown }).class);
  }
}

/** The one contradiction message a foreign marker gets: what the source
 *  CLAIMS by carrying the marker, what the rebuild would do about it, and
 *  the fix. Two families fill it. If the declaration owns markers of its
 *  own, the file carries a SECOND marker set and the rebuild - which
 *  splits by this declaration's markers alone - overwrites whatever the
 *  other set promised. If it owns none, the marker promises a
 *  sync-maintained region the declared class never keeps. */
function foreignMarkerMessage(
  marker: string,
  own: readonly string[],
  declaration: OwnershipDeclaration,
  where: string,
): string {
  const say = (claim: string, consequence: string, remedy: string) =>
    `${where}: carries the '${marker}' ${claim} - ${consequence}; ${remedy}`;
  if (own.length > 0) {
    return say(
      "region marker, which is not one of this declaration's own pair",
      "sync rebuilds at the DECLARED markers and would overwrite the " +
        "repo-owned area that marker promises",
      "drop it or declare the file under the markers it carries",
    );
  }
  const claim = `region marker but is declared ${declaredAs(declaration)}`;
  return declaration.class === "starter"
    ? say(
        claim,
        "the marker promises a sync-maintained managed region that a starter never gets",
        "drop one",
      )
    : say(
        claim,
        "sync would overwrite the repo-owned content the markers promise to preserve",
        "declare the file split (grammar managed-region) or drop the marker",
      );
}

// --- foreign-marker scanning ---------------------------------------------------

/** Markers in the source that this declaration does not own, at most one.
 *  Sync dispatches on the DECLARED markers alone, so a foreign marker makes
 *  the rebuild treat the repo-owned area it promises as its own and
 *  overwrite it. Matching is TEXT PRESENCE anywhere (a line, a tag, a prose
 *  mention), the validator's own substring semantics: deciding what could
 *  RENDER as a live marker needs a jinja evaluator, and an over-claim costs
 *  a reword at compose time while an under-claim ships a silent ownership
 *  bypass. An occurrence inside an own-marker occurrence is that marker's. */
function foreignMarkerErrors(
  declaration: OwnershipDeclaration,
  source: string,
  roster: readonly string[],
  where: string,
): string[] {
  const own = ownMarkers(declaration);
  // Every position the declaration's own markers occupy, overlapping
  // occurrences included.
  const ownSpans: [number, number][] = [];
  for (const owned of own) {
    for (let at = source.indexOf(owned); at !== -1; at = source.indexOf(owned, at + 1)) {
      ownSpans.push([at, at + owned.length]);
    }
  }
  const outsideOwn = (candidate: string): boolean => {
    for (let at = source.indexOf(candidate); at !== -1; at = source.indexOf(candidate, at + 1)) {
      const end = at + candidate.length;
      if (!ownSpans.some(([start, stop]) => start <= at && end <= stop)) return true;
    }
    return false;
  };
  const foreign = [...new Set(roster)].filter((text) => !own.includes(text)).find(outsideOwn);
  if (foreign !== undefined) {
    return [foreignMarkerMessage(foreign, own, declaration, where)];
  }
  return [];
}

/** Errors when a template source's decoration contradicts its declared class
 *  or grammar. Purely textual, purely per-file: the declaration is the
 *  classification, headers and marker lines are validated decoration, never
 *  classification input. `skipMatched` says whether copier.yml's
 *  _skip_if_exists exempts the landed path (the starter class and the skip
 *  list must agree in both directions). `declaredMarkers` is every declared
 *  grammar's marker strings over ALL sources; with the shipped constants they
 *  form the roster the foreign-marker scan checks each declaration against. */
export function declarationTextErrors(
  declaration: OwnershipDeclaration,
  source: string,
  skipMatched: boolean,
  declaredMarkers: readonly string[],
  where: string,
): string[] {
  // The foreign-marker rule runs FIRST and for every declaration, so the
  // split arm below states only what is true of its OWN markers. The
  // roster unions the SHIPPED marker constants with the texts derived
  // from live declarations. Deriving alone is self-disarming - retiring
  // the last declaration using a spelling would empty the roster and
  // silence the scan on exactly the flip it exists to catch - and the
  // constants alone would miss a custom declared marker copied into
  // another source.
  const roster = [...REGION_MARKER_LINES, ...declaredMarkers];
  const foreign = foreignMarkerErrors(declaration, source, roster, where);
  if (foreign.length > 0) return foreign;

  const errors: string[] = [];
  if (declaration.class === "starter") {
    if (!skipMatched) {
      errors.push(
        `${where}: declared a starter but no copier.yml _skip_if_exists pattern ` +
          `matches '${declaration.path}' - copier would overwrite the file on every ` +
          "sync; add the skip entry or fix the declared class",
      );
    }
    if (hasManagedHeader(source)) {
      errors.push(
        `${where}: opens with the managed header but is declared a starter - the ` +
          "header promises sync overwrites the file, the starter class promises " +
          "it never does; drop one",
      );
    }
    return errors;
  }
  if (skipMatched) {
    errors.push(
      `${where}: declared ${declaration.class} but copier.yml's _skip_if_exists ` +
        `matches '${declaration.path}', which makes the file render-once and ` +
        "repo-owned; declare it a starter or drop the skip entry",
    );
  }
  // managed owns no markers at all, so the shared scan above is its whole
  // marker surface; the skip cross-check is all that is left here.
  if (declaration.class === "managed") return errors;
  // managed-region: both declared markers must appear exactly once, in
  // order (BEGIN before END). Matched as substrings rather than exact
  // lines - splicing can glue jinja tags onto a marker line - so the
  // RENDERED line grammar stays the validator's check, not this
  // decoration check's; exactly-once is counted the same substring way
  // the validator and appendix neutralization count. Content above BEGIN
  // and below END is legal: it renders as the repository-owned seed.
  const ordered: [string, string][] = [
    ["BEGIN", declaration.begin],
    ["END", declaration.end],
  ];
  let previous = -1;
  for (const [name, marker] of ordered) {
    const count = source.split(marker).length - 1;
    if (count === 0) {
      errors.push(
        `${where}: declared split (managed-region) but the source does not ` +
          `carry the '${marker}' marker line - restore the marker or fix the declaration`,
      );
      continue;
    }
    if (count > 1) {
      errors.push(
        `${where}: the ${name} marker '${marker}' appears ${count} times - the ` +
          "region slicer and the validator's exactly-once rule both require one " +
          "copy; fix the source",
      );
    }
    const at = source.indexOf(marker);
    if (at <= previous) {
      errors.push(
        `${where}: the ${name} marker '${marker}' appears out of order (BEGIN ` +
          "before END) - the slicer and the managed-region hash both assume that " +
          "order; fix the source",
      );
    }
    previous = Math.max(previous, at);
  }
  return errors;
}

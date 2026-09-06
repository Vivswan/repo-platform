#!/usr/bin/env bun
// The single owner of template-file OWNERSHIP truth: how each file the
// template lands in a generated repository relates to sync.
//
// Three classes (the ownership manifest's vocabulary; a fourth,
// "mergeable" - baseline kept current by three-way merge - was retired
// when settings.yml, its only member, became a starter):
// - managed: sync overwrites the whole file; local edits are replaced.
// - split: sync owns the BEGIN/END-bounded managed region; the repository
//   owns everything outside it, above and below (the one grammar,
//   managed-region - the tail-marker and four-marker bounded-region
//   grammars were retired into it).
// - starter: rendered once, repo-owned from then on (_skip_if_exists).
//
// Ownership is DECLARED as data, never inferred from file text:
// templates/base/ownership.yml covers every base file (loadBaseOwnership)
// and each templates/<module>/module.yml carries an `ownership:` list
// covering every file the module lands (ownershipListSchema, consumed by
// scripts/module_manifests.ts). Headers and marker lines in template
// sources are validated DECORATION: declarationTextErrors reports a
// source whose text contradicts its declared class, and the composer
// (scripts/compose_template.ts) errors on a landed file with no
// declaration, a declaration whose path never lands, and same-path
// declarations that disagree across sources.
//
// Consumers, all reading the same declarations so ownership can never fork:
// - scripts/compose_template.ts emits the ownership manifest
//   (.github/repo-platform-manifest.json) into the composed template tree.
// - scripts/generate.ts derives validate-template's MODULE_OWNERSHIP and
//   BASE_OWNERSHIP records (moduleOwnershipEntries / baseOwnershipTables
//   below).
//
// Per-grammar behavior (owned markers, wire fields) is the GRAMMAR
// descriptor table in actions/shared/grammar.ts; the schema's grammar
// union is welded to the table's key set at compile time (the
// Expect<Equal<...>> bridge below), so no consumer can meet a grammar the
// table has no row for.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type GrammarId,
  grammarMarkers,
  HASH_REGION_MARKERS,
  HEADER_WINDOW,
  HTML_REGION_MARKERS,
} from "../actions/shared/grammar.ts";
import type { ModuleManifest } from "./module_manifests.ts";

/** The managed ownership header in template sources, anchored on the
 *  header sentence's canonical trailing period with no repo-name character
 *  (GitHub allows [A-Za-z0-9._-]) after it, so neither a negated
 *  look-alike ("is not managed by") nor a longer repo name
 *  ("/repo-platform_fork", "/repo-platform.fork") counts; the
 *  validate-template action's checks/headers.ts applies the same anchoring
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

/** Marker spellings of the RETIRED split grammars (tail-marker's
 *  local-section line and the four-marker bounded-region shape's LOCAL
 *  pair). No code splits at these anymore, so a template source carrying
 *  one ships a dead promise line readers would still believe - and keeping
 *  the scan armed is what stops the retired grammar from quietly growing
 *  back. Fleet repositories may still carry these spellings as ordinary
 *  repo-owned content (the retired one-time conversion stripped the
 *  platform-authored ones; anything left is the repository's and rides
 *  through every carry byte-identical); only TEMPLATE sources are scanned
 *  here. */
export const RETIRED_MARKER_LINES = new Set([
  "# repo-platform:local-section",
  "<!-- repo-platform:local-section -->",
  "# BEGIN REPOSITORY LOCAL",
  "# END REPOSITORY LOCAL",
]);

/** A module's settings layers, next to its module.yml (docs/settings.md).
 *  Module METADATA like the manifest itself: read by the fleet's settings
 *  merge, never rendered into a repository, so the composer skips them and
 *  they declare no ownership class. */
export const SETTINGS_LAYER_NAMES = new Set([
  "settings.yml",
  "settings-public.yml",
  "settings-private.yml",
]);

/** Whether a template source opens with the managed header (decoration;
 *  the class itself is declared, never inferred from this). */
export function hasManagedHeader(source: string): boolean {
  return MANAGED_HEADER_RE.test(source.split("\n", HEADER_WINDOW).join("\n"));
}

// --- ownership declarations -------------------------------------------------

// Declared paths and marker lines ride through YAML declarations, the
// manifest template's jinja single-quoted string literals, and JSON, so a
// single quote is refused (it would end the jinja literal early), and so
// is every character JSON.stringify must escape: the manifest template
// builds its entry lines with JSON.stringify, jinja UNESCAPES backslash
// sequences inside string literals, and a control character lands raw
// inside the JSON - a double quote breaks the rendered JSON, a backslash
// decodes to a different character, a tab corrupts the string. Markers
// are matched as whole trimmed lines against latin1-decoded file bytes by
// the sync's split-file rebuild, so they must be trim-stable printable
// ASCII (a non-ASCII marker would decode to different code units in the
// manifest and the file and never match); the recovery appendix writes
// comments in the marker's own syntax, so a marker must open as a hash or
// HTML comment - a new comment syntax extends the appendix writer and
// this schema together.
const manifestSafeLine = (what: string) =>
  z
    .string()
    .min(1)
    .refine((value) => !/[\r\n]/.test(value), { message: `${what} must be a single line` })
    .refine((value) => !value.includes("'"), {
      message: `${what} must not contain ' (it lands inside the manifest template's jinja string literals)`,
    })
    .superRefine((value, ctx) => {
      for (const ch of value) {
        if (JSON.stringify(ch) !== `"${ch}"`) {
          ctx.addIssue({
            code: "custom",
            message:
              `${what} must not contain ${JSON.stringify(ch)} - JSON.stringify escapes it, ` +
              "and the manifest template's jinja string literals unescape backslash " +
              "sequences, so the rendered manifest would not round-trip the value",
          });
          return;
        }
      }
    });

const declaredPath = manifestSafeLine("each ownership path")
  .refine((value) => value === value.trim(), {
    message: "each ownership path must not have leading or trailing whitespace",
  })
  .refine(
    (value) =>
      !value.startsWith("/") && value.split("/").every((part) => part !== "" && part !== ".."),
    { message: "each ownership path must be a clean relative landed path (no leading /, no ..)" },
  )
  .refine((value) => !value.includes("{%"), {
    message:
      "each ownership path must be the LANDED path, with filename gates stripped " +
      "(gates are recorded from the template filename, not the declaration)",
  });

const markerLine = (what: string) =>
  manifestSafeLine(what)
    .refine((value) => value === value.trim(), {
      message: `${what} is matched as a whole trimmed line, so it must not have leading or trailing whitespace`,
    })
    .refine((value) => /^[\x20-\x7e]+$/.test(value), {
      message: `${what} must be printable ASCII (the sync rebuild matches markers against latin1-decoded file bytes)`,
    });

/** A region marker's comment syntax: a hash comment or a complete HTML
 *  comment line. One predicate for the declaration schema AND the sync
 *  boundary (preserve_local_content's splitEntries re-checks what the
 *  manifest text claims) - the recovery appendix writes comments in the
 *  markers' syntax, so anything else would emit a non-comment line. */
export function isCommentMarker(value: string): boolean {
  if (value.startsWith("#")) return true;
  if (!value.startsWith("<!--")) return false;
  // Opens-and-closes was not enough: it accepted a line whose opener and
  // closer belong to DIFFERENT comments, leaving active text between them
  // ("<!-- a --> live <!-- b -->"), and the degenerate "<!-->" where the
  // delimiters overlap. A valid marker is exactly ONE comment spanning the
  // whole line, so the first closer AFTER the opener must be the line's
  // final characters - searching from 4 is also what rules the overlap out.
  const close = value.indexOf("-->", 4);
  return close !== -1 && close + 3 === value.length;
}

const hashOrHtmlMarker = (what: string) =>
  markerLine(what).refine(isCommentMarker, {
    message: `${what} must be a hash comment or a complete HTML comment line (the recovery appendix writes comments in the markers' syntax)`,
  });

/** One declared file. Exported for scripts/module_manifests.ts (module
 *  `ownership:` lists) and loadBaseOwnership below - one schema, so the
 *  two declaration homes can never diverge in shape.
 *
 *  `headerless: true` on a managed declaration says the file has no
 *  comment channel to carry the managed header (a symlink, a version pin,
 *  JSON): the validator then enforces its manifest class alone. It is
 *  DECLARED, never inferred from the source text - inferring it from a
 *  missing header would let deleting the header silently downgrade the
 *  file's enforcement, the exact bypass the header guards against. */
export const ownershipEntrySchema = z.discriminatedUnion("class", [
  z.strictObject({
    path: declaredPath,
    class: z.literal("managed"),
    headerless: z.literal(true).optional(),
  }),
  z.strictObject({ path: declaredPath, class: z.literal("starter") }),
  z
    .strictObject({
      path: declaredPath,
      class: z.literal("split"),
      grammar: z.literal("managed-region"),
      begin: hashOrHtmlMarker("the region BEGIN marker"),
      end: hashOrHtmlMarker("the region END marker"),
    })
    // The two markers must be distinct, mutually substring-free (the
    // validator's exactly-once rule and the appendix neutralization both
    // count SUBSTRINGS, so a marker contained in the other would
    // double-count or re-create its sibling), and of ONE comment family
    // (the recovery appendix writes its comment in the pair's syntax).
    .superRefine((entry, ctx) => {
      if (entry.begin.includes(entry.end) || entry.end.includes(entry.begin)) {
        ctx.addIssue({
          code: "custom",
          message:
            "the BEGIN and END markers must be distinct and neither may contain " +
            "the other (exactly-once counting and appendix neutralization count substrings)",
        });
      }
      if (entry.begin.startsWith("#") !== entry.end.startsWith("#")) {
        ctx.addIssue({
          code: "custom",
          message:
            "the BEGIN and END markers must share one comment syntax (both hash " +
            "comments or both HTML comments) - the recovery appendix writes its " +
            "comment in the pair's syntax",
        });
      }
    }),
]);

export type OwnershipDeclaration = z.infer<typeof ownershipEntrySchema>;

type OmitPath<T> = T extends { path: string } ? Omit<T, "path" | "headerless"> : never;

/** A declaration's ownership without its path or enforcement mode: what
 *  the manifest entry records for the landed file (`headerless` steers the
 *  validator's tables, not the sync, so it stays out of the manifest).
 *  Derived from the schema inference, so a schema change cannot leave this
 *  union behind. */
export type ManifestOwnership = OmitPath<OwnershipDeclaration>;

export type SplitOwnership = Extract<ManifestOwnership, { class: "split" }>;

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;
type SchemaGrammarId = SplitOwnership["grammar"];

/** The weld between the declaration schema and the grammar descriptor
 *  table (actions/shared/grammar.ts): the schema's grammar union and the
 *  table's key set must be the SAME type, so adding a grammar arm to the
 *  schema without a full table row - or a row without a schema arm - is a
 *  compile error, never a runtime fallthrough. */
type _GrammarTableCoversSchema = Expect<Equal<GrammarId, SchemaGrammarId>>;

export function ownershipOf(declaration: OwnershipDeclaration): ManifestOwnership {
  const { path: _path, ...ownership } = declaration;
  if (ownership.class === "managed") {
    const { headerless: _headerless, ...manifest } = ownership;
    return manifest;
  }
  return ownership;
}

/** An `ownership:` list: entries valid per ownershipEntrySchema, paths
 *  unique (two declarations for one path inside one list is always a
 *  mistake, whatever they say). */
export const ownershipListSchema = z
  .array(ownershipEntrySchema)
  .min(1)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.path)) {
        ctx.addIssue({ code: "custom", message: `path '${entry.path}' is declared twice` });
      }
      seen.add(entry.path);
    }
  });

/** templates/base/ownership.yml: the base tree's declarations. Throws on a
 *  missing file, YAML problems, or schema violations - base files without
 *  a valid declaration home must fail every consumer loudly. */
export function loadBaseOwnership(templatesDir: string): OwnershipDeclaration[] {
  const path = join(templatesDir, "base", "ownership.yml");
  const where = "templates/base/ownership.yml";
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(
      `${where} is missing - every base file's ownership class is declared there ` +
        "(the module files declare in their module.yml ownership lists)",
    );
  }
  let data: unknown;
  try {
    data = parseYaml(readFileSync(path, "utf-8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`${where}: YAML parse error: ${detail}`);
  }
  const shaped = z.strictObject({ ownership: ownershipListSchema }).safeParse(data);
  if (!shaped.success) {
    const details = shaped.error.issues
      .map((issue) => `${issue.path.join(".") || "(top level)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${where}: ${details}`);
  }
  return shaped.data.ownership;
}

// --- copier.yml's _skip_if_exists -------------------------------------------

/** copier.yml's _skip_if_exists globs as path matchers reproducing
 *  copier's gitignore-style semantics (pathspec gitwildmatch): a pattern
 *  containing "/" is anchored to the render root, a bare filename matches
 *  at any depth, and `*` stays within one component. Only that subset is
 *  implemented; a pattern using more (`**`, `?`, character classes,
 *  negation, edge slashes, and gitwildmatch's comment/whitespace line
 *  forms) throws rather than guessing what copier does. */
export function skipIfExistsPatterns(
  copierYamlText: string,
): { pattern: string; matcher: RegExp }[] {
  const skip = (parseYaml(copierYamlText) as { _skip_if_exists?: unknown } | null)?._skip_if_exists;
  if (!Array.isArray(skip) || skip.length === 0 || !skip.every((p) => typeof p === "string")) {
    throw new Error(
      "copier.yml: _skip_if_exists is missing or not a list of strings - the " +
        "starter consistency check needs it to keep repo-owned starters exempt",
    );
  }
  return skip.map((pattern) => ({ pattern, matcher: compileSkipIfExistsPattern(pattern) }));
}

/** One _skip_if_exists pattern compiled to the shared matcher - the ONLY
 *  implementation of the gitwildmatch subset, so the composer's starter
 *  checks and the sync's retirement filter (retired_paths.ts) can never
 *  disagree about what a skip pattern protects. Throws on features beyond
 *  the subset (fail closed - a guessed match could either delete a
 *  repo-owned starter or leave a retired file undead). */
export function compileSkipIfExistsPattern(pattern: string): RegExp {
  if (
    /[?[\]\\!]/.test(pattern) ||
    pattern.includes("**") ||
    pattern.startsWith("/") ||
    pattern.endsWith("/") ||
    pattern.startsWith("#") ||
    pattern.trim() !== pattern ||
    pattern === ""
  ) {
    throw new Error(
      `copier.yml: _skip_if_exists pattern '${pattern}' uses gitwildmatch ` +
        "features beyond the implemented subset (bare names, root-anchored " +
        "paths, single *) - extend compileSkipIfExistsPattern alongside it",
    );
  }
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  // A gitwildmatch pattern that matches a directory also covers every
  // descendant, hence the optional /... tail.
  const tail = "(?:/.*)?$";
  return new RegExp(pattern.includes("/") ? `^${body}${tail}` : `(?:^|/)${body}${tail}`);
}

/** The matchers alone, for consumers that never need the pattern text. */
export function skipIfExistsMatchers(copierYamlText: string): RegExp[] {
  return skipIfExistsPatterns(copierYamlText).map(({ matcher }) => matcher);
}

/** copier.yml's _exclude list, verbatim: the generated conditional-landing
 *  patterns (compose_template.ts's excludePatterns via scripts/generate.ts).
 *  Throws when the list is missing or malformed - the composed tree carries
 *  plain filenames, so a copier.yml without the generated excludes would
 *  land every conditional file unconditionally. */
export function readExcludeList(copierYamlText: string): string[] {
  const exclude = (parseYaml(copierYamlText) as { _exclude?: unknown } | null)?._exclude;
  if (!Array.isArray(exclude) || !exclude.every((pattern) => typeof pattern === "string")) {
    throw new Error(
      "copier.yml: _exclude is missing or not a list of strings - the generated " +
        "conditional-landing patterns live there (run `bun run generate`)",
    );
  }
  return exclude;
}

const FILENAME_GATE_RE = /^\{% if (.+?) %\}(.*)\{% endif %\}$/;

/** The path a render lands, with any filename gates stripped and their
 *  conditions collected (in path order). Input is the rendered path (the
 *  .jinja suffix already removed). */
export function landedPathAndGates(renderedPath: string): { path: string; gates: string[] } {
  const gates: string[] = [];
  const path = renderedPath
    .split("/")
    .map((segment) => {
      const match = FILENAME_GATE_RE.exec(segment);
      if (!match) return segment;
      gates.push(match[1]);
      return match[2];
    })
    .join("/");
  return { path, gates };
}

// --- declaration decoration checks --------------------------------------------

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
 *  Sync dispatches on the DECLARED markers alone, so a foreign marker is
 *  always the same hazard however the declaration is spelled: the rebuild
 *  treats the repo-owned area that marker promises as its own and
 *  overwrites it.
 *
 *  Matching is TEXT PRESENCE: a foreign marker string anywhere in the
 *  source - a whole line, glued to jinja tags, inside a tag or a comment,
 *  a prose mention - is a claim, the same substring semantics the
 *  validator's exactly-once count and the appendix neutralization apply.
 *  Deciding instead which occurrences could RENDER as a live marker line
 *  needs a jinja evaluator, and the failure directions are not symmetric:
 *  an over-claim surfaces at compose time and costs a reword or an
 *  explicit declaration, an under-claim ships a live marker in a managed
 *  file - a silent ownership bypass. Exemption is POSITIONAL: a foreign
 *  occurrence lying entirely inside an own-marker occurrence is the own
 *  marker's text; one extending past it in either direction claims. */
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

/** Errors when a template source's decoration contradicts its declared
 *  class or grammar. Purely textual, purely per-file: the declaration is
 *  the classification, headers and marker lines are validated decoration,
 *  never classification input. `skipMatched` says whether copier.yml's
 *  _skip_if_exists exempts the landed path: the starter class and the
 *  skip list must agree in both directions (copier needs the skip entry,
 *  the declaration is the single ownership truth). `declaredMarkers` is
 *  every declared grammar's marker strings (declaredMarkerTexts over ALL
 *  declaration sources); they join the shipped constants to form the
 *  roster the shared foreign-marker scan checks every declaration
 *  against. `where` names the source file in errors. */
export function declarationTextErrors(
  declaration: OwnershipDeclaration,
  source: string,
  skipMatched: boolean,
  declaredMarkers: readonly string[],
  where: string,
): string[] {
  // A RETIRED grammar's marker spelling is refused in every template
  // source, whatever the declared class: no code splits at those lines
  // anymore, so shipping one plants a dead ownership promise readers
  // would still believe - and the scan is what keeps the retired grammars
  // from quietly growing back.
  for (const retired of RETIRED_MARKER_LINES) {
    if (source.includes(retired)) {
      return [
        `${where}: carries the retired split marker '${retired}' - the tail-marker ` +
          "and LOCAL-region grammars were retired into managed-region (repo-owned " +
          "content lives outside the BEGIN/END managed region now); drop the line",
      ];
    }
  }
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

// --- validator table derivations ----------------------------------------------

export type OwnershipEntry =
  | { path: string; kind: "header" }
  | { path: string; kind: "class-only" }
  | { path: string; kind: "region"; begin: string; end: string };

/** Render conditions the validator can evaluate from a rendered repo's
 *  answers and modules list, translated from declared filename gates. */
export interface RenderWhen {
  publicOnly?: true;
  withoutModule?: string;
}

export type BaseOwnershipEntry = OwnershipEntry & { when?: RenderWhen };

/** A source folder's landed files: landed path -> gates + source text
 *  (null for symlinks - no text to read decoration from). */
function landedFiles(
  folder: string,
): Map<string, { gates: string[]; source: string | null; templateRel: string }> {
  const out = new Map<string, { gates: string[]; source: string | null; templateRel: string }>();
  const visit = (rel: string) => {
    for (const name of readdirSync(join(folder, rel)).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (childRel === "fragments" || childRel === "module.yml" || childRel === "ownership.yml") {
        continue;
      }
      // The module's settings layers are module METADATA like the manifest:
      // read by the fleet's settings merge, never rendered into a repository,
      // so they land nowhere and declare no ownership class.
      if (SETTINGS_LAYER_NAMES.has(childRel)) continue;
      const stat = lstatSync(join(folder, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        visit(childRel);
        continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      const rendered = childRel.replace(/\.jinja$/, "");
      const { path, gates } = landedPathAndGates(rendered);
      out.set(path, {
        gates,
        source: stat.isSymbolicLink() ? null : readFileSync(join(folder, childRel), "utf-8"),
        templateRel: childRel,
      });
    }
  };
  visit("");
  return out;
}

/** The enforcement a declaration gets in the validator's tables, mapped
 *  from the DECLARATION alone (see the schema's headerless note): "header"
 *  for a managed file, "class-only" for a managed file declared headerless
 *  (nothing to check in-file, but the path must still reach the manifest
 *  cross-check or a hand-flipped class would silently exempt it from byte
 *  parity), and "region" for splits, carrying the declared BEGIN/END
 *  marker pair. null for starters (repo-owned; nothing to enforce). */
function enforcementOf(declaration: OwnershipDeclaration): OwnershipEntry | null {
  switch (declaration.class) {
    case "starter":
      return null;
    case "managed":
      return declaration.headerless === true
        ? { path: declaration.path, kind: "class-only" }
        : { path: declaration.path, kind: "header" };
    case "split":
      return {
        path: declaration.path,
        kind: "region",
        begin: declaration.begin,
        end: declaration.end,
      };
    default: {
      const unhandled: never = declaration;
      throw new Error(`unhandled ownership class: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** The one error a managed declaration's header mode can produce against
 *  its source, or null. Both drift directions are loud: a deleted header
 *  fails regeneration instead of silently downgrading enforcement, and a
 *  headerless declaration whose file grew a header names the stale
 *  declaration. */
function headerModeError(
  declaration: OwnershipDeclaration,
  source: string | null,
  where: string,
): string | null {
  if (declaration.class !== "managed") return null;
  if (declaration.headerless === true) {
    return source !== null && hasManagedHeader(source)
      ? `${where}: '${declaration.path}' is declared headerless but its source opens ` +
          "with the managed header - the validator would not enforce the header it " +
          "carries; drop `headerless: true` or the header"
      : null;
  }
  return source === null || !hasManagedHeader(source)
    ? `${where}: '${declaration.path}' is declared managed but its source does not ` +
        "open with the managed header - the validator enforces the header on every " +
        "rendered copy; add the header, or declare `headerless: true` if the format " +
        "has no comment channel"
    : null;
}

/** The rendered paths, per module, whose ownership declaration the
 *  validator enforces while the module is selected - derived from the
 *  module.yml `ownership:` declarations plus each source's decoration
 *  (header presence, the declared marker). A declared path with no
 *  template file, or a landed file with no declaration, throws: the
 *  composer reports the same drift as a compose error, and this generator
 *  must never emit tables from a tree it cannot account for. */
export function moduleOwnershipEntries(
  manifests: ModuleManifest[],
  templatesDir: string,
): Record<string, OwnershipEntry[]> {
  const result: Record<string, OwnershipEntry[]> = {};
  for (const m of manifests) {
    const where = `templates/${m.module}/module.yml`;
    const files = landedFiles(join(templatesDir, m.module));
    const declarations = m.ownership ?? [];
    const declared = new Set(declarations.map((d) => d.path));
    for (const [path, { templateRel }] of files) {
      if (!declared.has(path)) {
        throw new Error(
          `templates/${m.module}/${templateRel}: lands at '${path}' with no ownership ` +
            `declaration - add the entry to ${where}'s ownership list`,
        );
      }
    }
    const entries: OwnershipEntry[] = [];
    for (const declaration of declarations) {
      const file = files.get(declaration.path);
      if (file === undefined) {
        throw new Error(
          `${where}: ownership declares '${declaration.path}', but no templates/` +
            `${m.module}/ file lands there - fix the path or delete the entry`,
        );
      }
      // Checked before the gate handling: a gated managed file's header
      // mode must hold too, even though the module tables never enforce it.
      const headerDrift = headerModeError(declaration, file.source, where);
      if (headerDrift !== null) throw new Error(headerDrift);
      const entry = enforcementOf(declaration);
      if (entry === null) continue;
      // Module selection alone does not render a filename-gated file, and
      // the module-keyed tables carry no render conditions - an entry here
      // would false-positive on renders whose gate is off, while dropping
      // it silently (the old behavior) exempted the file from enforcement
      // with nothing said. The composer refuses module filename gates
      // outright (custom gates live in module.yml, module-wide), so this
      // only fires on a tree the composer would reject too.
      if (file.gates.length > 0) {
        throw new Error(
          `${where}: '${declaration.path}' is enforceable but filename-gated ` +
            `(${file.gates.join(" and ")}), and the validator's module tables carry no ` +
            "render conditions, so it would silently fall out of enforcement - module " +
            "files must not carry filename gates (gate CONTENT with jinja instead, or " +
            "set the module-wide gate in module.yml)",
        );
      }
      entries.push(entry);
    }
    if (entries.length > 0) result[m.module] = entries;
  }
  if (Object.keys(result).length === 0) {
    throw new Error(
      "no module declaration yields an enforceable entry, so the validator's " +
        "MODULE_OWNERSHIP record would be empty - the managed module " +
        "workflows are expected to carry the header",
    );
  }
  return result;
}

/** Declared filename gates translated to conditions the validator can
 *  evaluate client-side. Only the forms the base tree uses are known; an
 *  enforced file behind an untranslatable gate throws so it cannot
 *  silently fall out of the tables. */
export function translateGates(gates: string[], where: string): RenderWhen | undefined {
  if (gates.length === 0) return undefined;
  const when: RenderWhen = {};
  for (const gate of gates) {
    const withoutModule = /^'([a-z][a-z0-9-]*)' not in modules$/.exec(gate);
    if (gate === "not private") {
      when.publicOnly = true;
    } else if (withoutModule) {
      if (when.withoutModule !== undefined && when.withoutModule !== withoutModule[1]) {
        throw new Error(
          `${where}: two module-exclusion gates ('${when.withoutModule}', ` +
            `'${withoutModule[1]}') gate one file - RenderWhen carries a single ` +
            "withoutModule; extend it to a list before stacking exclusions",
        );
      }
      when.withoutModule = withoutModule[1];
    } else {
      throw new Error(
        `${where}: filename gate '${gate}' has no client-side translation - the ` +
          "validator could not tell when the file renders; extend translateGates " +
          "(scripts/ownership.ts) alongside the new gate form",
      );
    }
  }
  return when;
}

/** The validator's base tables, derived from templates/base/ownership.yml
 *  plus each base source's decoration and declared filename gates:
 *  `enforced` drives the marker-section check (region entries), check 8
 *  (header self-declarations), and check 9's class cross-check. Drift
 *  between the declarations and the base tree throws, mirroring
 *  moduleOwnershipEntries. */
export function baseOwnershipTables(templatesDir: string): {
  enforced: BaseOwnershipEntry[];
} {
  const where = "templates/base/ownership.yml";
  const declarations = loadBaseOwnership(templatesDir);
  const files = landedFiles(join(templatesDir, "base"));
  const declared = new Set(declarations.map((d) => d.path));
  for (const [path, { templateRel }] of files) {
    if (!declared.has(path)) {
      throw new Error(
        `templates/base/${templateRel}: lands at '${path}' with no ownership ` +
          `declaration - add the entry to ${where}`,
      );
    }
  }
  const enforced: BaseOwnershipEntry[] = [];
  for (const declaration of declarations) {
    const file = files.get(declaration.path);
    if (file === undefined) {
      throw new Error(
        `${where}: declares '${declaration.path}', but no templates/base/ file ` +
          "lands there - fix the path or delete the entry",
      );
    }
    const headerDrift = headerModeError(declaration, file.source, where);
    if (headerDrift !== null) throw new Error(headerDrift);
    const entry = enforcementOf(declaration);
    if (entry === null) continue;
    const when = translateGates(file.gates, `templates/base/${file.templateRel}`);
    enforced.push(when === undefined ? entry : { ...entry, when });
  }
  if (
    !enforced.some((entry) => entry.kind === "region") ||
    !enforced.some((entry) => entry.kind !== "region")
  ) {
    throw new Error(
      `${where}: the derived validator tables would miss a whole enforcement kind ` +
        "(no region split, or no header/class-only file) - the base tree always carries both",
    );
  }
  return { enforced };
}

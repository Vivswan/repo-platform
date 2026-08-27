#!/usr/bin/env bun
// The single owner of template-file OWNERSHIP truth: how each file the
// template lands in a generated repository relates to sync.
//
// Three classes (the ownership manifest's vocabulary; a fourth,
// "mergeable" - baseline kept current by three-way merge - was retired
// when settings.yml, its only member, became a starter):
// - managed: sync overwrites the whole file; local edits are replaced.
// - split: sync owns one half; the split GRAMMAR is part of the
//   declaration (a discriminated union):
//   - tail-marker: one marker line ends the sync-owned top; the
//     repository owns everything below it.
//   - bounded-region: a BEGIN/END-bounded repository-local region sits
//     above the sync-owned half, which runs from its own BEGIN marker
//     line to end of file (.gitignore: last-match-wins makes managed
//     patterns non-overridable only below the local region).
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

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ModuleManifest } from "./module_manifests.ts";

/** The managed ownership header in template sources, anchored on the
 *  header sentence's canonical trailing period with no repo-name character
 *  (GitHub allows [A-Za-z0-9._-]) after it, so neither a negated
 *  look-alike ("is not managed by") nor a longer repo name
 *  ("/repo-platform_fork", "/repo-platform.fork") counts;
 *  validate_generated_files.ts applies the same anchoring to rendered
 *  files. */
export const MANAGED_HEADER_RE =
  /This file is managed by \{\{ github_username \}\}\/repo-platform\.(?![A-Za-z0-9._-])/;

/** The bounded-region marker texts the fleet actually ships, kept as a
 *  CONSTANT beside the derived set. Deriving from current declarations
 *  alone is self-disarming: .gitignore is the only bounded-region
 *  declaration in the tree, so flipping it to managed would empty the
 *  derived set and silence the contradiction scan on exactly the flip the
 *  scan exists to catch. The union of constant and derived is what gets
 *  scanned. */
export const REGION_MARKER_LINES = new Set([
  "# BEGIN REPO-PLATFORM MANAGED",
  "# END REPO-PLATFORM MANAGED",
  "# BEGIN REPOSITORY LOCAL",
  "# END REPOSITORY LOCAL",
]);

export const LOCAL_SECTION_MARKER = "repo-platform:local-section";
export const LOCAL_SECTION_LINES = new Set([
  `# ${LOCAL_SECTION_MARKER}`,
  `<!-- ${LOCAL_SECTION_MARKER} -->`,
]);

/** How many opening lines may hold the managed header: template sources
 *  keep it at the top, at most below a short jinja preamble that rendering
 *  collapses. The validator's rendered-file check uses the same window. */
export const HEADER_WINDOW = 10;

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

/** A tail marker's comment syntax: a hash comment or a complete HTML
 *  comment line. One predicate for the declaration schema AND the sync
 *  boundary (preserve_local_content's splitEntries re-checks what the
 *  manifest text claims) - the recovery appendix writes comments in the
 *  marker's syntax, so anything else would emit a non-comment line. */
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
    message: `${what} must be a hash comment or a complete HTML comment line (the recovery appendix writes comments in the marker's syntax)`,
  });

/** A bounded-region marker's comment syntax: hash comments only (the
 *  bounded-region appendix comments carried lines with #). One predicate
 *  for the declaration schema AND the sync boundary
 *  (preserve_local_content's splitEntries re-checks what the manifest
 *  text claims), like isCommentMarker above. */
export function isHashMarker(value: string): boolean {
  return value.startsWith("#");
}

const hashMarker = (what: string) =>
  markerLine(what).refine(isHashMarker, {
    message: `${what} must open as a hash comment (the bounded-region appendix comments carried lines with #)`,
  });

/** One declared file. Exported for scripts/module_manifests.ts (module
 *  `ownership:` lists) and loadBaseOwnership below - one schema, so the
 *  two declaration homes can never diverge in shape. */
export const ownershipEntrySchema = z.discriminatedUnion("class", [
  z.strictObject({ path: declaredPath, class: z.literal("managed") }),
  z.strictObject({ path: declaredPath, class: z.literal("starter") }),
  z.discriminatedUnion("grammar", [
    z.strictObject({
      path: declaredPath,
      class: z.literal("split"),
      grammar: z.literal("tail-marker"),
      marker: hashOrHtmlMarker("the tail marker"),
    }),
    z
      .strictObject({
        path: declaredPath,
        class: z.literal("split"),
        grammar: z.literal("bounded-region"),
        managed_begin: hashMarker("the managed BEGIN marker"),
        managed_end: hashMarker("the managed END marker"),
        local_begin: hashMarker("the local BEGIN marker"),
        local_end: hashMarker("the local END marker"),
      })
      // The four markers must be mutually substring-free: the region slicer
      // matches whole lines, but the validator's exactly-once rule and the
      // appendix neutralization both count SUBSTRINGS, so a marker contained
      // in another would double-count (or re-create) its sibling.
      .refine(
        (entry) => {
          const markers = [
            entry.managed_begin,
            entry.managed_end,
            entry.local_begin,
            entry.local_end,
          ];
          return markers.every(
            (marker, index) =>
              !markers.some((other, otherIndex) => otherIndex !== index && other.includes(marker)),
          );
        },
        {
          message:
            "the four bounded-region markers must be distinct and none may contain " +
            "another (exactly-once counting and appendix neutralization count substrings)",
        },
      ),
  ]),
]);

export type OwnershipDeclaration = z.infer<typeof ownershipEntrySchema>;

type OmitPath<T> = T extends { path: string } ? Omit<T, "path"> : never;

/** A declaration's ownership without its path: what the manifest entry
 *  records for the landed file. Derived from the schema inference, so a
 *  schema change cannot leave this union behind. */
export type ManifestOwnership = OmitPath<OwnershipDeclaration>;

export type SplitOwnership = Extract<ManifestOwnership, { class: "split" }>;

/** Which half of a split file sync owns, derived from the grammar (never
 *  declared separately - a side that disagreed with its grammar would be
 *  an unrepresentable state). */
export function managedSide(split: SplitOwnership): "above" | "below" {
  return split.grammar === "tail-marker" ? "above" : "below";
}

export function ownershipOf(declaration: OwnershipDeclaration): ManifestOwnership {
  const { path: _path, ...ownership } = declaration;
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
  return skip.map((pattern) => {
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
          "paths, single *) - extend skipIfExistsPatterns alongside it",
      );
    }
    const body = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    // A gitwildmatch pattern that matches a directory also covers every
    // descendant, hence the optional /... tail.
    const tail = "(?:/.*)?$";
    return {
      pattern,
      matcher: new RegExp(pattern.includes("/") ? `^${body}${tail}` : `(?:^|/)${body}${tail}`),
    };
  });
}

/** The matchers alone, for consumers that never need the pattern text. */
export function skipIfExistsMatchers(copierYamlText: string): RegExp[] {
  return skipIfExistsPatterns(copierYamlText).map(({ matcher }) => matcher);
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

/** Every marker string any declared TAIL grammar owns. The schema accepts
 *  arbitrary marker text, so the shipped LOCAL_SECTION_LINES alone would
 *  miss a custom declared marker copied into a managed or starter source;
 *  declarationTextErrors unions this derived set with those constants,
 *  exactly as it does for bounded-region markers. Deriving ALONE is
 *  self-disarming and the union must stay: the constants are what keep the
 *  scan armed when no declaration of a given grammar is left in the tree. */
export function declaredTailMarkerTexts(declarations: Iterable<OwnershipDeclaration>): string[] {
  const out = new Set<string>();
  for (const declaration of declarations) {
    if (declaration.class !== "split" || declaration.grammar !== "tail-marker") continue;
    out.add(declaration.marker);
  }
  return [...out];
}

export function declaredRegionMarkerTexts(declarations: Iterable<OwnershipDeclaration>): string[] {
  const out = new Set<string>();
  for (const declaration of declarations) {
    if (declaration.class !== "split" || declaration.grammar !== "bounded-region") continue;
    out.add(declaration.local_begin);
    out.add(declaration.local_end);
    out.add(declaration.managed_begin);
    out.add(declaration.managed_end);
  }
  return [...out];
}

// --- the foreign-marker rule, stated once -------------------------------------

/** The two marker vocabularies a source can claim ownership with: a TAIL
 *  marker (one line ends the sync-owned top) and the BOUNDED-REGION markers
 *  (four lines bound the halves). Every declaration owns some markers of at
 *  most one kind; markers of either kind that it does not own are foreign. */
type MarkerKind = "tail" | "region";

/** The markers a declaration itself owns, by kind. managed and starter own
 *  none of either - which is exactly what makes every marker in the tree
 *  foreign to them - and so does a shape this union does not recognise yet,
 *  so a grammar added tomorrow inherits the foreign-marker rejection before
 *  it has an arm of its own. */
function ownMarkers(declaration: OwnershipDeclaration): Record<MarkerKind, readonly string[]> {
  if (declaration.class === "split" && declaration.grammar === "tail-marker") {
    return { tail: [declaration.marker], region: [] };
  }
  if (declaration.class === "split" && declaration.grammar === "bounded-region") {
    return {
      tail: [],
      region: [
        declaration.local_begin,
        declaration.local_end,
        declaration.managed_begin,
        declaration.managed_end,
      ],
    };
  }
  return { tail: [], region: [] };
}

/** The four shipped declaration shapes, plus `other` for anything this
 *  union grows later: the discriminator the contradiction wording switches
 *  on, so an unrecognised shape falls to a generic wording rather than off
 *  the end of a switch. */
type DeclarationShape = "managed" | "starter" | "tail-marker" | "bounded-region" | "other";

function shapeOf(declaration: OwnershipDeclaration): DeclarationShape {
  if (declaration.class === "managed") return "managed";
  if (declaration.class === "starter") return "starter";
  if (declaration.class === "split") {
    if (declaration.grammar === "tail-marker") return "tail-marker";
    if (declaration.grammar === "bounded-region") return "bounded-region";
  }
  return "other";
}

/** How a declaration names itself inside a contradiction message. */
function declaredAs(declaration: OwnershipDeclaration): string {
  switch (shapeOf(declaration)) {
    case "starter":
      return "a starter";
    case "managed":
      return "managed";
    case "tail-marker":
      return "split (tail-marker)";
    case "bounded-region":
      return "split (bounded-region)";
    default:
      return String((declaration as { class: unknown }).class);
  }
}

const FOREIGN_GENERIC_CONSEQUENCE =
  "sync rebuilds by the DECLARED grammar and would overwrite the repo-owned " +
  "area that marker promises";
const FOREIGN_GENERIC_REMEDY = "drop the marker or declare the file under the grammar that owns it";

/** The one contradiction message a foreign marker gets, in one template:
 *  what the source CLAIMS by carrying the marker, what the rebuild would do
 *  about it, and the fix. Two families fill it. If the declaration owns
 *  markers of the same kind, the file carries a SECOND set of one grammar
 *  and the rebuild - which splits by this declaration's markers alone -
 *  overwrites whatever the other set promised. If it owns none of that
 *  kind, the marker is the wrong grammar entirely and the promise it makes
 *  is one the declared class never keeps; the clauses there are per shape,
 *  each the wording its specimen asserts. */
function foreignMarkerMessage(
  kind: MarkerKind,
  marker: string,
  own: readonly string[],
  declaration: OwnershipDeclaration,
  where: string,
): string {
  const say = (claim: string, consequence: string, remedy: string) =>
    `${where}: carries the '${marker}' ${claim} - ${consequence}; ${remedy}`;
  if (own.length > 0) {
    return kind === "tail"
      ? say(
          `tail marker as well as its own '${own[0]}'`,
          "the rebuild splits at this declaration's marker and would overwrite " +
            "the repo-owned tail the other one promises",
          "drop it or declare the file under the declaration that owns it",
        )
      : say(
          "bounded-region marker, which is not one of this declaration's four",
          "sync rebuilds by the DECLARED grammar and would overwrite the " +
            "repo-owned region that marker promises",
          "drop it or declare the file under the grammar that owns it",
        );
  }
  const claim = (noun: string) => `${noun} but is declared ${declaredAs(declaration)}`;
  if (kind === "tail") {
    switch (shapeOf(declaration)) {
      case "starter":
        return say(
          claim("split marker"),
          "the marker promises a sync-maintained half that a starter never gets",
          "drop one",
        );
      case "managed":
        return say(
          claim("split marker"),
          "sync would overwrite the repo-owned half the marker promises",
          "declare the file split (grammar tail-marker) or drop the marker",
        );
      case "bounded-region":
        return say(
          claim("tail-marker line"),
          "the rebuild would treat the tail that marker promises as part of this region",
          "drop the marker or declare the file split (grammar tail-marker)",
        );
      default:
        return say(claim("tail-marker line"), FOREIGN_GENERIC_CONSEQUENCE, FOREIGN_GENERIC_REMEDY);
    }
  }
  switch (shapeOf(declaration)) {
    case "starter":
      return say(
        claim("bounded-region marker"),
        "the markers promise a sync-maintained managed section that a starter never gets",
        "drop one",
      );
    case "managed":
      return say(
        claim("bounded-region marker"),
        "sync would overwrite the repo-owned LOCAL region the markers promise",
        "declare the file split (grammar bounded-region) or drop the markers",
      );
    case "tail-marker":
      return say(
        claim("bounded-region marker"),
        "the rebuild would treat the repo-owned LOCAL region as managed and overwrite it",
        "declare the file split (grammar bounded-region) or drop the markers",
      );
    default:
      return say(
        claim("bounded-region marker"),
        FOREIGN_GENERIC_CONSEQUENCE,
        FOREIGN_GENERIC_REMEDY,
      );
  }
}

// --- tail-marker claim scanning -----------------------------------------------
//
// What counts as a tail-marker CLAIM in a template source: any line one of
// whose POSSIBLE renders is a whole roster-marker line (the sync rebuild
// and the validator both match rendered markers as exact trimmed lines -
// trim is the fleet-wide marker-matching convention). Claims are
// possibilistic over the SET of a line's renders, not one flattened
// literal: control-flow bodies are optional or alternative, so
// "{% if x %}prefix{% endif %}MARKER" renders "prefixMARKER" when the
// condition holds and "MARKER" when it does not - the bare-marker render
// is reachable, so it claims. Each part of a line contributes:
// - literal text renders verbatim; a literal whole marker line always
//   claims. Raw-block inner text (multiline blocks included, via the
//   leftmost-precedence pre-pass in disarmRawBlocks) is literal too, so
//   "{% raw %}{# note #}{% endraw %}MARKER" stays a legal mid-line mention
//   while "{% raw %}{% endraw %}MARKER" claims;
// - comment spans render nothing, whatever tag-shaped text they hold, so
//   "{# docs: {% print 'x' %} #}MARKER" claims;
// - if/for openers, elif/else branches and their closers render nothing of
//   their own; their BODY is one possible render and its absence another,
//   so an inline body reachable in any branch is found (this also keeps
//   marker text INSIDE such a tag legal). Each branch carries the condition
//   values it needs, and only condition-consistent renders combine, so a
//   reused condition ("{% if x %}a{% endif %}{% if x %}MARKER{% endif %}"
//   renders only "aMARKER" or "") and an unreachable "{% elif x %}" after
//   "{% if x %}" do NOT invent a bare-marker render, while distinct
//   conditions ("{% if x %}a{% endif %}{% if y %}MARKER{% endif %}") still
//   reach it;
// - statements that emit nothing - set-assignment, import, from, do,
//   with/endwith - render "", so a marker glued after them ("{% set x = 1
//   %}MARKER") is a live line and claims;
// - an expression span renders its constant string value ("{{ '' }}MARKER"
//   and "{{ 'MARKER' }}" claim, "{{ 'prefix' }}MARKER" stays mid-line).
// EVERYTHING else leaves the line unbounded and fails toward LEGALITY:
// output emitters (print, include, extends) and NON-EMPTY body-emitting
// blocks (call, filter, block, autoescape - they transform, override or
// escape, so they are not stripped), non-constant expressions,
// whitespace-modified tags ({%- -%} join adjacent lines, {%+ disables
// trimming), and anything the span lexing cannot represent (multiline tags,
// string-embedded delimiters) mis-lexing into literal junk that matches no
// marker. The blocks that emit NOTHING - a block-form set, a macro, and an
// EMPTY emit block - are REMOVED first by stripCaptureBlocks, whose inner
// newlines are captured not emitted, so text before an open joins text
// after the matching close into one rendered line, exactly as jinja does. A
// false rejection blocks a legitimate template; a miss leaves a lying
// marker the repo owner can see, and sync dispatch never reads markers - it
// goes by the declared grammar.
const TAG_SPAN_RE = /\{\{.*?\}\}|\{%.*?%\}|\{#.*?#\}/g;
const CONSTANT_EXPRESSION_RE = /^\{\{\s*(?:"([^"\\]*)"|'([^'\\]*)')\s*\}\}$/;
// A tag carrying a whitespace-control modifier can trim into a neighboring
// line, so a line holding one cannot be bounded on its own.
const WHITESPACE_CONTROL_RE = /^\{[{%#][-+]|[-+][}%#]\}$/;
// Statements that emit nothing of their own (checked AFTER capture-open, so
// the block-set form is a capture, not an assignment).
const EMPTY_STATEMENT_RE = /^\{%\s*(?:set|import|from|do|with|endwith)\b/;
// if/for openers, their elif/else branches, and their closers. The
// condition of an if/elif and the iterable of a for are extracted as a
// string KEY so repeated conditions correlate: `{% if x %}...{% endif %}
// {% if x %}...{% endif %}` shares one x, and `{% elif x %}` after
// `{% if x %}` is unreachable - the reducer tracks each branch's required
// truth values and drops renders whose conditions contradict.
const CONTROL_OPEN_RE = /^\{%\s*(?:if|for)\b/;
const CONTROL_BRANCH_RE = /^\{%\s*(?:elif|else)\b/;
const CONTROL_CLOSE_RE = /^\{%\s*(?:endif|endfor)\b/;
const IF_CONDITION_RE = /^\{%\s*(?:if|elif)\s+([\s\S]+?)\s*%\}$/;
const FOR_ITERABLE_RE = /^\{%\s*for\s+[\s\S]+?\bin\b\s*([\s\S]+?)\s*%\}$/;
// The only two blocks that CAPTURE their body (emit nothing): a block-form
// set and a macro definition. call/filter/block/autoescape all EMIT their
// body (transformed, overridden or escaped), so they are NOT stripped -
// they fall through to unbounded, the legal direction, and a bare marker
// line inside one still renders live. set counts as an ASSIGNMENT (renders
// nothing, captures nothing) only in the clearly name-list-then-= shape;
// every other set - the block capture form, filtered captures whose
// arguments may contain = - opens a capture. Misreading an assignment as a
// capture only skips more lines, the legal direction; the reverse would
// reject captured text.
const CAPTURE_OPEN_RE = /^\{%[-+]?\s*(?:set\b(?!\s*[\w.\s,()]+=)|macro\b)/;
const CAPTURE_CLOSE_RE = /^\{%[-+]?\s*end(?:set|macro)\b/;
// Body-EMITTING blocks: their body renders (transformed, overridden or
// escaped), so they are left in place - a bare marker line inside one still
// claims, and their tag lines fall through to unbounded. The one exception
// stripCaptureBlocks handles is an EMPTY emit block (open immediately
// followed by close), which emits nothing, so a marker glued after it is a
// live line.
const EMIT_BLOCK_OPEN_RE = /^\{%[-+]?\s*(?:call\b|filter\b|block\b|autoescape\b)/;
const EMIT_BLOCK_CLOSE_RE = /^\{%[-+]?\s*end(?:call|filter|block|autoescape)\b/;
const RAW_OPEN_RE = /^\{%[-+]?\s*raw\s*[-+]?%\}/;
const RAW_CLOSE_RE = /\{%[-+]?\s*endraw\s*[-+]?%\}/g;

/** A cap on the number of distinct partial renders a single line's
 *  inline branching may produce before the line bails to unbounded
 *  (toward legality). Real template lines carry a handful; a pathological
 *  fan-out is not worth enumerating. */
const RENDER_CAP = 256;

/** The source with every raw block's inner text disarmed (each `{`
 *  dropped to NUL, so the span lexing below can neither eat it nor
 *  mistake it for a live tag - NUL never survives the marker schema, so a
 *  disarmed line only fails toward legality). Spans are lexed with
 *  jinja's leftmost-delimiter precedence: raw-shaped text INSIDE another
 *  tag (a comment, an expression string) stays that tag's content instead
 *  of being misread as a raw block. */
function disarmRawBlocks(source: string): string {
  let out = "";
  let at = 0;
  while (at < source.length) {
    const open = source.slice(at).search(/\{[{%#]/);
    if (open === -1) break;
    out += source.slice(at, at + open);
    at += open;
    const rawOpen = RAW_OPEN_RE.exec(source.slice(at));
    if (rawOpen !== null) {
      RAW_CLOSE_RE.lastIndex = at + rawOpen[0].length;
      const rawClose = RAW_CLOSE_RE.exec(source);
      if (rawClose === null) break; // unclosed raw: keep the rest verbatim
      let inner = source.slice(at + rawOpen[0].length, rawClose.index).replaceAll("{", "\u0000");
      // `-` modifiers strip adjacent whitespace, joining neighboring lines
      // exactly as the render does; model each of the four positions so
      // the disarmed text keeps the render's line shape.
      if (rawOpen[0].startsWith("{%-")) out = out.replace(/\s+$/, "");
      if (/-%\}$/.test(rawOpen[0])) inner = inner.replace(/^\s+/, "");
      if (rawClose[0].startsWith("{%-")) inner = inner.replace(/\s+$/, "");
      out += inner;
      at = rawClose.index + rawClose[0].length;
      if (/-%\}$/.test(rawClose[0])) {
        while (at < source.length && /\s/.test(source[at])) at += 1;
      }
      continue;
    }
    const closer = source.startsWith("{{", at) ? "}}" : source.startsWith("{%", at) ? "%}" : "#}";
    const close = source.indexOf(closer, at + 2);
    if (close === -1) break; // unclosed tag: keep the rest verbatim
    out += source.slice(at, close + 2);
    at = close + 2;
  }
  return out + source.slice(at);
}

/** The source with capture blocks (block-form set, macro) and EMPTY
 *  body-emitting blocks (an autoescape/filter/block/call whose open is
 *  immediately followed by its close) removed, so text before the open
 *  joins text after the matching close into one line - exactly as jinja
 *  renders it, since the block emits nothing (captures swallow their body;
 *  an empty emit block has none). A non-empty emit block is left in place:
 *  its body renders, so a bare marker line inside it still claims and its
 *  tag lines fall through to unbounded. Whitespace-control modifiers on the
 *  outer tags are applied ({%- open trims preceding whitespace, close -%}
 *  trims following). Nesting is balanced; an unclosed capture is dropped to
 *  end of source (discarding more, the legal direction). Runs AFTER
 *  disarmRawBlocks, whose NUL-poking keeps raw-inner tag-shaped text from
 *  being read as a block tag. */
function stripCaptureBlocks(source: string): string {
  const tagAt = (from: number): { span: string; start: number; end: number } | null => {
    const rel = source.slice(from).search(/\{[{%#]/);
    if (rel === -1) return null;
    const start = from + rel;
    const closer = source.startsWith("{{", start)
      ? "}}"
      : source.startsWith("{%", start)
        ? "%}"
        : "#}";
    const close = source.indexOf(closer, start + 2);
    return close === -1 ? null : { span: source.slice(start, close + 2), start, end: close + 2 };
  };
  // Drop up to closeEnd, applying the open/close whitespace-control trims.
  const joinAcross = (openSpan: string, closeSpan: string, closeEnd: number): number => {
    if (openSpan.startsWith("{%-")) out = out.replace(/\s+$/, "");
    let next = closeEnd;
    if (/-%\}$/.test(closeSpan)) {
      while (next < source.length && /\s/.test(source[next])) next += 1;
    }
    return next;
  };
  let out = "";
  let at = 0;
  while (at < source.length) {
    const tag = tagAt(at);
    if (tag === null) break;
    out += source.slice(at, tag.start);
    if (CAPTURE_OPEN_RE.test(tag.span)) {
      // Drop the whole capture block, inner newlines included, tracking nesting.
      let depth = 1;
      let closeSpan = "";
      at = tag.end;
      while (depth > 0) {
        const inner = tagAt(at);
        if (inner === null) {
          at = source.length;
          break;
        }
        at = inner.end;
        if (CAPTURE_OPEN_RE.test(inner.span)) depth += 1;
        else if (CAPTURE_CLOSE_RE.test(inner.span)) {
          depth -= 1;
          if (depth === 0) closeSpan = inner.span;
        }
      }
      at = joinAcross(tag.span, closeSpan, at);
      continue;
    }
    if (EMIT_BLOCK_OPEN_RE.test(tag.span)) {
      const next = tagAt(tag.end);
      if (
        next !== null &&
        EMIT_BLOCK_CLOSE_RE.test(next.span) &&
        source.slice(tag.end, next.start) === ""
      ) {
        // Truly-empty emit block (nothing between open and close): emits
        // nothing, so join across it. A whitespace-only body is NOT empty -
        // the block emits that whitespace, a newline can even start a fresh
        // line - so it is left in place (unbounded, the legal direction).
        at = joinAcross(tag.span, next.span, next.end);
        continue;
      }
      // Non-empty or nested: leave the open tag; the body renders and is
      // scanned normally (a bare marker line inside it still claims).
    }
    out += tag.span;
    at = tag.end;
  }
  return out + source.slice(at);
}

/** One possible render of a line: its text plus the branch conditions that
 *  must hold for it, each mapped to the truth value it requires. Two renders
 *  combine only when their guards agree on every shared condition, so a
 *  reused condition (`if x ... if x`) cannot take both values and an `elif x`
 *  after `if x` (which needs x both false and true) is dropped as
 *  unreachable. */
interface Render {
  text: string;
  guards: Map<string, boolean>;
}

/** The two guards merged, or null when they disagree on a shared condition
 *  (the combined render is then unreachable). */
function mergeGuards(
  a: Map<string, boolean>,
  b: Map<string, boolean>,
): Map<string, boolean> | null {
  const out = new Map(a);
  for (const [key, value] of b) {
    const existing = out.get(key);
    if (existing !== undefined && existing !== value) return null;
    out.set(key, value);
  }
  return out;
}

/** An open control frame while a line is reduced: `current` are the renders
 *  of the branch being built; `completed` the renders of branches already
 *  closed by an elif/else, each already constrained by its branch guard.
 *  `priors` are the conditions of earlier branches (false in later ones),
 *  `condition` this branch's condition (null for else / an unconditional
 *  body). */
interface ControlFrame {
  current: Render[];
  completed: Render[];
  priors: string[];
  condition: string | null;
  sawElse: boolean;
}

/** The possible whole-line renders of one capture-stripped source line, or
 *  null when the line cannot be bounded (an output emitter, a non-constant
 *  expression, a whitespace-trimmed tag, a residual block tag). Control
 *  bodies contribute a SET of guarded renders - a body when its condition
 *  holds, its absence otherwise - and only condition-consistent renders
 *  combine, so a marker reachable under SOME assignment claims while one
 *  that needs a condition to be two values at once does not. Captures and
 *  empty emit blocks are removed by stripCaptureBlocks first. */
function lineRenders(line: string): Render[] | null {
  let unbounded = false;
  const stack: ControlFrame[] = [
    {
      current: [{ text: "", guards: new Map() }],
      completed: [],
      priors: [],
      condition: null,
      sawElse: false,
    },
  ];
  const top = () => stack[stack.length - 1];
  const append = (text: string) => {
    for (const render of top().current) render.text += text;
  };
  const product = (left: Render[], right: Render[]): Render[] => {
    const out: Render[] = [];
    const seen = new Set<string>();
    for (const l of left) {
      for (const r of right) {
        const guards = mergeGuards(l.guards, r.guards);
        if (guards === null) continue; // unreachable combination
        const text = l.text + r.text;
        const key = JSON.stringify([text, [...guards].sort()]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text, guards });
        if (out.length > RENDER_CAP) {
          unbounded = true;
          return out;
        }
      }
    }
    return out;
  };
  // The guard of the branch about to close: every prior branch condition
  // false, this branch's condition true (null = an else or unconditional
  // body, so only the priors constrain it).
  const branchGuard = (frame: ControlFrame): Map<string, boolean> | null => {
    let guard: Map<string, boolean> | null = new Map();
    for (const prior of frame.priors) {
      if (guard === null) break;
      guard = mergeGuards(guard, new Map([[prior, false]]));
    }
    if (guard !== null && frame.condition !== null) {
      guard = mergeGuards(guard, new Map([[frame.condition, true]]));
    }
    return guard;
  };
  const closeBranch = (frame: ControlFrame) => {
    const guard = branchGuard(frame);
    if (guard !== null) {
      for (const render of frame.current) {
        const merged = mergeGuards(render.guards, guard);
        if (merged !== null) frame.completed.push({ text: render.text, guards: merged });
      }
    }
    frame.current = [{ text: "", guards: new Map() }];
  };
  const closeFrame = (frame: ControlFrame) => {
    closeBranch(frame);
    // An if/for without an else can render nothing: add the all-conditions-
    // false empty branch.
    if (!frame.sawElse) {
      let guard: Map<string, boolean> | null = new Map();
      for (const cond of [
        ...frame.priors,
        ...(frame.condition !== null ? [frame.condition] : []),
      ]) {
        if (guard === null) break;
        guard = mergeGuards(guard, new Map([[cond, false]]));
      }
      if (guard !== null) frame.completed.push({ text: "", guards: guard });
    }
    top().current = product(top().current, frame.completed);
  };

  let at = 0;
  for (const match of line.matchAll(TAG_SPAN_RE)) {
    if (match.index > at) append(line.slice(at, match.index));
    at = match.index + match[0].length;
    const span = match[0];
    if (WHITESPACE_CONTROL_RE.test(span)) unbounded = true;
    else if (span.startsWith("{#")) {
      // comment renders nothing
    } else if (span.startsWith("{{")) {
      const constant = CONSTANT_EXPRESSION_RE.exec(span);
      if (constant !== null) append(constant[1] ?? constant[2] ?? "");
      else unbounded = true;
    } else if (CONTROL_OPEN_RE.test(span)) {
      const isFor = /^\{%\s*for\b/.test(span);
      const key = isFor ? FOR_ITERABLE_RE.exec(span) : IF_CONDITION_RE.exec(span);
      stack.push({
        current: [{ text: "", guards: new Map() }],
        completed: [],
        priors: [],
        // An if/elif test keys on its RAW expression text (so textually
        // identical tests correlate); a for's presence keys on its iterable
        // under a "for:" prefix (distinct from an if test of the same text).
        // An unparsed opener keys on its whole span, correlating with
        // nothing (safe). Any textual difference - even a same-meaning one
        // like `x == y` vs `x==y` - keeps the conditions INDEPENDENT, which
        // over-approximates toward claiming, the safe direction; and a
        // variable REASSIGNED between two tests of it is not tracked (the
        // model assumes a condition is stable across a line), a fail-legal
        // miss.
        condition: isFor ? `for:${key?.[1] ?? span}` : (key?.[1] ?? span),
        sawElse: false,
      });
    } else if (CONTROL_BRANCH_RE.test(span)) {
      // A branch of a control opened on THIS line; one whose opener is on an
      // earlier line is untracked and renders as nothing.
      if (stack.length > 1) {
        const frame = top();
        closeBranch(frame);
        if (frame.condition !== null) frame.priors.push(frame.condition);
        if (/^\{%\s*elif\b/.test(span)) frame.condition = IF_CONDITION_RE.exec(span)?.[1] ?? span;
        else {
          frame.condition = null;
          frame.sawElse = true;
        }
      }
    } else if (CONTROL_CLOSE_RE.test(span)) {
      // Close a frame opened on this line; a closer for an earlier-line
      // opener renders as nothing.
      if (stack.length > 1) closeFrame(stack.pop() as ControlFrame);
    } else if (EMPTY_STATEMENT_RE.test(span)) {
      // set-assignment, import, from, do, with/endwith render nothing
    } else unbounded = true; // print/include/extends/residual block: cannot bound
  }
  if (at < line.length) append(line.slice(at));
  // An if/for left open at line end makes the body-tail optional too.
  while (stack.length > 1) closeFrame(stack.pop() as ControlFrame);
  if (unbounded) return null;
  return top().current;
}

/** Every roster marker the source claims per the model above, in first-
 *  appearance order. */
function claimedTailMarkers(source: string, roster: ReadonlySet<string>): string[] {
  const flattened = stripCaptureBlocks(disarmRawBlocks(source));
  const claims: string[] = [];
  for (const line of flattened.split("\n")) {
    const renders = lineRenders(line);
    if (renders === null) continue;
    for (const render of renders) {
      const trimmed = render.text.trim();
      if (roster.has(trimmed) && !claims.includes(trimmed)) claims.push(trimmed);
    }
  }
  return claims;
}

/** Markers in the source that this declaration does not own, at most one
 *  per kind. Sync dispatches on the DECLARED grammar alone, so a foreign
 *  marker is always the same hazard however the declaration is spelled: the
 *  rebuild treats the repo-owned area that marker promises as its own and
 *  overwrites it.
 *
 *  The two matching semantics stay SPLIT on purpose, because they decide
 *  what counts as a claim. Tail markers match as whole renderable lines
 *  (claimedTailMarkers above states the model and its boundaries), so a
 *  source may still MENTION one mid-line without claiming the tail below
 *  it. Region markers match as SUBSTRINGS, the way the validator's
 *  exactly-once count and the appendix neutralization both count.
 *  Unifying them would move the boundary of what a source can say. */
function foreignMarkerErrors(
  declaration: OwnershipDeclaration,
  source: string,
  rosters: Record<MarkerKind, readonly string[]>,
  where: string,
): string[] {
  const own = ownMarkers(declaration);
  const errors: string[] = [];
  const ownTail = new Set(own.tail);
  const foreignTail = claimedTailMarkers(source, new Set(rosters.tail)).find(
    (marker) => !ownTail.has(marker),
  );
  if (foreignTail !== undefined) {
    errors.push(foreignMarkerMessage("tail", foreignTail, own.tail, declaration, where));
  }
  const ownRegion = new Set(own.region);
  const foreignRegion = [...new Set(rosters.region)]
    .filter((candidate) => !ownRegion.has(candidate))
    .find((candidate) => source.includes(candidate));
  if (foreignRegion !== undefined) {
    errors.push(foreignMarkerMessage("region", foreignRegion, own.region, declaration, where));
  }
  return errors;
}

/** Errors when a template source's decoration contradicts its declared
 *  class or grammar. Purely textual, purely per-file: the declaration is
 *  the classification, headers and marker lines are validated decoration,
 *  never classification input. `skipMatched` says whether copier.yml's
 *  _skip_if_exists exempts the landed path: the starter class and the
 *  skip list must agree in both directions (copier needs the skip entry,
 *  the declaration is the single ownership truth). `regionMarkerTexts` and
 *  `tailMarkerTexts` are every declared grammar's marker strings
 *  (declaredRegionMarkerTexts / declaredTailMarkerTexts over ALL declaration
 *  sources); they join the shipped constants to form the rosters the shared
 *  foreign-marker scan checks every declaration against. `where` names the
 *  source file in errors. */
export function declarationTextErrors(
  declaration: OwnershipDeclaration,
  source: string,
  skipMatched: boolean,
  regionMarkerTexts: readonly string[],
  where: string,
  tailMarkerTexts: readonly string[] = [],
): string[] {
  // The foreign-marker rule runs FIRST and for every declaration, so each
  // arm below states only what is true of its OWN markers. Written per arm
  // it arrived unarmed every time an arm was added (three separate fixes
  // armed managed/starter, then tail-marker, then bounded-region); written
  // here, a grammar added tomorrow inherits it before it has an arm.
  //
  // Both rosters union the SHIPPED marker constants with the texts derived
  // from live declarations. Deriving alone is self-disarming - retiring the
  // last declaration of a grammar would empty the roster and silence the
  // scan on exactly the flip it exists to catch - and the constants alone
  // would miss a custom declared marker copied into another source.
  const rosters: Record<MarkerKind, readonly string[]> = {
    tail: [...LOCAL_SECTION_LINES, ...tailMarkerTexts],
    region: [...REGION_MARKER_LINES, ...regionMarkerTexts],
  };
  const foreign = foreignMarkerErrors(declaration, source, rosters, where);
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
  if (declaration.grammar === "tail-marker") {
    // The sync rebuild splits at ONE marker line, so the source must carry
    // it exactly once (a second copy would ride into repositories where
    // the exactly-once validator flags every render)...
    const markerCount = source
      .split("\n")
      .filter((line) => line.trim() === declaration.marker).length;
    if (markerCount !== 1) {
      errors.push(
        `${where}: declared split (tail-marker) but the source carries the ` +
          `'${declaration.marker}' marker line ${markerCount} times - the sync ` +
          "rebuild splits at exactly one marker line; keep exactly one",
      );
      return errors;
    }
    // ... and the rebuild anchors its split on the render ENDING at the
    // marker line - managed content below it would be carried into
    // repositories' local tails as if it were repo-owned - so the source
    // must end there too.
    const lastNonBlank = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1);
    if (lastNonBlank !== declaration.marker) {
      errors.push(
        `${where}: declared split (tail-marker) but the source does not END at the ` +
          `'${declaration.marker}' marker line - the sync rebuild anchors the ` +
          "repo-owned tail there; move the marker to the last non-blank line " +
          "or fix the declaration",
      );
    }
    return errors;
  }
  // bounded-region: every declared marker must appear exactly once, in the
  // grammar's order (the local region above the managed half). Matched as
  // substrings rather than exact lines - splicing can glue jinja tags onto
  // a marker line (the gitignore anchor's collapse guard does) - so the
  // RENDERED line grammar stays the validator's check, not this decoration
  // check's; exactly-once is counted the same substring way the validator
  // and appendix neutralization count.
  const ordered: [string, string][] = [
    ["local BEGIN", declaration.local_begin],
    ["local END", declaration.local_end],
    ["managed BEGIN", declaration.managed_begin],
    ["managed END", declaration.managed_end],
  ];
  let previous = -1;
  for (const [name, marker] of ordered) {
    const count = source.split(marker).length - 1;
    if (count === 0) {
      errors.push(
        `${where}: declared split (bounded-region) but the source does not ` +
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
        `${where}: the ${name} marker '${marker}' appears out of the bounded-region ` +
          "order (local BEGIN, local END, managed BEGIN, managed END) - the slicer " +
          "and the managed-half hash both assume that order; fix the source",
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
  | { path: string; kind: "marker"; marker: string };

/** Render conditions the validator can evaluate from a rendered repo's
 *  answers and modules list, translated from declared filename gates. */
export interface RenderWhen {
  publicOnly?: true;
  withoutModule?: string;
}

export type BaseOwnershipEntry = OwnershipEntry & { when?: RenderWhen };

export interface RegionSplitGrammar {
  managedBegin: string;
  managedEnd: string;
  localBegin: string;
  localEnd: string;
}

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

/** The enforcement a declaration gets in the validator's tables: "header"
 *  for a managed file whose source carries the managed header,
 *  "class-only" for a managed file with no comment channel (pin dotfiles,
 *  JSON, symlinks) - nothing to check in-file, but the path must still
 *  reach the validator's manifest cross-check or a hand-flipped class
 *  would silently exempt it from byte parity - and "marker" for a
 *  tail-marker split with its exact marker line. null for starters
 *  (repo-owned; nothing to enforce) and bounded-region splits (their
 *  grammar is enforced by the region tables, not a kind). */
function enforcementOf(
  declaration: OwnershipDeclaration,
  source: string | null,
): OwnershipEntry | null {
  switch (declaration.class) {
    case "starter":
      return null;
    case "managed":
      return source !== null && hasManagedHeader(source)
        ? { path: declaration.path, kind: "header" }
        : { path: declaration.path, kind: "class-only" };
    case "split":
      return declaration.grammar === "tail-marker"
        ? { path: declaration.path, kind: "marker", marker: declaration.marker }
        : null;
    default: {
      const unhandled: never = declaration;
      throw new Error(`unhandled ownership class: ${JSON.stringify(unhandled)}`);
    }
  }
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
      // Filename-gated files only declare: module selection alone does not
      // render them, so the module-keyed tables must not enforce them.
      if (file.gates.length > 0) continue;
      if (declaration.class === "split" && declaration.grammar === "bounded-region") {
        throw new Error(
          `${where}: '${declaration.path}' declares a bounded-region split, which the ` +
            "validator's module tables do not carry yet - extend " +
            "moduleOwnershipEntries and the validator's region tables together",
        );
      }
      const entry = enforcementOf(declaration, file.source);
      if (entry !== null) entries.push(entry);
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
 *  `enforced` drives check 8 (header/marker self-declarations) and check
 *  9's class cross-check; `regionSplits` carries the bounded-region
 *  grammars (today: .gitignore) for the marker-section checks. Drift
 *  between the declarations and the base tree throws, mirroring
 *  moduleOwnershipEntries. */
export function baseOwnershipTables(templatesDir: string): {
  enforced: BaseOwnershipEntry[];
  regionSplits: Record<string, RegionSplitGrammar>;
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
  const regionSplits: Record<string, RegionSplitGrammar> = {};
  for (const declaration of declarations) {
    const file = files.get(declaration.path);
    if (file === undefined) {
      throw new Error(
        `${where}: declares '${declaration.path}', but no templates/base/ file ` +
          "lands there - fix the path or delete the entry",
      );
    }
    if (declaration.class === "split" && declaration.grammar === "bounded-region") {
      const when = translateGates(file.gates, `templates/base/${file.templateRel}`);
      if (when !== undefined) {
        throw new Error(
          `templates/base/${file.templateRel}: a gated bounded-region split has no ` +
            "validator support - the region tables assume the file always renders; " +
            "extend baseOwnershipTables alongside the gate",
        );
      }
      regionSplits[declaration.path] = {
        managedBegin: declaration.managed_begin,
        managedEnd: declaration.managed_end,
        localBegin: declaration.local_begin,
        localEnd: declaration.local_end,
      };
      continue;
    }
    const entry = enforcementOf(declaration, file.source);
    if (entry === null) continue;
    const when = translateGates(file.gates, `templates/base/${file.templateRel}`);
    enforced.push(when === undefined ? entry : { ...entry, when });
  }
  if (enforced.length === 0 || Object.keys(regionSplits).length === 0) {
    throw new Error(
      `${where}: the derived validator tables would be empty (no enforced base ` +
        "files, or no bounded-region split) - the base tree always carries both",
    );
  }
  return { enforced, regionSplits };
}

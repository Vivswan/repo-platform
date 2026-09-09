// scripts/ownership/ is the single owner of template-file OWNERSHIP truth:
// how each file the template lands relates to sync. This file holds the
// declaration schema and its loader; the siblings are landed_paths.ts
// (copier.yml's landing rules), decoration_checks.ts (the header/marker
// scans), and enforcement_tables.ts (the validator's tables). The classes
// and the contract are docs/compose.md's ownership section.
//
// Ownership is DECLARED as data (templates/base/ownership.yml and each
// module.yml's `ownership:` list), never inferred from file text: headers
// and marker lines are validated DECORATION, so deleting a header can never
// silently downgrade a file's enforcement. Every consumer (the composer's
// manifest, validate-template's generated tables) reads these same
// declarations, so ownership can never fork.
//
// Per-grammar behavior (owned markers, wire fields) is the GRAMMAR descriptor
// table in actions/shared/grammar.ts; the schema's grammar union is welded to
// the table's key set at compile time (the Expect<Equal<...>> bridge below),
// so no consumer can meet a grammar the table has no row for.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { GrammarId } from "../../actions/shared/grammar.ts";

/** A module's settings layers, next to its module.yml (docs/settings.md).
 *  Module METADATA like the manifest itself: read by the fleet's settings
 *  merge, never rendered into a repository, so the composer skips them and
 *  they declare no ownership class. */
export const SETTINGS_LAYER_NAMES = new Set([
  "settings.yml",
  "settings-public.yml",
  "settings-private.yml",
]);

// Declared paths and marker lines ride through YAML, the manifest template's
// jinja single-quoted literals, and JSON.stringify, so a single quote (ends
// the jinja literal early) and every character JSON must escape (jinja
// UNESCAPES backslash sequences, so a control character lands raw in the
// rendered JSON) are refused. The sync's split-file rebuild matches markers
// as whole trimmed lines against latin1-decoded bytes, so they must be
// trim-stable printable ASCII, and the recovery appendix writes comments in
// the marker's own syntax, so a marker opens as a hash or HTML comment.
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

/** One declared file. Exported for scripts/lib/module_manifests.ts (module
 *  `ownership:` lists) and loadBaseOwnership below: one schema, so the two
 *  declaration homes can never diverge in shape. `headerless: true` on a
 *  managed declaration says the file has no comment channel for the managed
 *  header (a symlink, a version pin, JSON), so the validator enforces its
 *  manifest class alone. DECLARED, never inferred from a missing header:
 *  inferring would let deleting the header silently downgrade the file's
 *  enforcement, the exact bypass the header guards against. */
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

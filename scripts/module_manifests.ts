#!/usr/bin/env bun
// Shared loader for the module manifests (templates/<module>/module.yml),
// the single source of truth for module identity: the copier choice text,
// the ownership declarations for every file the module lands, the
// toolchain declaration (with its CodeQL language), the dependabot
// ecosystem/label tuple, the settings layer files it ships, gitignore
// upstream sources, gitleaks lockfile patterns, Pages commands, and the
// composer's gate expression.
//
// scripts/generate.ts derives the marker-fenced GENERATED regions from
// these; scripts/compose_template.ts, scripts/build_gitignore.ts, and the
// fleet scripts read them at runtime. Every function throws (never exits)
// on missing folders/manifests, unknown keys, or invalid values, so a typo
// in a manifest fails whichever consumer touches it first.
//
// Manifest strings are interpolated into YAML, Jinja, and markdown by
// generate.ts, so the schema refuses (rather than escapes) anything that
// would change meaning there: newlines anywhere, YAML comment/mapping
// metacharacters in descriptions, single quotes in Jinja-quoted commands,
// and pipes or backticks in strings that land inside markdown table cells.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ownershipListSchema, SETTINGS_LAYER_NAMES } from "./ownership.ts";

const TEMPLATES_DIR = resolve(import.meta.dir, "..", "templates");

/** The settings layer FILES a module may ship next to its module.yml,
 *  keyed by ROLE so no consumer ever assigns meaning by list position:
 *  the module's own layer (merged for every visibility), then the
 *  visibility overlays the fleet's render picks between. The composer's
 *  skip list (SETTINGS_LAYER_NAMES in scripts/ownership.ts) names the
 *  same files; the check below holds the two rosters together so a layer
 *  name one side learns cannot silently be a landed file (or an
 *  undeclarable layer) on the other. */
export const SETTINGS_LAYER_FILES = {
  module: "settings.yml",
  public: "settings-public.yml",
  private: "settings-private.yml",
} as const;

/** The declarable filenames in stack order (the module layer, then the
 *  overlays): the manifests' settings_layers lists follow this order. */
export const SETTINGS_LAYER_ORDER = [
  SETTINGS_LAYER_FILES.module,
  SETTINGS_LAYER_FILES.public,
  SETTINGS_LAYER_FILES.private,
] as const;

export type SettingsLayerName = (typeof SETTINGS_LAYER_ORDER)[number];

if (
  SETTINGS_LAYER_NAMES.size !== SETTINGS_LAYER_ORDER.length ||
  SETTINGS_LAYER_ORDER.some((name) => !SETTINGS_LAYER_NAMES.has(name))
) {
  throw new Error(
    "SETTINGS_LAYER_ORDER (scripts/module_manifests.ts) and SETTINGS_LAYER_NAMES " +
      "(scripts/ownership.ts) disagree - the manifests' declarable layer files and " +
      "the composer's skip list must name the same files, or a new layer name would " +
      "be skipped by one side and treated as a landed file (or rejected) by the other",
  );
}

// Fixed, deterministic module order for fragment splicing, generated
// or-chains, and collision resolution (bun before uv preserves the
// dependabot ecosystem order). A templates/ folder not listed here is an
// error, and so is an entry here without a templates/ folder.
export const MODULE_ORDER = [
  "agents",
  "bun",
  "node",
  "deno",
  "uv",
  "rust",
  "pages",
  "release-please",
  "issue-templates",
  "skills",
  "pr-title",
  "auto-assign",
  "fuzzer",
  "nightly",
  "settings-sync",
  "custom-license",
];

const singleLine = (what: string) =>
  z
    .string()
    .min(1)
    .refine((value) => !/[\r\n]/.test(value), { message: `${what} must be a single line` });

// Lands inside Jinja '...' quotes within a YAML double-quoted scalar in
// copier.yml's default expressions; a single quote would end the Jinja
// literal early, and a double quote or backslash would break the YAML
// scalar around it.
const jinjaQuoted = (what: string) =>
  singleLine(what).refine((value) => !/['"\\]/.test(value), {
    message: `${what} must not contain ', ", or \\ (it lands inside Jinja quotes within a YAML double-quoted scalar)`,
  });

// Lands inside a markdown table cell in the generated docs: "|" would end
// the cell early and a backtick would open or close a code span around it.
const mdCellSafe = <T extends z.ZodType<string>>(schema: T, what: string) =>
  schema.refine((value) => !/[|`]/.test(value), {
    message: `${what} must not contain "|" or a backtick (it lands inside a markdown table cell in the generated docs)`,
  });

// The copier choice text: generate.ts renders it as the YAML mapping line
// `<module> - <description>: <module>`, where ": " would end the key early
// and "#" would start a comment.
const description = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => !/[\r\n]/.test(value), { message: "must be a single line" })
  .refine((value) => !value.includes("#"), {
    message: 'must not contain "#" (it would start a YAML comment in the copier choice line)',
  })
  .refine((value) => !value.includes(": "), {
    message: 'must not contain ": " (it would end the copier choice key early)',
  });

/** Exported for scripts/generate.ts, which derives the editor-facing
 *  templates/module.schema.json from it. */
export const manifestSchema = z.strictObject({
  description,
  // Every file the module lands, with its declared ownership class (the
  // schema and the split-grammar union live in scripts/ownership.ts). The
  // composer errors on a landed file with no declaration and on a
  // declaration whose path never lands, so a module that lands files MUST
  // carry the list; modules landing none (fragment-only modules) omit it.
  ownership: ownershipListSchema.optional(),
  // A toolchain always analyzes as SOME CodeQL language; a module that has
  // none (rust) omits the key entirely, so "toolchain without a language"
  // is unrepresentable. pin declares the fleet-wide toolchain version:
  // generate.ts emits templates/<module>/<pin.file> (exactly the version
  // plus a newline) and the module's setup steps read that dotfile.
  toolchain: z
    .strictObject({
      codeql_language: z
        .string()
        .regex(
          /^[a-z]+(-[a-z]+)*$/,
          "must be a lowercase CodeQL language slug (dash-separated words)",
        ),
      pin: z
        .strictObject({
          file: z
            .string()
            .regex(
              /^\.[a-z][a-z0-9.-]*$/,
              "must be a root dotfile name (a dot, then lowercase letters, digits, dots, dashes)",
            ),
          version: z
            .string()
            .regex(/^\d+\.\d+\.\d+$/, "must be an exact X.Y.Z version (no prefix, no range)"),
        })
        .optional(),
    })
    .optional(),
  dependabot: z
    .strictObject({
      ecosystem: z.string().regex(/^[a-z0-9-]+$/, "must be a lowercase dependabot ecosystem id"),
      label: z.string().regex(/^[a-z0-9:_-]+$/, "must be a plain lowercase label name"),
      color: z.string().regex(/^[0-9a-f]{6}$/, "must be a 6-digit lowercase hex color"),
    })
    .optional(),
  // A nightly-stream module's tracking label: the copier answer recording
  // it (the question stays hand-written; the ssot rules anchor it here),
  // the answer's default, and the tuple the stream's starter/action creates
  // the label with - the composer generates the settings-labels block from
  // it. The fleet preflight derives its answer keys from this, so a third
  // stream module cannot silently miss it.
  tracking_label: z
    .strictObject({
      answer: z
        .string()
        .regex(/^[a-z][a-z0-9_]*$/, "must be a lowercase copier answer key (snake_case)"),
      default: z
        .string()
        .regex(
          /^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}$/,
          "must be a plain label (the shape the fuzz-issue action enforces)",
        ),
      color: z.string().regex(/^[0-9A-Fa-f]{6}$/, "must be a 6-digit hex color"),
      // Lands bare (unquoted) in the generated settings-labels block and in
      // the nightly starter's label-description input, so it must read back
      // as itself from YAML - a value YAML reinterprets (booleans, numbers,
      // quotes, ': ', '#', leading indicators) is refused rather than
      // escaped.
      description: singleLine("the tracking-label description").refine(
        (value) => {
          try {
            return parseYaml(value) === value;
          } catch {
            return false;
          }
        },
        {
          message:
            "the tracking-label description must survive a YAML round-trip as the " +
            "same plain string (no quotes, booleans, numbers, ': ', or '#') - it " +
            "lands as a bare YAML scalar in the generated settings-labels block " +
            "and the nightly starter",
        },
      ),
    })
    .optional(),
  // The settings LAYER FILES the module ships next to this manifest
  // (docs/settings.md) - filenames only, never settings content: the files
  // stay plain settings-YAML documents that the fleet's render selects and
  // merges. readManifest holds this declaration and the tree together in
  // both directions, so a declared-but-missing or present-but-undeclared
  // layer file is a hard error for every manifest consumer - selecting by
  // existence alone failed OPEN (a deleted layer file silently shrank the
  // merged roster and the apply deleted its labels fleet-wide). A module
  // shipping no layer files omits the key.
  settings_layers: z
    .array(z.enum(SETTINGS_LAYER_ORDER))
    .min(1)
    .refine(
      (layers) =>
        layers.every(
          (name, index) =>
            index === 0 ||
            SETTINGS_LAYER_ORDER.indexOf(name) > SETTINGS_LAYER_ORDER.indexOf(layers[index - 1]),
        ),
      {
        message:
          "settings_layers must list each layer file at most once, in stack order " +
          `(${SETTINGS_LAYER_ORDER.join(", ")})`,
      },
    )
    .optional(),
  gitignore_sources: z
    .array(mdCellSafe(singleLine("each gitignore source"), "each gitignore source"))
    .min(1)
    .optional(),
  // Patterns land inside a Jinja '...' literal in the generated gitleaks
  // allowlist line, so a single quote would end that literal early.
  lockfiles: z
    .array(
      singleLine("each lockfile pattern").refine((value) => !value.includes("'"), {
        message:
          "each lockfile pattern must not contain ' (it lands inside Jinja quotes in the gitleaks allowlist)",
      }),
    )
    .min(1)
    .optional(),
  pages: z
    .strictObject({
      install: mdCellSafe(jinjaQuoted("the install command"), "the install command"),
      build: mdCellSafe(jinjaQuoted("the build command"), "the build command"),
    })
    .optional(),
  // Workflows the module ships that the all-green verdict must roster on
  // every pull request (docs/all-green.md, the expected set): the
  // composed fleet wrapper's conditional-workflows input is generated
  // from these declarations by compose_template.ts's data anchor.
  // Declare ONLY a workflow that produces a run on EVERY pull_request
  // event - no paths/branches filters, no narrowing types - because the
  // verdict keeps a PR PENDING while a rostered name has no run at the
  // judged sha, so a filtered workflow would wedge every PR it skips
  // (per-run opt-out belongs in job-level conditions: a run whose jobs
  // all skip concludes "skipped" and stands down). No module qualifies
  // today - every shipped PR workflow is paths- or types-filtered - so
  // the fleet renders '[]' until a qualifying workflow exists. The name
  // lands inside Jinja '...' quotes in the generated input line; the
  // path binds the name to the module's own shipped workflow, held
  // against the tree (and the file's name: line) by
  // assertConditionalWorkflowFiles, with cross-module name uniqueness
  // enforced by assertConditionalWorkflowUniqueness - the verdict fails
  // closed on two-claimant names at run time, so they must be
  // unrepresentable at authoring time.
  conditional_workflows: z
    .array(
      z.strictObject({
        name: jinjaQuoted("the conditional workflow display name")
          .refine((value) => !/[{}%#]/.test(value), {
            message:
              "the conditional workflow display name must not contain {, }, %, or # (it lands " +
              "inside the generated wrapper's Jinja, and the roster must match GitHub's " +
              "registered name literally)",
          })
          .refine(
            (value) => {
              try {
                return parseYaml(value) === value;
              } catch {
                return false;
              }
            },
            {
              message:
                "the conditional workflow display name must survive a YAML round-trip as the " +
                "same plain string - the verdict rosters the name GitHub registered, which is " +
                "the workflow file's name: value AFTER YAML parsing",
            },
          ),
        path: z
          .string()
          .regex(
            /^\.github\/workflows\/[A-Za-z0-9._-]+\.yml$/,
            "must be a .github/workflows/<file>.yml path (the module's own shipped workflow)",
          ),
      }),
    )
    .min(1)
    .optional(),
  // The gate expression is interpolated verbatim into the generated
  // _exclude patterns' `{% if not (<gate>) %}` conditions and into
  // `not (<gate>)` guard chains: { } % # would open or close a jinja
  // delimiter around it. / and \ stay banned conservatively - no current
  // gate needs them, and freeing one is a one-line schema change if a
  // gate ever does. Single quotes stay allowed - membership gates like
  // 'bun' in modules need them.
  gate: singleLine("the gate expression")
    .refine((value) => !/[{}%#/\\]/.test(value), {
      message:
        "the gate expression must not contain {, }, %, #, /, or \\ " +
        "(it lands inside the generated _exclude conditions and not(...) guard chains)",
    })
    .optional(),
});

export type ModuleManifest = z.infer<typeof manifestSchema> & { module: string };

/** Parse one manifest's YAML text; `where` names the file in errors. */
export function parseManifest(module: string, text: string, where: string): ModuleManifest {
  let data: unknown;
  try {
    data = parseYaml(text) ?? {};
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`${where}: YAML parse error: ${detail}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(
      `${where}: must be a YAML mapping of manifest keys (it parsed as something else)`,
    );
  }
  const result = manifestSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(top level)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${where}: ${details}`);
  }
  return { module, ...result.data };
}

/** Modules sharing a dependabot label (the PR label follows the language,
 *  not the ecosystem) must agree on its color: settings.yml renders one
 *  label tuple per name, so a disagreement has no correct render. */
export function assertDependabotLabelConsistency(manifests: ModuleManifest[]): void {
  const byLabel = new Map<string, { module: string; color: string }>();
  for (const manifest of manifests) {
    if (!manifest.dependabot) continue;
    const { label, color } = manifest.dependabot;
    const prior = byLabel.get(label);
    if (prior && prior.color !== color) {
      throw new Error(
        `dependabot label '${label}' has color ${prior.color} in ` +
          `templates/${prior.module}/module.yml but ${color} in ` +
          `templates/${manifest.module}/module.yml - modules sharing a label ` +
          "must agree on its color",
      );
    }
    if (!prior) byLabel.set(label, { module: manifest.module, color });
  }
}

/** Tracking-label streams are keyed by answer and by label: two modules
 *  sharing either would let one stream read (or close) the other's - the
 *  copier validator rejects equal ANSWER VALUES at generation time, but
 *  equal answer keys or equal defaults must never exist to begin with.
 *  Defaults compare lowercased: GitHub deduplicates label names
 *  case-insensitively. */
export function assertTrackingLabelUniqueness(manifests: ModuleManifest[]): void {
  const seen = new Map<string, string>();
  for (const manifest of manifests) {
    if (!manifest.tracking_label) continue;
    for (const [what, value] of [
      ["answer", manifest.tracking_label.answer],
      ["default", manifest.tracking_label.default],
    ] as const) {
      const key = `${what}:${value.toLowerCase()}`;
      const prior = seen.get(key);
      if (prior) {
        throw new Error(
          `tracking_label ${what} '${value}' is declared by both templates/${prior}/module.yml ` +
            `and templates/${manifest.module}/module.yml - every tracking stream needs its own ` +
            "answer key and default label (label names are case-insensitive on GitHub)",
        );
      }
      seen.set(key, manifest.module);
    }
  }
}

/** The manifest's settings_layers declaration against the module folder,
 *  in BOTH directions. Layer files used to be selected by existence,
 *  which failed OPEN: a deleted templates/uv/settings.yml simply vanished
 *  from the fleet render's stack, the merged label roster came out short
 *  but valid-looking, and the apply's delete-undeclared pass removed that
 *  module's labels from every live repository. readManifest runs this on
 *  every load, so the declaration can only ever shrink on purpose (one
 *  change updating manifest and tree together). `exists` is injectable so
 *  a test can prove a deletion fails loudly without deleting anything. */
export function assertSettingsLayerFiles(
  manifest: ModuleManifest,
  templatesDir: string = TEMPLATES_DIR,
  exists: (path: string) => boolean = existsSync,
): void {
  const declared = manifest.settings_layers ?? [];
  for (const name of SETTINGS_LAYER_ORDER) {
    const where = `templates/${manifest.module}/${name}`;
    const present = exists(join(templatesDir, manifest.module, name));
    if (declared.includes(name) && !present) {
      throw new Error(
        `${where}: declared in templates/${manifest.module}/module.yml settings_layers but ` +
          "missing from the tree. Selecting layer files by existence alone fails OPEN - the " +
          "merged roster silently shrinks and the settings apply deletes the missing labels " +
          "fleet-wide - so a deleted layer file must retire its settings_layers entry in the " +
          "same change.",
      );
    }
    if (!declared.includes(name) && present) {
      throw new Error(
        `${where}: exists but templates/${manifest.module}/module.yml does not declare it in ` +
          "settings_layers, so the settings render would silently ignore it; declare it there.",
      );
    }
  }
}

/** A declared conditional workflow against the module folder: the path
 *  must be a workflow FILE the module itself ships (plain or .jinja), and
 *  that file's `name:` line must spell the declared display name - the
 *  verdict rosters by display name and binds it to the registered path at
 *  run time, so a manifest naming a workflow the module does not ship (or
 *  misspelling its rendered name) would wedge every PR of every repo that
 *  selects the module, pending on a member that can never appear. `read`
 *  and `exists` are injectable so tests can force each failure without
 *  touching the tree. */
export function assertConditionalWorkflowFiles(
  manifest: ModuleManifest,
  templatesDir: string = TEMPLATES_DIR,
  exists: (path: string) => boolean = existsSync,
  read: (path: string) => string = (path) => readFileSync(path, "utf-8"),
): void {
  for (const { name, path } of manifest.conditional_workflows ?? []) {
    const where = `templates/${manifest.module}/module.yml conditional_workflows '${name}'`;
    const plain = join(templatesDir, manifest.module, path);
    const source = exists(plain) ? plain : `${plain}.jinja`;
    if (!exists(source)) {
      throw new Error(
        `${where}: the module ships no ${path} (or ${path}.jinja) - a rostered workflow the ` +
          "repository never receives keeps every PR's verdict pending forever; declare only " +
          "workflows this module lands.",
      );
    }
    const nameLine = /^name: (.+)$/m.exec(read(source));
    if (nameLine === null) {
      throw new Error(
        `${where}: ${source} has no literal top-level 'name:' line - the verdict rosters by ` +
          "display name, so the workflow's name must be a plain literal the manifest can be " +
          "held against.",
      );
    }
    if (/\{[{%]/.test(nameLine[1])) {
      throw new Error(
        `${where}: the shipped workflow's name is templated ('${nameLine[1]}') - GitHub ` +
          "registers the RENDERED name, which the manifest cannot be held against; give a " +
          "rostered workflow a plain literal name.",
      );
    }
    // GitHub registers the name: line's value AFTER YAML parsing (quotes
    // stripped, trailing comments dropped), so the raw text is not what
    // the verdict's registry will know - compare the effective value.
    let effective: unknown;
    try {
      effective = parseYaml(nameLine[1]);
    } catch {
      throw new Error(
        `${where}: the shipped workflow's name line ('${nameLine[1]}') is not a parseable ` +
          "YAML scalar, so its registered display name cannot be held against the roster.",
      );
    }
    if (typeof effective !== "string" || effective !== name) {
      throw new Error(
        `${where}: the shipped workflow names itself '${String(effective)}' - the rostered ` +
          "display name must match exactly, or the verdict waits on a member that never appears.",
      );
    }
  }
}

/** A conditional-workflow display name declared twice - within one module
 *  or across modules - is the two-claimant collision the verdict fails
 *  closed on at run time; it must be unrepresentable at authoring time. */
export function assertConditionalWorkflowUniqueness(manifests: ModuleManifest[]): void {
  const seen = new Map<string, string>();
  for (const manifest of manifests) {
    for (const { name } of manifest.conditional_workflows ?? []) {
      const prior = seen.get(name);
      if (prior) {
        throw new Error(
          `conditional workflow '${name}' is declared by both templates/${prior}/module.yml ` +
            `and templates/${manifest.module}/module.yml - the verdict rosters by display ` +
            "name and fails closed on two claimants, so every rostered name needs exactly " +
            "one owner.",
        );
      }
      seen.set(name, manifest.module);
    }
  }
}

/** Every shipped workflow's EFFECTIVE display name (the name: line's
 *  YAML-parsed value), with its template source path - base and every
 *  module, plain and .jinja files alike. Templated and nameless names are
 *  skipped: they cannot be rostered and cannot be compared (the roster
 *  schema separately refuses declaring them). */
export function shippedWorkflowNames(
  templatesDir: string = TEMPLATES_DIR,
): { name: string; source: string }[] {
  const found: { name: string; source: string }[] = [];
  for (const dir of ["base", ...MODULE_ORDER]) {
    const workflows = join(templatesDir, dir, ".github", "workflows");
    if (!existsSync(workflows)) continue;
    for (const file of readdirSync(workflows).sort()) {
      const full = join(workflows, file);
      if (!lstatSync(full).isFile()) continue;
      const nameLine = /^name: (.+)$/m.exec(readFileSync(full, "utf-8"));
      if (nameLine === null || /\{[{%]/.test(nameLine[1])) continue;
      let effective: unknown;
      try {
        effective = parseYaml(nameLine[1]);
      } catch {
        continue;
      }
      if (typeof effective !== "string") continue;
      found.push({ name: effective, source: `templates/${dir}/.github/workflows/${file}` });
    }
  }
  return found;
}

/** A declared conditional name against EVERY shipped workflow's display
 *  name: uniqueness among declarations alone would still let a declared
 *  name collide with an undeclared workflow (base CI, All Green, another
 *  module's suite) - at run time the repository's registry then knows two
 *  claimants, or resolves the name to the wrong path, and the verdict
 *  fails closed forever. Pure over the shipped list so tests can force
 *  every branch; loadManifests feeds it shippedWorkflowNames. */
export function assertConditionalWorkflowNamesUnclaimed(
  manifests: ModuleManifest[],
  shipped: { name: string; source: string }[],
): void {
  for (const manifest of manifests) {
    for (const { name, path } of manifest.conditional_workflows ?? []) {
      const own = `templates/${manifest.module}/${path}`;
      const rivals = shipped.filter(
        (wf) => wf.name === name && wf.source !== own && wf.source !== `${own}.jinja`,
      );
      if (rivals.length > 0) {
        throw new Error(
          `conditional workflow '${name}' (templates/${manifest.module}/module.yml) is also ` +
            `the display name of ${rivals.map((wf) => wf.source).join(", ")} - a rostered ` +
            "name two shipped workflows can claim makes the verdict fail closed on every PR " +
            "of a repository that lands both; rename one of them.",
        );
      }
    }
  }
}

/** Read and validate templates/<module>/module.yml. */
export function readManifest(module: string, templatesDir: string = TEMPLATES_DIR): ModuleManifest {
  if (!/^[a-z][a-z0-9-]*$/.test(module)) {
    throw new Error(
      `module name '${module}' must match ^[a-z][a-z0-9-]*$ - it is embedded ` +
        "in jinja gates, YAML keys, and markdown table cells",
    );
  }
  const where = `templates/${module}/module.yml`;
  const folder = join(templatesDir, module);
  if (!existsSync(folder) || !lstatSync(folder).isDirectory()) {
    throw new Error(
      `templates/${module}/ does not exist - every module in MODULE_ORDER ` +
        "needs a templates/ folder carrying a module.yml manifest",
    );
  }
  const path = join(folder, "module.yml");
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(
      `${where} is missing - every module declares its manifest there ` +
        "(at minimum a description, the copier choice text)",
    );
  }
  const manifest = parseManifest(module, readFileSync(path, "utf-8"), where);
  assertSettingsLayerFiles(manifest, templatesDir);
  assertConditionalWorkflowFiles(manifest, templatesDir);
  return manifest;
}

/** MODULE_ORDER <-> templates/ integrity: no duplicate entries (a
 *  duplicate would splice its fragments twice) and no templates/ folder
 *  outside the list (readManifest already rejects a listed module whose
 *  folder is missing, closing the other half of the bijection). */
export function assertModuleOrderIntegrity(order: string[], templatesDir: string): void {
  const duplicate = order.find((module, index) => order.indexOf(module) !== index);
  if (duplicate !== undefined) {
    throw new Error(
      `MODULE_ORDER lists '${duplicate}' more than once; a duplicate entry ` +
        "splices its fragments twice",
    );
  }
  const known = new Set(order);
  for (const name of readdirSync(templatesDir).sort()) {
    if (name === "base" || known.has(name)) continue;
    if (!lstatSync(join(templatesDir, name)).isDirectory()) continue;
    throw new Error(
      `templates/${name}/ is not a known module; add it to MODULE_ORDER ` +
        "in scripts/module_manifests.ts",
    );
  }
}

/** Every module's manifest, in MODULE_ORDER, cross-checked for
 *  MODULE_ORDER <-> templates/ integrity, dependabot-label consistency,
 *  tracking-label uniqueness, and conditional-workflow name integrity
 *  (unique among declarations AND unclaimed by any other shipped
 *  workflow). */
export function loadManifests(templatesDir: string = TEMPLATES_DIR): ModuleManifest[] {
  assertModuleOrderIntegrity(MODULE_ORDER, templatesDir);
  const manifests = MODULE_ORDER.map((module) => readManifest(module, templatesDir));
  assertDependabotLabelConsistency(manifests);
  assertTrackingLabelUniqueness(manifests);
  assertConditionalWorkflowUniqueness(manifests);
  assertConditionalWorkflowNamesUnclaimed(manifests, shippedWorkflowNames(templatesDir));
  return manifests;
}

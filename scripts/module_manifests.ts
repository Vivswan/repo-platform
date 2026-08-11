#!/usr/bin/env bun
// Shared loader for the module manifests (templates/<module>/module.yml),
// the single source of truth for module identity: the copier choice text,
// the toolchain declaration (with its CodeQL language), the dependabot
// ecosystem/label tuple, gitignore upstream sources, gitleaks lockfile
// patterns, Pages commands, and the composer's gate/gate_dirs.
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

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const TEMPLATES_DIR = resolve(import.meta.dir, "..", "templates");

// Fixed, deterministic module order for fragment splicing, generated
// or-chains, and collision resolution (bun before uv preserves the
// dependabot ecosystem order). A templates/ folder not listed here is an
// error, and so is an entry here without a templates/ folder.
export const MODULE_ORDER = [
  "agents",
  "bun",
  "uv",
  "rust",
  "pages",
  "release-please",
  "issue-templates",
  "pr-title",
  "auto-assign",
  "fuzzer",
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

const manifestSchema = z.strictObject({
  description,
  // A toolchain always analyzes as SOME CodeQL language; a module that has
  // none (rust) omits the key entirely, so "toolchain without a language"
  // is unrepresentable.
  toolchain: z
    .strictObject({
      codeql_language: z
        .string()
        .regex(
          /^[a-z]+(-[a-z]+)*$/,
          "must be a lowercase CodeQL language slug (dash-separated words)",
        ),
    })
    .optional(),
  dependabot: z
    .strictObject({
      ecosystem: z.string().regex(/^[a-z0-9-]+$/, "must be a lowercase dependabot ecosystem id"),
      label: z.string().regex(/^[a-z0-9:_-]+$/, "must be a plain lowercase label name"),
      color: z.string().regex(/^[0-9a-f]{6}$/, "must be a 6-digit lowercase hex color"),
    })
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
  gate: z.string().min(1).optional(),
  gate_dirs: z.array(z.string().min(1)).min(1).optional(),
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
  return parseManifest(module, readFileSync(path, "utf-8"), where);
}

/** Every module's manifest, in MODULE_ORDER, cross-checked for
 *  dependabot-label consistency. */
export function loadManifests(templatesDir: string = TEMPLATES_DIR): ModuleManifest[] {
  const manifests = MODULE_ORDER.map((module) => readManifest(module, templatesDir));
  assertDependabotLabelConsistency(manifests);
  return manifests;
}

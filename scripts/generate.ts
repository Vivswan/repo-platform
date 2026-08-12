#!/usr/bin/env bun
// Umbrella generator for the marker-fenced GENERATED regions derived from
// the module manifests (templates/<module>/module.yml, loaded by
// scripts/module_manifests.ts):
//
// - copier.yml: the modules question's choices block, the has_toolchain
//   default expression, the pages_setup default + validator, and the
//   pages_install_command / pages_build_command default chains.
// - actions/validate-template/validate_generated_files.ts: the
//   KNOWN_MODULES set literal and the TOOLCHAIN_PINS record literal (the
//   action stays self-contained for client-side execution; only the
//   constants' authorship is generated).
// - README.md, docs/new-repo.md, docs/settings.md, docs/pages.md,
//   docs/toolchains.md: the prose that enumerates manifest data (module
//   roster, dependabot labels, gitignore upstream mapping, pages toolchain
//   defaults, toolchain pins).
// - templates/module.schema.json: a WHOLE generated file (no markers), the
//   JSON Schema the manifests' yaml-language-server directive points at,
//   derived from the zod schema in scripts/module_manifests.ts.
// - templates/<module>/<pin.file> for every manifest toolchain pin: WHOLE
//   generated dotfiles carrying exactly the pinned version plus a newline.
// - templates/release-please/fragments/ci-gate-jobs.jinja and
//   templates/release-please/.github/workflows/release-please.yml.jinja:
//   the tracking-labels input both release-health call sites pass, built
//   from the manifests' tracking_label streams (jinja-comment markers, so
//   a rendered downstream workflow carries no marker text).
//
// The .gitignore outputs are NOT owned here: scripts/build_gitignore.ts
// has its own upstream-lock fetch/check cycle (bun run gitignore:check).
//
// A region is the content strictly between its BEGIN/END marker comments;
// the markers themselves are hand-placed once and never rewritten. Editing
// a region by hand is drift: --check fails CI until it is regenerated.
// Every target's output is computed before anything is written, so a
// broken marker in one file never leaves another half-updated.
//
// Line-comment files (#, //) carry the markers on lines of their own, and
// jinja templates the same way as `{#- ... #}` comment lines (the leading
// dash folds the marker line into the preceding line's whitespace the way
// the fenced `{%- if %}` blocks already do, so rendering leaves no blank
// lines behind). In
// markdown that is impossible without visible damage - a standalone
// comment line is a CommonMark HTML block that severs the paragraph,
// list, or table it sits in - so markdown markers ride INLINE at the ends
// of content lines and render as invisible inline HTML: the BEGIN marker
// ends the line preceding the region, the END marker ends the region's
// last line, and table-cell regions keep both markers inside the row.
// Markdown regions start and end at sentence or paragraph boundaries, so
// a hand-reword outside a region cannot strand a generated half-sentence.
//
// Usage:
//   bun scripts/generate.ts           # rewrite every generated region
//   bun scripts/generate.ts --check   # exit 1 if any region is stale

import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  loadManifests,
  MODULE_ORDER,
  type ModuleManifest,
  manifestSchema,
} from "./module_manifests.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The marker grammar's kind tokens. check_ssot.ts's stripGeneratedRegions
 *  builds its matcher from these, so renaming the marker text here cannot
 *  leave that stripper silently matching nothing. */
export const MARKER_TOKENS = { begin: "BEGIN GENERATED:", end: "END GENERATED:" } as const;

function markerTexts(name: string): { begin: string; end: string } {
  return {
    begin: `${MARKER_TOKENS.begin} ${name} (scripts/generate.ts - edit module.yml manifests, not this block)`,
    end: `${MARKER_TOKENS.end} ${name}`,
  };
}

/** The BEGIN/END marker comment lines fencing a line-syntax region. A
 *  suffix closes comment syntaxes that need one (jinja's `#}`). */
export function markerLines(
  name: string,
  prefix: string,
  suffix = "",
): { begin: string; end: string } {
  const texts = markerTexts(name);
  const close = suffix === "" ? "" : ` ${suffix}`;
  return { begin: `${prefix} ${texts.begin}${close}`, end: `${prefix} ${texts.end}${close}` };
}

/** The `<!-- ... -->` marker pair fencing an inline markdown region. */
export function mdMarkers(name: string): { begin: string; end: string } {
  const texts = markerTexts(name);
  return { begin: `<!-- ${texts.begin} -->`, end: `<!-- ${texts.end} -->` };
}

/** A body that carries its own marker text would splice cleanly once and
 *  corrupt the next run's marker matching; refuse it up front. */
function rejectSmuggledMarkers(body: string, file: string, name: string, markers: string[]): void {
  if (markers.some((marker) => body.includes(marker))) {
    throw new Error(
      `${file}: region '${name}' body contains its own marker text - ` +
        "that would break the next regeneration's marker matching",
    );
  }
}

/** Replace the lines strictly between a region's markers with `body`.
 *  Markers are matched by trimmed content (they may be indented) and kept
 *  verbatim; a missing, duplicated, or misordered marker throws. */
export function spliceRegion(
  text: string,
  file: string,
  name: string,
  prefix: string,
  body: string[],
  suffix = "",
): string {
  const { begin, end } = markerLines(name, prefix, suffix);
  rejectSmuggledMarkers(body.join("\n"), file, name, [begin, end]);
  const lines = text.split("\n");
  const at = (marker: string) =>
    lines.flatMap((line, index) => (line.trim() === marker ? [index] : []));
  const begins = at(begin);
  const ends = at(end);
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(
      `${file}: region '${name}' needs exactly one BEGIN and one END marker, ` +
        `found ${begins.length} and ${ends.length} - restore the marker pair`,
    );
  }
  if (ends[0] < begins[0]) {
    throw new Error(`${file}: region '${name}' has its END marker before BEGIN - swap them`);
  }
  return [...lines.slice(0, begins[0] + 1), ...body, ...lines.slice(ends[0])].join("\n");
}

/** Replace the substring strictly between a markdown region's inline
 *  markers with `body`.
 *
 *  A `string[]` body is a multi-line span: the BEGIN marker ends the line
 *  preceding the region, so the body's lines start on a fresh line. A
 *  `string` body is a table cell and must stay a single line - a newline
 *  would end the row. */
export function spliceInlineRegion(
  text: string,
  file: string,
  name: string,
  body: string | string[],
): string {
  const { begin, end } = mdMarkers(name);
  if (typeof body === "string" && /[\r\n]/.test(body)) {
    throw new Error(
      `${file}: inline region '${name}' is a table cell; its body must be a single line`,
    );
  }
  const spliced = typeof body === "string" ? body : `\n${body.join("\n")}`;
  rejectSmuggledMarkers(spliced, file, name, [begin, end]);
  const at = (marker: string, which: string) => {
    const first = text.indexOf(marker);
    if (first === -1 || text.indexOf(marker, first + 1) !== -1) {
      throw new Error(
        `${file}: inline region '${name}' needs exactly one ${which} ` +
          "marker - restore the marker pair",
      );
    }
    return first;
  };
  const begins = at(begin, "BEGIN");
  const ends = at(end, "END");
  if (ends < begins) {
    throw new Error(`${file}: inline region '${name}' has its END marker before BEGIN - swap them`);
  }
  return text.slice(0, begins + begin.length) + spliced + text.slice(ends);
}

/** Greedy word-wrap for the docs' prose regions, at the files' prevailing
 *  75-column width. */
export function wrapProse(
  text: string,
  { firstPrefix = "", indent = "", width = 75 } = {},
): string[] {
  const lines: string[] = [];
  let line: string | undefined;
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line === undefined) line = firstPrefix + word;
    else if (`${line} ${word}`.length > width) {
      lines.push(line);
      line = indent + word;
    } else line = `${line} ${word}`;
  }
  return line === undefined ? [] : [...lines, line];
}

// --- region bodies ----------------------------------------------------------
// Each returns full lines, indentation included, matching the target file's
// surrounding layout.

/** copier.yml `modules` question: the choices block. */
export function moduleChoices(manifests: ModuleManifest[]): string[] {
  return ["  choices:", ...manifests.map((m) => `    ${m.module} - ${m.description}: ${m.module}`)];
}

/** copier.yml `has_toolchain`: or-chain over the toolchain manifests. */
export function hasToolchainDefault(manifests: ModuleManifest[]): string[] {
  const chain = manifests
    .filter((m) => m.toolchain !== undefined)
    .map((m) => `'${m.module}' in modules`)
    .join(" or ");
  if (chain === "") {
    throw new Error(
      "no manifest declares a toolchain, so copier.yml's has_toolchain " +
        "default would be empty - declare toolchain: {codeql_language: ...} " +
        "in at least one module.yml",
    );
  }
  return [`  default: "{{ ${chain} }}"`];
}

export type TrackingManifest = ModuleManifest & {
  tracking_label: NonNullable<ModuleManifest["tracking_label"]>;
};

/** The tracking-stream manifests (fuzzer, nightly, ...), in MODULE_ORDER;
 *  a new stream module joins every consumer below by declaring
 *  tracking_label in its manifest. */
export function trackingStreams(manifests: ModuleManifest[]): TrackingManifest[] {
  const streams = manifests.filter((m): m is TrackingManifest => m.tracking_label !== undefined);
  if (streams.length === 0) {
    throw new Error(
      "no manifest declares tracking_label, so the release-health call " +
        "sites' tracking-labels region would be empty - declare " +
        "tracking_label in at least one module.yml",
    );
  }
  return streams;
}

/** The membership or-chain over the tracking-stream modules; exported so
 *  check_ssot.ts's dogfood-parity rule resolves the exact expression the
 *  tracking-labels region emits. */
export function trackingGate(manifests: ModuleManifest[]): string {
  return trackingStreams(manifests)
    .map((m) => `'${m.module}' in modules`)
    .join(" or ");
}

/** The release-health call sites' tracking-labels input: the selected
 *  tracking streams' label ANSWERS joined into one comma-separated value
 *  (labels cannot contain commas - copier.yml validates them against the
 *  same shape the action's LABEL_RE enforces). The body hardcodes the
 *  call sites' 10-space `with:`-entry indentation; a call site at a
 *  different depth needs its own body. */
export function trackingLabelsInput(manifests: ModuleManifest[]): string[] {
  const listExpr = trackingStreams(manifests)
    .map((m) => `([${m.tracking_label.answer}] if '${m.module}' in modules else [])`)
    .join(" + ");
  return [
    `{%- if ${trackingGate(manifests)} %}`,
    `          tracking-labels: {{ (${listExpr}) | join(',') | tojson }}`,
    "{%- endif %}",
  ];
}

export type PagesManifest = ModuleManifest & { pages: NonNullable<ModuleManifest["pages"]> };

/** The manifests declaring Pages commands, filtered once for the three
 *  pages_* region builders. */
export function pagesManifests(manifests: ModuleManifest[]): PagesManifest[] {
  const withPages = manifests.filter((m): m is PagesManifest => m.pages !== undefined);
  if (withPages.length === 0) {
    throw new Error(
      "no manifest declares pages commands, so copier.yml's pages_setup and " +
        "pages_*_command defaults would offer no toolchains - declare " +
        "pages: {install, build} in at least one module.yml",
    );
  }
  return withPages;
}

/** copier.yml `pages_setup`: default expression + validator token list. */
export function pagesSetup(withPages: PagesManifest[]): string[] {
  const defaultExpr = withPages
    .map((m) => `(['${m.module}'] if '${m.module}' in modules else [])`)
    .join(" + ");
  const names = withPages.map((m) => m.module);
  const tokenList = [...names, "none"].map((t) => `'${t}'`).join(", ");
  const tokenProse = names.length === 1 ? `${names[0]} or none` : `${names.join(", ")}, or none`;
  return [
    `  default: "{{ (${defaultExpr}) | join(',') or 'none' }}"`,
    `  validator: "{% set ts = pages_setup.split(',') %}{% if '' in ts or ts | map('trim') | list != ts %}pages_setup must be comma-separated with no spaces or empty tokens{% elif ts | reject('in', [${tokenList}]) | list %}pages_setup tokens must be ${tokenProse}{% elif ts | unique | list | length != ts | length %}pages_setup tokens must be unique{% elif 'none' in ts and ts | length > 1 %}pages_setup 'none' cannot be combined with toolchains{% endif %}"`,
  ];
}

/** The nested `'<cmd>' if '<module>' in pages_setup.split(',') else (...)`
 *  chain for a per-toolchain pages command, ending in ''. */
function pagesCommandChain(
  withPages: PagesManifest[],
  command: (pages: PagesManifest["pages"]) => string,
): string[] {
  let chain = "''";
  for (const m of [...withPages].reverse()) {
    const alternative = chain === "''" ? "''" : `(${chain})`;
    chain = `'${command(m.pages)}' if '${m.module}' in pages_setup.split(',') else ${alternative}`;
  }
  return [`  default: "{{ ${chain} }}"`];
}

/** copier.yml `pages_install_command` default chain. */
export function pagesInstallCommand(withPages: PagesManifest[]): string[] {
  return pagesCommandChain(withPages, (pages) => pages.install);
}

/** copier.yml `pages_build_command` default chain. */
export function pagesBuildCommand(withPages: PagesManifest[]): string[] {
  return pagesCommandChain(withPages, (pages) => pages.build);
}

/** validate_generated_files.ts KNOWN_MODULES set literal. */
export function knownModules(manifests: ModuleManifest[]): string[] {
  return ["const KNOWN_MODULES = new Set([", ...manifests.map((m) => `  "${m.module}",`), "]);"];
}

export interface ToolchainPin {
  module: string;
  file: string;
  version: string;
}

/** The manifests' toolchain pins, in MODULE_ORDER; every pin becomes a
 *  generated templates/<module>/<file> dotfile plus a row in the validator
 *  and docs regions below. */
export function toolchainPins(manifests: ModuleManifest[]): ToolchainPin[] {
  return manifests.flatMap((m) =>
    m.toolchain?.pin ? [{ module: m.module, ...m.toolchain.pin }] : [],
  );
}

/** The version dotfile a pin renders into managed repos: exactly the
 *  version plus a trailing newline (what the setup actions' version-file
 *  readers expect). */
export function pinFileContent(pin: ToolchainPin): string {
  return `${pin.version}\n`;
}

/** validate_generated_files.ts TOOLCHAIN_PINS record literal. */
export function toolchainPinsRegion(manifests: ModuleManifest[]): string[] {
  const pins = toolchainPins(manifests);
  if (pins.length === 0) {
    throw new Error(
      "no manifest declares a toolchain pin, so the validator's " +
        "TOOLCHAIN_PINS record would be empty - declare toolchain: " +
        "{pin: {file, version}} in at least one module.yml",
    );
  }
  return [
    "const TOOLCHAIN_PINS: Record<string, { file: string; version: string }> = {",
    // Keys stay biome-stable: bare where valid, quoted where a dash in the
    // module name requires it (matching the formatter's as-needed quoting).
    ...pins.map((p) => {
      const key = /^[a-z][a-z0-9]*$/.test(p.module) ? p.module : JSON.stringify(p.module);
      return `  ${key}: { file: "${p.file}", version: "${p.version}" },`;
    }),
    "};",
  ];
}

/** docs/toolchains.md pin table: one row per pinned toolchain module. */
export function toolchainPinRows(manifests: ModuleManifest[]): string[] {
  return toolchainPins(manifests).map((p) => `| \`${p.module}\` | \`${p.file}\` | ${p.version} |`);
}

/** Version-dotfile-shaped files at a module's root that no manifest pin
 *  declares: a renamed or removed pin leaves the old dotfile behind, and
 *  composition would keep shipping it to every render. Returned (for the
 *  caller to throw on) rather than deleted - the file may be a pin typo
 *  to fix, not an orphan to drop. */
export function strayPinFiles(manifests: ModuleManifest[], templatesDir: string): string[] {
  const strays: string[] = [];
  for (const m of manifests) {
    for (const name of readdirSync(join(templatesDir, m.module)).sort()) {
      if (!/^\.[a-z][a-z0-9.-]*$/.test(name)) continue;
      const path = join(templatesDir, m.module, name);
      if (!lstatSync(path).isFile()) continue;
      if (!/^\d+\.\d+\.\d+\n$/.test(readFileSync(path, "utf-8"))) continue;
      if (m.toolchain?.pin?.file === name) continue;
      strays.push(`templates/${m.module}/${name}`);
    }
  }
  return strays;
}

// The docs regions below regenerate hand-written prose. Each region is a
// whole sentence (or sentence run), so the hand prose around it always
// reads on regardless of how the data rewraps.

/** The backticked module roster: `agents`, `bun`, ... */
function moduleRoster(manifests: ModuleManifest[]): string {
  return manifests.map((m) => `\`${m.module}\``).join(", ");
}

/** "bun" / "bun and npm" / "bun, npm, and yarn". */
function proseList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Modules whose follow-up copier questions have a dedicated docs/ guide;
 *  the new-repo roster sentence links each one. A module with parameters
 *  gets its guide listed here when the guide lands. */
export const MODULE_PARAM_DOCS: Record<string, string> = {
  pages: "pages.md",
  fuzzer: "fuzzer.md",
  nightly: "nightly.md",
  skills: "skills.md",
};

/** The `[docs/<file>](<file>)` links for MODULE_PARAM_DOCS, in MODULE_ORDER,
 *  each key checked against the module roster and each guide against disk
 *  so a renamed module or doc fails the generator instead of emitting a
 *  dead link. */
function paramDocLinks(): string[] {
  const links: string[] = [];
  for (const module of Object.keys(MODULE_PARAM_DOCS)) {
    if (!MODULE_ORDER.includes(module)) {
      throw new Error(
        `MODULE_PARAM_DOCS names '${module}', which is not in MODULE_ORDER - ` +
          "fix the key in scripts/generate.ts",
      );
    }
  }
  for (const module of MODULE_ORDER) {
    const doc = MODULE_PARAM_DOCS[module];
    if (doc === undefined) continue;
    if (!existsSync(join(REPO_ROOT, "docs", doc))) {
      throw new Error(
        `MODULE_PARAM_DOCS maps '${module}' to docs/${doc}, which does not exist - ` +
          "fix the mapping in scripts/generate.ts or restore the guide",
      );
    }
    links.push(`[docs/${doc}](${doc})`);
  }
  return links;
}

/** README.md "Modules and channels": the roster bullet (the BEGIN marker
 *  rides on the section heading, so the span opens with the blank line
 *  separating them). */
export function readmeModuleRoster(manifests: ModuleManifest[]): string[] {
  return [
    "",
    ...wrapProse(
      `Modules (pick any combination): ${moduleRoster(manifests)}. ` +
        "Modules with parameters (like `pages`) ask follow-up questions only when " +
        "selected. After generation, module selection lives in each repo's own " +
        "`.repo-platform.yml`: edit its `modules:` list and the next sync applies " +
        "the change.",
      { firstPrefix: "- ", indent: "  " },
    ),
  ];
}

/** docs/new-repo.md: the sentence run from the `modules` multiselect
 *  through "and visibility." (the roster's own sentence). */
export function newRepoModuleRoster(manifests: ModuleManifest[]): string[] {
  return wrapProse(
    `multiselect (any combination of ${moduleRoster(manifests)}), follow-up ` +
      `parameters for modules that have them (see ${proseList(paramDocLinks())}), ` +
      "and visibility.",
  );
}

/** README.md layout-table cell for scripts/build_gitignore.ts: which
 *  upstream templates map to which module. An upstream shared by several
 *  modules (Node.gitignore under bun, node, and deno) is named once, by its
 *  first declaring module. */
export function gitignoreUpstreamMap(manifests: ModuleManifest[]): string {
  const withSources = manifests.filter(
    (m): m is ModuleManifest & { gitignore_sources: string[] } => m.gitignore_sources !== undefined,
  );
  if (withSources.length === 0) {
    throw new Error(
      "no manifest declares gitignore_sources, so the README's " +
        "build_gitignore row would map nothing - declare gitignore_sources " +
        "in at least one module.yml",
    );
  }
  const modules = withSources.map((m) => m.module).join("/");
  const seen = new Set<string>();
  const perModule = withSources.map((m) => {
    const fresh: string[] = [];
    for (const source of m.gitignore_sources) {
      const template = source.replace(/^.*\//, "").replace(/\.gitignore$/, "");
      if (!seen.has(template)) {
        seen.add(template);
        fresh.push(template);
      }
    }
    return fresh.join(" + ");
  });
  const upstreams = perModule.filter((names) => names !== "").join(" / ");
  return (
    `Regenerates the gitignore outputs (\`templates/base/.gitignore.jinja\`, the ${modules} ` +
    "toolchain fragments, this repo's `.gitignore`) from the latest " +
    "[github/gitignore](https://github.com/github/gitignore) " +
    `(Windows + macOS + Linux always, ${upstreams} by ${modules} module)`
  );
}

export interface DependabotLabelGroup {
  label: string;
  color: string;
  ecosystems: string[];
}

/** The dependabot labels the settings docs enumerate, deduped by label
 *  name (the loader already rejects same-label color disagreements), each
 *  listing its contributing ecosystems once, in manifest order. Distinct
 *  from compose_template.ts's dependabotLabels (the rich name/color/
 *  description roster) and validate_central_settings.ts's moduleLabelPairs
 *  (the fleet preflight's flat module->label pairs). */
export function dependabotLabelGroups(manifests: ModuleManifest[]): DependabotLabelGroup[] {
  const byLabel = new Map<string, DependabotLabelGroup>();
  for (const { dependabot } of manifests) {
    if (!dependabot) continue;
    const group = byLabel.get(dependabot.label);
    if (group) {
      if (!group.ecosystems.includes(dependabot.ecosystem)) {
        group.ecosystems.push(dependabot.ecosystem);
      }
    } else {
      byLabel.set(dependabot.label, {
        label: dependabot.label,
        color: dependabot.color,
        ecosystems: [dependabot.ecosystem],
      });
    }
  }
  if (byLabel.size === 0) {
    throw new Error(
      "no manifest declares a dependabot entry, so the docs' per-toolchain " +
        "label lists would be empty - declare dependabot: {ecosystem, label, " +
        "color} in at least one module.yml",
    );
  }
  return [...byLabel.values()];
}

/** `javascript` (`168700`) for bun, `python:uv` (`2b67c6`) for uv, ... */
function dependabotLabelList(manifests: ModuleManifest[]): string {
  return dependabotLabelGroups(manifests)
    .map((g) => `\`${g.label}\` (\`${g.color}\`) for ${proseList(g.ecosystems)}`)
    .join(", ");
}

/** docs/new-repo.md: the per-toolchain dependabot labels a central
 *  settings file must declare. */
export function newRepoDependabotLabels(manifests: ModuleManifest[]): string[] {
  return wrapProse(`${dependabotLabelList(manifests)}.`);
}

/** docs/settings.md: the same labels inside the apply-semantics bullet. */
export function settingsDependabotLabels(manifests: ModuleManifest[]): string[] {
  return wrapProse(`${dependabotLabelList(manifests)}.`, { firstPrefix: "  ", indent: "  " });
}

/** docs/pages.md `pages_setup` row: the Meaning cell. */
export function pagesSetupMeaning(withPages: PagesManifest[]): string {
  const names = withPages.map((m) => m.module);
  if (names.length === 1) {
    return `Toolchain installed on the build runner (\`${names[0]}\` or \`none\`)`;
  }
  const tokens = names.map((name) => `\`${name}\``).join("/");
  return `Toolchain(s) installed on the build runner (comma-separated ${tokens}, or \`none\`)`;
}

/** docs/pages.md `pages_setup` row: the Default cell. */
export function pagesSetupDefault(withPages: PagesManifest[]): string {
  const names = withPages.map((m) => m.module);
  if (names.length === 1) {
    return `\`${names[0]}\` when that module is selected, else \`none\``;
  }
  return (
    "every selected toolchain module joined with commas " +
    `(e.g. \`${names.join(",")}\`), else \`none\``
  );
}

/** docs/pages.md `pages_install_command` row: the Default cell. */
export function pagesInstallRow(withPages: PagesManifest[]): string {
  return [...withPages.map((m) => `\`${m.pages.install}\``), "empty"].join(" / ");
}

/** docs/pages.md `pages_build_command` row: the Default cell. */
export function pagesBuildRow(withPages: PagesManifest[]): string {
  return withPages.map((m) => `\`${m.pages.build}\``).join(" / ");
}

/** templates/module.schema.json: the manifest zod schema as JSON Schema
 *  (draft-07 - what yaml-language-server speaks natively). Regex/pattern
 *  and structural constraints translate; the zod refinements (single-line,
 *  quote/metacharacter safety) have no JSON Schema equivalent and are
 *  silently skipped, so the loader stays the enforcement layer and the
 *  schema is editor assistance only. */
export function moduleSchemaJson(): string {
  const { $schema, ...schema } = z.toJSONSchema(manifestSchema, { target: "draft-7" });
  return `${JSON.stringify(
    {
      $schema,
      $comment:
        "Generated by scripts/generate.ts from the zod schema in " +
        "scripts/module_manifests.ts - do not edit. Only structural and " +
        "pattern constraints translate to JSON Schema; the zod refinements " +
        "(single-line, quote/metacharacter safety) do not, so the loader " +
        "remains the enforcement layer.",
      title: "repo-platform module manifest (templates/<module>/module.yml)",
      ...schema,
    },
    null,
    2,
  )}\n`;
}

// --- targets ------------------------------------------------------------------

interface RegionInputs {
  manifests: ModuleManifest[];
  pages: PagesManifest[];
}

type SpanRegion = [name: string, body: (inputs: RegionInputs) => string[]];
type CellRegion = [name: string, body: (inputs: RegionInputs) => string];

// At least one region list is required by construction, and cell regions
// (single-line, inside table rows) exist only for markdown targets:
// line-comment files cannot carry inline markers at all.
type MarkdownRegions =
  | { regions: SpanRegion[]; cells?: CellRegion[] }
  | { regions?: SpanRegion[]; cells: CellRegion[] };

type Target =
  | { file: string; syntax: "line"; prefix: string; regions: SpanRegion[] }
  | { file: string; syntax: "jinja"; regions: SpanRegion[] }
  | ({ file: string; syntax: "markdown" } & MarkdownRegions);

const TARGETS: Target[] = [
  {
    file: "copier.yml",
    syntax: "line",
    prefix: "#",
    regions: [
      ["module-choices", ({ manifests }) => moduleChoices(manifests)],
      ["has-toolchain-default", ({ manifests }) => hasToolchainDefault(manifests)],
      ["pages-setup", ({ pages }) => pagesSetup(pages)],
      ["pages-install-command", ({ pages }) => pagesInstallCommand(pages)],
      ["pages-build-command", ({ pages }) => pagesBuildCommand(pages)],
    ],
  },
  {
    file: "actions/validate-template/validate_generated_files.ts",
    syntax: "line",
    prefix: "//",
    regions: [
      ["known-modules", ({ manifests }) => knownModules(manifests)],
      ["toolchain-pins", ({ manifests }) => toolchainPinsRegion(manifests)],
    ],
  },
  {
    file: "templates/release-please/fragments/ci-gate-jobs.jinja",
    syntax: "jinja",
    regions: [["tracking-labels", ({ manifests }) => trackingLabelsInput(manifests)]],
  },
  {
    file: "templates/release-please/.github/workflows/release-please.yml.jinja",
    syntax: "jinja",
    regions: [["tracking-labels", ({ manifests }) => trackingLabelsInput(manifests)]],
  },
  {
    file: "README.md",
    syntax: "markdown",
    regions: [["module-roster", ({ manifests }) => readmeModuleRoster(manifests)]],
    cells: [["gitignore-upstream-map", ({ manifests }) => gitignoreUpstreamMap(manifests)]],
  },
  {
    file: "docs/new-repo.md",
    syntax: "markdown",
    regions: [
      ["module-roster", ({ manifests }) => newRepoModuleRoster(manifests)],
      ["dependabot-labels", ({ manifests }) => newRepoDependabotLabels(manifests)],
    ],
  },
  {
    file: "docs/settings.md",
    syntax: "markdown",
    regions: [["dependabot-labels", ({ manifests }) => settingsDependabotLabels(manifests)]],
  },
  {
    file: "docs/pages.md",
    syntax: "markdown",
    cells: [
      ["pages-setup-meaning", ({ pages }) => pagesSetupMeaning(pages)],
      ["pages-setup-default", ({ pages }) => pagesSetupDefault(pages)],
      ["pages-install-default", ({ pages }) => pagesInstallRow(pages)],
      ["pages-build-default", ({ pages }) => pagesBuildRow(pages)],
    ],
  },
  {
    file: "docs/toolchains.md",
    syntax: "markdown",
    regions: [["toolchain-pins", ({ manifests }) => toolchainPinRows(manifests)]],
  },
];

// Fully-generated files (no markers): the whole byte content is the
// generator's output, byte-compared by --check like the regions. Each
// carries its own staleness cause - their sources differ from the
// manifests the regions derive from.
function wholeFiles(
  manifests: ModuleManifest[],
): [file: string, content: (inputs: RegionInputs) => string, stale: string][] {
  return [
    [
      "templates/module.schema.json",
      () => moduleSchemaJson(),
      "its content does not match the zod schema in scripts/module_manifests.ts " +
        "(a zod upgrade changing the emitted JSON Schema is the usual cause)",
    ],
    ...toolchainPins(manifests).map((pin): [string, (inputs: RegionInputs) => string, string] => [
      `templates/${pin.module}/${pin.file}`,
      () => pinFileContent(pin),
      `its content does not match the toolchain pin in templates/${pin.module}/module.yml`,
    ]),
  ];
}

function main(): number {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const unknown = args.filter((a) => a !== "--check");
  if (unknown.length > 0) {
    console.error(`error: unrecognized argument(s): ${unknown.join(" ")}`);
    return 2;
  }

  // Compute every output before writing anything: a bad manifest or a
  // broken marker aborts cleanly instead of leaving a target half-updated.
  let changed: { path: string; file: string; next: string; stale: string }[];
  try {
    const manifests = loadManifests();
    const strays = strayPinFiles(manifests, join(REPO_ROOT, "templates"));
    if (strays.length > 0) {
      throw new Error(
        `stray toolchain version dotfile(s) not declared by any manifest pin: ` +
          `${strays.join(", ")} - a renamed or removed pin leaves the old file ` +
          "shipping to every render; delete it (or fix the manifest's pin.file)",
      );
    }
    const inputs: RegionInputs = { manifests, pages: pagesManifests(manifests) };
    const regionStale = "its generated region(s) do not match the module manifests";
    changed = TARGETS.flatMap((target) => {
      const path = join(REPO_ROOT, target.file);
      const current = readFileSync(path, "utf-8");
      let next = current;
      if (target.syntax === "line") {
        for (const [name, body] of target.regions) {
          next = spliceRegion(next, target.file, name, target.prefix, body(inputs));
        }
      } else if (target.syntax === "jinja") {
        for (const [name, body] of target.regions) {
          next = spliceRegion(next, target.file, name, "{#-", body(inputs), "#}");
        }
      } else {
        for (const [name, body] of target.regions ?? []) {
          next = spliceInlineRegion(next, target.file, name, body(inputs));
        }
        for (const [name, body] of target.cells ?? []) {
          next = spliceInlineRegion(next, target.file, name, body(inputs));
        }
      }
      return next === current ? [] : [{ path, file: target.file, next, stale: regionStale }];
    });
    changed.push(
      ...wholeFiles(manifests).flatMap(([file, content, stale]) => {
        const path = join(REPO_ROOT, file);
        const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
        const next = content(inputs);
        return next === current ? [] : [{ path, file, next, stale }];
      }),
    );
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (check) {
    for (const { file, stale } of changed) {
      console.log(`${file} is stale: ${stale}; run bun run generate to rewrite it`);
    }
    if (changed.length > 0) return 1;
    console.log("generated regions are up to date");
    return 0;
  }
  for (const { path, file, next } of changed) {
    writeFileSync(path, next);
    console.log(`rewrote ${file}'s generated content`);
  }
  if (changed.length === 0) {
    console.log("generated content already matches its sources; nothing to write");
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

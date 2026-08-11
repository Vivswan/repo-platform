#!/usr/bin/env bun
// Compose the flat template/ tree Copier renders from templates/ sources.
//
// templates/ is the source of truth, one folder per module plus base/:
//
// - templates/base/: passed through verbatim, filenames included (explicit
//   conditional filenames like CONTRIBUTING.md's `not private` gate live here).
// - templates/<module>/: whole files owned by that module. The composer adds
//   the module's filename gate automatically ({% if '<module>' in modules %}),
//   wrapping the leaf name (keeping any .jinja suffix outside), or a whole
//   directory listed in the module.yml manifest's `gate_dirs`. module.yml is
//   the module's manifest (schema: scripts/module_manifests.ts).
// - templates/<module>/fragments/<anchor>.jinja: additive contributions to
//   shared files. A skeleton file carries a marker line starting with
//   `{# compose:<anchor> #}` (text after the closing tag is appended
//   verbatim after the last contribution, for inline `{% endif %}<text>`
//   junctions); the composer replaces the line with every contribution in
//   MODULE_ORDER, each fragment wrapped in its module's gate. Fragments own
//   all whitespace between the tags; the composer adds none.
// - Data anchors (DATA_ANCHORS below) are filled from manifest data instead
//   of fragment files, so the composed output carries no marker comments and
//   list-shaped content cannot drift from the manifests. The sharing rule: a
//   manifest value declared by several modules is grouped BY VALUE, emitted
//   ONCE, and gated on the or-chain of the contributing modules in
//   MODULE_ORDER - never per-module duplicates, never precedence guards.
//   A fragment file for a data anchor is an error, with two exceptions:
//   ci-gate-needs still takes fragments from modules the generator does not
//   cover, and agents-toolchain consumes its fragments as generator input.
//
// Every anchor needs at least one contribution (fragment or generated) and
// every contribution needs its anchor. Collisions are errors, never silent
// merges: the same logical path provided by two folders (or a module file
// colliding with base) must be resolved by hoisting the file to base/ with
// an explicit gate or by adding an anchor.
//
// All I/O is bytes (source files are copied verbatim, never re-encoded) and
// symlinks are copied as symlinks. Output is deterministic: sorted walks plus
// the fixed MODULE_ORDER (CI builds twice and diffs to prove it).
//
// Usage:
//   bun scripts/compose_template.ts   # regenerate the local template/ artifact

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadManifests, MODULE_ORDER, type ModuleManifest } from "./module_manifests.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SRC = join(REPO_ROOT, "templates");
const OUT = join(REPO_ROOT, "template");

// Module identity (the order included) lives with the manifests; re-exported
// here for the existing importers keyed on the composer.
export { MODULE_ORDER };

const ANCHOR_RE = /^\{# compose:([a-z0-9][a-z0-9-]*) #\}([^\r]*)$/;
const JINJA_SUFFIX = ".jinja";
const MANIFEST_NAME = "module.yml";
const FRAGMENTS_DIR = "fragments";

// One collected source file: regular bytes or a symlink target (emitted as a
// link with the target rewritten).
export type Entry = { kind: "symlink"; target: string } | { kind: "file"; data: Buffer };

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function relToRepo(path: string): string {
  return path.startsWith(`${REPO_ROOT}/`) ? path.slice(REPO_ROOT.length + 1) : path;
}

function readEntry(path: string): Entry {
  if (lstatSync(path).isSymbolicLink()) return { kind: "symlink", target: readlinkSync(path) };
  return { kind: "file", data: readFileSync(path) };
}

/** All non-directory entries below `dir` as relative paths, sorted. */
function walkFiles(dir: string): string[] {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(dir, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(childRel);
      else if (stat.isSymbolicLink() || stat.isFile()) found.push(childRel);
    }
  };
  visit("");
  return found.sort();
}

/** Logical path -> Entry for a source folder (skips manifest + fragments). */
function collectFiles(folder: string): Map<string, Entry> {
  const files = new Map<string, Entry>();
  for (const rel of walkFiles(folder)) {
    if (rel.split("/")[0] === FRAGMENTS_DIR || rel === MANIFEST_NAME) continue;
    files.set(rel, readEntry(join(folder, rel)));
  }
  return files;
}

/** Anchor name -> fragment bytes for a module folder. */
function collectFragments(folder: string): Map<string, Buffer> {
  const fragments = new Map<string, Buffer>();
  const fragDir = join(folder, FRAGMENTS_DIR);
  if (!existsSync(fragDir) || !lstatSync(fragDir).isDirectory()) return fragments;
  for (const name of readdirSync(fragDir).sort()) {
    const path = join(fragDir, name);
    if (!lstatSync(path).isFile()) continue;
    if (!name.endsWith(JINJA_SUFFIX)) {
      die(
        `error: ${relToRepo(path)}: fragment files must end in ` +
          `${JINJA_SUFFIX} (the composer strips it to get the anchor name); ` +
          `rename the file to <anchor>${JINJA_SUFFIX} or move it out of ${FRAGMENTS_DIR}/`,
      );
    }
    fragments.set(name.slice(0, -JINJA_SUFFIX.length), readFileSync(path));
  }
  return fragments;
}

/** A module's gate expression: its manifest override or plain membership.
 *  Exported so build_gitignore's cross-module guards negate the same
 *  expressions the composer gates with. */
export function gateExpression(module: string, manifest: ModuleManifest): string {
  return manifest.gate || `'${module}' in modules`;
}

function rpartition(value: string, sep: string): [string, string, string] {
  const index = value.lastIndexOf(sep);
  if (index === -1) return ["", "", value];
  return [value.slice(0, index), sep, value.slice(index + sep.length)];
}

/** Wrap the leaf filename (or a declared directory) in the module gate. */
function gatedPath(logical: string, gate: string, gateDirs: string[]): string {
  for (const gatedDir of gateDirs) {
    const prefix = gatedDir.replace(/\/+$/, "");
    if (logical === prefix || logical.startsWith(`${prefix}/`)) {
      const [parent, , dirname_] = rpartition(prefix, "/");
      const wrapped = `{% if ${gate} %}${dirname_}{% endif %}`;
      const newPrefix = parent ? `${parent}/${wrapped}` : wrapped;
      return newPrefix + logical.slice(prefix.length);
    }
  }
  const [parent, , leaf] = rpartition(logical, "/");
  let wrapped: string;
  if (leaf.endsWith(JINJA_SUFFIX)) {
    const stem = leaf.slice(0, -JINJA_SUFFIX.length);
    wrapped = `{% if ${gate} %}${stem}{% endif %}${JINJA_SUFFIX}`;
  } else {
    wrapped = `{% if ${gate} %}${leaf}{% endif %}`;
  }
  return parent ? `${parent}/${wrapped}` : wrapped;
}

// --- data anchors ----------------------------------------------------------

// A total module -> gate lookup: build() populates the gate map for every
// module in MODULE_ORDER before any generator runs, so a miss can only be
// a programming error and fails loudly instead of guessing a gate.
type GateOf = (module: string) => string;

/** The gate for a group of contributing modules: each module's own gate
 *  expression, or-chained in the given (MODULE_ORDER) order. */
export function orChain(modules: string[], gateOf: GateOf): string {
  return modules.map((module) => gateOf(module)).join(" or ");
}

/** The CodeQL job slug for a language: its first dash-separated word
 *  (javascript-typescript -> javascript, python -> python). */
export function codeqlSlug(language: string): string {
  return language.split("-")[0];
}

// YAML parses these unquoted lowercase words as non-strings.
const YAML_RESERVED = new Set(["true", "false", "null"]);

/** settings.yml label names are emitted quoted unless they are plainly
 *  safe YAML scalars (lowercase word characters, no leading digit, not a
 *  reserved word) - python:uv gets quotes, javascript stays bare. */
export function yamlLabelName(name: string): string {
  return /^[a-z][a-z0-9_-]*$/.test(name) && !YAML_RESERVED.has(name) ? name : `"${name}"`;
}

export type EcosystemGroup = { ecosystem: string; modules: string[] };

/** Distinct dependabot ecosystems with their contributing modules, in
 *  MODULE_ORDER of first contributor. */
export function ecosystemGroups(manifests: ModuleManifest[]): EcosystemGroup[] {
  const groups = new Map<string, EcosystemGroup>();
  for (const manifest of manifests) {
    if (!manifest.dependabot) continue;
    const { ecosystem } = manifest.dependabot;
    const group = groups.get(ecosystem) ?? { ecosystem, modules: [] };
    group.modules.push(manifest.module);
    groups.set(ecosystem, group);
  }
  return [...groups.values()];
}

export type CodeqlGroup = { language: string; slug: string; modules: string[] };

/** Distinct CodeQL languages with their contributing modules, in
 *  MODULE_ORDER of first contributor. Two distinct languages deriving the
 *  same job slug would emit duplicate codeql-<slug> YAML keys (one language
 *  silently lost), so that collision throws. */
export function codeqlGroups(manifests: ModuleManifest[]): CodeqlGroup[] {
  const groups = new Map<string, CodeqlGroup>();
  const bySlug = new Map<string, CodeqlGroup>();
  for (const manifest of manifests) {
    if (!manifest.toolchain) continue;
    const language = manifest.toolchain.codeql_language;
    const slug = codeqlSlug(language);
    if (slug === "") {
      throw new GeneratorValidationError(
        `CodeQL language '${language}' (templates/${manifest.module}/module.yml) ` +
          "derives an empty job slug - fix the language to start with a word",
      );
    }
    const collision = bySlug.get(slug);
    if (collision && collision.language !== language) {
      throw new GeneratorValidationError(
        `CodeQL languages '${collision.language}' (modules ${collision.modules.join(", ")}) ` +
          `and '${language}' (templates/${manifest.module}/module.yml) both derive the ` +
          `job slug 'codeql-${slug}' - the generated jobs would collide as duplicate ` +
          "YAML keys; consolidate the modules onto one language",
      );
    }
    const group = groups.get(language) ?? { language, slug, modules: [] };
    group.modules.push(manifest.module);
    groups.set(language, group);
    bySlug.set(slug, group);
  }
  return [...groups.values()];
}

export type DependabotLabel = {
  name: string;
  color: string;
  description: string;
  modules: string[];
};

/** Distinct dependabot PR labels with their contributing modules, in
 *  MODULE_ORDER of first contributor (shared labels agree on their color -
 *  the manifest loader asserts it). check_ssot.ts reads this too, so the
 *  label rosters cannot drift from what the composer emits. */
export function dependabotLabels(manifests: ModuleManifest[]): DependabotLabel[] {
  const groups = new Map<string, DependabotLabel>();
  for (const manifest of manifests) {
    if (!manifest.dependabot) continue;
    const { label, color } = manifest.dependabot;
    const group = groups.get(label) ?? {
      name: label,
      color,
      description: `Pull requests that update ${label} code`,
      modules: [],
    };
    group.modules.push(manifest.module);
    groups.set(label, group);
  }
  return [...groups.values()];
}

export type LockfileGroup = { patterns: string[]; modules: string[] };

/** Gitleaks lockfile patterns grouped for emission: each distinct pattern
 *  appears once with its declaring modules; consecutive patterns with the
 *  same module set share one group (one emitted line). */
export function lockfileGroups(manifests: ModuleManifest[]): LockfileGroup[] {
  const byPattern = new Map<string, string[]>();
  for (const manifest of manifests) {
    for (const pattern of manifest.lockfiles ?? []) {
      const modules = byPattern.get(pattern) ?? [];
      if (!modules.includes(manifest.module)) modules.push(manifest.module);
      byPattern.set(pattern, modules);
    }
  }
  const groups: LockfileGroup[] = [];
  for (const [pattern, modules] of byPattern) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last.modules.length === modules.length &&
      last.modules.every((m, i) => m === modules[i])
    ) {
      last.patterns.push(pattern);
    } else {
      groups.push({ patterns: [pattern], modules });
    }
  }
  return groups;
}

// One spliced piece of an anchor's replacement, already carrying its gate.
// `order` is the MODULE_ORDER position of the (first) contributing module,
// so generated groups interleave with fragment contributions exactly where
// the contributing modules sit.
type Contribution = { order: number; source: string; text: Buffer };

/** A generator's own validation failure (bad manifest data): reported as a
 *  clean composition error. Anything else escaping a generator is a bug and
 *  is rethrown with its stack preserved via `cause`. */
export class GeneratorValidationError extends Error {}

/** Rendered-separation invariant for an anchor's ordered contributions:
 *  every NON-LAST contribution, once its trailing closing tags are
 *  stripped, must end with a newline - otherwise two selected
 *  contributions render onto one line (adjacent `{% if %}...{% endif %}`
 *  wrappers emit no separator of their own). The last contribution may end
 *  mid-line (pr-title's gate entry does). */
export function renderedSeparationErrors(
  anchor: string,
  contributions: { source: string; text: Buffer }[],
): string[] {
  const errors: string[] = [];
  for (let i = 0; i + 1 < contributions.length; i++) {
    const { source, text } = contributions[i];
    let body = text.toString("latin1");
    for (;;) {
      const stripped = body.replace(/\{%-?\s*endif\s*-?%\}$/, "");
      if (stripped === body) break;
      body = stripped;
    }
    if (!body.endsWith("\n")) {
      errors.push(
        `anchor '${anchor}': ${source} renders without a trailing newline ` +
          `(after its closing tags) but a later contribution follows - when ` +
          "both are selected they render onto one line; end the fragment " +
          "body with a newline",
      );
    }
  }
  return errors;
}

type GeneratorContext = { manifests: ModuleManifest[]; gateOf: GateOf };

// Discriminated on `kind` so the shapes stay honest: only a coexist anchor
// can (and must) say which modules the generator covers, and only a consume
// generator ever sees fragment bytes.
type DataAnchorSpec = { data: string } & (
  | {
      /** Any fragment file for the anchor is an error. */
      kind: "reject";
      generate: (ctx: GeneratorContext) => Contribution[];
    }
  | {
      /** Fragments splice normally unless `covered` claims their module. */
      kind: "coexist";
      covered: (manifest: ModuleManifest) => boolean;
      generate: (ctx: GeneratorContext) => Contribution[];
    }
  | {
      /** Fragments become the generator's input instead of being spliced. */
      kind: "consume";
      generate: (ctx: GeneratorContext & { fragments: [string, Buffer][] }) => Contribution[];
    }
);

function gatedText(gate: string, body: string): string {
  return `{% if ${gate} %}${body}{% endif %}`;
}

function generatorSource(anchor: string, data: string): string {
  return `the built-in '${anchor}' generator (module.yml ${data})`;
}

function orderOf(manifests: ModuleManifest[], module: string): number {
  return manifests.findIndex((manifest) => manifest.module === module);
}

function ecosystemBlock(ecosystem: string): string {
  return `
  - package-ecosystem: "${ecosystem}"
    directory: "/"
    schedule:
      interval: "monthly"
    cooldown:
      default-days: 7
    commit-message:
      prefix: "build"
      include: "scope"
`;
}

function codeqlJob(group: CodeqlGroup): string {
  return `
  codeql-${group.slug}:
    uses: {{ github_username }}/repo-platform/.github/workflows/reusable-codeql.yml@{{ uses_ref }}
    with:
      language: ${group.language}
    permissions:
      contents: read
      security-events: write
      actions: read
`;
}

/** The rendered settings.yml block for one label group; exported so tests
 *  can round-trip it through a YAML parser. */
export function labelBlock(label: DependabotLabel): string {
  return (
    `  - name: ${yamlLabelName(label.name)}\n` +
    `    color: "${label.color}"\n` +
    `    description: ${label.description}\n`
  );
}

const DATA_ANCHORS: Record<string, DataAnchorSpec> = {
  "dependabot-ecosystems": {
    data: "dependabot.ecosystem",
    kind: "reject",
    generate: ({ manifests, gateOf }) =>
      ecosystemGroups(manifests).map((group) => ({
        order: orderOf(manifests, group.modules[0]),
        source: generatorSource("dependabot-ecosystems", "dependabot.ecosystem"),
        text: Buffer.from(
          gatedText(orChain(group.modules, gateOf), ecosystemBlock(group.ecosystem)),
        ),
      })),
  },
  "codeql-languages": {
    data: "toolchain.codeql_language",
    kind: "reject",
    generate: ({ manifests, gateOf }) =>
      codeqlGroups(manifests).map((group) => ({
        order: orderOf(manifests, group.modules[0]),
        source: generatorSource("codeql-languages", "toolchain.codeql_language"),
        text: Buffer.from(gatedText(orChain(group.modules, gateOf), codeqlJob(group))),
      })),
  },
  // Mixed anchor: the toolchain gate entries are generated here; pr-title
  // and release-please still contribute fragment files, spliced at their
  // own MODULE_ORDER positions.
  "ci-gate-needs": {
    data: "toolchain.codeql_language",
    kind: "coexist",
    covered: (manifest) => manifest.toolchain !== undefined,
    generate: ({ manifests, gateOf }) =>
      codeqlGroups(manifests).map((group) => ({
        order: orderOf(manifests, group.modules[0]),
        source: generatorSource("ci-gate-needs", "toolchain.codeql_language"),
        text: Buffer.from(
          gatedText(
            orChain(group.modules, gateOf),
            `{% if enable_codeql %}      - codeql-${group.slug}\n{% endif %}`,
          ),
        ),
      })),
  },
  "settings-dependabot-labels": {
    data: "dependabot.label",
    kind: "reject",
    generate: ({ manifests, gateOf }) =>
      dependabotLabels(manifests).map((label) => ({
        order: orderOf(manifests, label.modules[0]),
        source: generatorSource("settings-dependabot-labels", "dependabot.label"),
        text: Buffer.from(gatedText(orChain(label.modules, gateOf), labelBlock(label))),
      })),
  },
  "gitleaks-locks": {
    data: "lockfiles",
    kind: "reject",
    generate: ({ manifests, gateOf }) => {
      const groups = lockfileGroups(manifests);
      if (groups.length === 0) return [];
      const lines = groups.map(
        ({ patterns, modules }) =>
          `{%- if ${orChain(modules, gateOf)} %}${patterns
            .map((pattern) => `{% set _ = locks.append('${pattern}') %}`)
            .join("")}{% endif %}`,
      );
      return [
        {
          order: orderOf(manifests, groups[0].modules[0]),
          source: generatorSource("gitleaks-locks", "lockfiles"),
          text: Buffer.from(lines.join("\n")),
        },
      ];
    },
  },
  // The generator owns the whole Toolchain block: the outer guard is the
  // or-chain over the modules that ship an agents-toolchain fragment, so a
  // new toolchain module extends it by adding its fragment - nothing
  // hand-written to keep in sync. The bullet text itself stays free-form in
  // the fragments (which must end with a newline - the closing tag needs its
  // own line).
  "agents-toolchain": {
    data: "fragments/agents-toolchain.jinja",
    kind: "consume",
    generate: ({ manifests, gateOf, fragments }) => {
      if (fragments.length === 0) return [];
      const modules = fragments.map(([module]) => module);
      const parts: Buffer[] = [
        Buffer.from(`{% if ${orChain(modules, gateOf)} %}\n## Toolchain\n\n`),
      ];
      for (const [module, body] of fragments) {
        parts.push(
          Buffer.from(`{% if ${gateOf(module)} -%}\n`),
          body,
          Buffer.from("{% endif -%}\n"),
        );
      }
      parts.push(Buffer.from("{% endif %}"));
      return [
        {
          order: orderOf(manifests, modules[0]),
          source: generatorSource("agents-toolchain", "fragments"),
          text: Buffer.concat(parts),
        },
      ];
    },
  },
};

// --- splicing ----------------------------------------------------------------

const NEWLINE = Buffer.from("\n");
const ANCHOR_HINT = Buffer.from("{# compose:");

function splitLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a) {
      lines.push(data.subarray(start, i));
      start = i + 1;
    }
  }
  lines.push(data.subarray(start));
  return lines;
}

function joinLines(lines: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  lines.forEach((line, index) => {
    if (index > 0) parts.push(NEWLINE);
    parts.push(line);
  });
  return Buffer.concat(parts);
}

function matchAnchor(line: Buffer): { name: string; trailing: string } | null {
  // Bytes, matched as latin1: non-ASCII bytes can never satisfy the pattern.
  const match = ANCHOR_RE.exec(line.toString("latin1"));
  return match ? { name: match[1], trailing: match[2] } : null;
}

function sortedByKey<V>(map: Map<string, V>): [string, V][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

type SourcedEntry =
  | { origin: "base"; entry: Entry }
  | { origin: "module"; module: string; gate: string; gateDirs: string[]; entry: Entry };

function sourceName(sourced: SourcedEntry): string {
  return sourced.origin === "base" ? "base" : sourced.module;
}

/** Replace anchor lines in-place; returns error strings. */
function spliceContributions(
  files: Map<string, SourcedEntry>,
  contributions: Map<string, Contribution[]>,
): string[] {
  const errors: string[] = [];
  const anchorOwner = new Map<string, [string, string]>(); // anchor -> [source, logical]
  for (const [logical, sourced] of sortedByKey(files)) {
    const { entry } = sourced;
    if (entry.kind === "symlink") continue;
    for (const line of splitLines(entry.data)) {
      if (line.includes(ANCHOR_HINT) && matchAnchor(line) === null) {
        errors.push(
          `templates/${sourceName(sourced)}/${logical}: malformed anchor line ` +
            `'${line.toString("utf-8").trim()}' - anchors must start the ` +
            "line as '{# compose:<name> #}' (no indentation or CRLF; text " +
            "after the closing tag is appended verbatim after the last " +
            "contribution)",
        );
        continue;
      }
      const anchor = matchAnchor(line);
      if (anchor === null) continue;
      if (anchor.trailing !== "" && anchor.trailing.trim() === "") {
        errors.push(
          `templates/${sourceName(sourced)}/${logical}: anchor '${anchor.name}' ` +
            "carries only whitespace after the closing tag - almost certainly " +
            "an accident (a trailing literal must contain visible text); " +
            "delete the stray whitespace",
        );
      }
      const other = anchorOwner.get(anchor.name);
      if (other) {
        errors.push(
          `duplicate anchor '${anchor.name}' in templates/${sourceName(sourced)}/${logical} ` +
            `and templates/${other[0]}/${other[1]} - each anchor may appear ` +
            "in exactly one skeleton file; rename one anchor (and any " +
            `fragments/${anchor.name}.jinja files that feed it) or remove the duplicate marker`,
        );
      }
      anchorOwner.set(anchor.name, [sourceName(sourced), logical]);
    }
  }

  for (const [anchor, list] of sortedByKey(contributions)) {
    if (!anchorOwner.has(anchor)) {
      for (const { source } of list) {
        errors.push(
          `${source}: no anchor {# compose:${anchor} #} found in any source ` +
            "file - the contribution has nowhere to splice; add the marker " +
            "line to a skeleton file, or remove the contribution (delete " +
            "the fragment or drop the manifest data feeding it)",
        );
      }
    }
  }
  for (const [anchor, [source, logical]] of sortedByKey(anchorOwner)) {
    if ((contributions.get(anchor)?.length ?? 0) > 0) continue;
    const dataHint =
      anchor in DATA_ANCHORS ? `, or declare the manifest data (${DATA_ANCHORS[anchor].data})` : "";
    errors.push(
      `templates/${source}/${logical}: anchor '${anchor}' has no ` +
        `contributions - remove the marker or add ${FRAGMENTS_DIR}/${anchor}${JINJA_SUFFIX} ` +
        `to a module${dataHint}`,
    );
  }
  if (errors.length > 0) return errors;

  for (const sourced of files.values()) {
    const { entry } = sourced;
    if (entry.kind === "symlink" || !entry.data.includes(ANCHOR_HINT)) continue;
    const rebuilt: Buffer[] = [];
    for (const line of splitLines(entry.data)) {
      const anchor = matchAnchor(line);
      if (anchor === null) {
        rebuilt.push(line);
        continue;
      }
      const spliced = Buffer.concat([
        ...(contributions.get(anchor.name) as Contribution[]).map(({ text }) => text),
        Buffer.from(anchor.trailing),
      ]);
      rebuilt.push(spliced);
    }
    entry.data = joinLines(rebuilt);
  }
  return errors;
}

/** Compose the output map: emitted path -> Entry. Exits 1 on errors. */
export function build(): Map<string, Entry> {
  const base = join(SRC, "base");
  if (!existsSync(base) || !lstatSync(base).isDirectory() || readdirSync(base).length === 0) {
    die(
      "error: templates/base is missing or empty; refusing to compose " +
        "(a broken checkout must not wipe template/). Restore templates/base/ " +
        "with git checkout before rerunning.",
    );
  }
  const folders = readdirSync(SRC)
    .filter((name) => name !== "base" && lstatSync(join(SRC, name)).isDirectory())
    .sort();
  const unknown = folders.filter((f) => !MODULE_ORDER.includes(f));
  if (unknown.length > 0) {
    die(
      `error: templates/${unknown[0]}/ is not a known module; add it to ` +
        "MODULE_ORDER in scripts/module_manifests.ts",
    );
  }
  const missing = MODULE_ORDER.filter((m) => !folders.includes(m));
  if (missing.length > 0) {
    die(
      `error: MODULE_ORDER lists '${missing[0]}' but templates/${missing[0]}/ ` +
        "does not exist; remove it from MODULE_ORDER in " +
        "scripts/module_manifests.ts or restore the folder",
    );
  }
  const duplicate = MODULE_ORDER.find((m, i) => MODULE_ORDER.indexOf(m) !== i);
  if (duplicate !== undefined) {
    die(
      `error: MODULE_ORDER lists '${duplicate}' more than once; a duplicate ` +
        "entry splices its fragments twice",
    );
  }

  let manifests: ModuleManifest[];
  try {
    manifests = loadManifests();
  } catch (error) {
    die(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifestByModule = new Map(manifests.map((manifest) => [manifest.module, manifest]));

  const errors: string[] = [];
  const files = new Map<string, SourcedEntry>();
  const fragments = new Map<string, [string, Buffer][]>();
  const gates = new Map<string, string>();

  for (const [logical, entry] of collectFiles(base)) {
    files.set(logical, { origin: "base", entry });
  }
  try {
    lstatSync(join(base, FRAGMENTS_DIR));
    errors.push(
      `templates/base/${FRAGMENTS_DIR}: base cannot contribute fragments ` +
        "(it owns the skeletons); fragments belong to module folders",
    );
  } catch {
    // No fragments/ entry under base - the expected state.
  }

  for (const module of MODULE_ORDER) {
    const folder = join(SRC, module);
    const manifest = manifestByModule.get(module) as ModuleManifest;
    const gate = gateExpression(module, manifest);
    gates.set(module, gate);
    const dirs = [...(manifest.gate_dirs ?? [])];
    const moduleFiles = collectFiles(folder);
    // Every gate_dirs entry must name a DIRECTORY holding at least one of
    // this module's files - a typo would otherwise silently fall back to
    // per-leaf gating, and a file entry would break .jinja suffix handling.
    for (const gatedDir of dirs) {
      const prefix = gatedDir.replace(/\/+$/, "");
      if (moduleFiles.has(prefix)) {
        errors.push(
          `templates/${module}/${MANIFEST_NAME}: gate_dirs entry ` +
            `'${gatedDir}' is a file, not a directory - leaf files are ` +
            "gated automatically; remove the entry",
        );
      } else if (![...moduleFiles.keys()].some((p) => p.startsWith(`${prefix}/`))) {
        errors.push(
          `templates/${module}/${MANIFEST_NAME}: gate_dirs entry ` +
            `'${gatedDir}' matches none of the module's files - likely a ` +
            "typo; fix the path or remove the entry",
        );
      }
    }
    for (const [logical, entry] of moduleFiles) {
      if (logical.includes("{%")) {
        errors.push(
          `templates/${module}/${logical}: module files must not hand-write ` +
            `filename gates; the composer adds the '${module}' gate ` +
            "automatically (custom gates go in module.yml)",
        );
        continue;
      }
      const existing = files.get(logical);
      if (existing) {
        errors.push(
          `collision: templates/${sourceName(existing)}/${logical} and ` +
            `templates/${module}/${logical} both provide ${logical}. Additive ` +
            "content must go through an anchor ({# compose:<name> #} plus " +
            `${FRAGMENTS_DIR}/<name>${JINJA_SUFFIX}); otherwise hoist the file ` +
            "to templates/base/ with an explicit {% if %} filename.",
        );
        continue;
      }
      files.set(logical, { origin: "module", module, gate, gateDirs: dirs, entry });
    }
    for (const [anchor, body] of collectFragments(folder)) {
      const contributions = fragments.get(anchor) ?? [];
      contributions.push([module, body]);
      fragments.set(anchor, contributions);
    }
  }

  // Route every fragment and data generator into per-anchor contributions.
  const contributions = new Map<string, Contribution[]>();
  const addContribution = (anchor: string, contribution: Contribution) => {
    const list = contributions.get(anchor) ?? [];
    list.push(contribution);
    contributions.set(anchor, list);
  };
  const gateOf: GateOf = (module) => {
    const gate = gates.get(module);
    if (gate === undefined) {
      throw new Error(`no gate for module '${module}' - it is not in MODULE_ORDER`);
    }
    return gate;
  };
  const wrapFragment = (anchor: string, module: string, body: Buffer): Contribution => ({
    order: MODULE_ORDER.indexOf(module),
    source: `templates/${module}/${FRAGMENTS_DIR}/${anchor}${JINJA_SUFFIX}`,
    text: Buffer.concat([
      Buffer.from(`{% if ${gateOf(module)} %}`),
      body,
      Buffer.from("{% endif %}"),
    ]),
  });

  // A dependabot-carrying module lands in the managed AGENTS.md Toolchain
  // section's audience; without an agents-toolchain fragment its bullets
  // would just silently be missing.
  const agentsToolchainModules = new Set(
    (fragments.get("agents-toolchain") ?? []).map(([module]) => module),
  );
  for (const manifest of manifests) {
    if (manifest.dependabot && !agentsToolchainModules.has(manifest.module)) {
      errors.push(
        `templates/${manifest.module}/${MANIFEST_NAME} declares dependabot but ` +
          `templates/${manifest.module}/${FRAGMENTS_DIR}/agents-toolchain${JINJA_SUFFIX} ` +
          "is missing - AGENTS.md's Toolchain section would silently skip the " +
          "module; add the fragment with its toolchain bullets",
      );
    }
  }

  for (const [anchor, spec] of Object.entries(DATA_ANCHORS)) {
    const fromFiles = fragments.get(anchor) ?? [];
    fragments.delete(anchor);
    const consumed: [string, Buffer][] = [];
    for (const [module, body] of fromFiles) {
      const path = `templates/${module}/${FRAGMENTS_DIR}/${anchor}${JINJA_SUFFIX}`;
      const manifest = manifestByModule.get(module) as ModuleManifest;
      if (spec.kind === "reject" || (spec.kind === "coexist" && spec.covered(manifest))) {
        errors.push(
          `${path}: the composer generates this module's '${anchor}' ` +
            `contribution from the module manifests (${spec.data}); delete ` +
            `the fragment and declare the data in templates/${module}/${MANIFEST_NAME}`,
        );
      } else if (spec.kind === "consume") {
        if (body.length === 0 || body[body.length - 1] !== 0x0a) {
          errors.push(
            `${path}: the fragment must end with a newline (the '${anchor}' ` +
              "generator closes each contribution with '{% endif -%}' on the " +
              "following line)",
          );
        } else {
          consumed.push([module, body]);
        }
      } else {
        addContribution(anchor, wrapFragment(anchor, module, body));
      }
    }
    try {
      const generated =
        spec.kind === "consume"
          ? spec.generate({ manifests, gateOf, fragments: consumed })
          : spec.generate({ manifests, gateOf });
      for (const contribution of generated) addContribution(anchor, contribution);
    } catch (error) {
      if (error instanceof GeneratorValidationError) {
        errors.push(`anchor '${anchor}': ${error.message}`);
      } else {
        throw new Error(`anchor '${anchor}': unexpected generator failure`, { cause: error });
      }
    }
  }
  for (const [anchor, list] of fragments) {
    for (const [module, body] of list) {
      addContribution(anchor, wrapFragment(anchor, module, body));
    }
  }
  for (const [anchor, list] of contributions) {
    list.sort((a, b) => a.order - b.order);
    errors.push(...renderedSeparationErrors(anchor, list));
  }

  errors.push(...spliceContributions(files, contributions));
  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exit(1);
  }

  const output = new Map<string, Entry>();
  const emittedErrors: string[] = [];
  for (const [logical, sourced] of files) {
    const emitted =
      sourced.origin === "base" ? logical : gatedPath(logical, sourced.gate, sourced.gateDirs);
    if (output.has(emitted)) {
      // Distinct logical paths can still emit the same name (e.g. a
      // hand-gated base filename plus the module's plain copy).
      emittedErrors.push(
        `collision: two sources emit template/${emitted} (one of them via ` +
          "an explicit filename gate in base/) - delete the module copy or " +
          "the hand-gated base file",
      );
      continue;
    }
    output.set(emitted, sourced.entry);
  }
  if (emittedErrors.length > 0) {
    for (const error of emittedErrors) console.error(`error: ${error}`);
    process.exit(1);
  }
  return output;
}

/** Write the composed map into `out`, replacing it entirely. */
export function writeOutput(composed: Map<string, Entry>, out: string): void {
  if (existsSync(out)) rmSync(out, { recursive: true });
  for (const [path, entry] of sortedByKey(composed)) {
    const dest = join(out, path);
    mkdirSync(dirname(dest), { recursive: true });
    if (entry.kind === "symlink") {
      // Source symlinks target the .jinja file so they are never
      // dangling in git (GitHub's action downloader refuses tarballs
      // with broken links); emitted links target the RENDERED name.
      let target = entry.target;
      if (target.endsWith(JINJA_SUFFIX)) target = target.slice(0, -JINJA_SUFFIX.length);
      symlinkSync(target, dest);
    } else {
      writeFileSync(dest, entry.data);
    }
  }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    console.error(`error: unrecognized argument(s): ${args.join(" ")}`);
    return 2;
  }
  const composed = build();
  writeOutput(composed, OUT);
  console.log(`composed ${composed.size} file(s) into template/`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

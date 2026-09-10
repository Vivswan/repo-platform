#!/usr/bin/env bun
// Compose .gitignore files from the latest github/gitignore templates: the
// base skeleton downstream repos receive (OS sections plus the
// `{# compose:gitignore #}` anchor), one fragment per module declaring
// gitignore_sources in its manifest, the sync writer's copies of both
// (files/base/.gitignore is the skeleton's region body, one block file per
// module and source), and this repository's own .gitignore (every toolchain
// template once; content outside the managed region is preserved). The
// sharing rule (a source several modules declare is emitted plain by the
// first and gate-negated by the rest) and the topology gate are
// docs/compose.md. The template and self outputs open their managed block
// with two sections that have no upstream source: agent local state and
// the CI workspace paths.
//
// Every regeneration resolves github/gitignore's current HEAD and fetches
// every section from that one commit; nothing records the SHA, so the
// outputs change only when consumed upstream content changes and the
// refresh-gitignore PR diff stays worth reading. There is no offline
// REGENERATION mode: --topology only verifies (fragments match the
// manifests' sources and gates, the files/ side matches the fragments), and
// content drift INSIDE a managed block is ungated until the next refresh
// regenerates over it.
//
// Usage: bun scripts/generate/build_gitignore.ts [--topology]
//   (no flag: fetch upstream HEAD and regenerate; --topology: offline verify)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseFilesConfig } from "../../.github/scripts/sync/writer/files_config.ts";
import { cleanManagedRegion, HASH_REGION_MARKERS } from "../../actions/shared/grammar.ts";
import { gateExpression } from "../compose/exclude.ts";
import { loadManifests, type ModuleManifest } from "../lib/module_manifests.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TEMPLATES_DIR = join(REPO_ROOT, "templates");
const OUTPUT_TEMPLATE = join(REPO_ROOT, "templates", "base", ".gitignore.jinja");
const OUTPUT_SELF = join(REPO_ROOT, ".gitignore");
const FILES_DIR = join(REPO_ROOT, "files");
const FILES_CONFIG = join(REPO_ROOT, "files.yml");
const OUTPUT_FILES_BASE = join(FILES_DIR, "base", ".gitignore");

const ALWAYS = ["Global/Windows.gitignore", "Global/macOS.gitignore", "Global/Linux.gitignore"];

/** Per-module upstream sources plus every module's gate expression. Reads
 *  nothing itself: run() loads the manifests, so a broken one reports
 *  through the script's single error path. */
function byModule(manifests: ModuleManifest[]): {
  entries: [string, string[]][];
  gates: Map<string, string>;
} {
  return {
    entries: manifests.flatMap((m): [string, string[]][] =>
      m.gitignore_sources ? [[m.module, m.gitignore_sources]] : [],
    ),
    gates: new Map(manifests.map((m) => [m.module, gateExpression(m.module, m)])),
  };
}

const ANCHOR = "gitignore";

const DEFAULT_LOCAL_BODY =
  "# Repository-specific ignore patterns go outside the managed region:\n" +
  "# here (above BEGIN), or below the END marker where last-match-wins\n" +
  "# can override managed patterns.\n";

// Not from github/gitignore: agent local state (worktree directories and
// the machine-local settings file). Both .claude spellings are deliberate:
// the documented .claude/worktrees/ location plus the dotted variant.
const AGENT_SECTION =
  "## Agent local state (repo-platform)\n" +
  ".claude/worktrees/\n" +
  ".claude/.worktrees/\n" +
  ".codex/worktrees/\n" +
  ".worktrees/\n" +
  ".claude/settings.local.json\n";

// Not from github/gitignore: only the paths a fleet workflow step creates
// INSIDE a checked-out workspace (the secret scan's SARIF report, the fuzz
// starter's failure reports), because only those can collide with a
// committed path of the same name; a job that never checks the repository
// out cannot collide, so its paths are not listed. Anchored to the root so
// a nested source folder of the same name is not swallowed.
export const CI_WORKSPACE_SECTION =
  "## CI workspace paths (repo-platform)\n" + "/results.sarif\n" + "/.fuzz-failures/\n";

const RAW = "https://raw.githubusercontent.com/github/gitignore";
const HEAD_API = "https://api.github.com/repos/github/gitignore/commits/main";

function fragmentOutput(module: string): string {
  return join(TEMPLATES_DIR, module, "fragments", `${ANCHOR}.jinja`);
}

/** The name a github/gitignore path takes in its section heading and, on
 *  the files/ side, in its block file's suffix: the file's stem. */
export function blockName(path: string): string {
  return (path.split("/").pop() as string).replace(/\.gitignore$/, "");
}

/** The files/-relative block file the writer reads for one module's source. */
export function blockRel(module: string, path: string): string {
  return `${module}/.gitignore.block.${blockName(path)}`;
}

/** Generated gitignore fragments whose module no longer declares
 *  gitignore_sources: removing the manifest key stops regenerating the
 *  fragment but leaves the old file behind, and composition would keep
 *  shipping its stale sections to every render. Returned (for run() to
 *  throw on) rather than deleted - the missing key may be the typo to
 *  fix, not the fragment. */
export function strayFragmentFiles(manifests: ModuleManifest[], templatesDir: string): string[] {
  const strays: string[] = [];
  for (const m of manifests) {
    if (m.gitignore_sources) continue;
    if (existsSync(join(templatesDir, m.module, "fragments", `${ANCHOR}.jinja`))) {
      strays.push(`templates/${m.module}/fragments/${ANCHOR}.jinja`);
    }
  }
  return strays;
}

/** Declared gitignore_sources whose generated fragment file is missing: a
 *  module NEWLY declaring the key has no fragment until the generator
 *  runs, and composition would render nothing for it. The topology
 *  check's second direction (strayFragmentFiles is the first). */
export function missingFragmentFiles(manifests: ModuleManifest[], templatesDir: string): string[] {
  const missing: string[] = [];
  for (const m of manifests) {
    if (!m.gitignore_sources) continue;
    if (!existsSync(join(templatesDir, m.module, "fragments", `${ANCHOR}.jinja`))) {
      missing.push(`templates/${m.module}/fragments/${ANCHOR}.jinja`);
    }
  }
  return missing;
}

/** The github/gitignore source paths a generated fragment encodes in its
 *  section headings, in order. The offline topology check compares them
 *  against the manifest's gitignore_sources, so a manifest EDIT (a source
 *  added, removed, replaced, or reordered) cannot pass on fragment
 *  presence alone with stale content until the weekly refresh. */
export function fragmentSourcePaths(fragmentText: string): string[] {
  return [...fragmentText.matchAll(/^## .+ \(github\/gitignore (.+)\)$/gm)].map(
    (match) => match[1],
  );
}

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`GET ${url} failed: HTTP ${resp.status}`);
  return resp.text();
}

async function upstreamHead(): Promise<string> {
  const body = await fetchText(HEAD_API, { Accept: "application/vnd.github+json" });
  return (JSON.parse(body) as { sha: string }).sha;
}

async function section(sha: string, path: string): Promise<string> {
  const name = blockName(path);
  // Upstream files may carry CRLF line endings (Windows.gitignore does), and
  // macOS.gitignore spells CR-suffixed filename patterns as a character
  // class holding a raw CR byte (`Icon[\r]`); normalize to LF and rewrite
  // those classes to the CR-free `?` glob so outputs stay ASCII. Upstream
  // comment lines also carry trailing spaces, which fail downstream repos'
  // whitespace linters; strip them.
  const body = (await fetchText(`${RAW}/${sha}/${path}`))
    .replaceAll("\r\n", "\n")
    .replaceAll("[\r]", "?")
    .replace(/[ \t]+$/gm, "")
    .trim();
  // Enforced, not just claimed: the outputs are written latin1 so the self
  // file's byte-owned sides round-trip exactly, and that encoding is only
  // identity for ASCII generated text - a non-ASCII upstream section must
  // fail here, named, rather than corrupt silently on write.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range check is this regex's whole job
  if (!/^[\x00-\x7f]*$/.test(body)) {
    throw new Error(
      `github/gitignore ${path} contains non-ASCII content after normalization - ` +
        "extend section()'s normalization (the outputs must stay ASCII)",
    );
  }
  return `## ${name} (github/gitignore ${path})\n${body}\n`;
}

function localSeed(body: string): string {
  return `${body}\n`;
}

const HEADER_COMMENT =
  "# Generated from github/gitignore - do not edit between the BEGIN/END\n" +
  "# markers; repository-local patterns live outside the managed region\n" +
  "# (above BEGIN, or below END where last-match-wins can override).\n" +
  "\n";

function managedHeader(): string {
  return `${HASH_REGION_MARKERS.begin}\n${HEADER_COMMENT}`;
}

/** Current content outside the managed region (above BEGIN and below END),
 *  the default seed when the file does not exist yet, or a loud error when
 *  the file exists but has no exactly-once clean region
 *  (cleanManagedRegion - the same accept/reject the sync carry applies, so
 *  the two writers can never slice the same malformed file differently).
 *  Regenerating around a malformed region would silently drop local
 *  content or duplicate markers; the fix is a hand edit, not a guess.
 *  Exported for the writers-agree test. */
export function existingLocalSides(output: string): { above: string; below: string } {
  if (!existsSync(output)) return { above: localSeed(DEFAULT_LOCAL_BODY), below: "" };
  // latin1, not utf-8: the sides are repo-owned bytes (the sync carries
  // them byte-for-byte under the same decoding), and a utf-8 decode would
  // fold invalid sequences onto U+FFFD - silent corruption on rewrite.
  const slice = cleanManagedRegion(readFileSync(output).toString("latin1"), HASH_REGION_MARKERS);
  if (slice === null) {
    throw new Error(
      `${output} has no single clean REPO-PLATFORM MANAGED region (markers missing, duplicated, out of order, or marker text outside the region); fix its markers by hand, then rerun`,
    );
  }
  return { above: slice.above, below: slice.below };
}

/** The skeleton's region body up to the compose anchor: the header
 *  comment, the agent and CI workspace sections, and the OS sections. The template carries
 *  it between BEGIN and the anchor; files/base/.gitignore IS it (the
 *  writer adds the markers and appends the module blocks). */
export function buildFilesBase(sections: Record<string, string>): string {
  const parts = [HEADER_COMMENT, AGENT_SECTION, "\n", CI_WORKSPACE_SECTION, "\n"];
  for (const path of ALWAYS) {
    parts.push(sections[path], "\n");
  }
  return parts.join("");
}

export function buildTemplate(sections: Record<string, string>): string {
  return (
    "{# Generated by scripts/generate/build_gitignore.ts - edit the script, not this file. #}\n" +
    localSeed(DEFAULT_LOCAL_BODY) +
    `${HASH_REGION_MARKERS.begin}\n` +
    buildFilesBase(sections) +
    `{# compose:${ANCHOR} #}\n` +
    `${HASH_REGION_MARKERS.end}\n`
  );
}

/** A block file: the section plus the blank line the composed fragment
 *  put after it, so the writer's concatenation reads like the render. */
export function buildBlock(section: string): string {
  return `${section}\n`;
}

/** The region body a generated template carries (what buildFilesBase
 *  produced), read back for the offline files/ comparison. */
export function templateRegionBody(templateText: string): string {
  const begin = `${HASH_REGION_MARKERS.begin}\n`;
  const anchor = `{# compose:${ANCHOR} #}\n`;
  const start = templateText.indexOf(begin);
  const end = templateText.indexOf(anchor);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      "templates/base/.gitignore.jinja has no BEGIN marker followed by the compose anchor",
    );
  }
  return templateText.slice(start + begin.length, end);
}

/** The github/gitignore sections a generated fragment carries, by source
 *  path: each heading through the line before the next, jinja tags removed
 *  and the trailing blank line dropped, so the text is what section()
 *  produced and the files/ side can be derived from the fragment offline. */
export function sectionsIn(fragmentText: string): Record<string, string> {
  const plain = fragmentText.replace(/\{%.*?%\}/g, "");
  const headings = [...plain.matchAll(/^## .+ \(github\/gitignore (.+)\)$/gm)];
  const sections: Record<string, string> = {};
  headings.forEach((match, index) => {
    const end = index + 1 < headings.length ? headings[index + 1].index : plain.length;
    sections[match[1]] = `${plain.slice(match.index, end).trimEnd()}\n`;
  });
  return sections;
}

/** Block files under files/ that no manifest source names: the files/
 *  twin of strayFragmentFiles (a dropped or renamed source leaves the old
 *  block for the writer to keep appending). */
export function strayBlockFiles(entries: [string, string[]][], filesDir: string): string[] {
  const expected = new Set(
    entries.flatMap(([module, sources]) => sources.map((path) => blockRel(module, path))),
  );
  const strays: string[] = [];
  for (const module of readdirSync(filesDir).sort()) {
    const dir = join(filesDir, module);
    if (!existsSync(dir) || module === "base") continue;
    for (const name of readdirSync(dir).sort()) {
      const rel = `${module}/${name}`;
      if (name.startsWith(".gitignore.block.") && !expected.has(rel)) strays.push(`files/${rel}`);
    }
  }
  return strays;
}

/** The files/ side against the templates side, offline: files.yml names
 *  each module's sources by block name, files/base/.gitignore is the
 *  template's region body, and every block file is its fragment's section.
 *  Any difference means a refresh regenerated the templates and not the
 *  copies (or a hand edit on one side); the problems name the fix. */
export function filesSideProblems(input: {
  entries: [string, string[]][];
  filesModules: Record<string, Record<string, unknown>>;
  templateText: string;
  fragmentText: (module: string) => string;
  filesDir: string;
}): string[] {
  const problems: string[] = [];
  const rerun = "run 'bun scripts/generate/build_gitignore.ts' to regenerate both sides";
  const declaring = new Map(input.entries);
  for (const [module, data] of Object.entries(input.filesModules)) {
    const declared = data.gitignore_sources;
    const expected = declaring.get(module)?.map(blockName);
    if (JSON.stringify(declared) !== JSON.stringify(expected)) {
      problems.push(
        `files.yml modules.${module}.gitignore_sources is ${JSON.stringify(declared)} but ` +
          `templates/${module}/module.yml declares ${JSON.stringify(expected)} as block names - ` +
          "edit files.yml to match (the templates side is the source until the cutover)",
      );
    }
  }
  for (const module of declaring.keys()) {
    if (!(module in input.filesModules)) {
      problems.push(
        `files.yml has no modules.${module} entry for a module declaring gitignore_sources`,
      );
    }
  }
  const compare = (rel: string, expected: string, source: string) => {
    const abs = join(input.filesDir, rel);
    if (!existsSync(abs)) {
      problems.push(`files/${rel} is missing (${source}); ${rerun}`);
    } else if (readFileSync(abs, "utf-8") !== expected) {
      problems.push(`files/${rel} differs from ${source}; ${rerun}`);
    }
  };
  compare(
    "base/.gitignore",
    templateRegionBody(input.templateText),
    "templates/base/.gitignore.jinja's region body",
  );
  for (const [module, sources] of input.entries) {
    const sections = sectionsIn(input.fragmentText(module));
    for (const path of sources) {
      const section = sections[path];
      if (section === undefined) continue;
      compare(
        blockRel(module, path),
        buildBlock(section),
        `its section in templates/${module}/fragments/${ANCHOR}.jinja`,
      );
    }
  }
  return problems;
}

/** Each module's fragment parts: its sources in manifest order, each with
 *  the EARLIER modules that already declared the same source (whose
 *  selection must suppress the duplicate section). */
export function fragmentPlans(
  entries: [string, string[]][],
): { module: string; parts: { path: string; earlier: string[] }[] }[] {
  const owners = new Map<string, string[]>();
  return entries.map(([module, sources]) => ({
    module,
    parts: sources.map((path) => {
      const earlier = owners.get(path) ?? [];
      owners.set(path, [...earlier, module]);
      return { path, earlier };
    }),
  }));
}

/** Every distinct source across all modules, in first-declaration order -
 *  what the self output (which carries every toolchain) emits. */
export function selfSources(entries: [string, string[]][]): string[] {
  return [...new Set(entries.flatMap(([, sources]) => sources))];
}

/** The jinja guard expression a shared source's chunk carries: the
 *  negation of every EARLIER owner's gate expression, and-joined. ONE
 *  constructor for buildFragment and the offline topology check, so the
 *  expected guard can never drift from the generated one. */
export function guardExpressionFor(earlier: string[], gates: Map<string, string>): string {
  return earlier
    .map((module) => {
      const gate = gates.get(module);
      if (gate === undefined) throw new Error(`no gate expression for module '${module}'`);
      return `not (${gate})`;
    })
    .join(" and ");
}

/** The jinja guard expressions a generated fragment actually carries, in
 *  order - the offline topology check compares them against the
 *  manifests' expected guards, so a changed module gate cannot leave a
 *  stale fragment passing until the weekly refresh (the next build would
 *  emit duplicate shared sections). */
export function fragmentGuardExpressions(fragmentText: string): string[] {
  return [...fragmentText.matchAll(/\{% if (.+?) %\}/g)].map((match) => match[1]);
}

/** A module's fragment: one chunk per source, each owning its leading
 *  newline (the composer's fragment whitespace convention). A section
 *  already owned by earlier modules has its WHOLE chunk wrapped in the
 *  negation of those modules' gate expressions, so a suppressed chunk
 *  renders as nothing - not as stray blank lines. */
export function buildFragment(
  sections: Record<string, string>,
  parts: { path: string; earlier: string[] }[],
  gates: Map<string, string>,
): string {
  return parts
    .map(({ path, earlier }) => {
      const chunk = `\n${sections[path]}`;
      if (earlier.length === 0) return chunk;
      return `{% if ${guardExpressionFor(earlier, gates)} %}${chunk}{% endif %}`;
    })
    .join("");
}

/** The self output: everything outside the managed region rides through
 *  verbatim from the existing file (both sides are repo-owned - the
 *  "Generated by" note lives inside the region so it stays script-owned),
 *  and the region itself is regenerated. */
function buildSelf(
  sections: Record<string, string>,
  sources: string[],
  sides: { above: string; below: string },
): string {
  const parts = [sides.above, managedHeader(), AGENT_SECTION, "\n", CI_WORKSPACE_SECTION, "\n"];
  for (const path of [...ALWAYS, ...sources]) {
    parts.push(sections[path], "\n");
  }
  parts.push(`${HASH_REGION_MARKERS.end}\n`, sides.below);
  return parts.join("");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const topology = argv.includes("--topology");
  const unknown = argv.filter((a) => a !== "--topology");
  if (unknown.length > 0) {
    console.error(
      `error: unrecognized argument(s): ${unknown.join(" ")} - the script takes only ` +
        "--topology (the offline manifest/fragment check); with no arguments it " +
        "always regenerates from github/gitignore HEAD",
    );
    return 2;
  }
  // One error dialect for every failure past argument parsing (a broken
  // manifest, an upstream fetch failure), matching generate.ts and
  // render_dogfood.ts.
  try {
    return await run(topology);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function run(topology = false): Promise<number> {
  const manifests = loadManifests();
  const strays = strayFragmentFiles(manifests, TEMPLATES_DIR);
  if (strays.length > 0) {
    throw new Error(
      `stray gitignore fragment(s) for module(s) without gitignore_sources: ` +
        `${strays.join(", ")} - a removed manifest key leaves the old fragment ` +
        "shipping stale sections to every render; delete it (or restore the " +
        "manifest's gitignore_sources)",
    );
  }
  const { entries, gates } = byModule(manifests);
  const strayBlocks = strayBlockFiles(entries, FILES_DIR);
  if (strayBlocks.length > 0) {
    throw new Error(
      `stray gitignore block file(s) no manifest source names: ${strayBlocks.join(", ")} - ` +
        "the writer would keep appending them; delete them (or restore the source)",
    );
  }
  // --topology: the OFFLINE manifests-vs-fragments check for bun run check.
  // It fires on the PR that changes a manifest, before the weekly refresh
  // would: a stray fragment would ABORT the refresh with no way to
  // self-heal, a missing one would render nothing, a fragment whose encoded
  // sources are stale keeps rendering the old sections, and a stale gate
  // guard makes the next build emit duplicate shared sections.
  if (topology) {
    const missing = missingFragmentFiles(manifests, TEMPLATES_DIR);
    if (missing.length > 0) {
      throw new Error(
        `missing gitignore fragment(s) for module(s) declaring gitignore_sources: ` +
          `${missing.join(", ")} - run 'bun scripts/generate/build_gitignore.ts' ` +
          "to generate them (or drop the manifest key)",
      );
    }
    const plans = new Map(fragmentPlans(entries).map((plan) => [plan.module, plan.parts]));
    for (const [module, declared] of entries) {
      const rel = relative(REPO_ROOT, fragmentOutput(module));
      const text = readFileSync(fragmentOutput(module), "utf-8");
      const encoded = fragmentSourcePaths(text);
      if (JSON.stringify(encoded) !== JSON.stringify(declared)) {
        throw new Error(
          `${rel} encodes sources [${encoded.join(", ")}] but templates/${module}/module.yml ` +
            `declares [${declared.join(", ")}] - the fragment is stale against the manifest ` +
            "edit; run 'bun scripts/generate/build_gitignore.ts' to regenerate it",
        );
      }
      const expectedGuards = (plans.get(module) ?? [])
        .filter((part) => part.earlier.length > 0)
        .map((part) => guardExpressionFor(part.earlier, gates));
      const actualGuards = fragmentGuardExpressions(text);
      if (JSON.stringify(actualGuards) !== JSON.stringify(expectedGuards)) {
        throw new Error(
          `${rel} embeds guard expression(s) [${actualGuards.join(" | ")}] but the manifests ` +
            `expect [${expectedGuards.join(" | ")}] - a changed module gate leaves the ` +
            "fragment's shared-section guards stale (the next build would emit duplicate " +
            "sections); run 'bun scripts/generate/build_gitignore.ts' to regenerate it",
        );
      }
    }
    const filesProblems = filesSideProblems({
      entries,
      filesModules: parseFilesConfig(readFileSync(FILES_CONFIG, "utf-8")).modules,
      templateText: readFileSync(OUTPUT_TEMPLATE, "utf-8"),
      fragmentText: (module) => readFileSync(fragmentOutput(module), "utf-8"),
      filesDir: FILES_DIR,
    });
    if (filesProblems.length > 0) {
      throw new Error(
        `the files/ side is stale against the templates:\n  - ${filesProblems.join("\n  - ")}`,
      );
    }
    console.log(
      "gitignore topology OK: fragments match the manifests' gitignore_sources and gates, and files/ matches the fragments.",
    );
    return 0;
  }
  const moduleSources = entries;
  const sources = selfSources(moduleSources);
  // Before any fetch: a malformed self output must abort while every
  // output still stands as committed, rather than behind a half-written
  // set.
  const selfSides = existingLocalSides(OUTPUT_SELF);

  // One resolved SHA for the whole run: fetching each file from "main"
  // could straddle an upstream push and mix two commits' content.
  const sha = await upstreamHead();
  console.log(`github/gitignore HEAD is ${sha}`);
  const sections: Record<string, string> = {};
  for (const path of [...ALWAYS, ...sources]) sections[path] = await section(sha, path);

  const outputs: [string, string][] = [
    [OUTPUT_TEMPLATE, buildTemplate(sections)],
    ...fragmentPlans(moduleSources).map(({ module, parts }): [string, string] => [
      fragmentOutput(module),
      buildFragment(sections, parts, gates),
    ]),
    [OUTPUT_FILES_BASE, buildFilesBase(sections)],
    ...moduleSources.flatMap(([module, paths]) =>
      paths.map((path): [string, string] => [
        join(FILES_DIR, blockRel(module, path)),
        buildBlock(sections[path]),
      ]),
    ),
    [OUTPUT_SELF, buildSelf(sections, sources, selfSides)],
  ];

  for (const [out, content] of outputs) {
    // A module declaring gitignore_sources for the first time has no
    // fragments/ directory yet (newly-declared sources are exactly the
    // path the topology check routes here); create it rather than ENOENT.
    mkdirSync(dirname(out), { recursive: true });
    // latin1, the read decoding's inverse: the self output's repo-owned
    // sides are byte-owned, and a utf-8 encode would widen any non-ASCII
    // byte (generated content is ASCII, so this is identity for it).
    writeFileSync(out, Buffer.from(content, "latin1"));
    console.log(`wrote ${relative(REPO_ROOT, out)}`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}

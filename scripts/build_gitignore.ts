#!/usr/bin/env bun
// Compose .gitignore files from the latest github/gitignore templates:
//
// - templates/base/.gitignore.jinja: the skeleton downstream repos receive
//   (published onto the template build branch by build-branches.yml):
//   OS templates (Windows, macOS, Linux) plus a {# compose:gitignore #}
//   anchor where the composer splices the toolchain fragments below, each
//   wrapped in its module's gate.
// - templates/<module>/fragments/gitignore.jinja: one fragment per module
//   declaring gitignore_sources in its module.yml manifest (uv maps to
//   Python.gitignore, which carries upstream's uv section - there is no
//   standalone uv template) as module fragments. A source declared by
//   several modules is emitted plain in the first declaring module's
//   fragment; each later one carries the whole chunk (leading newline
//   included) wrapped in the negation of the earlier declarers' gates, so
//   a repo selecting both gets the section once and a suppressed chunk
//   renders as nothing.
// - .gitignore (this repo's own): same OS templates plus ALL toolchain
//   templates, each once (downstream repos may carry any combination).
//   Existing content OUTSIDE the managed region (above BEGIN and below
//   END) is preserved across regenerations.
//
// The template and self outputs open their managed block with one section
// that has no upstream source: agent local state.
//
// There is no pinned upstream SHA and no offline REGENERATION mode: every run resolves
// github/gitignore's current HEAD and fetches every section from that one
// commit. Nothing generated records the SHA, so the outputs change only
// when upstream content we consume changes - which is what makes the
// refresh-gitignore workflow's PR diff worth reading. That workflow is the
// only caller of networked regeneration; `bun run check` and CI's validate
// job also call this script with --topology for offline validation. Content
// drift INSIDE a managed block is still ungated - only the fragments'
// encoded source paths are checked - so a hand edit there survives until the
// next refresh PR regenerates over it.
//
// Usage:
//   bun scripts/build_gitignore.ts              # fetch upstream HEAD, regenerate
//   bun scripts/build_gitignore.ts --topology   # offline: fragments match the manifests' gitignore_sources
//
// --topology is the one OFFLINE mode, and it only verifies; there is no
// offline REGENERATION mode - producing content always fetches upstream HEAD.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cleanManagedRegion, HASH_REGION_MARKERS } from "../actions/shared/grammar.ts";
import { gateExpression } from "./compose_template.ts";
import { loadManifests, type ModuleManifest } from "./module_manifests.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const TEMPLATES_DIR = join(REPO_ROOT, "templates");
const OUTPUT_TEMPLATE = join(REPO_ROOT, "templates", "base", ".gitignore.jinja");
const OUTPUT_SELF = join(REPO_ROOT, ".gitignore");

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

const RAW = "https://raw.githubusercontent.com/github/gitignore";
const HEAD_API = "https://api.github.com/repos/github/gitignore/commits/main";

function fragmentOutput(module: string): string {
  return join(TEMPLATES_DIR, module, "fragments", `${ANCHOR}.jinja`);
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
  const name = (path.split("/").pop() as string).replace(/\.gitignore$/, "");
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

function managedHeader(): string {
  return (
    `${HASH_REGION_MARKERS.begin}\n` +
    "# Generated from github/gitignore - do not edit between the BEGIN/END\n" +
    "# markers; repository-local patterns live outside the managed region\n" +
    "# (above BEGIN, or below END where last-match-wins can override).\n" +
    "\n"
  );
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

function buildTemplate(sections: Record<string, string>): string {
  const parts = [
    "{# Generated by scripts/build_gitignore.ts - edit the script, not this file. #}\n",
    localSeed(DEFAULT_LOCAL_BODY),
    managedHeader(),
    AGENT_SECTION,
    "\n",
  ];
  for (const path of ALWAYS) {
    parts.push(sections[path], "\n");
  }
  parts.push(`{# compose:${ANCHOR} #}\n`, `${HASH_REGION_MARKERS.end}\n`);
  return parts.join("");
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
  const parts = [sides.above, managedHeader(), AGENT_SECTION, "\n"];
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
  // --topology: the OFFLINE manifests-vs-fragments check (no upstream
  // fetch, no lock read), for bun run check. It catches every topology
  // direction on the PR that changes a manifest: a removed
  // gitignore_sources key with the fragment left behind (the stray check
  // above, which would otherwise ABORT the weekly refresh - the failure
  // could never self-heal), a newly declared key whose fragment was never
  // generated (composition would render nothing for it), an EDITED
  // source list whose fragment still encodes the old sources (each
  // fragment's section headings carry them - fragmentSourcePaths), and a
  // changed module GATE whose fragment still embeds the old guard
  // expressions (fragmentGuardExpressions vs the manifests' expected
  // guards - a stale guard makes the next build emit duplicate shared
  // sections).
  if (topology) {
    const missing = missingFragmentFiles(manifests, TEMPLATES_DIR);
    if (missing.length > 0) {
      throw new Error(
        `missing gitignore fragment(s) for module(s) declaring gitignore_sources: ` +
          `${missing.join(", ")} - run 'bun scripts/build_gitignore.ts' ` +
          "to generate them (or drop the manifest key)",
      );
    }
    const { entries, gates } = byModule(manifests);
    const plans = new Map(fragmentPlans(entries).map((plan) => [plan.module, plan.parts]));
    for (const [module, declared] of entries) {
      const rel = relative(REPO_ROOT, fragmentOutput(module));
      const text = readFileSync(fragmentOutput(module), "utf-8");
      const encoded = fragmentSourcePaths(text);
      if (JSON.stringify(encoded) !== JSON.stringify(declared)) {
        throw new Error(
          `${rel} encodes sources [${encoded.join(", ")}] but templates/${module}/module.yml ` +
            `declares [${declared.join(", ")}] - the fragment is stale against the manifest ` +
            "edit; run 'bun scripts/build_gitignore.ts' to regenerate it",
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
            "sections); run 'bun scripts/build_gitignore.ts' to regenerate it",
        );
      }
    }
    console.log(
      "gitignore topology OK: fragments match the manifests' gitignore_sources and gates.",
    );
    return 0;
  }
  const { entries: moduleSources, gates } = byModule(manifests);
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

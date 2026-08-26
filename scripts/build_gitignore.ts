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
//   templates, each once (downstream repos may carry any combination). The
//   REPOSITORY LOCAL section's existing content is preserved across
//   regenerations.
//
// The template and self outputs open their managed block with one section
// that has no upstream source: agent local state.
//
// There is no pinned upstream SHA and no offline mode: every run resolves
// github/gitignore's current HEAD and fetches every section from that one
// commit. Nothing generated records the SHA, so the outputs change only
// when upstream content we consume changes - which is what makes the
// refresh-gitignore workflow's PR diff worth reading. That workflow is the
// only caller: no CI job verifies these outputs, so a hand edit to a
// managed block survives until the next refresh PR regenerates over it.
//
// Usage:
//   bun scripts/build_gitignore.ts              # fetch upstream HEAD, regenerate
//   bun scripts/build_gitignore.ts --topology   # offline: fragments match the manifests' gitignore_sources

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { gateExpression } from "./compose_template.ts";
import { cleanLocalRegion, LOCAL_BEGIN, LOCAL_END } from "./gitignore_local.ts";
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

const DEFAULT_LOCAL_BODY = "# Add repository-specific ignore patterns in this section only.\n";

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
  return `## ${name} (github/gitignore ${path})\n${body}\n`;
}

function localSection(body: string): string {
  return `${LOCAL_BEGIN}\n${body}${LOCAL_END}\n\n`;
}

function managedHeader(): string {
  return (
    "# BEGIN REPO-PLATFORM MANAGED\n" +
    "# Generated from github/gitignore - do not edit; local patterns go in\n" +
    "# the REPOSITORY LOCAL section above. Managed patterns deliberately\n" +
    "# come last: last-match-wins makes them non-overridable.\n" +
    "\n"
  );
}

/** Current content between the LOCAL markers, the default when the file
 *  does not exist yet, or a loud error when the file exists but has no
 *  exactly-once clean region (cleanLocalRegion - the same accept/reject
 *  the sync carry applies, so the two writers can never slice the same
 *  malformed file differently). Regenerating around a malformed region
 *  would silently drop local content or duplicate markers; the fix is a
 *  hand edit, not a guess. Exported for the writers-agree test. */
export function existingLocalBody(output: string): string {
  if (!existsSync(output)) return DEFAULT_LOCAL_BODY;
  const region = cleanLocalRegion(readFileSync(output).toString("utf-8"));
  if (region === null) {
    throw new Error(
      `${output} has no single clean REPOSITORY LOCAL region (markers missing, duplicated, out of order, or marker text inside the body); fix its markers by hand, then rerun`,
    );
  }
  return region.body;
}

function buildTemplate(sections: Record<string, string>): string {
  const parts = [
    "{# Generated by scripts/build_gitignore.ts - edit the script, not this file. #}\n",
    localSection(`${DEFAULT_LOCAL_BODY}\n`),
    managedHeader(),
    AGENT_SECTION,
    "\n",
  ];
  for (const path of ALWAYS) {
    parts.push(sections[path], "\n");
  }
  parts.push(`{# compose:${ANCHOR} #}\n`, "# END REPO-PLATFORM MANAGED\n");
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
  const gateOf = (module: string): string => {
    const gate = gates.get(module);
    if (gate === undefined) throw new Error(`no gate expression for module '${module}'`);
    return gate;
  };
  return parts
    .map(({ path, earlier }) => {
      const chunk = `\n${sections[path]}`;
      if (earlier.length === 0) return chunk;
      const guard = earlier.map((module) => `not (${gateOf(module)})`).join(" and ");
      return `{% if ${guard} %}${chunk}{% endif %}`;
    })
    .join("");
}

function buildSelf(sections: Record<string, string>, sources: string[], localBody: string): string {
  const parts = [
    "# Generated by scripts/build_gitignore.ts - only edit the LOCAL section.\n",
    localSection(localBody),
    managedHeader(),
    AGENT_SECTION,
    "\n",
  ];
  for (const path of [...ALWAYS, ...sources]) {
    parts.push(sections[path], "\n");
  }
  parts.push("# END REPO-PLATFORM MANAGED\n");
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
  // --topology: the OFFLINE manifests-vs-fragment-presence check (no
  // upstream fetch, no lock read), for bun run check. It catches both
  // topology directions on the PR that changes a manifest: a removed
  // gitignore_sources key with the fragment left behind (the stray check
  // above, which would otherwise ABORT the weekly refresh - the failure
  // could never self-heal), and a newly declared key whose fragment was
  // never generated (composition would render nothing for it).
  if (topology) {
    const missing = missingFragmentFiles(manifests, TEMPLATES_DIR);
    if (missing.length > 0) {
      throw new Error(
        `missing gitignore fragment(s) for module(s) declaring gitignore_sources: ` +
          `${missing.join(", ")} - run 'bun scripts/build_gitignore.ts' ` +
          "to generate them (or drop the manifest key)",
      );
    }
    console.log("gitignore topology OK: fragments match the manifests' gitignore_sources.");
    return 0;
  }
  const { entries: moduleSources, gates } = byModule(manifests);
  const sources = selfSources(moduleSources);
  // Before any fetch: a malformed self output must abort while every
  // output still stands as committed, rather than behind a half-written
  // set.
  const selfLocalBody = existingLocalBody(OUTPUT_SELF);

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
    [OUTPUT_SELF, buildSelf(sections, sources, selfLocalBody)],
  ];

  for (const [out, content] of outputs) {
    writeFileSync(out, Buffer.from(content, "utf-8"));
    console.log(`wrote ${relative(REPO_ROOT, out)}`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}

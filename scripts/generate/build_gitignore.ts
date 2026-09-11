#!/usr/bin/env bun
// Builds the gitignore files from the latest github/gitignore content:
// files/base/.gitignore (the region body every repository receives: the
// agent and CI workspace sections, then the OS sections), one block file
// per module and source under files/<module>/ (the writer splices the
// selected modules' blocks into the region), and this repository's own
// .gitignore (every source once; content outside the managed region is
// preserved). files.yml's modules.<module>.gitignore_sources names each
// source by its github/gitignore stem.
//
// Every regeneration resolves github/gitignore's current HEAD and fetches
// every section from that one commit; nothing records the SHA, so the
// outputs change only when consumed upstream content changes and the
// refresh-gitignore PR diff stays worth reading. --topology is the offline
// gate: the block files match files.yml's sources, and every copy of a
// section (block, base, this repository's region) carries the same bytes.
// Content drift inside a block against upstream is ungated until the next
// refresh regenerates over it.
//
// Usage: bun scripts/generate/build_gitignore.ts [--topology]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseFilesConfig } from "../../actions/plan/files_config.ts";
import { cleanManagedRegion, HASH_REGION_MARKERS } from "../../actions/shared/grammar.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const OUTPUT_SELF = join(REPO_ROOT, ".gitignore");
const FILES_DIR = join(REPO_ROOT, "files");
const FILES_CONFIG = join(REPO_ROOT, "files.yml");
const BASE_REL = "base/.gitignore";

/** The OS sections every repository receives, github/gitignore paths. */
export const ALWAYS = [
  "Global/Windows.gitignore",
  "Global/macOS.gitignore",
  "Global/Linux.gitignore",
];

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

/** The github/gitignore path a files.yml source name stands for: the
 *  repository-root file of that stem. */
export function upstreamPath(name: string): string {
  return `${name}.gitignore`;
}

/** The name a github/gitignore path takes in its section heading and in
 *  its block file's suffix: the file's stem. */
export function blockName(path: string): string {
  return (path.split("/").pop() as string).replace(/\.gitignore$/, "");
}

/** The files/-relative block file the writer reads for one module's source. */
export function blockRel(module: string, path: string): string {
  return `${module}/.gitignore.block.${blockName(path)}`;
}

/** Each module's github/gitignore source paths, in files.yml order, from
 *  the modules that declare gitignore_sources. */
export function gitignoreSources(filesText: string, label = "files.yml"): [string, string[]][] {
  const config = parseFilesConfig(filesText, label);
  return Object.entries(config.modules).flatMap(([module, data]): [string, string[]][] => {
    const names = data.gitignore_sources;
    if (names === undefined) return [];
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
      throw new Error(`${label}: modules.${module}.gitignore_sources must be a list of names`);
    }
    return [[module, (names as string[]).map(upstreamPath)]];
  });
}

/** Every distinct source across all modules, in first-declaration order:
 *  what this repository's own .gitignore (which carries every toolchain)
 *  emits. */
export function selfSources(entries: [string, string[]][]): string[] {
  return [...new Set(entries.flatMap(([, sources]) => sources))];
}

/** Block files under files/ that no files.yml source names: a dropped or
 *  renamed source leaves the old block behind, and the writer would keep
 *  splicing it. Returned (for run() to throw on) rather than deleted: the
 *  missing name may be the typo to fix, not the block. */
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

/** Declared sources whose block file is missing: a module newly declaring
 *  a source has no block until the generator runs, and the writer would
 *  fail on the missing source. */
export function missingBlockFiles(entries: [string, string[]][], filesDir: string): string[] {
  return entries.flatMap(([module, sources]) =>
    sources
      .map((path) => blockRel(module, path))
      .filter((rel) => !existsSync(join(filesDir, rel)))
      .map((rel) => `files/${rel}`),
  );
}

/** The github/gitignore sections a generated text carries, by source
 *  path: each heading through the line before the next heading, the
 *  trailing blank line dropped, so the text is what section() produced. */
export function sectionsIn(text: string): Record<string, string> {
  const headings = [...text.matchAll(/^## .+ \(github\/gitignore (.+)\)$/gm)];
  const sections: Record<string, string> = {};
  headings.forEach((match, index) => {
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    sections[match[1]] = `${text.slice(match.index, end).trimEnd()}\n`;
  });
  return sections;
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

const HEADER_COMMENT =
  "# Generated from github/gitignore - do not edit between the BEGIN/END\n" +
  "# markers; repository-local patterns live outside the managed region\n" +
  "# (above BEGIN, or below END where last-match-wins can override).\n" +
  "\n";

/** Current content outside the managed region (above BEGIN and below END),
 *  the default seed when the file does not exist yet, or a loud error when
 *  the file exists but has no exactly-once clean region (cleanManagedRegion,
 *  the same accept/reject the writer applies). Regenerating around a
 *  malformed region would silently drop local content or duplicate
 *  markers; the fix is a hand edit, not a guess. */
export function existingLocalSides(output: string): { above: string; below: string } {
  if (!existsSync(output)) return { above: `${DEFAULT_LOCAL_BODY}\n`, below: "" };
  // latin1, not utf-8: the sides are repo-owned bytes, and a utf-8 decode
  // would fold invalid sequences onto U+FFFD - silent corruption on rewrite.
  const slice = cleanManagedRegion(readFileSync(output).toString("latin1"), HASH_REGION_MARKERS);
  if (slice === null) {
    throw new Error(
      `${output} has no single clean REPO-PLATFORM MANAGED region (markers missing, duplicated, out of order, or marker text outside the region); fix its markers by hand, then rerun`,
    );
  }
  return { above: slice.above, below: slice.below };
}

/** The region body every repository receives: the header comment, the
 *  agent and CI workspace sections, and the OS sections. The writer adds
 *  the markers and splices the selected modules' blocks after it. */
export function buildFilesBase(sections: Record<string, string>): string {
  const parts = [HEADER_COMMENT, AGENT_SECTION, "\n", CI_WORKSPACE_SECTION, "\n"];
  for (const path of ALWAYS) {
    parts.push(sections[path], "\n");
  }
  return parts.join("");
}

/** A block file: the section plus the blank line that separates it from
 *  the next block once the writer has spliced them. */
export function buildBlock(section: string): string {
  return `${section}\n`;
}

/** This repository's own .gitignore: the sides ride through verbatim from
 *  the existing file (both are repo-owned) and the region is regenerated
 *  as the base body plus every module source once. */
export function buildSelf(
  sections: Record<string, string>,
  sources: string[],
  sides: { above: string; below: string },
): string {
  const parts = [sides.above, `${HASH_REGION_MARKERS.begin}\n`, buildFilesBase(sections)];
  for (const path of sources) {
    parts.push(sections[path], "\n");
  }
  parts.push(`${HASH_REGION_MARKERS.end}\n`, sides.below);
  return parts.join("");
}

/** The offline comparison of every copy of a section: the block files are
 *  files.yml's sources block for block, the base body opens with the two
 *  local sections and carries exactly the OS sections, and this repository's
 *  region is the base body plus every block's section once, so a refresh
 *  that regenerated one copy and not another (or a hand edit on one side)
 *  is named. Sections are compared by content, so the problems name the
 *  fix rather than the diff. */
export function topologyProblems(input: {
  entries: [string, string[]][];
  filesDir: string;
  selfText: string;
}): string[] {
  const problems: string[] = [];
  const rerun = "run 'bun scripts/generate/build_gitignore.ts' to regenerate every copy";
  const blockSections = new Map<string, string>();
  for (const [module, sources] of input.entries) {
    for (const path of sources) {
      const rel = blockRel(module, path);
      const abs = join(input.filesDir, rel);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, "utf-8");
      const encoded = Object.keys(sectionsIn(text));
      if (encoded.length !== 1 || encoded[0] !== path) {
        problems.push(
          `files/${rel} encodes [${encoded.join(", ")}] but its name stands for ${path}; ${rerun}`,
        );
        continue;
      }
      const sectionText = sectionsIn(text)[path];
      if (buildBlock(sectionText) !== text) {
        problems.push(`files/${rel} is not exactly its section plus one blank line; ${rerun}`);
      }
      const earlier = blockSections.get(path);
      if (earlier !== undefined && earlier !== sectionText) {
        problems.push(`files/${rel} differs from another module's copy of ${path}; ${rerun}`);
      }
      blockSections.set(path, sectionText);
    }
  }
  const baseAbs = join(input.filesDir, BASE_REL);
  const baseText = existsSync(baseAbs) ? readFileSync(baseAbs, "utf-8") : null;
  if (baseText === null) {
    problems.push(`files/${BASE_REL} is missing; ${rerun}`);
  } else {
    const baseSections = sectionsIn(baseText);
    // Presence first: buildFilesBase joins a missing section as empty
    // text, so a base that dropped an OS section would rebuild to itself.
    const baseMissing = ALWAYS.filter((path) => !(path in baseSections));
    if (baseMissing.length > 0) {
      problems.push(`files/${BASE_REL} lacks the section(s) [${baseMissing.join(", ")}]; ${rerun}`);
    } else if (buildFilesBase(baseSections) !== baseText) {
      problems.push(
        `files/${BASE_REL} is not the header, the agent and CI workspace sections, and exactly the OS sections [${ALWAYS.join(", ")}]; ${rerun}`,
      );
    }
    const slice = cleanManagedRegion(input.selfText, HASH_REGION_MARKERS);
    if (slice === null) {
      problems.push(".gitignore has no single clean REPO-PLATFORM MANAGED region");
    } else {
      const sources = selfSources(input.entries);
      const sectionsMissing = sources.filter((path) => !blockSections.has(path));
      if (sectionsMissing.length > 0) {
        problems.push(
          `no block file carries [${sectionsMissing.join(", ")}], so .gitignore cannot be checked against them; ${rerun}`,
        );
        return problems;
      }
      const expected = buildSelf(
        { ...baseSections, ...Object.fromEntries(blockSections) },
        sources,
        { above: "", below: "" },
      );
      if (slice.region !== expected) {
        const present = sectionsIn(slice.region);
        const missing = [...ALWAYS, ...sources].filter((path) => !(path in present));
        problems.push(
          missing.length > 0
            ? `.gitignore's managed region lacks the section(s) [${missing.join(", ")}]; ${rerun}`
            : `.gitignore's managed region differs from files/base/.gitignore plus the block files; ${rerun}`,
        );
      }
    }
  }
  return problems;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const topology = argv.includes("--topology");
  const unknown = argv.filter((a) => a !== "--topology");
  if (unknown.length > 0) {
    console.error(
      `error: unrecognized argument(s): ${unknown.join(" ")} - the script takes only ` +
        "--topology (the offline check); with no arguments it always regenerates " +
        "from github/gitignore HEAD",
    );
    return 2;
  }
  try {
    return await run(topology);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function run(topology: boolean): Promise<number> {
  const entries = gitignoreSources(readFileSync(FILES_CONFIG, "utf-8"));
  const strays = strayBlockFiles(entries, FILES_DIR);
  if (strays.length > 0) {
    throw new Error(
      `stray gitignore block file(s) no files.yml source names: ${strays.join(", ")} - ` +
        "the writer would keep splicing them; delete them (or restore the source)",
    );
  }
  if (topology) {
    const missing = missingBlockFiles(entries, FILES_DIR);
    if (missing.length > 0) {
      throw new Error(
        `missing gitignore block file(s) for declared source(s): ${missing.join(", ")} - ` +
          "run 'bun scripts/generate/build_gitignore.ts' to generate them (or drop the source)",
      );
    }
    const problems = topologyProblems({
      entries,
      filesDir: FILES_DIR,
      selfText: readFileSync(OUTPUT_SELF).toString("latin1"),
    });
    if (problems.length > 0) {
      throw new Error(`the gitignore copies disagree:\n  - ${problems.join("\n  - ")}`);
    }
    console.log(
      "gitignore topology OK: the block files match files.yml's sources, and every copy of a section agrees.",
    );
    return 0;
  }
  const sources = selfSources(entries);
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
    [join(FILES_DIR, BASE_REL), buildFilesBase(sections)],
    ...entries.flatMap(([module, paths]) =>
      paths.map((path): [string, string] => [
        join(FILES_DIR, blockRel(module, path)),
        buildBlock(sections[path]),
      ]),
    ),
    [OUTPUT_SELF, buildSelf(sections, sources, selfSides)],
  ];
  for (const [out, content] of outputs) {
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

#!/usr/bin/env bun
// Nothing records the upstream SHA on purpose: the outputs change only when consumed upstream content changes,
// so the refresh-gitignore PR diff stays worth reading.
// --topology is the offline gate over the block files: one per files.yml source, each exactly its section.
// The root .gitignore is the sync's, written from these files like any target's.
// Content drift inside a block against upstream is ungated until the next refresh regenerates over it.
//
// Usage: bun scripts/generate/build_gitignore.ts [--topology]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  blockSource,
  type FilesConfig,
  parseFilesConfig,
} from "../../actions/plan/files_config.ts";
import { PLATFORM_NAME } from "../../actions/shared/platform.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const FILES_DIR = join(REPO_ROOT, "files");
const FILES_CONFIG = join(REPO_ROOT, "files.yml");
const GITIGNORE = ".gitignore";
const BASE_REL = `base/${GITIGNORE}`;

export const ALWAYS = [
  "Global/Windows.gitignore",
  "Global/macOS.gitignore",
  "Global/Linux.gitignore",
];

// Both .claude spellings are deliberate: the documented .claude/worktrees/ location plus the dotted variant.
const AGENT_SECTION =
  `## Agent local state (${PLATFORM_NAME})\n` +
  ".claude/worktrees/\n" +
  ".claude/.worktrees/\n" +
  ".codex/worktrees/\n" +
  ".worktrees/\n" +
  ".claude/settings.local.json\n";

// Only paths a fleet step creates inside every checked-out workspace are listed: only those can collide with a committed path of the same name.
// Root-anchored so a nested source folder of the same name is not swallowed.
export const CI_WORKSPACE_SECTION = `## CI workspace paths (${PLATFORM_NAME})\n/results.sarif\n`;

// Sections the platform authors itself, keyed by the files.yml source name a module lists beside its github/gitignore stems.
// The fuzz failure directory rides the fuzzer module because only its starter produces it.
export const PLATFORM_SECTIONS: Record<string, string> = {
  fuzzer: `## Fuzzer workspace paths (${PLATFORM_NAME} fuzzer)\n/.fuzz-failures/\n`,
};

const RAW = "https://raw.githubusercontent.com/github/gitignore";
const HEAD_API = "https://api.github.com/repos/github/gitignore/commits/main";

/** A files.yml source name is a platform section's key or a github/gitignore root stem. */
export function sourceId(name: string): string {
  return Object.hasOwn(PLATFORM_SECTIONS, name) ? name : `${name}.gitignore`;
}

export function blockName(path: string): string {
  return (path.split("/").pop() as string).replace(/\.gitignore$/, "");
}

export interface GitignoreBlocks {
  /** The files/-relative directory every block file sits in. */
  dir: string;
  /** Source path (github/gitignore path or platform key) to its files/-relative block file, in files.yml order. */
  files: Map<string, string>;
}

/** One block file per source however many modules name it, so the entry must share its blocks. */
export function gitignoreBlocks(config: FilesConfig, label = "files.yml"): GitignoreBlocks {
  const entry = config.files.find((candidate) => candidate.path === GITIGNORE);
  if (
    entry === undefined ||
    entry.class === "link" ||
    "render" in entry ||
    entry.blocks === undefined
  ) {
    throw new Error(`${label}: no ${GITIGNORE} entry declares blocks`);
  }
  if (entry.blocks_dir === undefined) {
    throw new Error(`${label}: the ${GITIGNORE} entry needs blocks_dir, one block file per source`);
  }
  const files = new Map<string, string>();
  for (const [module, data] of Object.entries(config.modules)) {
    const names = data[entry.blocks];
    if (names === undefined) continue;
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
      throw new Error(`${label}: modules.${module}.${entry.blocks} must be a list of names`);
    }
    for (const name of names as string[]) {
      const path = sourceId(name);
      if (!files.has(path)) files.set(path, blockSource(entry, module, name));
    }
  }
  return { dir: entry.blocks_dir, files };
}

/** Returned rather than deleted: the missing name may be the typo to fix, not the block. */
export function strayBlockFiles({ dir, files }: GitignoreBlocks, filesDir: string): string[] {
  const expected = new Set(files.values());
  const abs = join(filesDir, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .sort()
    .map((name) => `${dir}/${name}`)
    .filter((rel) => !expected.has(rel))
    .map((rel) => `files/${rel}`);
}

/** A module newly declaring a source has no block until the generator runs, and the writer fails on the missing source
 *  (.github/scripts/sync/writer/files_config.ts, verifySources). */
export function missingBlockFiles({ files }: GitignoreBlocks, filesDir: string): string[] {
  return [...files.values()]
    .filter((rel) => !existsSync(join(filesDir, rel)))
    .map((rel) => `files/${rel}`);
}

export function sectionsIn(text: string): Record<string, string> {
  const headings = [
    ...text.matchAll(new RegExp(`^## .+ \\((?:github/gitignore|${PLATFORM_NAME}) (.+)\\)$`, "gm")),
  ];
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
  if (Object.hasOwn(PLATFORM_SECTIONS, path)) return PLATFORM_SECTIONS[path];
  const name = blockName(path);
  // Upstream quirks, each normalized so the outputs stay lint-clean downstream:
  //   Windows.gitignore  -> CRLF line endings
  //   macOS.gitignore    -> `Icon[\r]`, a character class holding a raw CR byte, rewritten to the CR-free `?` glob
  //   comment lines      -> trailing spaces, which fail downstream repos' whitespace linters
  const body = (await fetchText(`${RAW}/${sha}/${path}`))
    .replaceAll("\r\n", "\n")
    .replaceAll("[\r]", "?")
    .replace(/[ \t]+$/gm, "")
    .trim();
  return `## ${name} (github/gitignore ${path})\n${body}\n`;
}

const HEADER_COMMENT =
  "# Generated from github/gitignore - do not edit between the BEGIN/END\n" +
  "# markers; repository-local patterns live outside the managed region\n" +
  "# (above BEGIN, or below END where last-match-wins can override).\n" +
  "\n";

/** The writer adds the markers and splices the selected modules' blocks after this body. */
export function buildFilesBase(sections: Record<string, string>): string {
  const parts = [HEADER_COMMENT, AGENT_SECTION, "\n", CI_WORKSPACE_SECTION, "\n"];
  for (const path of ALWAYS) {
    parts.push(sections[path], "\n");
  }
  return parts.join("");
}

/** The trailing blank line separates this block from the next once the writer has spliced them. */
export function buildBlock(section: string): string {
  return `${section}\n`;
}

export function topologyProblems(input: { blocks: GitignoreBlocks; filesDir: string }): string[] {
  const problems: string[] = [];
  const rerun = "run 'bun scripts/generate/build_gitignore.ts' to regenerate";
  for (const [path, rel] of input.blocks.files) {
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
    if (Object.hasOwn(PLATFORM_SECTIONS, path) && sectionText !== PLATFORM_SECTIONS[path]) {
      problems.push(`files/${rel} is not the platform-authored section ${path}; ${rerun}`);
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
  const config = parseFilesConfig(readFileSync(FILES_CONFIG, "utf-8"));
  const blocks = gitignoreBlocks(config);
  const strays = strayBlockFiles(blocks, FILES_DIR);
  if (strays.length > 0) {
    throw new Error(
      `stray gitignore block file(s) no files.yml source names: ${strays.join(", ")} - ` +
        "the writer refuses a file no source reads; delete them (or restore the source)",
    );
  }
  if (topology) {
    const missing = missingBlockFiles(blocks, FILES_DIR);
    if (missing.length > 0) {
      throw new Error(
        `missing gitignore block file(s) for declared source(s): ${missing.join(", ")} - ` +
          "run 'bun scripts/generate/build_gitignore.ts' to generate them (or drop the source)",
      );
    }
    const problems = topologyProblems({ blocks, filesDir: FILES_DIR });
    if (problems.length > 0) {
      throw new Error(`the gitignore outputs are stale:\n  - ${problems.join("\n  - ")}`);
    }
    console.log(
      "gitignore topology OK: one block file per files.yml source, each exactly its section.",
    );
    return 0;
  }
  // One resolved SHA for the whole run: fetching each file from "main"
  // could straddle an upstream push and mix two commits' content.
  const sha = await upstreamHead();
  console.log(`github/gitignore HEAD is ${sha}`);
  const sections: Record<string, string> = {};
  for (const path of [...ALWAYS, ...blocks.files.keys()]) sections[path] = await section(sha, path);

  const outputs: [string, string][] = [
    [join(FILES_DIR, BASE_REL), buildFilesBase(sections)],
    ...[...blocks.files].map(([path, rel]): [string, string] => [
      join(FILES_DIR, rel),
      buildBlock(sections[path]),
    ]),
  ];
  for (const [out, content] of outputs) {
    writeFileSync(out, content);
    console.log(`wrote ${relative(REPO_ROOT, out)}`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}

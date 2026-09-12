#!/usr/bin/env bun
// Nothing records the upstream SHA on purpose: the outputs change only when consumed upstream content changes,
// so the refresh-gitignore PR diff stays worth reading.
// --topology is the offline gate: the block files match files.yml's sources, every copy of a section carries the same bytes,
// and the operator's own region carries exactly the sections its registration selects;
// content drift inside a block against upstream is ungated until the next refresh regenerates over it.
//
// Usage: bun scripts/generate/build_gitignore.ts [--topology]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readRegistration } from "../../.github/scripts/sync/writer/registration.ts";
import { resolveModules } from "../../.github/scripts/sync/writer/select.ts";
import {
  blockSourcePath,
  blockValueOf,
  type FilesConfig,
  parseFilesConfig,
} from "../../actions/plan/files_config.ts";
import { cleanManagedRegion, HASH_REGION_MARKERS } from "../../actions/shared/grammar.ts";
import {
  MANAGED_REGION_LABEL,
  PLATFORM_NAME,
  REGISTRATION_PATH,
} from "../../actions/shared/platform.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const OUTPUT_SELF = join(REPO_ROOT, ".gitignore");
const FILES_DIR = join(REPO_ROOT, "files");
const FILES_CONFIG = join(REPO_ROOT, "files.yml");
const GITIGNORE = ".gitignore";
const BASE_REL = `base/${GITIGNORE}`;

export const ALWAYS = [
  "Global/Windows.gitignore",
  "Global/macOS.gitignore",
  "Global/Linux.gitignore",
];

const DEFAULT_LOCAL_BODY =
  "# Repository-specific ignore patterns go outside the managed region:\n" +
  "# here (above BEGIN), or below the END marker where last-match-wins\n" +
  "# can override managed patterns.\n";

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

export function blockRel(module: string, path: string): string {
  return `${module}/${blockSourcePath(GITIGNORE, blockName(path))}`;
}

export function gitignoreSources(config: FilesConfig, label = "files.yml"): [string, string[]][] {
  return Object.entries(config.modules).flatMap(([module, data]): [string, string[]][] => {
    const names = data.gitignore_sources;
    if (names === undefined) return [];
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
      throw new Error(`${label}: modules.${module}.gitignore_sources must be a list of names`);
    }
    return [[module, (names as string[]).map(sourceId)]];
  });
}

/** The operator's own selection, read the way the sync reads a target's: the registration resolved against files.yml. */
export function ownModules(root: string, config: FilesConfig): string[] {
  const { selected, dropped } = resolveModules(config, readRegistration(root).modules);
  if (dropped.length > 0) {
    throw new Error(
      `${REGISTRATION_PATH} selects module(s) files.yml does not know: ${dropped.join(", ")}`,
    );
  }
  return selected;
}

/** The selected modules' sources once each, in files.yml order: the writer's block order for the same selection. */
export function selfSources(entries: [string, string[]][], modules: string[]): string[] {
  return [
    ...new Set(
      entries.filter(([module]) => modules.includes(module)).flatMap(([, sources]) => sources),
    ),
  ];
}

/** Returned rather than deleted: the missing name may be the typo to fix, not the block. */
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
      if (blockValueOf(GITIGNORE, name) !== null && !expected.has(rel)) strays.push(`files/${rel}`);
    }
  }
  return strays;
}

/** A module newly declaring a source has no block until the generator runs, and the writer fails on the missing source
 *  (.github/scripts/sync/writer/files_config.ts, blockSources). */
export function missingBlockFiles(entries: [string, string[]][], filesDir: string): string[] {
  return entries.flatMap(([module, sources]) =>
    sources
      .map((path) => blockRel(module, path))
      .filter((rel) => !existsSync(join(filesDir, rel)))
      .map((rel) => `files/${rel}`),
  );
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
  // Upstream quirks, each normalized so the outputs stay ASCII and lint-clean downstream:
  //   Windows.gitignore  -> CRLF line endings
  //   macOS.gitignore    -> `Icon[\r]`, a character class holding a raw CR byte, rewritten to the CR-free `?` glob
  //   comment lines      -> trailing spaces, which fail downstream repos' whitespace linters
  const body = (await fetchText(`${RAW}/${sha}/${path}`))
    .replaceAll("\r\n", "\n")
    .replaceAll("[\r]", "?")
    .replace(/[ \t]+$/gm, "")
    .trim();
  // The outputs are written latin1 (the self file's sides are byte-owned), which is identity only for ASCII,
  // so a non-ASCII section must fail here rather than corrupt silently on write.
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

/** Regenerating around a malformed region would silently drop local content or duplicate markers, so it throws;
 *  cleanManagedRegion is the same accept/reject the writer applies. */
export function existingLocalSides(output: string): { above: string; below: string } {
  if (!existsSync(output)) return { above: `${DEFAULT_LOCAL_BODY}\n`, below: "" };
  // latin1, not utf-8: the sides are repo-owned bytes, and a utf-8 decode
  // would fold invalid sequences onto U+FFFD - silent corruption on rewrite.
  const slice = cleanManagedRegion(readFileSync(output).toString("latin1"), HASH_REGION_MARKERS);
  if (slice === null) {
    throw new Error(
      `${output} has no single clean ${MANAGED_REGION_LABEL} region (markers missing, duplicated, out of order, or marker text outside the region); fix its markers by hand, then rerun`,
    );
  }
  return { above: slice.above, below: slice.below };
}

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

export function topologyProblems(input: {
  entries: [string, string[]][];
  modules: string[];
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
      if (Object.hasOwn(PLATFORM_SECTIONS, path) && sectionText !== PLATFORM_SECTIONS[path]) {
        problems.push(`files/${rel} is not the platform-authored section ${path}; ${rerun}`);
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
      problems.push(`.gitignore has no single clean ${MANAGED_REGION_LABEL} region`);
    } else {
      const sources = selfSources(input.entries, input.modules);
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
        const wanted = [...ALWAYS, ...sources];
        const missing = wanted.filter((path) => !(path in present));
        const unselected = Object.keys(present).filter((path) => !wanted.includes(path));
        problems.push(
          missing.length > 0
            ? `.gitignore's managed region lacks the section(s) [${missing.join(", ")}]; ${rerun}`
            : unselected.length > 0
              ? `.gitignore's managed region carries the section(s) [${unselected.join(", ")}] no module in ${REGISTRATION_PATH} declares; ${rerun}`
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
  const config = parseFilesConfig(readFileSync(FILES_CONFIG, "utf-8"));
  const entries = gitignoreSources(config);
  const modules = ownModules(REPO_ROOT, config);
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
      modules,
      filesDir: FILES_DIR,
      selfText: readFileSync(OUTPUT_SELF).toString("latin1"),
    });
    if (problems.length > 0) {
      throw new Error(`the gitignore copies disagree:\n  - ${problems.join("\n  - ")}`);
    }
    console.log(
      "gitignore topology OK: the block files match files.yml's sources, every copy of a section agrees, and .gitignore carries this repository's selection.",
    );
    return 0;
  }
  // Before any fetch: a malformed self output must abort while every
  // output still stands as committed, rather than behind a half-written
  // set.
  const selfSides = existingLocalSides(OUTPUT_SELF);

  // One resolved SHA for the whole run: fetching each file from "main"
  // could straddle an upstream push and mix two commits' content.
  const sha = await upstreamHead();
  console.log(`github/gitignore HEAD is ${sha}`);
  const sections: Record<string, string> = {};
  // Every declared source feeds a block file; the self output takes only this repository's selection.
  const declared = new Set([...ALWAYS, ...entries.flatMap(([, paths]) => paths)]);
  for (const path of declared) sections[path] = await section(sha, path);

  const outputs: [string, string][] = [
    [join(FILES_DIR, BASE_REL), buildFilesBase(sections)],
    ...entries.flatMap(([module, paths]) =>
      paths.map((path): [string, string] => [
        join(FILES_DIR, blockRel(module, path)),
        buildBlock(sections[path]),
      ]),
    ),
    [OUTPUT_SELF, buildSelf(sections, selfSources(entries, modules), selfSides)],
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

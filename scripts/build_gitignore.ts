#!/usr/bin/env bun
// Compose .gitignore files from the latest github/gitignore templates:
//
// - templates/base/.gitignore.jinja: the skeleton downstream repos receive
//   (published onto the staging/latest build branches by build-branches.yml):
//   OS templates (Windows, macOS, Linux) plus a {# compose:gitignore #}
//   anchor where the composer splices the toolchain fragments below, each
//   wrapped in its module's gate.
// - templates/<module>/fragments/gitignore.jinja: the toolchain templates
//   (bun: Node + bun; uv: Python, which carries upstream's uv section - there
//   is no standalone uv template; rust: Rust) as module fragments.
// - .gitignore (this repo's own): same OS templates plus ALL toolchain
//   templates (downstream repos may carry any combination). The REPOSITORY
//   LOCAL section's existing content is preserved across regenerations.
//
// The template and self outputs open their managed block with one section
// that has no upstream source: agent local state.
//
// By default the script fetches upstream HEAD and records the commit SHA in
// scripts/gitignore.lock (provenance, and what CI verifies against).
//
// Usage:
//   bun scripts/build_gitignore.ts           # fetch latest, update lock, regenerate
//   bun scripts/build_gitignore.ts --locked  # regenerate from the recorded lock SHA
//   bun scripts/build_gitignore.ts --check   # exit 1 if outputs don't match the lock SHA

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(Bun.main), "..");
const LOCK_FILE = join(REPO_ROOT, "scripts", "gitignore.lock");
const OUTPUT_TEMPLATE = join(REPO_ROOT, "templates", "base", ".gitignore.jinja");
const OUTPUT_SELF = join(REPO_ROOT, ".gitignore");

const ALWAYS = ["Global/Windows.gitignore", "Global/macOS.gitignore", "Global/Linux.gitignore"];
const BY_MODULE: Record<string, string[]> = {
  bun: ["Node.gitignore", "bun.gitignore"],
  uv: ["Python.gitignore"],
  rust: ["Rust.gitignore"],
};

const ANCHOR = "gitignore";

const LOCAL_BEGIN = "# BEGIN REPOSITORY LOCAL";
const LOCAL_END = "# END REPOSITORY LOCAL";
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
  return join(REPO_ROOT, "templates", module, "fragments", `${ANCHOR}.jinja`);
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
  // those classes to the CR-free `?` glob so outputs stay ASCII.
  const body = (await fetchText(`${RAW}/${sha}/${path}`))
    .replaceAll("\r\n", "\n")
    .replaceAll("[\r]", "?")
    .trim();
  return `## ${name} (github/gitignore ${path})\n${body}\n`;
}

function localSection(body: string): string {
  return `${LOCAL_BEGIN}\n${body}${LOCAL_END}\n\n`;
}

function managedHeader(sha: string): string {
  return (
    "# BEGIN REPO-PLATFORM MANAGED\n" +
    `# Generated from github/gitignore @ ${sha} - do not edit; local\n` +
    "# patterns go in the REPOSITORY LOCAL section above. Managed patterns\n" +
    "# deliberately come last: last-match-wins makes them non-overridable.\n" +
    "\n"
  );
}

/** Current content between the LOCAL markers, or the default. */
function existingLocalBody(output: string): string {
  if (!existsSync(output)) return DEFAULT_LOCAL_BODY;
  const text = readFileSync(output).toString("utf-8");
  const begin = text.indexOf(LOCAL_BEGIN);
  const end = text.indexOf(LOCAL_END);
  if (begin === -1 || end === -1 || end < begin) return DEFAULT_LOCAL_BODY;
  return text.slice(begin + LOCAL_BEGIN.length + 1, end);
}

function buildTemplate(sha: string, sections: Record<string, string>): string {
  const parts = [
    "{# Generated by scripts/build_gitignore.ts - edit the lock/script, not this file. #}\n",
    localSection(`${DEFAULT_LOCAL_BODY}\n`),
    managedHeader(sha),
    AGENT_SECTION,
    "\n",
  ];
  for (const path of ALWAYS) {
    parts.push(sections[path], "\n");
  }
  parts.push(`{# compose:${ANCHOR} #}\n`, "# END REPO-PLATFORM MANAGED\n");
  return parts.join("");
}

/** A module's fragment: its sections, leading newline owned per the
 *  composer's fragment whitespace convention. */
function buildFragment(sections: Record<string, string>, paths: string[]): string {
  return `\n${paths.map((path) => sections[path]).join("\n")}`;
}

function buildSelf(sha: string, sections: Record<string, string>, localBody: string): string {
  const parts = [
    "# Generated by scripts/build_gitignore.ts - only edit the LOCAL section.\n",
    localSection(localBody),
    managedHeader(sha),
    AGENT_SECTION,
    "\n",
  ];
  for (const path of [...ALWAYS, ...Object.values(BY_MODULE).flat()]) {
    parts.push(sections[path], "\n");
  }
  parts.push("# END REPO-PLATFORM MANAGED\n");
  return parts.join("");
}

type Mode = "fetch" | "locked" | "check";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const locked = args.includes("--locked");
  const check = args.includes("--check");
  const unknown = args.filter((a) => a !== "--locked" && a !== "--check");
  if (unknown.length > 0 || (locked && check)) {
    console.error(
      unknown.length > 0
        ? `error: unrecognized argument(s): ${unknown.join(" ")}`
        : "error: --locked and --check are mutually exclusive",
    );
    return 2;
  }
  const mode: Mode = locked ? "locked" : check ? "check" : "fetch";

  const paths = [...ALWAYS, ...Object.values(BY_MODULE).flat()];
  let sha: string;
  if (mode === "fetch") {
    sha = await upstreamHead();
  } else {
    sha = readFileSync(LOCK_FILE, "utf-8").trim();
  }
  const sections: Record<string, string> = {};
  for (const path of paths) sections[path] = await section(sha, path);
  if (mode === "fetch") {
    // The lock is written only after every fetch succeeded - a failed fetch
    // must not advance the lock past the generated files.
    writeFileSync(LOCK_FILE, `${sha}\n`);
    console.log(`lock updated to ${sha}`);
  }

  const outputs: [string, string][] = [
    [OUTPUT_TEMPLATE, buildTemplate(sha, sections)],
    ...Object.entries(BY_MODULE).map(([module, modulePaths]): [string, string] => [
      fragmentOutput(module),
      buildFragment(sections, modulePaths),
    ]),
    [OUTPUT_SELF, buildSelf(sha, sections, existingLocalBody(OUTPUT_SELF))],
  ];

  if (mode === "check") {
    const stale = outputs
      .filter(
        ([out, content]) =>
          !(existsSync(out) ? readFileSync(out) : Buffer.alloc(0)).equals(
            Buffer.from(content, "utf-8"),
          ),
      )
      .map(([out]) => relative(REPO_ROOT, out));
    if (stale.length > 0) {
      for (const rel of stale) {
        console.log(
          `${rel} is stale: it does not match the output generated from ` +
            `the locked github/gitignore SHA (${sha.slice(0, 12)}); run ` +
            "bun scripts/build_gitignore.ts --locked to regenerate it " +
            "(drop --locked to also advance the lock)",
        );
      }
      return 1;
    }
    console.log("gitignore outputs are up to date");
    return 0;
  }

  for (const [out, content] of outputs) {
    writeFileSync(out, Buffer.from(content, "utf-8"));
    console.log(`wrote ${relative(REPO_ROOT, out)} from github/gitignore @ ${sha}`);
  }
  return 0;
}

process.exit(await main());

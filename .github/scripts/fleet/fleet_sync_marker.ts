#!/usr/bin/env bun
// The merged commit's directives block: the PR body's FINAL paragraph
// (git trailers such as the Co-authored-by lines GitHub appends on squash
// may follow it), one bracketed directive per line -
//
//   [fleet-sync]                      sync the whole fleet now
//   [fleet-sync: owner/a, owner/b]    sync those repos now
//
// Squash merges carry the PR body verbatim (.github/settings-override.yml
// pins PR_BODY), so post-green.yml's read-directives leg reads the opt-in
// from the commit alone and hands the scope to its sync-fleet leg. A
// [fleet-sync] anywhere else, an unknown or duplicated keyword, an empty
// scope, or a bad slug FAILS the leg: a misread opt-in must be loud,
// never a silent fall-through to the weekly cron. No redaction: the text
// is already public on main.
//
// Env: SOURCE_SHA (the judged commit), GITHUB_OUTPUT (armed, repos).

import { fail, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { mustCapture } from "../shared/proc.ts";
import { isSlug } from "./repos_registry.ts";

export type Directives =
  | { kind: "none" }
  | { kind: "fleet-sync"; repos: string[] }
  | { kind: "error"; errors: string[] };

const KEYWORDS = ["fleet-sync"];
const BLOCK_LINE = /^\[[^[\]]*\]$/;
const DIRECTIVE = /^\[([A-Za-z][A-Za-z0-9-]*)(?::\s*(.*?))?\s*\]$/;
const FLEET_SYNC_ANYWHERE = /\[\s*fleet-sync/i;
// A git trailer or Conventional Commits footer (Co-authored-by: x,
// BREAKING CHANGE: x); a paragraph OPENING with one is a footer
// paragraph, continuation lines included. Footers may follow the block:
// GitHub appends co-author trailers below the PR body on squash.
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z0-9-]+)*: \S/;

function paragraphs(body: string): string[][] {
  const lines = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  const result: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === "") {
      if (current.length > 0) result.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

/** Parses a merged commit message (subject included) for its directives
 * block. Pure: every problem comes back as data, all at once. */
export function parseDirectives(body: string): Directives {
  const paras = paragraphs(body);
  let blockIndex = paras.length - 1;
  while (blockIndex >= 0 && TRAILER_LINE.test(paras[blockIndex][0])) {
    blockIndex--;
  }
  const isBlock = blockIndex >= 0 && paras[blockIndex].every((line) => BLOCK_LINE.test(line));

  const errors: string[] = [];
  paras.forEach((para, index) => {
    if (isBlock && index === blockIndex) return;
    for (const line of para) {
      if (FLEET_SYNC_ANYWHERE.test(line)) {
        errors.push(
          `misplaced directive "${line.trim()}": directives go in the PR body's final paragraph, one [keyword] per line and nothing else in that paragraph`,
        );
      }
    }
  });
  if (!isBlock) return errors.length > 0 ? { kind: "error", errors } : { kind: "none" };

  const seen = new Set<string>();
  let repos: string[] = [];
  for (const line of paras[blockIndex]) {
    const match = DIRECTIVE.exec(line);
    if (match === null) {
      errors.push(`"${line}" is not a directive: write [keyword] or [keyword: value]`);
      continue;
    }
    const keyword = match[1].toLowerCase();
    if (!KEYWORDS.includes(keyword)) {
      errors.push(`unknown directive keyword in "${line}"; known: ${KEYWORDS.join(", ")}`);
      continue;
    }
    if (seen.has(keyword)) {
      errors.push(`duplicate directive [${keyword}]: one line per keyword`);
      continue;
    }
    seen.add(keyword);
    const scope = (match[2] ?? "").trim();
    if (match[2] !== undefined && scope === "") {
      errors.push(
        `"${line}" has an empty scope: write [${keyword}] for the whole fleet, or list owner/name slugs`,
      );
      continue;
    }
    if (scope === "") continue;
    const entries = scope.split(",").map((entry) => entry.trim());
    if (entries.includes("")) {
      errors.push(`"${line}" has an empty entry in its list`);
      continue;
    }
    const folded = [...new Set(entries.map((entry) => entry.toLowerCase()))];
    if (folded.includes("all")) {
      if (folded.length > 1) {
        errors.push(`"${line}" mixes "all" with slugs: write [${keyword}] or the slugs alone`);
      }
      continue;
    }
    const bad = entries.filter((entry) => !isSlug(entry));
    if (bad.length > 0) {
      errors.push(`"${line}" lists entries that are not owner/name slugs: ${bad.join(", ")}`);
      continue;
    }
    repos = folded;
  }
  if (errors.length > 0) return { kind: "error", errors };
  return { kind: "fleet-sync", repos };
}

function main(): number {
  const sha = requireEnv("SOURCE_SHA");
  const parsed = parseDirectives(mustCapture(["git", "log", "-1", "--format=%B", sha]));
  switch (parsed.kind) {
    case "error":
      return fail(parsed.errors);
    case "none":
      notice(
        `${sha.slice(0, 12)} carries no directives block; the fleet picks it up on the weekly sync`,
      );
      setOutput("armed", "false");
      return 0;
    case "fleet-sync": {
      const scope = parsed.repos.length === 0 ? "all" : parsed.repos.join(",");
      notice(`[fleet-sync] on ${sha.slice(0, 12)}: syncing ${scope} now`);
      setOutput("armed", "true");
      setOutput("repos", scope);
      return 0;
    }
  }
}

if (import.meta.main) {
  process.exit(main());
}

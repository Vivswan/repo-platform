#!/usr/bin/env bun
// The merged commit's directives block: the PR body's FIRST paragraph
// (a squash merge writes subject, blank line, PR body), one bracketed
// directive per line, each optionally fenced in one pair of backticks -
//
//   [fleet-sync]                      sync the whole fleet now
//   `[fleet-sync: owner/a, owner/b]`  sync those repos now
//
// Squash merges carry the PR body verbatim (.github/settings-override.yml
// pins PR_BODY), so post-green.yml's read-directives leg reads the opt-in
// from the commit alone and hands the scope to its sync-fleet leg.
//
// A block-shaped paragraph or a [fleet-sync anywhere else, bad backtick
// fencing, an unknown or duplicated keyword, an empty scope, or a bad slug
// FAILS the leg: a misread opt-in is loud, never a silent weekly-cron wait.
//
// Env: SOURCE_SHA (the judged commit), GITHUB_OUTPUT (armed, repos).

import { fail, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { mustCapture } from "../shared/proc.ts";
import { isSlug } from "./repos_registry.ts";

export type Directives =
  | { kind: "none" }
  | { kind: "fleet-sync"; repos: string[] }
  | { kind: "error"; errors: string[] };

const KEYWORD = "fleet-sync";
// A block line as written: brackets, any backticks around them. Whether
// the backticks are one balanced pair is judged per line by unwrap().
const BLOCK_LINE = /^`*\[[^[\]]*\]`*$/;
const DIRECTIVE = /^\[([A-Za-z][A-Za-z0-9-]*)(?::\s*(.*?))?\s*\]$/;
const FLEET_SYNC_ANYWHERE = /\[\s*fleet-sync/i;
// paragraphs()[0] is the subject, so the PR body opens at index 1.
const BLOCK_INDEX = 1;
const POSITION =
  "the directives block must be the first paragraph of the PR body, right under the subject: one [keyword] per line and nothing else in that paragraph";

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

/** The bracketed text of a block line without its optional backtick pair;
 * null when the fencing is anything but one pair or none. */
function unwrap(line: string): string | null {
  const open = line.length - line.replace(/^`+/, "").length;
  const close = line.length - line.replace(/`+$/, "").length;
  if (open === 0 && close === 0) return line;
  if (open === 1 && close === 1) return line.slice(1, -1);
  return null;
}

/** Parses a merged commit message (subject included) for its directives
 * block. Pure: every problem comes back as data, all at once. */
export function parseDirectives(body: string): Directives {
  const paras = paragraphs(body);
  const isBlockShaped = (para: string[]) => para.every((line) => BLOCK_LINE.test(line));
  const block =
    paras.length > BLOCK_INDEX && isBlockShaped(paras[BLOCK_INDEX]) ? paras[BLOCK_INDEX] : null;

  const errors: string[] = [];
  paras.forEach((para, index) => {
    if (block !== null && index === BLOCK_INDEX) return;
    const shaped = isBlockShaped(para);
    for (const line of para) {
      if (shaped || FLEET_SYNC_ANYWHERE.test(line)) {
        errors.push(`misplaced directive "${line.trim()}": ${POSITION}`);
      }
    }
  });
  if (block === null) return errors.length > 0 ? { kind: "error", errors } : { kind: "none" };

  const seen = new Set<string>();
  let repos: string[] = [];
  for (const line of block) {
    const directive = unwrap(line);
    if (directive === null) {
      errors.push(
        `"${line}" has bad backtick fencing: wrap the whole directive in one pair, \`[keyword]\`, or none`,
      );
      continue;
    }
    const match = DIRECTIVE.exec(directive);
    if (match === null) {
      errors.push(`"${line}" is not a directive: write [keyword] or [keyword: value]`);
      continue;
    }
    const keyword = match[1].toLowerCase();
    if (keyword !== KEYWORD) {
      errors.push(`unknown directive keyword in "${line}"; known: ${KEYWORD}`);
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
      notice(`fleet-sync directive on ${sha.slice(0, 12)}: syncing ${scope} now`);
      setOutput("armed", "true");
      setOutput("repos", scope);
      return 0;
    }
  }
}

if (import.meta.main) {
  process.exit(main());
}

#!/usr/bin/env bun
// The merged commits' directives blocks: each PR body's FIRST paragraph
// (a squash merge writes subject, blank line, PR body), one bracketed
// directive per line, each optionally fenced in one pair of backticks -
//
//   [fleet-sync]                      sync the whole fleet now
//   `[fleet-sync: owner/a, owner/b]`  sync those repos now
//
// Squash merges carry the PR body verbatim (.github/settings-override.yml
// pins PR_BODY), so post-green.yml's read-directives leg reads the opt-ins
// from git alone and hands the scope to its sync-fleet leg. It reads EVERY
// commit since the last published build (judged_range.ts), not the judged
// commit alone: merges landing within a minute share one surviving CI run,
// and the opt-in may sit on an evicted one. The scopes union - any `all`
// wins, otherwise the repo lists in commit order.
//
// A block-shaped paragraph or a [fleet-sync anywhere else, bad backtick
// fencing, an unknown or duplicated keyword, an empty scope, or a bad slug
// on ANY body in the range FAILS the leg, naming the commit: a misread
// opt-in is loud, never a silent weekly-cron wait.
//
// Env: judged_range.ts's SOURCE_SHA and BEFORE_SHA; GITHUB_OUTPUT (armed, repos).

import { fail, notice, setOutput } from "../shared/gha.ts";
import { mustCapture } from "../shared/proc.ts";
import {
  type DiffBase,
  judgedRangeEnv,
  rangeCommits,
  rangeLabel,
  resolveBase,
} from "./judged_range.ts";
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
  const { sha, before } = judgedRangeEnv();
  const cwd = process.cwd();
  let base: DiffBase;
  try {
    base = resolveBase(cwd, sha, before);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (base.kind !== "build-stamp") {
    notice(
      `no build stamp older than ${sha.slice(0, 12)} exists (nothing published before this run); reading the push alone, from ${base.kind === "empty-tree" ? "the empty tree" : before.slice(0, 12)}`,
    );
  }
  const errors: string[] = [];
  let armed = false;
  let all = false;
  const repos = new Set<string>();
  for (const commit of rangeCommits(cwd, sha, base)) {
    const parsed = parseDirectives(
      mustCapture(["git", "-C", cwd, "log", "-1", "--format=%B", commit]),
    );
    if (parsed.kind === "none") continue;
    if (parsed.kind === "error") {
      errors.push(...parsed.errors.map((error) => `${commit.slice(0, 12)}: ${error}`));
      continue;
    }
    armed = true;
    if (parsed.repos.length === 0) all = true;
    for (const repo of parsed.repos) repos.add(repo);
    const scope = parsed.repos.length === 0 ? "all" : parsed.repos.join(",");
    notice(`fleet-sync directive on ${commit.slice(0, 12)}: ${scope}`);
  }
  if (errors.length > 0) return fail(errors);
  const range = rangeLabel(sha, base);
  if (!armed) {
    notice(`${range} carries no directives block; the fleet picks it up on the weekly sync`);
    setOutput("armed", "false");
    return 0;
  }
  const scope = all ? "all" : [...repos].join(",");
  notice(`${range} opted in: syncing ${scope} now`);
  setOutput("armed", "true");
  setOutput("repos", scope);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

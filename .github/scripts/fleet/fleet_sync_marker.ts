#!/usr/bin/env bun
// The merged commits' directives blocks: each PR body's FIRST paragraph
// (a squash merge writes subject, blank line, PR body), one bracketed
// directive per line, each optionally fenced in one pair of backticks -
//
//   `[fleet-sync: public]`                     the public repos now (the default choice)
//   [fleet-sync: public, owner/a]              plus a public repo by slug
//   [fleet-sync: private]                      the private repos (paid Actions minutes)
//   [fleet-sync: all] every repo's ci.yml changed   everything; the justification is required
//
// Squash merges carry the body verbatim (settings-override.yml pins
// PR_BODY), so the leg reads git alone: every commit in judged_range.ts's
// range, scopes unioned (any `all` wins). The tokens pass through as
// written (sync_scope.ts is the grammar; the plan expands them and refuses
// a private repo's slug - the leg has no visibility source). A malformed or
// misplaced block on any body fails the leg, naming the commit. Env:
// judged_range.ts's, plus GITHUB_OUTPUT (armed, repos).

import { fail, notice, setOutput } from "../shared/gha.ts";
import { mustCapture } from "../shared/proc.ts";
import {
  type DiffBase,
  judgedRangeEnv,
  rangeCommits,
  rangeLabel,
  resolveBase,
} from "./judged_range.ts";
import { classifyEntry } from "./sync_scope.ts";

export type Directives =
  | { kind: "none" }
  | { kind: "fleet-sync"; scope: "all" | string[] }
  | { kind: "error"; errors: string[] };

const KEYWORD = "fleet-sync";
// A block line as written: brackets, any backticks around them, then an
// optional space-separated justification. Whether the backticks are one
// balanced pair is judged per line by unwrap().
const BLOCK_LINE = /^(`*\[[^[\]]*\]`*)(?:\s+(\S.*))?$/;
const DIRECTIVE = /^\[([A-Za-z][A-Za-z0-9-]*)(?::\s*(.*?))?\s*\]$/;
const NEEDS_REASON =
  "syncing every repo needs a justification; use `public` unless private repos need this now - write [fleet-sync: all] <why every repo needs this now>";
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
  let scope: "all" | string[] = [];
  for (const line of block) {
    const [, bracketed, reason = ""] = BLOCK_LINE.exec(line) as RegExpExecArray;
    const directive = unwrap(bracketed);
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
    const value = (match[2] ?? "").trim();
    if (match[2] === undefined) {
      errors.push(`"${line}": ${NEEDS_REASON}`);
      continue;
    }
    if (value === "") {
      errors.push(
        `"${line}" has an empty scope: write [${keyword}: public], [${keyword}: private], owner/name slugs, or [${keyword}: all] <justification>`,
      );
      continue;
    }
    const entries = value.split(",").map((entry) => entry.trim());
    if (entries.includes("")) {
      errors.push(`"${line}" has an empty entry in its list`);
      continue;
    }
    const folded = [...new Set(entries.map((entry) => entry.toLowerCase()))];
    if (folded.includes("all")) {
      if (folded.length > 1) {
        errors.push(
          `"${line}" mixes "all" with other entries: write [${keyword}: all] <justification> alone, or public, private, and slugs`,
        );
      } else if (reason === "") {
        errors.push(`"${line}": ${NEEDS_REASON}`);
      } else {
        scope = "all";
      }
      continue;
    }
    if (reason !== "") {
      errors.push(
        `"${line}" carries text after the directive: only [${keyword}: all] takes a justification`,
      );
      continue;
    }
    const bad = entries.filter((entry) => classifyEntry(entry) === "invalid");
    if (bad.length > 0) {
      errors.push(
        `"${line}" lists entries that are not owner/name slugs, public, or private: ${bad.join(", ")}`,
      );
      continue;
    }
    scope = folded;
  }
  if (errors.length > 0) return { kind: "error", errors };
  return { kind: "fleet-sync", scope };
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
    if (parsed.scope === "all") all = true;
    else for (const entry of parsed.scope) repos.add(entry);
    const scope = parsed.scope === "all" ? "all" : parsed.scope.join(",");
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

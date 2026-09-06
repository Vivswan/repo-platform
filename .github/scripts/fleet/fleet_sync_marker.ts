#!/usr/bin/env bun
// The directives block: each PR body's FIRST paragraph, one `[fleet-sync: <scope>]` per line
// (sync_scope.ts's grammar; only a bare `all` takes, and requires, a trailing justification), read over
// judged_range.ts's range and unioned. A bad body fails the leg only on the judged commit;
// an older one already failed its own run and is a counts-only warning here.

import { fail, notice, setOutput, warning } from "../shared/gha.ts";
import { mustCapture } from "../shared/proc.ts";
import {
  type DiffBase,
  judgedRangeEnv,
  rangeCommits,
  rangeLabel,
  resolveBase,
} from "./judged_range.ts";
import { parseScope } from "./sync_scope.ts";

export type Directives =
  | { kind: "none" }
  | { kind: "fleet-sync"; scope: "all" | string[] }
  | { kind: "error"; errors: string[] };

const KEYWORD = "fleet-sync";
// A block line: brackets with any backticks around them (one balanced pair
// is judged by unwrap()). Trailing text is part of the line only behind a
// BARE fleet-sync bracket: `[Context] ordinary prose` stays prose, and so
// does a code span followed by text, which is how a body mentions the grammar.
const BLOCK_LINE = /^`*\[[^[\]]*\]`*$/;
const JUSTIFIED_LINE = /^(\[\s*fleet-sync\b[^[\]]*\])\s+(\S.*)$/i;
const DIRECTIVE = /^\[([A-Za-z][A-Za-z0-9-]*)(?::\s*(.*?))?\s*\]$/;
const NEEDS_REASON =
  "syncing every repo needs a justification; use `public` unless private repos need this now - write [fleet-sync: all] <why every repo needs this now>";
const FLEET_SYNC_ANYWHERE = /\[\s*fleet-sync/i;
// paragraphs()[0] is the subject, so the PR body opens at index 1.
const BLOCK_INDEX = 1;
const POSITION =
  "the directives block must be the first paragraph of the PR body, right under the subject: one [keyword] per line and nothing else in that paragraph";

// A fence line (CommonMark: three or more backticks with an info string free of backticks, or
// three or more tildes) opens or closes a code block: its marks are never code-span delimiters,
// and no span pairs across it. Read on the container-stripped line.
const FENCE_LINE = /^(?:`{3,}[^`]*|~{3,}.*)$/;

/** The line behind its container prefixes: leading whitespace and blockquote markers, in any mix
 *  (CommonMark counts columns here; the reader models no indented code, so every leading space,
 *  tab, and `>` is a prefix). Every shape decision reads this form, so a shape inside a quote or an
 *  indent is the same shape. One regex pass, linear. */
function containerBody(line: string): string {
  return line.replace(/^[ \t]*(?:>[ \t]*)*/, "");
}

/** One inline run of lines (no fence line inside) with its code spans blanked, line count kept
 *  (CommonMark: a run of N backticks closes at the next run of exactly N, across line breaks; an
 *  unclosed run is literal text). Linear: one tokenizing pass, one right-to-left pairing pass. */
function blankCodeSpans(lines: string[]): string[] {
  const text = lines.join("\n");
  const runs: { start: number; end: number }[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && text[j] === "`") j++;
    runs.push({ start: i, end: j });
    i = j;
  }
  const nextSame = new Array<number>(runs.length).fill(-1);
  const nearest = new Map<number, number>();
  for (let r = runs.length - 1; r >= 0; r--) {
    const length = runs[r].end - runs[r].start;
    nextSame[r] = nearest.get(length) ?? -1;
    nearest.set(length, r);
  }
  let out = "";
  let cursor = 0;
  for (let r = 0; r < runs.length; ) {
    const close = nextSame[r];
    if (close === -1) {
      r++;
      continue;
    }
    out += text.slice(cursor, runs[r].start);
    out += text.slice(runs[r].start, runs[close].end).replace(/[^\n]/g, "");
    cursor = runs[close].end;
    r = close + 1;
  }
  return (out + text.slice(cursor)).split("\n");
}

/** One paragraph's lines with their code spans blanked: each stretch between fence lines is one
 *  inline run scanned as a whole (GitHub wraps the squash body at 72 columns, so a one-line span
 *  in the PR body arrives as several lines here); a fence line passes through as written. */
function withoutCodeSpans(lines: string[]): string[] {
  const bare: string[] = [];
  let inline: string[] = [];
  const flush = () => {
    bare.push(...blankCodeSpans(inline));
    inline = [];
  };
  for (const line of lines) {
    if (FENCE_LINE.test(line)) {
      if (inline.length > 0) flush();
      bare.push(line);
    } else {
      inline.push(line);
    }
  }
  if (inline.length > 0) flush();
  return bare;
}

/** A blank-line-delimited paragraph: its lines as written (`lines`, what an error quotes), behind
 *  their container prefixes (`body`, what every shape decision reads), and with their code spans
 *  blanked (`bare`), all computed once here. */
type Paragraph = { lines: string[]; body: string[]; bare: string[] };

function paragraphs(text: string): Paragraph[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  const result: Paragraph[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      const body = current.map(containerBody);
      result.push({ lines: current, body, bare: withoutCodeSpans(body) });
    }
    current = [];
  };
  for (const line of lines) {
    if (line === "") flush();
    else current.push(line);
  }
  flush();
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
  const isBlockShaped = (para: Paragraph) =>
    para.body.every((line) => BLOCK_LINE.test(line) || JUSTIFIED_LINE.test(line));
  const block =
    paras.length > BLOCK_INDEX && isBlockShaped(paras[BLOCK_INDEX]) ? paras[BLOCK_INDEX] : null;

  const errors: string[] = [];
  paras.forEach((para, index) => {
    if (block !== null && index === BLOCK_INDEX) return;
    const shaped = isBlockShaped(para);
    para.lines.forEach((line, at) => {
      if (shaped || FLEET_SYNC_ANYWHERE.test(para.bare[at])) {
        errors.push(`misplaced directive "${line.trim()}": ${POSITION}`);
      }
    });
  });
  if (block === null) return errors.length > 0 ? { kind: "error", errors } : { kind: "none" };

  const seen = new Set<string>();
  let scope: "all" | string[] = [];
  block.body.forEach((text, at) => {
    const line = block.lines[at];
    const justified = JUSTIFIED_LINE.exec(text);
    const [bracketed, reason] = justified === null ? [text, ""] : [justified[1], justified[2]];
    const directive = unwrap(bracketed);
    if (directive === null) {
      errors.push(
        `"${line}" has bad backtick fencing: wrap the whole directive in one pair, \`[keyword]\`, or none`,
      );
      return;
    }
    const match = DIRECTIVE.exec(directive);
    if (match === null) {
      errors.push(`"${line}" is not a directive: write [keyword] or [keyword: value]`);
      return;
    }
    const keyword = match[1].toLowerCase();
    if (keyword !== KEYWORD) {
      errors.push(`unknown directive keyword in "${line}"; known: ${KEYWORD}`);
      return;
    }
    if (seen.has(keyword)) {
      errors.push(`duplicate directive [${keyword}]: one line per keyword`);
      return;
    }
    seen.add(keyword);
    const value = (match[2] ?? "").trim();
    if (match[2] === undefined) {
      errors.push(`"${line}": ${NEEDS_REASON}`);
      return;
    }
    // parseScope reads "" as the whole fleet (an empty dispatch input); on a
    // directive it is a typo, refused here before the shared grammar.
    if (value === "") {
      errors.push(
        `"${line}" has an empty scope: write [${keyword}: public], [${keyword}: private], owner/name slugs, or [${keyword}: all] <justification>`,
      );
      return;
    }
    // The one scope grammar: what the plans accept, the leg accepts. Its
    // messages carry counts, never entries, so the line is not quoted here.
    const parsed = parseScope(value);
    if (parsed.kind === "error") {
      errors.push(`[${keyword}] scope: ${parsed.message}`);
      return;
    }
    if (parsed.kind === "all") {
      if (reason === "") errors.push(`"${line}": ${NEEDS_REASON}`);
      else scope = "all";
      return;
    }
    if (reason !== "") {
      errors.push(
        `"${line}" carries text after the directive: only [${keyword}: all] takes a justification`,
      );
      return;
    }
    scope = [...parsed.visibility, ...parsed.slugs];
  });
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
  let armed = false;
  let all = false;
  const repos = new Set<string>();
  for (const commit of rangeCommits(cwd, sha, base)) {
    const parsed = parseDirectives(
      mustCapture(["git", "-C", cwd, "log", "-1", "--format=%B", commit]),
    );
    if (parsed.kind === "none") continue;
    if (parsed.kind === "error") {
      // Only the judged commit's body is this run's fault; an older one
      // failed its own run, and failing here would poison every later
      // range until the build tree changes.
      if (commit === sha) {
        return fail(parsed.errors.map((error) => `${commit.slice(0, 12)}: ${error}`));
      }
      warning(
        `${commit.slice(0, 12)} carries a malformed directives block (${parsed.errors.length} problem${parsed.errors.length === 1 ? "" : "s"}; its own run was red) and contributes nothing to this range`,
      );
      continue;
    }
    armed = true;
    if (parsed.scope === "all") all = true;
    else for (const entry of parsed.scope) repos.add(entry);
    const scope = parsed.scope === "all" ? "all" : parsed.scope.join(",");
    notice(`fleet-sync directive on ${commit.slice(0, 12)}: ${scope}`);
  }
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

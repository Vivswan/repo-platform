#!/usr/bin/env bun
// The directives block: each PR body's FIRST paragraph, one `[fleet-sync: <scope>]` per line
// (sync_scope.ts's grammar; a bare `all` requires a justification), read over judged_range.ts's
// range and unioned. The squash commit carries the PR title alone (the fleet override's
// squash_merge_commit_message: BLANK), so each commit's merged pull request is looked up and its
// title and body parsed; a commit with no pull request (a direct push) is read from its message.
// Only the judged commit's body fails the leg; an older one warns (docs/all-green.md).
// Env: GITHUB_REPOSITORY, GH_TOKEN (read), plus judged_range.ts's.

import { z } from "zod";
import { MODULE_ORDER } from "../../../scripts/lib/module_manifests.ts";
import { fail, notice, requireEnv, setOutput, warning } from "../shared/gha.ts";
import { parseJsonWithThrow } from "../shared/json.ts";
import { mustCapture } from "../shared/proc.ts";
import { captureNetwork } from "./discovery.ts";
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
const MODULE_ROSTER = new Set(MODULE_ORDER);
// paragraphs()[0] is the subject, so the PR body opens at index 1.
const BLOCK_INDEX = 1;
const POSITION =
  "the directives block must be the first paragraph of the PR body, right under the subject: one [keyword] per line and nothing else in that paragraph";

// A fence line (CommonMark: three or more backticks with an info string free of backticks, or
// three or more tildes) opens or closes a code block: its marks are never code-span delimiters,
// and no span pairs across it. Read on the container-stripped line.
const FENCE_LINE = /^(?:`{3,}[^`]*|~{3,}.*)$/;

/** The line behind its leading whitespace and blockquote markers, in any mix: what the mention
 *  scan reads (a quoted fence is a fence, a quoted span a span). The block grammar reads raw lines.
 *  Generous on purpose: stripping more can only expose a mention, never hide one. */
function containerBody(line: string): string {
  return line.replace(/^[ \t]*(?:>[ \t]*)*/, "");
}

/** The blockquote markers in the line's container prefix, counted as generously as containerBody
 *  strips them: bareMentions() keeps the pairing-across reading, so a blockquote start the body did not
 *  have never hides a mention that reading exposes. */
function quoteDepth(line: string): number {
  return (/^[ \t]*(?:>[ \t]*)*/.exec(line)?.[0].match(/>/g) ?? []).length;
}

// What CommonMark lets interrupt a paragraph, on the container-stripped line: an ATX heading, a
// thematic break or setext underline, a list item, an HTML block start. Generous where the spec is
// fussy (any list number, any tag). Fences are hard boundaries everywhere; blockquotes are depth.
const INTERRUPTS_PARAGRAPH = [
  /^ {0,3}#{1,6}(?:[ \t]|$)/,
  /^ {0,3}(?:([-*_])(?:[ \t]*\1){2,}|=+|-+)[ \t]*$/,
  /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/,
  /^ {0,3}<[A-Za-z/!?]/,
];

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

/** One paragraph's lines with their code spans blanked: each stretch between fence lines, and
 *  before a line `opensBlock` says starts a new block, is one inline run scanned as a whole (a
 *  commit message, the direct-push source, may carry a 72-column wrap, so a one-line span can
 *  arrive as several lines here); a fence line passes through as written. */
function withoutCodeSpans(
  lines: string[],
  opensBlock: (at: number, runStart: number) => boolean,
): string[] {
  const bare: string[] = [];
  let inline: string[] = [];
  let runStart = 0;
  const flush = () => {
    bare.push(...blankCodeSpans(inline));
    inline = [];
  };
  lines.forEach((line, at) => {
    if (FENCE_LINE.test(line)) {
      if (inline.length > 0) flush();
      bare.push(line);
      return;
    }
    if (inline.length === 0) runStart = at;
    else if (opensBlock(at, runStart)) {
      flush();
      runStart = at;
    }
    inline.push(line);
  });
  if (inline.length > 0) flush();
  return bare;
}

/** Per line, whether a bare mention survives span blanking under ANY reading of where inline runs
 *  end: at fences only (main's reading), or also at one kind of paragraph-interrupting line. One
 *  reading per kind, so adding a kind adds exposures and never hides one another reading shows. */
function bareMentions(lines: string[]): boolean[] {
  const body = lines.map(containerBody);
  const depth = lines.map(quoteDepth);
  const boundaries: ((at: number, runStart: number) => boolean)[] = [
    () => false,
    (at, runStart) => depth[at] > depth[runStart],
    ...INTERRUPTS_PARAGRAPH.map((shape) => (at: number) => shape.test(body[at])),
  ];
  const readings = boundaries.map((opensBlock) => withoutCodeSpans(body, opensBlock));
  return lines.map((_, at) => readings.some((bare) => FLEET_SYNC_ANYWHERE.test(bare[at])));
}

// A line opening with a bare bracket group that ends or continues with text is directive-shaped
// (a directive, a typo of one, `[word] prose`); a link, `[text](url)`, or a code span is not.
const DIRECTIVE_SHAPED = /^\[[^[\]]*\](?:\s|$)/;

/** The lines as written before any 72-column wrap (a commit message, the direct-push source, may
 *  carry one): a line after a justified directive is its continuation. A line the block grammar or the mention scan
 *  would judge on its own never folds, so folding hides nothing. */
function foldJustifications(lines: string[], mentions: boolean[]): string[] {
  const folded: string[] = [];
  let justified: string[] | null = null;
  const flush = () => {
    if (justified !== null) folded.push(justified.join(" "));
    justified = null;
  };
  lines.forEach((line, at) => {
    const body = containerBody(line);
    const ownLine =
      DIRECTIVE_SHAPED.test(body) || BLOCK_LINE.test(body) || FENCE_LINE.test(body) || mentions[at];
    if (justified !== null && !ownLine) {
      justified.push(line);
      return;
    }
    flush();
    if (JUSTIFIED_LINE.test(line)) justified = [line];
    else folded.push(line);
  });
  flush();
  return folded;
}

/** One computation per paragraph: `lines` as written (what errors quote), `folded` (the block
 *  grammar's view), `mentions` (which lines carry a bare mention once container prefixes and code
 *  spans are blanked). A line of only whitespace and blockquote markers is a break. */
type Paragraph = { lines: string[]; folded: string[]; mentions: boolean[] };

function paragraphs(text: string): Paragraph[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  const result: Paragraph[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      const mentions = bareMentions(current);
      result.push({ lines: current, folded: foldJustifications(current, mentions), mentions });
    }
    current = [];
  };
  for (const line of lines) {
    if (containerBody(line) === "") flush();
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

/** Parses a message (the subject, then the body) for its directives block.
 * Pure: every problem comes back as data, all at once. */
export function parseDirectives(body: string): Directives {
  const paras = paragraphs(body);
  const isBlockShaped = (lines: string[]) =>
    lines.every((line) => BLOCK_LINE.test(line) || JUSTIFIED_LINE.test(line));
  const block =
    paras.length > BLOCK_INDEX && isBlockShaped(paras[BLOCK_INDEX].folded)
      ? paras[BLOCK_INDEX].folded
      : null;

  const errors: string[] = [];
  paras.forEach((para, index) => {
    if (block !== null && index === BLOCK_INDEX) return;
    // Folding is for the block position only: elsewhere the raw shape and the
    // mention scan decide, so a wrapped code span holding brackets stays prose.
    const shaped = isBlockShaped(para.lines);
    para.lines.forEach((line, at) => {
      if (shaped || para.mentions[at]) {
        errors.push(`misplaced directive "${line.trim()}": ${POSITION}`);
      }
    });
  });
  if (block === null) return errors.length > 0 ? { kind: "error", errors } : { kind: "none" };

  const seen = new Set<string>();
  let scope: "all" | string[] = [];
  for (const line of block) {
    const justified = JUSTIFIED_LINE.exec(line);
    const [bracketed, reason] = justified === null ? [line, ""] : [justified[1], justified[2]];
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
    // parseScope reads "" as the whole fleet (an empty dispatch input); on a
    // directive it is a typo, refused here before the shared grammar.
    if (value === "") {
      errors.push(
        `"${line}" has an empty scope: write [${keyword}: public], [${keyword}: private], owner/name slugs, or [${keyword}: all] <justification>`,
      );
      continue;
    }
    // The one scope grammar: what the plans accept, the leg accepts. Its
    // messages carry counts, never entries, so the line is not quoted here.
    const parsed = parseScope(value, MODULE_ROSTER);
    if (parsed.kind === "error") {
      errors.push(`[${keyword}] scope: ${parsed.message}`);
      continue;
    }
    if (parsed.kind === "all") {
      if (reason === "") errors.push(`"${line}": ${NEEDS_REASON}`);
      else scope = "all";
      continue;
    }
    // A modules: filter intersects with the visibility tokens, and this leg
    // UNIONS the entries of every commit in the range: "public, modules:x"
    // plus "private" would read as every repo selecting x, dropping the
    // private repos the second commit asked for. Dispatch-only, therefore.
    if (parsed.modules.length > 0) {
      errors.push(
        `"${line}" carries a modules: filter, which is dispatch-only (it intersects with the visibility tokens, so the range union would misread it): dispatch the sync by hand with gh workflow run sync-repos.yml -f repo=...`,
      );
      continue;
    }
    if (reason !== "") {
      errors.push(
        `"${line}" carries text after the directive: only [${keyword}: all] takes a justification`,
      );
      continue;
    }
    scope = [...parsed.visibility, ...parsed.slugs];
  }
  if (errors.length > 0) return { kind: "error", errors };
  return { kind: "fleet-sync", scope };
}

// repos/{repo}/commits/{sha}/pulls lists every pull request the commit reached. The one whose
// merge_commit_sha IS the commit is the merge that produced it; a closed unmerged pull request,
// or one that merely contained the commit, carries another sha or none.
const associatedPulls = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    merge_commit_sha: z.string().nullable(),
  }),
);

/** The message the directives are read from: the merged pull request's title and body, or the
 *  commit's own message when no pull request produced it (a direct push). A failed lookup throws:
 *  an unreadable pull request must never read as "no directive". */
function directiveSource(cwd: string, repository: string, commit: string): string {
  const endpoint = `repos/${repository}/commits/${commit}/pulls`;
  const lookup = captureNetwork(["gh", "api", endpoint]);
  if (lookup.exitCode !== 0) {
    const detail = lookup.stderr.trim();
    throw new Error(
      `${endpoint} could not be read (gh api exit ${lookup.exitCode})${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  const merged = parseJsonWithThrow(associatedPulls, lookup.stdout, endpoint).filter(
    (pull) => pull.merge_commit_sha === commit,
  );
  if (merged.length > 1) {
    throw new Error(
      `${endpoint}: ${merged.length} pull requests claim this commit as their merge (${merged.map((pull) => `#${pull.number}`).join(", ")}); refusing to pick one`,
    );
  }
  if (merged.length === 0)
    return mustCapture(["git", "-C", cwd, "log", "-1", "--format=%B", commit]);
  return `${merged[0].title}\n\n${merged[0].body ?? ""}`;
}

function main(): number {
  const { sha, before } = judgedRangeEnv();
  const repository = requireEnv("GITHUB_REPOSITORY");
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
    let source: string;
    try {
      source = directiveSource(cwd, repository, commit);
    } catch (error) {
      // Every commit's lookup is fatal, the older ones included: a directive
      // that cannot be read must fail the leg, never quietly disarm it.
      return fail(
        `${commit.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = parseDirectives(source);
    if (parsed.kind === "none") continue;
    if (parsed.kind === "error") {
      // Only the judged commit's body is this run's fault; failing on an
      // older one would poison every later range until the build tree changes.
      if (commit === sha) {
        return fail(parsed.errors.map((error) => `${commit.slice(0, 12)}: ${error}`));
      }
      warning(
        `${commit.slice(0, 12)} carries a malformed directives block (${parsed.errors.length} problem${parsed.errors.length === 1 ? "" : "s"}) and contributes nothing to this range; only the judged commit's body fails this leg`,
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

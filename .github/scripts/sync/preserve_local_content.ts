#!/usr/bin/env bun
// Carries repo-local content over a recovery re-render (recover=recopy).
//
// A recovery re-render has no three-way merge: `copier recopy --overwrite`
// rewrites every template-managed file outright, which resets the
// sanctioned repository-local regions a normal update's merge preserves:
//
// - everything below the repo-platform:local-section sentinel in any
//   rendered file that carries one (AGENTS.md, .gitattributes),
// - .gitignore's "# BEGIN/END REPOSITORY LOCAL" section,
// - the repository tails of the prefix docs (SECURITY.md, CONTRIBUTING.md,
//   LICENSE.md), whose managed half ends at the sentinel and whose tail
//   is repo-owned (check_ssot's dogfood-parity prefix mode names the same
//   trio).
//
// This script runs after the re-render, walks the rendered tree, compares
// each affected file with its pre-render HEAD copy, and splices the
// repository-local content back in. Loud beats lossy: the recovery PR is
// always manual-review, so NO shape of previous copy may lose content
// without a disposition in the summary - when a previous copy cannot be
// split into managed content and local tail (it predates the sentinel, or
// was hand-edited past recognition), the WHOLE previous copy is appended
// below a marked recovery-appendix comment instead of being dropped.
// Rules:
//
// - Sentinel files and prefix docs share one carry: a target that
//   startsWith the render is kept whole; else the target's content after
//   its FIRST sentinel line is re-appended below the render (which must
//   end at a sentinel to be used as the managed half - splitting at the
//   first target sentinel keeps everything after it, so a stale duplicate
//   marker can only ever ADD reviewable lines, never drop them); else
//   keep BOTH (render, then the marked appendix). A sentinel-bearing
//   target whose tail is blank was never customized and keeps the render.
// - A render without the sentinel is routed here only for the prefix
//   docs (their mechanism is prefix-ness, not the sentinel); for every
//   other file it means the template dropped the mechanism and the tail
//   is not resurrected.
// - .gitignore: the target's LOCAL section body replaces the render's.
//   A previous copy without a single cleanly-locatable LOCAL region
//   (markers missing, duplicated - even as mid-line text - or reversed)
//   is preserved INSIDE the fresh LOCAL section below a recovery-appendix
//   comment, every carried line commented out (the carry must not
//   silently activate or rewrite ignore patterns) and marker text
//   dash-joined so the validator's exactly-once rule holds; a render
//   without the region keeps the render (the mechanism left the
//   template).
//
// Note: resolve_copier_conflicts.ts's localTailOf splits at the LAST
// sentinel on purpose (its inputs are conflict-hunk fragments that can
// embed a stale managed half); this script splits whole files at the
// FIRST - each is correct for its input. Known corner: a prefix doc
// whose render drops the sentinel in one release and regains it in a
// later one dissolves a prior recovery appendix on the second recovery -
// the repository tail still survives via the first-sentinel split; only
// the appendix framing and the stale managed half above it are dropped.
//
// Files the re-render did not touch are naturally no-ops (render == HEAD),
// so a de-rendered file (module deselected) is never resurrected or
// modified. The carried files land in --summary as markdown for the PR
// body; for a hide-details target the log prints counts only (paths and
// dispositions are target data).
//
// Usage:
//   bun preserve_local_content.ts --summary FILE [--root target]
//     [--hide-details true|false]

import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "../shared/flags.ts";

const HTML_SENTINEL = "<!-- repo-platform:local-section -->";
const HASH_SENTINEL = "# repo-platform:local-section";
const SENTINELS = [HTML_SENTINEL, HASH_SENTINEL];
const LOCAL_BEGIN = "# BEGIN REPOSITORY LOCAL";
const LOCAL_END = "# END REPOSITORY LOCAL";
const MANAGED_BEGIN = "# BEGIN REPO-PLATFORM MANAGED";
const MANAGED_END = "# END REPO-PLATFORM MANAGED";
const GITIGNORE_MARKERS = [LOCAL_BEGIN, LOCAL_END, MANAGED_BEGIN, MANAGED_END];
const PREFIX_DOCS = new Set(["SECURITY.md", "CONTRIBUTING.md", "LICENSE.md"]);

const SKIP_DIRS = new Set([".git", ".repo-platform-src", "node_modules", ".venv", "__pycache__"]);

interface Line {
  text: string;
  /** Index just past the line's newline (or end of content). */
  end: number;
}

function splitLines(content: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      out.push({ text: content.slice(start, i), end: i + 1 });
      start = i + 1;
    }
  }
  if (start < content.length) out.push({ text: content.slice(start), end: content.length });
  return out;
}

function stripCr(text: string): string {
  return text.replace(/\r+$/, "");
}

function lastLineIndex(lines: Line[], match: (text: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (match(stripCr(lines[i].text))) return i;
  }
  return -1;
}

function isSentinel(text: string): boolean {
  return SENTINELS.includes(text);
}

function hasSentinelLine(content: string): boolean {
  return splitLines(content).some((line) => isSentinel(stripCr(line.text)));
}

/** Content split at the FIRST sentinel line: head runs through the
 * sentinel (newline included), tail is everything below it. Splitting at
 * the first keeps every later line - including any further sentinel, so a
 * stale duplicate marker adds reviewable lines instead of dropping the
 * content between the markers; extraSentinels flags that for the summary. */
function splitAtFirstSentinel(
  content: string,
): { head: string; tail: string; extraSentinels: boolean } | null {
  const lines = splitLines(content);
  const first = lines.findIndex((line) => isSentinel(stripCr(line.text)));
  if (first === -1) return null;
  const extraSentinels = lines.some(
    (line, index) => index > first && isSentinel(stripCr(line.text)),
  );
  return {
    head: content.slice(0, lines[first].end),
    tail: content.slice(lines[first].end),
    extraSentinels,
  };
}

function withTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

/** The keep-both fallback: render, then the previous copy in full below a
 * marked comment. Hash-comment spelling for files whose sentinel is the
 * hash form (.gitattributes - an HTML comment there would parse as
 * attribute patterns), the HTML comment otherwise. */
function withAppendix(renderNl: string, target: string): string {
  const hashStyle = splitLines(renderNl).some((line) => stripCr(line.text) === HASH_SENTINEL);
  const explanation = [
    "The recovery re-render (recover=recopy) could not tell this file's",
    "repository-local tail apart from its managed content, so the previous",
    "copy is preserved in full below. Keep what is repository-local, drop",
    "what the content above already covers, then delete this comment.",
  ];
  const appendix = hashStyle
    ? ["# repo-platform:recovery-appendix", ...explanation.map((line) => `# ${line}`)].join("\n")
    : ["<!-- repo-platform:recovery-appendix", `${explanation.join("\n")} -->`].join("\n");
  return `${renderNl}\n${appendix}\n\n${withTrailingNewline(target)}`;
}

export type CarryDisposition = "kept-whole" | "tail-appended" | "appendix";

export interface TailCarry {
  content: string;
  disposition: CarryDisposition;
  /** The target carried more than one sentinel line; everything after the
   * first was kept, so the tail may hold a stale duplicate to review. */
  extraSentinels: boolean;
}

/** Managed-content carry, shared by the sentinel files and the prefix
 * docs: the render is the managed content, the target's local tail is
 * re-appended below it. Null means keep the render (the target never
 * diverged below the managed content). */
export function carryManagedTail(render: string, target: string): TailCarry | null {
  const renderNl = withTrailingNewline(render);
  if (target === render || target === renderNl) return null;
  // Unchanged managed content: the target IS render + tail; keep it whole.
  if (target.startsWith(renderNl)) {
    return {
      content: target,
      disposition: "kept-whole",
      extraSentinels: splitAtFirstSentinel(target)?.extraSentinels ?? false,
    };
  }
  // The render is usable as the managed half only when it ENDS at a
  // recognized sentinel line; anchoring a split on an arbitrary final
  // line would guess. Then the target's content after its FIRST sentinel
  // is the repository tail.
  const renderLines = splitLines(render);
  const finalIndex = lastLineIndex(renderLines, (text) => text.trim() !== "");
  if (finalIndex !== -1 && isSentinel(stripCr(renderLines[finalIndex].text))) {
    const split = splitAtFirstSentinel(target);
    if (split !== null) {
      // Blank tail below the target's sentinel: never customized.
      if (split.tail.trim() === "") return null;
      return {
        content: renderNl + split.tail,
        disposition: "tail-appended",
        extraSentinels: split.extraSentinels,
      };
    }
  }
  // No recognizable split (the previous copy predates the sentinel, or
  // was hand-edited past recognition). Keep BOTH: silently losing the
  // repository's content is the defect this script exists to fix, and the
  // recovery PR is manual-review, so a marked duplicate is acceptable.
  return {
    content: withAppendix(renderNl, target),
    disposition: "appendix",
    extraSentinels: false,
  };
}

/** The LOCAL section split line-anchored on the BEGIN/END marker lines:
 * before runs through the BEGIN line, body sits between the markers, after
 * starts at the END line. */
function localRegion(content: string): { before: string; body: string; after: string } | null {
  const lines = splitLines(content);
  const begin = lines.findIndex((line) => stripCr(line.text) === LOCAL_BEGIN);
  if (begin === -1) return null;
  const end = lines.findIndex((line, index) => index > begin && stripCr(line.text) === LOCAL_END);
  if (end === -1) return null;
  const bodyStart = lines[begin].end;
  const bodyEnd = lines[end - 1].end;
  return {
    before: content.slice(0, bodyStart),
    body: content.slice(bodyStart, bodyEnd),
    after: content.slice(bodyEnd),
  };
}

export interface GitignoreCarry {
  content: string;
  disposition: "spliced" | "appendix";
}

/** Count of lines whose CR-stripped text equals the marker. */
function markerLineCount(content: string, marker: string): number {
  return splitLines(content).filter((line) => stripCr(line.text) === marker).length;
}

/** Substring occurrences, the way validate_generated_files counts. */
function substringCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

/** Previous-copy lines carried into the appendix are commented out (the
 * carry must not silently activate or rewrite ignore patterns - inert and
 * loud, like the .md appendices) and marker text inside them is
 * dash-joined so validate_generated_files' exactly-once substring rule
 * holds on the result. */
function inertPreviousCopy(content: string): string {
  let neutralized = content;
  for (const marker of GITIGNORE_MARKERS) {
    neutralized = neutralized.replaceAll(marker, marker.slice(2).replaceAll(" ", "-"));
  }
  return splitLines(neutralized)
    .map((line) => (stripCr(line.text) === "" ? line.text : `# ${line.text}`))
    .join("\n");
}

/** .gitignore carry: the target's LOCAL section body inside the render's
 * markers. The clean shape requires each LOCAL marker exactly once BOTH
 * as an exact line and as a substring (the validator counts substrings,
 * so a marker buried in surrounding text is a duplicate too), ordered,
 * with no marker text inside the body. Any other shape with non-blank
 * previous content is preserved, commented out, inside the fresh LOCAL
 * section - dropping it would silently lose whatever local entries it
 * held. Null means keep the render: the render has no region (the
 * mechanism left the template), the bodies already match, or an
 * unsplittable previous copy is blank. */
export function carryGitignoreLocal(render: string, target: string): GitignoreCarry | null {
  const renderRegion = localRegion(render);
  if (renderRegion === null) return null;
  const clean = [LOCAL_BEGIN, LOCAL_END].every(
    (marker) => markerLineCount(target, marker) === 1 && substringCount(target, marker) === 1,
  );
  const targetRegion = clean ? localRegion(target) : null;
  if (
    targetRegion !== null &&
    !GITIGNORE_MARKERS.some((marker) => targetRegion.body.includes(marker))
  ) {
    if (renderRegion.body === targetRegion.body) return null;
    return {
      content: renderRegion.before + targetRegion.body + renderRegion.after,
      disposition: "spliced",
    };
  }
  if (target.trim() === "") return null;
  const explanation = [
    "# repo-platform:recovery-appendix",
    "# The recovery re-render (recover=recopy) could not locate a single",
    "# REPOSITORY LOCAL section in this file's previous copy, so the",
    "# previous copy is preserved below, commented out, with marker text",
    "# neutralized. Move what is repository-local up into this section",
    "# (uncommented), drop the rest, then delete this block.",
  ].join("\n");
  return {
    content:
      renderRegion.before +
      renderRegion.body +
      `${explanation}\n${withTrailingNewline(inertPreviousCopy(target))}` +
      renderRegion.after,
    disposition: "appendix",
  };
}

export interface Carried {
  content: string;
  note: string;
}

const TAIL_NOTES: Record<CarryDisposition, string> = {
  "kept-whole": "repository copy kept whole (its managed content matches the render)",
  "tail-appended": "repository tail re-appended below the fresh managed content",
  appendix:
    "managed content not recognized in the repository's previous copy; the previous " +
    "copy is preserved in full below a repo-platform:recovery-appendix comment - " +
    "reconcile manually",
};

const EXTRA_SENTINELS_NOTE =
  "; the previous copy carried more than one local-section marker, and everything " +
  "after its first marker was kept - review the tail for stale duplicates";

const GITIGNORE_NOTES: Record<GitignoreCarry["disposition"], string> = {
  spliced: "REPOSITORY LOCAL section restored from the repository's copy",
  appendix:
    "no single REPOSITORY LOCAL section in the repository's previous copy; the " +
    "previous copy is preserved, commented out, inside the fresh LOCAL section " +
    "below a repo-platform:recovery-appendix comment (its entries do not apply " +
    "until restored) - reconcile manually",
};

/** Repository-local content of the pre-render target spliced into the
 * fresh render, or null when the render is already right. */
export function carryLocalContent(rel: string, render: string, target: string): Carried | null {
  if (render === target) return null;
  let carried: Carried | null = null;
  if (rel === ".gitignore") {
    const carry = carryGitignoreLocal(render, target);
    if (carry !== null) {
      carried = { content: carry.content, note: GITIGNORE_NOTES[carry.disposition] };
    }
  } else if (PREFIX_DOCS.has(rel) || hasSentinelLine(render)) {
    const carry = carryManagedTail(render, target);
    if (carry !== null) {
      carried = {
        content: carry.content,
        note: TAIL_NOTES[carry.disposition] + (carry.extraSentinels ? EXTRA_SENTINELS_NOTE : ""),
      };
    }
  }
  return carried;
}

/** All regular (non-symlink) files below root, sorted, skipping SKIP_DIRS. */
function walkFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (SKIP_DIRS.has(name)) continue;
      const stat = lstatSync(join(root, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(childRel);
      else if (stat.isFile() && !stat.isSymbolicLink()) found.push(childRel);
    }
  };
  visit("");
  return found.sort();
}

/** Fail closed before any per-file HEAD read: a missing repository or an
 * unborn HEAD must abort the carry, not read as "every file is new". */
function requireHead(root: string): void {
  const proc = Bun.spawnSync(["git", "-C", root, "rev-parse", "--verify", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`cannot resolve HEAD in ${root}: ${proc.stderr.toString().trim()}`);
  }
}

/** The file's pre-render content at the target's HEAD, or null when the
 * path is genuinely absent there. The probe is `git ls-tree HEAD -- rel`:
 * exit 0 with empty output means absent, exit 0 with output means
 * present, and ANY nonzero exit is a real git failure and throws -
 * cat-file -e cannot make that distinction (it exits 128 for a missing
 * path and for fatal errors alike), and reading damage as "every file is
 * new" would silently skip the carry. */
function headContent(root: string, rel: string): string | null {
  const probe = Bun.spawnSync(["git", "-C", root, "ls-tree", "HEAD", "--", rel], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (probe.exitCode !== 0) {
    throw new Error(
      `git ls-tree HEAD -- ${rel} failed in ${root}: ${probe.stderr.toString().trim()}`,
    );
  }
  if (probe.stdout.toString().trim() === "") return null;
  const proc = Bun.spawnSync(["git", "-C", root, "show", `HEAD:${rel}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git show HEAD:${rel} failed in ${root}: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString();
}

const SENTINEL_BUFFERS = SENTINELS.map((sentinel) => Buffer.from(sentinel));

function main(argv: string[]): number {
  const flags = parseFlags(argv, ["--summary"] as const, ["--root", "--hide-details"] as const);
  const root = flags["--root"] ?? "target";
  const hideDetails = flags["--hide-details"] === "true";
  requireHead(root);

  const bullets: string[] = [];
  for (const rel of walkFiles(root)) {
    // Byte-level pre-filter (binaries never decode): only the LOCAL-marker
    // gitignore, the prefix docs, and sentinel-bearing files can carry
    // local content.
    const data = readFileSync(join(root, rel));
    if (
      rel !== ".gitignore" &&
      !PREFIX_DOCS.has(rel) &&
      !SENTINEL_BUFFERS.some((sentinel) => data.includes(sentinel))
    ) {
      continue;
    }
    const render = data.toString("utf-8");
    const target = headContent(root, rel);
    if (target === null) continue;
    const carried = carryLocalContent(rel, render, target);
    if (carried === null) continue;
    writeFileSync(join(root, rel), carried.content);
    bullets.push(`- \`${rel}\`: ${carried.note}`);
    // Paths and dispositions are target file data: a hide-details target
    // gets a count here and the detail only in the PR body, which lives
    // in the private repo.
    if (!hideDetails) console.log(`${rel}: ${carried.note}`);
  }

  let summary = "";
  if (bullets.length > 0) {
    summary = [
      "Repo-local content carried over the recovery re-render - the re-render",
      "has no three-way merge and had reset these sanctioned repository-local",
      "regions; verify each file's diff before merging:",
      "",
      ...bullets,
      "",
    ].join("\n");
    if (hideDetails) {
      console.log(
        `carried repo-local content back into ${bullets.length} file(s) ` +
          "(paths hidden: private repository; listed in the PR body)",
      );
    }
  } else {
    console.log("no repo-local content needed carrying over the re-render");
  }
  writeFileSync(flags["--summary"], summary, "utf-8");
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

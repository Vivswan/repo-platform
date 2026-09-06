// The directives grammar as one table of whole messages and FULL parse
// results; the main() rows run the script on scratch clones and assert the
// whole outcome (exit code, GITHUB_OUTPUT, every log line).

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Directives, parseDirectives } from "../../.github/scripts/fleet/fleet_sync_marker.ts";
import { commitStampWrite } from "../../.github/scripts/shared/commit_stamp.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const SUBJECT = "feat: ship the thing (#12)";
const PROSE = "## How\n\nThe thing ships.\n\n## Proof\n\n- bun run check green";
const TRAILERS = "Co-authored-by: A <a@x.test>\nSigned-off-by: B <b@x.test>";

/** A squash-merge message: the subject, then each paragraph in order. */
function message(...paras: string[]): string {
  return [SUBJECT, ...paras].join("\n\n");
}

const NONE: Directives = { kind: "none" };
const FLEET: Directives = { kind: "fleet-sync", scope: "all" };
const NEEDS_REASON =
  "syncing every repo needs a justification; use `public` unless private repos need this now - write [fleet-sync: all] <why every repo needs this now>";
const POSITION =
  "the directives block must be the first paragraph of the PR body, right under the subject: one [keyword] per line and nothing else in that paragraph";
function misplaced(...lines: string[]): Directives {
  return {
    kind: "error",
    errors: lines.map((line) => `misplaced directive "${line}": ${POSITION}`),
  };
}

describe("parseDirectives", () => {
  test.each<{ reason: string; body: string; expected: Directives }>([
    { reason: "a body without a block", body: message(PROSE), expected: NONE },
    { reason: "a bare subject", body: SUBJECT, expected: NONE },
    { reason: "an empty message", body: "", expected: NONE },
    { reason: "a footer-only body is not a block", body: message(TRAILERS), expected: NONE },
    {
      reason: "the all-scope with its justification arms the whole fleet",
      body: message("[fleet-sync: all] every repo's ci.yml changed", PROSE),
      expected: FLEET,
    },
    {
      reason: "a bare [fleet-sync] is the unjustified all-scope: red",
      body: message("[fleet-sync]", PROSE),
      expected: { kind: "error", errors: [`"[fleet-sync]": ${NEEDS_REASON}`] },
    },
    {
      reason: "[fleet-sync: all] without a reason is red the same way",
      body: message("`[fleet-sync: all]`", PROSE),
      expected: { kind: "error", errors: [`"\`[fleet-sync: all]\`": ${NEEDS_REASON}`] },
    },
    {
      reason: "a block with nothing after it",
      body: message("[fleet-sync: all] the gate action changed"),
      expected: FLEET,
    },
    {
      reason: "a code-span bracket followed by text is prose, never a justified directive",
      body: message("`[fleet-sync: all]` every repo's ci.yml changed", PROSE),
      expected: NONE,
    },
    {
      reason:
        "a first paragraph that mentions the default scope in a code span is prose (the control)",
      body: message("`[fleet-sync: public]` is the default scope.", PROSE),
      expected: NONE,
    },
    {
      reason: "public: the public repos, no reason needed",
      body: message("`[fleet-sync: public]`", PROSE),
      expected: { kind: "fleet-sync", scope: ["public"] },
    },
    {
      reason: "private: the private repos",
      body: message("[fleet-sync: Private]", PROSE),
      expected: { kind: "fleet-sync", scope: ["private"] },
    },
    {
      reason: "a slug written before a token is emitted after it: the scope is a set, tokens first",
      body: message("[fleet-sync: Vivswan/a, private]", PROSE),
      expected: { kind: "fleet-sync", scope: ["private", "vivswan/a"] },
    },
    {
      reason: "a token mixes with slugs, folded",
      body: message("[fleet-sync: public, Vivswan/Dotfiles]", PROSE),
      expected: { kind: "fleet-sync", scope: ["public", "vivswan/dotfiles"] },
    },
    {
      reason: "a justification on a scope other than all is red",
      body: message("[fleet-sync: public] because the ci changed", PROSE),
      expected: {
        kind: "error",
        errors: [
          '"[fleet-sync: public] because the ci changed" carries text after the directive: only [fleet-sync: all] takes a justification',
        ],
      },
    },
    {
      reason: "a backticked scoped block",
      body: message("`[fleet-sync: Vivswan/a, Vivswan/b]`", PROSE),
      expected: { kind: "fleet-sync", scope: ["vivswan/a", "vivswan/b"] },
    },
    {
      reason: "a list is trimmed, folded, and deduped",
      body: message("[Fleet-Sync: Vivswan/A , vivswan/b,Vivswan/a]", PROSE),
      expected: { kind: "fleet-sync", scope: ["vivswan/a", "vivswan/b"] },
    },
    {
      reason: "no space after the colon",
      body: message("[fleet-sync:o/r]", PROSE),
      expected: { kind: "fleet-sync", scope: ["o/r"] },
    },
    {
      reason: "trailing whitespace, blank lines, and CRLF are tolerated",
      body: `${message("[fleet-sync: all] every repo's ci.yml changed  ", PROSE)}\r\n\r\n   \r\n`.replace(
        /\n/g,
        "\r\n",
      ),
      expected: FLEET,
    },
    {
      reason: "git trailers GitHub appends on squash follow the body as before",
      body: message("[fleet-sync: all] every repo's ci.yml changed", PROSE, TRAILERS),
      expected: FLEET,
    },
    {
      reason: "a Conventional Commits footer in the body is prose",
      body: message("[fleet-sync: o/r]", PROSE, "BREAKING CHANGE: the asset is renamed"),
      expected: { kind: "fleet-sync", scope: ["o/r"] },
    },
    {
      reason: "a block at the bottom of the body (the retired position) fails, naming the position",
      body: message(PROSE, "[fleet-sync]"),
      expected: misplaced("[fleet-sync]"),
    },
    {
      reason: "a backticked block at the bottom fails the same way",
      body: message(PROSE, "`[fleet-sync: o/r]`", TRAILERS),
      expected: misplaced("`[fleet-sync: o/r]`"),
    },
    {
      reason: "a block-shaped paragraph anywhere else is misplaced even with an unknown keyword",
      body: message(PROSE, "[fleet-synk]\n[`fleet-sync`]"),
      expected: misplaced("[fleet-synk]", "[`fleet-sync`]"),
    },
    {
      reason: "backticks inside the brackets are not a directive",
      body: message("[`fleet-sync`]", PROSE),
      expected: {
        kind: "error",
        errors: ['"[`fleet-sync`]" is not a directive: write [keyword] or [keyword: value]'],
      },
    },
    {
      reason: "a block in the middle of the body fails",
      body: message("## How", "[fleet-sync]", "## Proof"),
      expected: misplaced("[fleet-sync]"),
    },
    {
      reason: "a bracketed lead-in followed by ordinary prose is prose, not a block (the control)",
      body: message("[Context] This is ordinary PR prose.", PROSE),
      expected: NONE,
    },
    {
      reason: "a bracket-only near-miss keyword is still caught",
      body: message("[fleet-synk]", "[Context] This is ordinary PR prose."),
      expected: {
        kind: "error",
        errors: ['unknown directive keyword in "[fleet-synk]"; known: fleet-sync'],
      },
    },
    {
      reason: "a first paragraph that is a markdown link is not a block: misplaced",
      body: message("[fleet-sync](https://x.test)", PROSE),
      expected: misplaced("[fleet-sync](https://x.test)"),
    },
    {
      reason: "a marker inside prose is misplaced even with no block anywhere",
      body: message("Remember to add [fleet-sync] here.", "Closing thoughts."),
      expected: misplaced("Remember to add [fleet-sync] here."),
    },
    {
      reason: "a marker glued to the subject (no blank line) is misplaced",
      body: `${SUBJECT}\n[fleet-sync]`,
      expected: misplaced("[fleet-sync]"),
    },
    {
      reason: "a marker in the subject is misplaced",
      body: `${SUBJECT} [fleet-sync]\n\n${PROSE}`,
      expected: misplaced(`${SUBJECT} [fleet-sync]`),
    },
    {
      reason: "a valid block AND a marker in prose: the misplaced one still fails",
      body: message("[fleet-sync: public]", "See [fleet-sync] above."),
      expected: misplaced("See [fleet-sync] above."),
    },
    {
      reason: "a keyword typo outside the block is misplaced, not silently prose",
      body: message("Later: [fleet-syncs] maybe.", "Done."),
      expected: misplaced("Later: [fleet-syncs] maybe."),
    },
    {
      reason: "an unbalanced backtick fails",
      body: message("`[fleet-sync]", PROSE),
      expected: {
        kind: "error",
        errors: [
          '"`[fleet-sync]" has bad backtick fencing: wrap the whole directive in one pair, `[keyword]`, or none',
        ],
      },
    },
    {
      reason: "doubled backticks fail",
      body: message("``[fleet-sync]``", PROSE),
      expected: {
        kind: "error",
        errors: [
          '"``[fleet-sync]``" has bad backtick fencing: wrap the whole directive in one pair, `[keyword]`, or none',
        ],
      },
    },
    {
      reason: "a trailing-only backtick fails",
      body: message("[fleet-sync]`", PROSE),
      expected: {
        kind: "error",
        errors: [
          '"[fleet-sync]`" has bad backtick fencing: wrap the whole directive in one pair, `[keyword]`, or none',
        ],
      },
    },
    {
      reason: "uneven backtick counts fail",
      body: message("`[fleet-sync]``", PROSE),
      expected: {
        kind: "error",
        errors: [
          '"`[fleet-sync]``" has bad backtick fencing: wrap the whole directive in one pair, `[keyword]`, or none',
        ],
      },
    },
    {
      reason: "a backtick inside the scope list is not a slug",
      body: message("[fleet-sync: `o/r`, o/s]", PROSE),
      expected: {
        kind: "error",
        errors: [
          "[fleet-sync] scope: 1 of 2 scope entries is neither owner/name slugs nor public/private (values withheld - they may be private slugs)",
        ],
      },
    },
    {
      reason: "a marker inside a fenced code block is misplaced, never prose",
      body: message(PROSE, "```text\n[fleet-sync]\n```"),
      expected: misplaced("[fleet-sync]"),
    },
    {
      reason: "a code-span mention in a fenced example beside a valid block is prose",
      body: message("[fleet-sync: public]", PROSE, "```text\n`[fleet-sync: o/r]`\n```"),
      expected: { kind: "fleet-sync", scope: ["public"] },
    },
    {
      reason: "a code-span mention in later prose is prose (the #94 body shape)",
      body: message(PROSE, "The sync leg is untouched, so no `[fleet-sync]`."),
      expected: NONE,
    },
    {
      reason: "the same mention without backticks is misplaced",
      body: message(PROSE, "The sync leg is untouched, so no [fleet-sync]."),
      expected: misplaced("The sync leg is untouched, so no [fleet-sync]."),
    },
    {
      reason: "a mismatched delimiter run is no code span: the mention stays bare and misplaced",
      body: message(PROSE, "No `[fleet-sync]`` here."),
      expected: misplaced("No `[fleet-sync]`` here."),
    },
    {
      reason: "an unclosed run before a closed span leaves only the span's mention hidden",
      body: message(PROSE, "See `` `x` and `[fleet-sync]` there."),
      expected: NONE,
    },
    {
      reason: "a double-backtick span holding a single-backtick span is one code span",
      body: message(PROSE, "Write ``[fleet-sync: all] `why` here`` on one line."),
      expected: NONE,
    },
    {
      reason:
        "the same span wrapped over three lines (GitHub's 72-column squash body) is still one code span",
      body: message(
        PROSE,
        '``::error::33fa6d9769d2: "[fleet-sync]": syncing every repo needs a\njustification; use `public` unless private repos need this now - write\n[fleet-sync: all] <why every repo needs this now>``',
      ),
      expected: NONE,
    },
    {
      reason:
        "the wrapped span without its closer is literal text: both mentions are bare (the control)",
      body: message(
        PROSE,
        '``::error::33fa6d9769d2: "[fleet-sync]": syncing every repo needs a\njustification; use `public` unless private repos need this now - write\n[fleet-sync: all] <why every repo needs this now>',
      ),
      expected: misplaced(
        '``::error::33fa6d9769d2: "[fleet-sync]": syncing every repo needs a',
        "[fleet-sync: all] <why every repo needs this now>",
      ),
    },
    {
      reason:
        "a span never crosses a blank line: the paragraph after an unclosed run is scanned on its own",
      body: message(PROSE, "See ``x", "and [fleet-sync] here``."),
      expected: misplaced("and [fleet-sync] here``."),
    },
    {
      reason:
        "a span never crosses a fence line: the bare mention inside the fence stays misplaced",
      body: message(PROSE, "Before `\n```text\n[fleet-sync]\n```\nAfter `"),
      expected: misplaced("[fleet-sync]"),
    },
    {
      reason: "a tilde fence line ends a span the same way: the mention inside it stays misplaced",
      body: message(PROSE, "Before `\n~~~text\n[fleet-sync]\n~~~\nAfter `"),
      expected: misplaced("[fleet-sync]"),
    },
    {
      reason:
        "the merged body of #89 as GitHub wrapped it (the observed red read-directives on main)",
      body: readFileSync(join(import.meta.dir, "fixtures", "squash_731d2d37.txt"), "utf8"),
      expected: NONE,
    },
    {
      reason:
        "the merged body of #107, its one-line justification wrapped over two lines by GitHub (the observed malformed block on main)",
      body: readFileSync(join(import.meta.dir, "fixtures", "squash_87829f94.txt"), "utf8"),
      expected: FLEET,
    },
    {
      reason: "a justification wrapped over three lines is one justified line",
      body: message(
        "[fleet-sync: all] every repository renders the workflow today; the\nretirement must reach all of them in this merge's own run, not on\nTuesday",
        PROSE,
      ),
      expected: FLEET,
    },
    {
      reason:
        "a wrapped line whose continuation starts with a code span is still the justification",
      body: message("[fleet-sync: all] every repo renders\n`ci.yml` from this template", PROSE),
      expected: FLEET,
    },
    {
      reason: "a wrapped justification whose continuation opens with a markdown link is one line",
      body: message(
        "[fleet-sync: all] every repo needs the shared workflow updated; see\n[details](https://x.test)",
        PROSE,
      ),
      expected: FLEET,
    },
    {
      reason:
        "a quoted directive after a justified line is not a continuation: misplaced, as before",
      body: message("[fleet-sync: all] why\n> [fleet-sync: public]", PROSE),
      expected: misplaced("[fleet-sync: all] why", "> [fleet-sync: public]"),
    },
    {
      reason: "an indented directive after a justified line is not a continuation either",
      body: message("[fleet-sync: all] why\n   [fleet-sync: public]", PROSE),
      expected: misplaced("[fleet-sync: all] why", "[fleet-sync: public]"),
    },
    {
      reason:
        "a bracketed lead-in after a justified line is its own line, not a continuation: prose, misplaced",
      body: message("[fleet-sync: all] why; see\n[RFC] section 2", PROSE),
      expected: misplaced("[fleet-sync: all] why; see"),
    },
    {
      reason:
        "a wrapped code span holding a justified line elsewhere stays prose (folding is for the block position)",
      body: message(PROSE, "`[Context]\n[fleet-sync: all] why\nmore`"),
      expected: NONE,
    },
    {
      reason:
        "a fence line after a justified line never folds, mention or not: the paragraph is prose",
      body: message("[fleet-sync: all] why\n~~~", PROSE),
      expected: misplaced("[fleet-sync: all] why"),
    },
    {
      reason:
        "a fenced example after a justified line never folds: its bare mention is misplaced, as before",
      body: message("[fleet-sync: all] why\n```text\nexample [fleet-sync: public]\n```", PROSE),
      expected: misplaced("[fleet-sync: all] why", "example [fleet-sync: public]"),
    },
    {
      reason: "a continuation carrying a bare mention never folds: misplaced, as before",
      body: message(
        "[fleet-sync: all] why: the\ndefault [fleet-sync: public] is too narrow",
        PROSE,
      ),
      expected: misplaced(
        "[fleet-sync: all] why: the",
        "default [fleet-sync: public] is too narrow",
      ),
    },
    {
      reason: "a continuation carrying the mention in a code span folds (the control)",
      body: message(
        "[fleet-sync: all] why: the\n`[fleet-sync: public]` default is too narrow",
        PROSE,
      ),
      expected: FLEET,
    },
    {
      reason: "a continuation line that is itself a directive is a second block line: duplicate",
      body: message("[fleet-sync: all] every repo changed\n[fleet-sync: public]", PROSE),
      expected: {
        kind: "error",
        errors: ["duplicate directive [fleet-sync]: one line per keyword"],
      },
    },
    {
      reason:
        "a backticked directive after a justified line is a second block line, not a continuation",
      body: message("[fleet-sync: all] every repo changed\n`[fleet-synk]`", PROSE),
      expected: {
        kind: "error",
        errors: ['unknown directive keyword in "`[fleet-synk]`"; known: fleet-sync'],
      },
    },
    {
      reason:
        "a wrapped justification on a scope other than all is still red, quoting the rejoined line",
      body: message("[fleet-sync: public] because the\nci changed", PROSE),
      expected: {
        kind: "error",
        errors: [
          '"[fleet-sync: public] because the ci changed" carries text after the directive: only [fleet-sync: all] takes a justification',
        ],
      },
    },
    {
      reason:
        "prose after a bracket-only directive is not a continuation: the paragraph is prose, the mention misplaced",
      body: message("[fleet-sync: public]\nbecause the ci changed", PROSE),
      expected: misplaced("[fleet-sync: public]"),
    },
    {
      reason: "a code-span block at the bottom is still the misplaced block, not a mention",
      body: message(PROSE, "`[fleet-sync: public]`"),
      expected: misplaced("`[fleet-sync: public]`"),
    },
    {
      reason: "a fenced example written with the [keyword] placeholder is prose",
      body: message(PROSE, "```text\n`[keyword]`\n```"),
      expected: NONE,
    },
    {
      reason: "an unknown keyword fails, naming the known ones",
      body: message("[fleet-synk]", PROSE),
      expected: {
        kind: "error",
        errors: ['unknown directive keyword in "[fleet-synk]"; known: fleet-sync'],
      },
    },
    {
      reason: "a bracketed line that is not keyword-shaped fails",
      body: message("[skip ci]", PROSE),
      expected: {
        kind: "error",
        errors: ['"[skip ci]" is not a directive: write [keyword] or [keyword: value]'],
      },
    },
    {
      reason: "a multi-line block repeating the keyword fails",
      body: message("[fleet-sync: public]\n`[fleet-sync: o/r]`", PROSE),
      expected: {
        kind: "error",
        errors: ["duplicate directive [fleet-sync]: one line per keyword"],
      },
    },
    {
      reason: "an empty scope fails",
      body: message("[fleet-sync:]", PROSE),
      expected: {
        kind: "error",
        errors: [
          '"[fleet-sync:]" has an empty scope: write [fleet-sync: public], [fleet-sync: private], owner/name slugs, or [fleet-sync: all] <justification>',
        ],
      },
    },
    {
      reason: "an empty list entry fails",
      body: message("[fleet-sync: o/r,]", PROSE),
      expected: {
        kind: "error",
        errors: [
          "[fleet-sync] scope: the scope has an empty entry: pass owner/name slugs, public, or private separated by commas, with no stray or trailing comma",
        ],
      },
    },
    {
      reason: "all mixed with anything fails, justification or not",
      body: message("[fleet-sync: all, public] every repo changed", PROSE),
      expected: {
        kind: "error",
        errors: [
          '[fleet-sync] scope: "all" mixes with nothing: pass all alone, or public, private, and owner/name slugs',
        ],
      },
    },
    {
      reason: "a duplicated all is refused like the selectors refuse it (the control)",
      body: message("[fleet-sync: all, all] every repo changed", PROSE),
      expected: {
        kind: "error",
        errors: [
          '[fleet-sync] scope: "all" mixes with nothing: pass all alone, or public, private, and owner/name slugs',
        ],
      },
    },
    {
      reason: "non-slug entries fail, counted like the selectors count them",
      body: message("[fleet-sync: o/r, just-a-name, o/r/extra]", PROSE),
      expected: {
        kind: "error",
        errors: [
          "[fleet-sync] scope: 2 of 3 scope entries are neither owner/name slugs nor public/private (values withheld - they may be private slugs)",
        ],
      },
    },
    {
      reason: "every problem in a block is reported at once, backticks included",
      body: message("[fleet-synk]\n`[fleet-sync:]\n`[fleet-sync:]`", PROSE),
      expected: {
        kind: "error",
        errors: [
          'unknown directive keyword in "[fleet-synk]"; known: fleet-sync',
          '"`[fleet-sync:]" has bad backtick fencing: wrap the whole directive in one pair, `[keyword]`, or none',
          '"`[fleet-sync:]`" has an empty scope: write [fleet-sync: public], [fleet-sync: private], owner/name slugs, or [fleet-sync: all] <justification>',
        ],
      },
    },
  ])("$reason", ({ body, expected }) => {
    expect(parseDirectives(body)).toEqual(expected);
  });
});

// The mention scan reads each line behind its leading whitespace and blockquote markers, so a
// quoted fence is a fence and a quoted span a span; the block grammar reads the raw line, so a
// quoted or indented directive is no block: misplaced, as before the container rule.
describe("parseDirectives inside a container", () => {
  const quoted = (prefix: string, para: string) =>
    para
      .split("\n")
      .map((line) => (line === "" ? prefix.trimEnd() : `${prefix}${line}`))
      .join("\n");
  test.each(
    [
      {
        shape: "a directive as the first paragraph arms only when written bare",
        body: (p: string) => message(quoted(p, "[fleet-sync: public]"), PROSE),
        expected: (p: string): Directives =>
          p === ""
            ? { kind: "fleet-sync", scope: ["public"] }
            : misplaced(`${p}[fleet-sync: public]`.trim()),
      },
      {
        shape: "a justified all-scope as the first paragraph arms only when written bare",
        body: (p: string) => message(quoted(p, "[fleet-sync: all] every ci.yml changed"), PROSE),
        expected: (p: string): Directives =>
          p === "" ? FLEET : misplaced(`${p}[fleet-sync: all] every ci.yml changed`.trim()),
      },
      {
        shape: "a fence line: the fenced mention stays misplaced",
        body: (p: string) => message(PROSE, quoted(p, "```text\n[fleet-sync]\n```")),
        expected: (p: string) => misplaced(`${p}[fleet-sync]`.trim()),
      },
      {
        shape: "a code span in prose",
        body: (p: string) => message(PROSE, quoted(p, "No `[fleet-sync]` here.")),
        expected: (): Directives => NONE,
      },
      {
        shape: "a span never crosses a fence line (the Copilot input at the blockquote prefix)",
        body: (p: string) =>
          message(PROSE, quoted(p, "Before `\n```text\n[fleet-sync]\n```\nAfter `")),
        expected: (p: string) => misplaced(`${p}[fleet-sync]`.trim()),
      },
      {
        shape: "a quote-only line is a paragraph break: a span never crosses it",
        body: (p: string) => message(PROSE, quoted(p, "Before `\n\n[fleet-sync]\nAfter `")),
        expected: (p: string) => misplaced(`${p}[fleet-sync]`.trim()),
      },
    ].flatMap((row) =>
      [
        { container: "unprefixed", prefix: "" },
        { container: "in a blockquote", prefix: "> " },
        { container: "in a nested blockquote without spaces", prefix: ">>" },
        { container: "in a nested blockquote with spaces", prefix: "> > " },
        { container: "in a tab-separated blockquote", prefix: ">\t" },
        { container: "in a tab-indented blockquote", prefix: "\t> " },
        {
          container: "in a blockquote with spaces and tabs mixed around the markers",
          prefix: " \t> \t>  \t",
        },
        { container: "indented three spaces", prefix: "   " },
        { container: "indented four spaces", prefix: "    " },
      ].map((c) => ({ ...row, ...c })),
    ),
  )("$shape $container", ({ body, prefix, expected }) => {
    expect(parseDirectives(body(prefix))).toEqual(expected(prefix));
  });

  test.each([
    {
      reason:
        "entering a blockquote ends the inline run (the Copilot input): the quoted mention is bare",
      body: message(PROSE, "Before `\n> [fleet-sync]\nAfter `"),
      expected: misplaced("> [fleet-sync]"),
    },
    {
      reason: "a deeper blockquote inside a quote ends the run the same way",
      body: message(PROSE, "> a `\n> > [fleet-sync]\n> b `"),
      expected: misplaced("> > [fleet-sync]"),
    },
    {
      reason:
        "leaving a blockquote is a lazy continuation (CommonMark): the span still pairs, the mention is code",
      body: message(PROSE, "> Before `\n[fleet-sync]\n> After `"),
      expected: NONE,
    },
    {
      reason:
        "a lazy continuation is never split, or its own backticks would re-pair and hide the bare mention",
      body: message(PROSE, "> Before `\nend ` [fleet-sync] `"),
      expected: misplaced("end ` [fleet-sync] `"),
    },
    {
      reason:
        "a `>` behind four spaces is text, not a marker: the paragraph continues and the span pairs as rendered",
      body: message(PROSE, "Before `\n    > end ` [fleet-sync] `"),
      expected: misplaced("> end ` [fleet-sync] `"),
    },
    {
      reason:
        "a `>` behind four spaces after a directive is prose in the same paragraph: misplaced, as before, never armed",
      body: message("[fleet-sync: public]\n    > more", PROSE),
      expected: misplaced("[fleet-sync: public]"),
    },
    {
      reason:
        "a deeper `>` inside a fenced block opens nothing: the fenced lines stay one run and the mention is bare",
      body: message(PROSE, "```\na `\n> end ` [fleet-sync] `\n```"),
      expected: misplaced("> end ` [fleet-sync] `"),
    },
    {
      reason: "the same inside a tilde fence",
      body: message(PROSE, "~~~\na `\n> end ` [fleet-sync] `\n~~~"),
      expected: misplaced("> end ` [fleet-sync] `"),
    },
    {
      reason: "a tilde line inside a backtick fence closes nothing: the fenced lines stay one run",
      body: message(PROSE, "```\n~~~\na `\n> end ` [fleet-sync] `\n```"),
      expected: misplaced("> end ` [fleet-sync] `"),
    },
    {
      reason:
        "a tab and spaces after the first marker leave the second `>` as text: one quoted paragraph, the span pairs as rendered",
      body: message(PROSE, "> Before `\n>\t  > end ` [fleet-sync] `"),
      expected: misplaced(">\t  > end ` [fleet-sync] `"),
    },
    {
      reason:
        "a constant quote depth with the markers written differently is one paragraph: the span pairs",
      body: message(PROSE, "> Before `\n>[fleet-sync]\n > After `"),
      expected: NONE,
    },
    {
      reason:
        "a quoted prose line after a justified line folds as its continuation (the block grammar never splits on quotes)",
      body: message("[fleet-sync: all] why\n> more", PROSE),
      expected: FLEET,
    },
  ])("$reason", ({ body, expected }) => {
    expect(parseDirectives(body)).toEqual(expected);
  });

  test("the quote-only-line input as reviewed, byte for byte", () => {
    expect(
      parseDirectives("feat: probe\n\nIntro.\n\n> Before `\n>\n> [fleet-sync]\n> After `"),
    ).toEqual(misplaced("> [fleet-sync]"));
  });
});

test.each([
  {
    shape: "100k backticks in prose (the run tokenizer)",
    line: `x ${"`".repeat(100_000)} [fleet-sync]`,
  },
  {
    shape: "100k backticks as a fence line (the fence regex)",
    line: `${"`".repeat(100_000)} [fleet-sync]`,
  },
  {
    // 400k markers: the repeated-replace scan this row retired took 1.8 s here and 130 ms at 100k.
    shape: "400k blockquote markers (the container scan)",
    line: `${">".repeat(400_000)} [fleet-sync]`,
  },
])("a run of $shape is scanned in linear time: the mention stays bare", ({ line }) => {
  // The control for the scanner: the regex it replaced backtracked
  // quadratically on one long run (about a second at this length).
  const started = performance.now();
  const parsed = parseDirectives(message(PROSE, line));
  const elapsed = performance.now() - started;
  expect(parsed).toEqual(misplaced(line));
  expect(elapsed).toBeLessThan(300);
});

test("a justification wrapped over 100k lines folds in linear time and arms", () => {
  // The control for the fold: rescanning the growing joined line on every
  // continuation took 3.8 s here.
  const body = message(`[fleet-sync: all] why\n${"more\n".repeat(100_000)}`.trimEnd(), PROSE);
  const started = performance.now();
  const parsed = parseDirectives(body);
  const elapsed = performance.now() - started;
  expect(parsed).toEqual(FLEET);
  expect(elapsed).toBeLessThan(300);
});

describe("main", () => {
  const script = join(import.meta.dir, "../../.github/scripts/fleet/fleet_sync_marker.ts");
  const root = temp.dir("fleet-sync-marker-");

  function git(cwd: string, args: string[]): string {
    const proc = boundedSpawnSync([
      "git",
      "-C",
      cwd,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@x.test",
      ...args,
    ]);
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
    return proc.stdout.trimEnd();
  }

  // main's history, one squash merge per commit: the fixture every clone
  // below is taken from. The leg's checkout sees the build branch as
  // refs/remotes/origin/build, so each scenario is a clone of a bare
  // origin carrying (or lacking) a build branch stamped at one commit.
  const source = join(root, "source");
  mkdirSync(source);
  git(source, ["init", "-q", "-b", "main"]);
  function commit(body: string): string {
    const file = join(root, `msg-${Bun.hash(body).toString(16)}.txt`);
    writeFileSync(file, body);
    git(source, ["commit", "-q", "--allow-empty", "-F", file]);
    return git(source, ["rev-parse", "HEAD"]);
  }
  const seed = commit("seed");
  const listA = commit(message("`[fleet-sync: Vivswan/a]`", PROSE));
  const prose1 = commit(message(PROSE));
  const prose2 = commit(message(PROSE));
  const listBA = commit(message("[fleet-sync: Vivswan/b, vivswan/a]", PROSE));
  const whole = commit(message("[fleet-sync: all] every repo's ci.yml changed", PROSE));
  const bottom = commit(message(PROSE, "[fleet-sync]"));
  const prose3 = commit(message(PROSE));
  const pub = commit(message("[fleet-sync: public]", PROSE));
  const mixed = commit(message("`[fleet-sync: private, Vivswan/b]`", PROSE));
  const bare = commit(message("[fleet-sync]", PROSE));
  const unjustified = commit(message("`[fleet-sync: all]`", PROSE));
  const reasoned = commit(message("[fleet-sync: public] the ci changed", PROSE));
  const context = commit(message("[Context] This is ordinary PR prose.", PROSE));
  const leaky = commit(message("[fleet-sync: SecretOrg/PrivateRepo,]", PROSE));
  const ordered = commit(message("[fleet-sync: Vivswan/a, private]", PROSE));
  const mention = commit(message(PROSE, "The sync leg is untouched, so no `[fleet-sync]`."));

  /** A clone whose origin carries main plus, when `stamp` is given, a
   *  build branch of one orphan commit stamped like publish.ts stamps. */
  function cloneWithBuild(name: string, stamp: string | null): string {
    const bare = join(root, `${name}.git`);
    git(root, ["clone", "-q", "--bare", source, bare]);
    if (stamp !== null) {
      const scratch = join(root, `${name}-build`);
      git(root, ["clone", "-q", bare, scratch]);
      git(scratch, ["checkout", "-q", "--orphan", "build"]);
      writeFileSync(join(scratch, "tree.txt"), "0\n");
      git(scratch, ["add", "-A"]);
      git(scratch, [
        "commit",
        "-q",
        "-m",
        `build\n\n${commitStampWrite("https://x.test", "o/r", stamp)}\nrun: https://x.test/run`,
      ]);
      git(scratch, ["push", "-q", "origin", "build"]);
    }
    const clone = join(root, name);
    git(root, ["clone", "-q", bare, clone]);
    return clone;
  }

  const unpublished = cloneWithBuild("unpublished", null);
  const publishedSeed = cloneWithBuild("published-seed", seed);
  const publishedProse2 = cloneWithBuild("published-prose2", prose2);
  const publishedListBA = cloneWithBuild("published-list-ba", listBA);
  const publishedProse3 = cloneWithBuild("published-prose3", prose3);
  const publishedWhole = cloneWithBuild("published-whole", whole);
  const publishedMixed = cloneWithBuild("published-mixed", mixed);

  function run(
    cwd: string,
    sha: string,
    before: string,
  ): { exitCode: number; stdout: string; output: string } {
    const outputFile = join(root, `out-${Bun.hash(cwd + sha + before).toString(16)}.txt`);
    writeFileSync(outputFile, "");
    const proc = boundedSpawnSync(["bun", script], {
      cwd,
      env: { ...process.env, SOURCE_SHA: sha, BEFORE_SHA: before, GITHUB_OUTPUT: outputFile },
    });
    return { ...proc, output: readFileSync(outputFile, "utf-8") };
  }

  const short = (sha: string) => sha.slice(0, 12);
  const lines = (...notices: string[]) => notices.map((text) => `${text}\n`).join("");
  const pushAlone = (sha: string, before: string) =>
    `::notice::no build stamp older than ${short(sha)} exists (nothing published before this run); reading the push alone, from ${short(before)}`;
  const noBlock = (base: string, sha: string) =>
    `::notice::${short(base)}..${short(sha)} carries no directives block; the fleet picks it up on the weekly sync`;
  const directive = (sha: string, scope: string) =>
    `::notice::fleet-sync directive on ${short(sha)}: ${scope}`;
  const syncing = (base: string, sha: string, scope: string) =>
    `::notice::${short(base)}..${short(sha)} opted in: syncing ${scope} now`;

  test("the coalescing case: three merges within a minute, only the first opted in, and only the last one's CI run survived", () => {
    // The stamped base covers every commit since the last publish, so the
    // surviving run carries the first merge's directive.
    const stamped = run(publishedSeed, prose2, prose1);
    expect(stamped).toEqual({
      exitCode: 0,
      output: "armed=true\nrepos=vivswan/a\n",
      stdout: lines(directive(listA, "vivswan/a"), syncing(seed, prose2, "vivswan/a")),
      stderr: "",
    });
    // The control, the old single-commit read: the same run against an
    // origin with no build branch reads the surviving push alone and
    // arms nothing - the defect as observed.
    const pushOnly = run(unpublished, prose2, prose1);
    expect(pushOnly).toEqual({
      exitCode: 0,
      output: "armed=false\n",
      stdout: lines(pushAlone(prose2, prose1), noBlock(prose1, prose2)),
      stderr: "",
    });
  });

  test.each([
    {
      reason:
        "two directives with overlapping repo lists: the union, in commit order, each repo once",
      cwd: publishedSeed,
      sha: listBA,
      output: "armed=true\nrepos=vivswan/a,vivswan/b\n",
      stdout: lines(
        directive(listA, "vivswan/a"),
        directive(listBA, "vivswan/b,vivswan/a"),
        syncing(seed, listBA, "vivswan/a,vivswan/b"),
      ),
    },
    {
      reason: "a justified all-scope beside a list: all wins",
      cwd: publishedProse2,
      sha: whole,
      output: "armed=true\nrepos=all\n",
      stdout: lines(
        directive(listBA, "vivswan/b,vivswan/a"),
        directive(whole, "all"),
        syncing(prose2, whole, "all"),
      ),
    },
    {
      reason: "visibility tokens union with a slug list and pass through as written",
      cwd: publishedProse3,
      sha: mixed,
      output: "armed=true\nrepos=public,private,vivswan/b\n",
      stdout: lines(
        directive(pub, "public"),
        directive(mixed, "private,vivswan/b"),
        syncing(prose3, mixed, "public,private,vivswan/b"),
      ),
    },
  ])("$reason", ({ cwd, sha, output, stdout }) => {
    const result = run(cwd, sha, git(cwd, ["rev-parse", `${sha}~1`]));
    expect(result).toEqual({ exitCode: 0, output, stdout, stderr: "" });
  });

  // A malformed body on an OLDER commit is a warning: a docs-only commit
  // leaves the build stamp in place, so failing here would poison every
  // later range. The judged commit's own body stays fatal.
  const poisoned = `::warning::${short(bottom)} carries a malformed directives block (1 problem) and contributes nothing to this range; only the judged commit's body fails this leg`;
  test.each([
    {
      reason: "a malformed older body warns and the judged commit's valid block arms",
      cwd: publishedWhole,
      sha: pub,
      exitCode: 0,
      output: "armed=true\nrepos=public\n",
      stdout: lines(poisoned, directive(pub, "public"), syncing(whole, pub, "public")),
    },
    {
      reason: "a malformed older body warns, a valid block before it still arms",
      cwd: publishedListBA,
      sha: prose3,
      exitCode: 0,
      output: "armed=true\nrepos=all\n",
      stdout: lines(directive(whole, "all"), poisoned, syncing(listBA, prose3, "all")),
    },
    {
      reason: "a malformed older body warns, and the judged commit's own bare form is red",
      cwd: publishedWhole,
      sha: bare,
      exitCode: 1,
      output: "",
      stdout: lines(
        poisoned,
        directive(pub, "public"),
        directive(mixed, "private,vivswan/b"),
        `::error::${short(bare)}: "[fleet-sync]": ${NEEDS_REASON}`,
      ),
    },
    {
      reason: "the judged commit's own bare form alone is red",
      cwd: publishedMixed,
      sha: bare,
      exitCode: 1,
      output: "",
      stdout: lines(`::error::${short(bare)}: "[fleet-sync]": ${NEEDS_REASON}`),
    },
  ])("$reason", ({ cwd, sha, exitCode, output, stdout }) => {
    const result = run(cwd, sha, git(cwd, ["rev-parse", `${sha}~1`]));
    expect(result).toEqual({ exitCode, output, stdout, stderr: "" });
  });

  test.each([
    {
      reason: "no block: armed=false and a notice",
      sha: prose1,
      exitCode: 0,
      output: "armed=false\n",
      stdout: (base: string, sha: string) => lines(pushAlone(sha, base), noBlock(base, sha)),
    },
    {
      reason: "public: armed=true, repos=public",
      sha: pub,
      exitCode: 0,
      output: "armed=true\nrepos=public\n",
      stdout: (base: string, sha: string) =>
        lines(pushAlone(sha, base), directive(sha, "public"), syncing(base, sha, "public")),
    },
    {
      reason: "the justified all-scope: armed=true, repos=all",
      sha: whole,
      exitCode: 0,
      output: "armed=true\nrepos=all\n",
      stdout: (base: string, sha: string) =>
        lines(pushAlone(sha, base), directive(sha, "all"), syncing(base, sha, "all")),
    },
    {
      reason: "a list: repos is the folded comma list",
      sha: listBA,
      exitCode: 0,
      output: "armed=true\nrepos=vivswan/b,vivswan/a\n",
      stdout: (base: string, sha: string) =>
        lines(
          pushAlone(sha, base),
          directive(sha, "vivswan/b,vivswan/a"),
          syncing(base, sha, "vivswan/b,vivswan/a"),
        ),
    },
    {
      reason: "[fleet-sync: all] without a reason: red leg, nothing armed",
      sha: unjustified,
      exitCode: 1,
      output: "",
      stdout: (base: string, sha: string) =>
        lines(
          pushAlone(sha, base),
          `::error::${short(sha)}: "\`[fleet-sync: all]\`": ${NEEDS_REASON}`,
        ),
    },
    {
      reason: "a reason on public: red leg, nothing armed",
      sha: reasoned,
      exitCode: 1,
      output: "",
      stdout: (base: string, sha: string) =>
        lines(
          pushAlone(sha, base),
          `::error::${short(sha)}: "[fleet-sync: public] the ci changed" carries text after the directive: only [fleet-sync: all] takes a justification`,
        ),
    },
    {
      reason: "a bracketed lead-in with prose is a normal body: armed=false",
      sha: context,
      exitCode: 0,
      output: "armed=false\n",
      stdout: (base: string, sha: string) => lines(pushAlone(sha, base), noBlock(base, sha)),
    },
    {
      reason: "a code-span mention in later prose (the #94 body shape): armed=false",
      sha: mention,
      exitCode: 0,
      output: "armed=false\n",
      stdout: (base: string, sha: string) => lines(pushAlone(sha, base), noBlock(base, sha)),
    },
    {
      reason: "a slug before a token: repos= carries tokens first, then slugs",
      sha: ordered,
      exitCode: 0,
      output: "armed=true\nrepos=private,vivswan/a\n",
      stdout: (base: string, sha: string) =>
        lines(
          pushAlone(sha, base),
          directive(sha, "private,vivswan/a"),
          syncing(base, sha, "private,vivswan/a"),
        ),
    },
    {
      reason: "a scope error names no entry: the private slug never reaches the log",
      sha: leaky,
      exitCode: 1,
      output: "",
      stdout: (base: string, sha: string) =>
        lines(
          pushAlone(sha, base),
          `::error::${short(sha)}: [fleet-sync] scope: the scope has an empty entry: pass owner/name slugs, public, or private separated by commas, with no stray or trailing comma`,
        ),
    },
    {
      reason: "a block at the bottom of the body: red leg, nothing armed",
      sha: bottom,
      exitCode: 1,
      output: "",
      stdout: (base: string, sha: string) =>
        lines(
          pushAlone(sha, base),
          `::error::${short(sha)}: misplaced directive "[fleet-sync]": ${POSITION}`,
        ),
    },
  ])("a one-commit push without a build stamp, $reason", ({ sha, exitCode, output, stdout }) => {
    const before = git(unpublished, ["rev-parse", `${sha}~1`]);
    const result = run(unpublished, sha, before);
    expect(result).toEqual({ exitCode, output, stdout: stdout(before, sha), stderr: "" });
    for (const channel of [result.stdout, result.stderr, result.output]) {
      expect(channel).not.toContain("SecretOrg");
      expect(channel).not.toContain("PrivateRepo");
    }
  });

  test("a truncated judged sha is refused with no output line", () => {
    const result = run(unpublished, prose1.slice(0, 12), seed);
    expect(result).toEqual({
      exitCode: 1,
      output: "",
      stdout: `::error::SOURCE_SHA is not a full commit sha (got '${short(prose1)}')\n`,
      stderr: "",
    });
  });
});

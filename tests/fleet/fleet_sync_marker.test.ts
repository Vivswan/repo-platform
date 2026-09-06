// The directives-block grammar read-directives reads off the merged
// commit, as one table of whole commit messages and FULL parse results.
// The main() rows run the script on a scratch repo and read GITHUB_OUTPUT.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Directives, parseDirectives } from "../../.github/scripts/fleet/fleet_sync_marker.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const SUBJECT = "feat: ship the thing (#12)";
const PROSE = "## How\n\nThe thing ships.\n\n## Proof\n\n- bun run check green";
const TRAILERS = "Co-authored-by: A <a@x.test>\nSigned-off-by: B <b@x.test>";

/** A squash-merge message: the subject, then each paragraph in order. */
function message(...paras: string[]): string {
  return [SUBJECT, ...paras].join("\n\n");
}

const NONE: Directives = { kind: "none" };
const FLEET: Directives = { kind: "fleet-sync", repos: [] };
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
      reason: "a bare [fleet-sync] opening the body arms the whole fleet",
      body: message("[fleet-sync]", PROSE),
      expected: FLEET,
    },
    {
      reason: "a block with nothing after it",
      body: message("[fleet-sync]"),
      expected: FLEET,
    },
    {
      reason: "a backticked block renders as code and arms the same",
      body: message("`[fleet-sync]`", PROSE),
      expected: FLEET,
    },
    {
      reason: "a backticked scoped block",
      body: message("`[fleet-sync: Vivswan/a, Vivswan/b]`", PROSE),
      expected: { kind: "fleet-sync", repos: ["vivswan/a", "vivswan/b"] },
    },
    {
      reason: "[fleet-sync: all] is the same as bare",
      body: message("[fleet-sync: all]", PROSE),
      expected: FLEET,
    },
    {
      reason: "a list is trimmed, folded, and deduped",
      body: message("[Fleet-Sync: Vivswan/A , vivswan/b,Vivswan/a]", PROSE),
      expected: { kind: "fleet-sync", repos: ["vivswan/a", "vivswan/b"] },
    },
    {
      reason: "no space after the colon",
      body: message("[fleet-sync:o/r]", PROSE),
      expected: { kind: "fleet-sync", repos: ["o/r"] },
    },
    {
      reason: "trailing whitespace, blank lines, and CRLF are tolerated",
      body: `${message("`[fleet-sync]`  ", PROSE)}\r\n\r\n   \r\n`.replace(/\n/g, "\r\n"),
      expected: FLEET,
    },
    {
      reason: "git trailers GitHub appends on squash follow the body as before",
      body: message("[fleet-sync]", PROSE, TRAILERS),
      expected: FLEET,
    },
    {
      reason: "a Conventional Commits footer in the body is prose",
      body: message("[fleet-sync: o/r]", PROSE, "BREAKING CHANGE: the asset is renamed"),
      expected: { kind: "fleet-sync", repos: ["o/r"] },
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
      body: message("[fleet-sync]", "See [fleet-sync] above."),
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
      body: message("[fleet-sync]\n`[fleet-sync: o/r]`", PROSE),
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
          '"[fleet-sync:]" has an empty scope: write [fleet-sync] for the whole fleet, or list owner/name slugs',
        ],
      },
    },
    {
      reason: "an empty list entry fails",
      body: message("[fleet-sync: o/r,]", PROSE),
      expected: {
        kind: "error",
        errors: ['"[fleet-sync: o/r,]" has an empty entry in its list'],
      },
    },
    {
      reason: "all mixed with slugs fails",
      body: message("[fleet-sync: all, o/r]", PROSE),
      expected: {
        kind: "error",
        errors: [
          '"[fleet-sync: all, o/r]" mixes "all" with slugs: write [fleet-sync] or the slugs alone',
        ],
      },
    },
    {
      reason: "non-slug entries fail, all of them named",
      body: message("[fleet-sync: o/r, just-a-name, o/r/extra]", PROSE),
      expected: {
        kind: "error",
        errors: [
          '"[fleet-sync: o/r, just-a-name, o/r/extra]" lists entries that are not owner/name slugs: just-a-name, o/r/extra',
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
          '"`[fleet-sync:]`" has an empty scope: write [fleet-sync] for the whole fleet, or list owner/name slugs',
        ],
      },
    },
  ])("$reason", ({ body, expected }) => {
    expect(parseDirectives(body)).toEqual(expected);
  });
});

describe("main", () => {
  const script = join(import.meta.dir, "../../.github/scripts/fleet/fleet_sync_marker.ts");
  const root = mkdtempSync(join(tmpdir(), "fleet-sync-marker-"));

  function git(args: string[]): string {
    const proc = boundedSpawnSync(["git", "-C", root, ...args]);
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
    return proc.stdout.trimEnd();
  }
  git(["init", "-q", "-b", "main"]);
  git([
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@x.test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "seed",
  ]);

  function commit(body: string): string {
    const file = join(root, `msg-${Bun.hash(body).toString(16)}.txt`);
    writeFileSync(file, body);
    git([
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@x.test",
      "commit",
      "-q",
      "--allow-empty",
      "-F",
      file,
    ]);
    return git(["rev-parse", "HEAD"]);
  }

  function run(sha: string): { exitCode: number; stdout: string; output: string } {
    const outputFile = join(root, `out-${sha}.txt`);
    writeFileSync(outputFile, "");
    const proc = boundedSpawnSync(["bun", script], {
      cwd: root,
      env: { ...process.env, SOURCE_SHA: sha, GITHUB_OUTPUT: outputFile },
    });
    return { ...proc, output: readFileSync(outputFile, "utf-8") };
  }

  test.each([
    {
      reason: "no block: armed=false and a notice",
      body: message(PROSE),
      exitCode: 0,
      output: "armed=false\n",
      stdout: "::notice::",
    },
    {
      reason: "whole fleet: armed=true, repos=all",
      body: message("`[fleet-sync]`", PROSE),
      exitCode: 0,
      output: "armed=true\nrepos=all\n",
      stdout: "syncing all now",
    },
    {
      reason: "a list: repos is the folded comma list",
      body: message("[fleet-sync: Vivswan/B, vivswan/a]", PROSE),
      exitCode: 0,
      output: "armed=true\nrepos=vivswan/b,vivswan/a\n",
      stdout: "syncing vivswan/b,vivswan/a now",
    },
    {
      reason: "a block at the bottom of the body: red leg, nothing armed",
      body: message(PROSE, "[fleet-sync]"),
      exitCode: 1,
      output: "",
      stdout: "::error::misplaced directive",
    },
  ])("$reason", ({ body, exitCode, output, stdout }) => {
    const result = run(commit(body));
    expect(result.exitCode).toBe(exitCode);
    expect(result.output).toBe(output);
    expect(result.stdout).toContain(stdout);
  });
});

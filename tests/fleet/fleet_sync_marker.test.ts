// The directives-block grammar post-green's read-directives leg reads
// off the merged commit, pinned as one table: each row is a whole commit
// message (subject included) and the FULL parse result, so the block
// detection, keyword grammar, scope folding, trailer tolerance, and every
// loud-failure path are each proven against the value, never a shape.
// The main() rows run the script against a real scratch repo and read
// the GITHUB_OUTPUT lines the sync-fleet leg consumes.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Directives, parseDirectives } from "../../.github/scripts/fleet/fleet_sync_marker.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const SUBJECT = "feat: ship the thing (#12)";
const PROSE = "## How\n\nThe thing ships.\n\n## Proof\n\n- bun run check green";

function message(...tail: string[]): string {
  return [SUBJECT, PROSE, ...tail].join("\n\n");
}

const NONE: Directives = { kind: "none" };
const FLEET: Directives = { kind: "fleet-sync", repos: [] };

describe("parseDirectives", () => {
  test.each<{ reason: string; body: string; expected: Directives }>([
    { reason: "a body without a block", body: message(), expected: NONE },
    { reason: "a bare subject", body: SUBJECT, expected: NONE },
    { reason: "an empty message", body: "", expected: NONE },
    {
      reason: "a bare [fleet-sync] arms the whole fleet",
      body: message("[fleet-sync]"),
      expected: FLEET,
    },
    {
      reason: "[fleet-sync: all] is the same as bare",
      body: message("[fleet-sync: all]"),
      expected: FLEET,
    },
    {
      reason: "a list is trimmed, folded, and deduped",
      body: message("[Fleet-Sync: Vivswan/A , vivswan/b,Vivswan/a]"),
      expected: { kind: "fleet-sync", repos: ["vivswan/a", "vivswan/b"] },
    },
    {
      reason: "no space after the colon",
      body: message("[fleet-sync:o/r]"),
      expected: { kind: "fleet-sync", repos: ["o/r"] },
    },
    {
      reason: "trailing whitespace, blank lines, and CRLF are tolerated",
      body: `${message("[fleet-sync]  ")}\r\n\r\n   \r\n`.replace(/\n/g, "\r\n"),
      expected: FLEET,
    },
    {
      reason: "git trailers GitHub appends on squash may follow the block",
      body: message("[fleet-sync]", "Co-authored-by: A <a@x.test>\nSigned-off-by: B <b@x.test>"),
      expected: FLEET,
    },
    {
      reason: "a Conventional Commits footer may follow the block too",
      body: message("[fleet-sync: o/r]", "BREAKING CHANGE: the asset is renamed"),
      expected: { kind: "fleet-sync", repos: ["o/r"] },
    },
    {
      reason: "a multi-line footer after the block is one footer paragraph",
      body: message(
        "[fleet-sync]",
        "BREAKING CHANGE: the asset is renamed\nold releases keep the old name\nCo-authored-by: A <a@x.test>",
      ),
      expected: FLEET,
    },
    {
      reason: "a footer above the block is prose, not part of it",
      body: message("BREAKING CHANGE: renamed", "[fleet-sync]"),
      expected: FLEET,
    },
    {
      reason: "a final paragraph that is a markdown link is not a block: misplaced",
      body: message("[fleet-sync](https://x.test)"),
      expected: {
        kind: "error",
        errors: [
          'misplaced directive "[fleet-sync](https://x.test)": directives go in the PR body\'s final paragraph, one [keyword] per line and nothing else in that paragraph',
        ],
      },
    },
    {
      reason: "a marker mid-body is misplaced even when the final paragraph is prose",
      body: message("Remember to add [fleet-sync] here.", "Closing thoughts."),
      expected: {
        kind: "error",
        errors: [
          'misplaced directive "Remember to add [fleet-sync] here.": directives go in the PR body\'s final paragraph, one [keyword] per line and nothing else in that paragraph',
        ],
      },
    },
    {
      reason: "a marker glued to the subject paragraph is misplaced (no blank line above)",
      body: `${SUBJECT}\n[fleet-sync]`,
      expected: {
        kind: "error",
        errors: [
          'misplaced directive "[fleet-sync]": directives go in the PR body\'s final paragraph, one [keyword] per line and nothing else in that paragraph',
        ],
      },
    },
    {
      reason: "a marker in prose AND a valid block: the misplaced one still fails",
      body: message("See [fleet-sync] below.", "[fleet-sync]"),
      expected: {
        kind: "error",
        errors: [
          'misplaced directive "See [fleet-sync] below.": directives go in the PR body\'s final paragraph, one [keyword] per line and nothing else in that paragraph',
        ],
      },
    },
    {
      reason: "a keyword typo outside the block is misplaced, not silently prose",
      body: message("Later: [fleet-syncs] maybe.", "Done."),
      expected: {
        kind: "error",
        errors: [
          'misplaced directive "Later: [fleet-syncs] maybe.": directives go in the PR body\'s final paragraph, one [keyword] per line and nothing else in that paragraph',
        ],
      },
    },
    {
      reason: "an unknown keyword fails, naming the known ones",
      body: message("[fleet-synk]"),
      expected: {
        kind: "error",
        errors: ['unknown directive keyword in "[fleet-synk]"; known: fleet-sync'],
      },
    },
    {
      reason: "a bracketed line that is not keyword-shaped fails",
      body: message("[skip ci]"),
      expected: {
        kind: "error",
        errors: ['"[skip ci]" is not a directive: write [keyword] or [keyword: value]'],
      },
    },
    {
      reason: "a duplicate keyword fails",
      body: message("[fleet-sync]\n[fleet-sync: o/r]"),
      expected: {
        kind: "error",
        errors: ["duplicate directive [fleet-sync]: one line per keyword"],
      },
    },
    {
      reason: "an empty scope fails",
      body: message("[fleet-sync:]"),
      expected: {
        kind: "error",
        errors: [
          '"[fleet-sync:]" has an empty scope: write [fleet-sync] for the whole fleet, or list owner/name slugs',
        ],
      },
    },
    {
      reason: "an empty list entry fails",
      body: message("[fleet-sync: o/r,]"),
      expected: {
        kind: "error",
        errors: ['"[fleet-sync: o/r,]" has an empty entry in its list'],
      },
    },
    {
      reason: "all mixed with slugs fails",
      body: message("[fleet-sync: all, o/r]"),
      expected: {
        kind: "error",
        errors: [
          '"[fleet-sync: all, o/r]" mixes "all" with slugs: write [fleet-sync] or the slugs alone',
        ],
      },
    },
    {
      reason: "non-slug entries fail, all of them named",
      body: message("[fleet-sync: o/r, just-a-name, o/r/extra]"),
      expected: {
        kind: "error",
        errors: [
          '"[fleet-sync: o/r, just-a-name, o/r/extra]" lists entries that are not owner/name slugs: just-a-name, o/r/extra',
        ],
      },
    },
    {
      reason: "every problem in a block is reported at once",
      body: message("[fleet-synk]\n[fleet-sync:]"),
      expected: {
        kind: "error",
        errors: [
          'unknown directive keyword in "[fleet-synk]"; known: fleet-sync',
          '"[fleet-sync:]" has an empty scope: write [fleet-sync] for the whole fleet, or list owner/name slugs',
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
      body: message(),
      exitCode: 0,
      output: "armed=false\n",
      stdout: "::notice::",
    },
    {
      reason: "whole fleet: armed=true, repos=all",
      body: message("[fleet-sync]"),
      exitCode: 0,
      output: "armed=true\nrepos=all\n",
      stdout: "syncing all now",
    },
    {
      reason: "a list: repos is the folded comma list",
      body: message("[fleet-sync: Vivswan/B, vivswan/a]"),
      exitCode: 0,
      output: "armed=true\nrepos=vivswan/b,vivswan/a\n",
      stdout: "syncing vivswan/b,vivswan/a now",
    },
    {
      reason: "a misplaced marker: red leg, nothing armed",
      body: message("Add [fleet-sync] later.", "Done."),
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

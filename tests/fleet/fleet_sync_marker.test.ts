// The directives-block grammar read-directives reads off each merged
// commit, as one table of whole commit messages and FULL parse results.
// The main() rows run the script on scratch clones and assert the whole
// outcome: exit code, GITHUB_OUTPUT, and every log line - the range walk
// from the last published build (the coalesced-merge case that motivates
// it, with the old single-commit read as the control), the union rule,
// and a red body anywhere in the range.

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
        errors: ['"[fleet-sync: `o/r`, o/s]" lists entries that are not owner/name slugs: `o/r`'],
      },
    },
    {
      reason: "a marker inside a fenced code block is misplaced, never prose",
      body: message(PROSE, "```text\n[fleet-sync]\n```"),
      expected: misplaced("[fleet-sync]"),
    },
    {
      reason: "a valid block AND a backticked marker in a fenced example: the fenced one fails",
      body: message("[fleet-sync]", PROSE, "```text\n`[fleet-sync: o/r]`\n```"),
      expected: misplaced("`[fleet-sync: o/r]`"),
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
  const listBC = commit(message("[fleet-sync: Vivswan/b, vivswan/c]", PROSE));
  const whole = commit(message("`[fleet-sync]`", PROSE));
  const bottom = commit(message(PROSE, "[fleet-sync]"));
  const prose3 = commit(message(PROSE));

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
  const publishedListBC = cloneWithBuild("published-list-bc", listBC);

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
      reason: "two directives with different repo lists: the union, in commit order",
      cwd: publishedSeed,
      sha: listBC,
      output: "armed=true\nrepos=vivswan/a,vivswan/b,vivswan/c\n",
      stdout: lines(
        directive(listA, "vivswan/a"),
        directive(listBC, "vivswan/b,vivswan/c"),
        syncing(seed, listBC, "vivswan/a,vivswan/b,vivswan/c"),
      ),
    },
    {
      reason: "a whole-fleet directive beside a list: all wins",
      cwd: publishedProse2,
      sha: whole,
      output: "armed=true\nrepos=all\n",
      stdout: lines(
        directive(listBC, "vivswan/b,vivswan/c"),
        directive(whole, "all"),
        syncing(prose2, whole, "all"),
      ),
    },
  ])("$reason", ({ cwd, sha, output, stdout }) => {
    const result = run(cwd, sha, git(cwd, ["rev-parse", `${sha}~1`]));
    expect(result).toEqual({ exitCode: 0, output, stdout, stderr: "" });
  });

  test("a misplaced block on any commit in the range turns the leg red, naming that commit; nothing is armed", () => {
    const result = run(publishedListBC, prose3, bottom);
    expect(result).toEqual({
      exitCode: 1,
      output: "",
      stdout: lines(
        directive(whole, "all"),
        `::error::${short(bottom)}: misplaced directive "[fleet-sync]": ${POSITION}`,
      ),
      stderr: "",
    });
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
      reason: "whole fleet: armed=true, repos=all",
      sha: whole,
      exitCode: 0,
      output: "armed=true\nrepos=all\n",
      stdout: (base: string, sha: string) =>
        lines(pushAlone(sha, base), directive(sha, "all"), syncing(base, sha, "all")),
    },
    {
      reason: "a list: repos is the folded comma list",
      sha: listBC,
      exitCode: 0,
      output: "armed=true\nrepos=vivswan/b,vivswan/c\n",
      stdout: (base: string, sha: string) =>
        lines(
          pushAlone(sha, base),
          directive(sha, "vivswan/b,vivswan/c"),
          syncing(base, sha, "vivswan/b,vivswan/c"),
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

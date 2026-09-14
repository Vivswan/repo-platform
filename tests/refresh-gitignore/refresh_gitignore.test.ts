import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Bump,
  bump,
  headSha,
  prBody,
  proseBumps,
  repin,
  upstreams,
} from "../../.github/scripts/refresh-gitignore/refresh_gitignore.ts";
import { parseFilesConfig } from "../../actions/plan/files_config.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const FILES_YML = readFileSync(join(REPO_ROOT, "files.yml"), "utf-8");
const OLD = "0123456789abcdef0123456789abcdef01234567";
const NEW = "89abcdef0123456789abcdef0123456789abcdef";
const registry = {
  repository: "github/gitignore",
  sha: OLD,
  always: ["Linux"],
  paths: { Linux: "Global/Linux.gitignore", Node: "Node.gitignore", Alias: "Node.gitignore" },
};

describe("the pin", () => {
  test("files.yml registers one upstream, and repin rewrites exactly that spelling", () => {
    const [registered, ...rest] = upstreams(parseFilesConfig(FILES_YML).files);
    expect(rest).toEqual([]);
    expect(registered.repository).toBe("github/gitignore");
    const moved = repin(FILES_YML, registered.sha, NEW);
    expect(moved.split(`sha: ${NEW}`).length - 1).toBe(1);
    expect(moved.replace(`sha: ${NEW}`, `sha: ${registered.sha}`)).toBe(FILES_YML);
    expect(parseFilesConfig(moved).files).toBeDefined();
  });

  test.each([
    [
      "a sha the file does not spell",
      `sha: ${OLD}\n`,
      NEW,
      "spells 'sha: 89abcdef0123456789abcdef0123456789abcdef' 0 times",
    ],
    ["a sha spelled twice", `sha: ${OLD}\nsha: ${OLD}\n`, OLD, "2 times, expected once"],
  ])("%s is refused, so a copy never drifts from the pin", (_case, text, from, message) => {
    expect(() => repin(text, from, NEW)).toThrow(message);
  });

  test("headSha reads the default branch head and refuses a reply without a full sha", async () => {
    const calls: [string, Record<string, string> | undefined][] = [];
    const answer = (body: string) => async (url: string, headers?: Record<string, string>) => {
      calls.push([url, headers]);
      return body;
    };
    expect(await headSha("github/gitignore", answer(`{"sha": "${NEW}"}`))).toBe(NEW);
    expect(calls[0][0]).toBe("https://api.github.com/repos/github/gitignore/commits/HEAD");
    expect(calls[0][1]?.accept).toBe("application/vnd.github+json");
    await expect(headSha("github/gitignore", answer('{"sha": "abc"}'))).rejects.toThrow(
      "github/gitignore: the commits/HEAD reply carries no full sha",
    );
  });
});

describe("the bump", () => {
  const upstreamText: Record<string, string> = {
    [`h/github/gitignore/${OLD}/Global/Linux.gitignore`]: "*~\r\n",
    [`h/github/gitignore/${NEW}/Global/Linux.gitignore`]: "*~\n",
    [`h/github/gitignore/${OLD}/Node.gitignore`]: "node_modules/\n",
    [`h/github/gitignore/${NEW}/Node.gitignore`]: "node_modules/\n.bun/\n",
  };
  const fetched: string[] = [];
  const fetch = async (url: string) => {
    fetched.push(url);
    const text = upstreamText[url];
    if (text === undefined) throw new Error(`GET ${url} failed: HTTP 404`);
    return text;
  };

  test("diffs each registered path once between the two commits as the writer renders it; a path whose normalized body did not move is absent", async () => {
    const moved = await bump(registry, NEW, "h", fetch);
    expect(fetched).toEqual([
      `h/github/gitignore/${OLD}/Global/Linux.gitignore`,
      `h/github/gitignore/${NEW}/Global/Linux.gitignore`,
      `h/github/gitignore/${OLD}/Node.gitignore`,
      `h/github/gitignore/${NEW}/Node.gitignore`,
    ]);
    expect(moved).toEqual({
      repository: "github/gitignore",
      from: OLD,
      to: NEW,
      diffs: new Map([
        ["Node.gitignore", "--- Node.gitignore\n+++ Node.gitignore\n@@\n node_modules/\n+.bun/"],
      ]),
    });
  });

  test("the subject names each repository and short sha; the body carries every diff, or says the pin alone moved", () => {
    const moved: Bump = {
      repository: "github/gitignore",
      from: OLD,
      to: NEW,
      diffs: new Map([
        ["Node.gitignore", "--- Node.gitignore\n+++ Node.gitignore\n@@\n node_modules/\n+.bun/"],
      ]),
    };
    expect(proseBumps([moved])).toBe("github/gitignore to 89abcde");
    expect(proseBumps([])).toBe("");
    expect(prBody([moved])).toBe(
      [
        "## github/gitignore: `0123456` -> `89abcde`",
        "",
        "### Node.gitignore",
        "",
        "````diff",
        "--- Node.gitignore",
        "+++ Node.gitignore",
        "@@",
        " node_modules/",
        "+.bun/",
        "````",
        "",
        "The next sync renders these blocks into every repository's `.gitignore` region, one sync PR per repository (auto-merged when clean). Merging this moves the stable tag once green.",
      ].join("\n"),
    );
    expect(prBody([{ ...moved, diffs: new Map() }])).toContain(
      "No registered block changed between the two commits; the pin moves so the next refresh diffs from here.",
    );
  });
});

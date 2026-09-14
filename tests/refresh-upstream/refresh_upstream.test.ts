import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Bump,
  bump,
  headSha,
  pins,
  prBody,
  proseBumps,
  repin,
} from "../../.github/scripts/refresh-upstream/refresh_upstream.ts";
import { parseFilesConfig, upstreamRefs } from "../../actions/plan/files_config.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const FILES_YML = readFileSync(join(REPO_ROOT, "files.yml"), "utf-8");
const OLD = "0123456789abcdef0123456789abcdef01234567";
const NEW = "89abcdef0123456789abcdef0123456789abcdef";
const ref = (repository: string, sha: string, path: string) => ({ repository, sha, path });

describe("the pins", () => {
  test("every ref files.yml carries is pinned to a full sha, and repin moves each pin's every spelling", () => {
    const refs = upstreamRefs(parseFilesConfig(FILES_YML).files);
    expect(refs.length).toBeGreaterThan(0);
    for (const pin of pins(refs)) {
      expect(pin.sha).toMatch(/^[0-9a-f]{40}$/);
      const moved = repin(FILES_YML, pin, NEW);
      expect(moved).not.toContain(pin.sha);
      expect(moved.replaceAll(NEW, pin.sha)).toBe(FILES_YML);
      expect(pins(upstreamRefs(parseFilesConfig(moved).files))).toContainEqual({
        ...pin,
        sha: NEW,
      });
    }
  });

  test("one pin per repository and sha, its paths sorted and named once, whether spelled by a source or a block", () => {
    expect(
      pins([
        ref("o/a", OLD, "z.md"),
        ref("o/a", OLD, "b/x.md"),
        ref("o/a", NEW, "z.md"),
        ref("o/b", OLD, "z.md"),
        ref("o/a", OLD, "z.md"),
      ]),
    ).toEqual([
      { repository: "o/a", sha: OLD, paths: ["b/x.md", "z.md"] },
      { repository: "o/a", sha: NEW, paths: ["z.md"] },
      { repository: "o/b", sha: OLD, paths: ["z.md"] },
    ]);
  });

  test("every spelling of one pin moves, quoted or not, flow or block; another repository at the same sha and a pin the file lacks do not", () => {
    const text = [
      "files:",
      `  - {path: a.md, class: managed, source: {repository: o/a, sha: "${OLD}", path: a.md}}`,
      "  - path: .gitignore",
      "    upstream:",
      "      repository: o/a",
      `      sha: ${OLD}`,
      "      paths: {X: x}",
      `  - {path: b.md, class: managed, source: {repository: o/b, sha: ${OLD}, path: b.md}}`,
      "",
    ].join("\n");
    expect(repin(text, { repository: "o/a", sha: OLD }, NEW)).toBe(
      text.replace(`"${OLD}"`, NEW).replace(`sha: ${OLD}\n      paths`, `sha: ${NEW}\n      paths`),
    );
    expect(() => repin(text, { repository: "o/c", sha: OLD }, NEW)).toThrow(
      `files.yml names no pin o/c@${OLD}`,
    );
  });

  test("headSha reads the default branch head and refuses a reply without a full sha", async () => {
    const calls: [string, Record<string, string> | undefined][] = [];
    const answer = (body: string) => async (url: string, headers?: Record<string, string>) => {
      calls.push([url, headers]);
      return body;
    };
    expect(await headSha("o/a", answer(`{"sha": "${NEW}"}`))).toBe(NEW);
    expect(calls[0][0]).toBe("https://api.github.com/repos/o/a/commits/HEAD");
    expect(calls[0][1]?.accept).toBe("application/vnd.github+json");
    await expect(headSha("o/a", answer('{"sha": "abc"}'))).rejects.toThrow(
      "o/a: the commits/HEAD reply carries no full sha",
    );
  });
});

describe("the bump", () => {
  const upstreamText: Record<string, string> = {
    [`h/o/a/${OLD}/Global/Linux.gitignore`]: "*~\r\n",
    [`h/o/a/${NEW}/Global/Linux.gitignore`]: "*~\n",
    [`h/o/a/${OLD}/Node.gitignore`]: "node_modules/\n",
    [`h/o/a/${NEW}/Node.gitignore`]: "node_modules/\n.bun/\n",
  };
  const fetched: string[] = [];
  const fetch = async (url: string) => {
    fetched.push(url);
    const text = upstreamText[url];
    if (text === undefined) throw new Error(`GET ${url} failed: HTTP 404`);
    return text;
  };

  test("diffs each path once between the two commits as the writer fetches it; a path whose normalized body did not move is absent", async () => {
    const pin = {
      repository: "o/a",
      sha: OLD,
      paths: ["Global/Linux.gitignore", "Node.gitignore"],
    };
    const moved = await bump(pin, NEW, "h", fetch);
    expect(fetched).toEqual([
      `h/o/a/${OLD}/Global/Linux.gitignore`,
      `h/o/a/${OLD}/Node.gitignore`,
      `h/o/a/${NEW}/Global/Linux.gitignore`,
      `h/o/a/${NEW}/Node.gitignore`,
    ]);
    expect(moved).toEqual({
      repository: "o/a",
      from: OLD,
      to: NEW,
      diffs: new Map([
        ["Node.gitignore", "--- Node.gitignore\n+++ Node.gitignore\n@@\n node_modules/\n+.bun/"],
      ]),
    });
  });

  test("the subject names each repository and short sha; the body carries every diff, or says the pin alone moved", () => {
    const moved: Bump = {
      repository: "o/a",
      from: OLD,
      to: NEW,
      diffs: new Map([
        ["Node.gitignore", "--- Node.gitignore\n+++ Node.gitignore\n@@\n node_modules/\n+.bun/"],
      ]),
    };
    expect(proseBumps([moved])).toBe("o/a to 89abcde");
    expect(proseBumps([])).toBe("");
    expect(prBody([moved])).toBe(
      [
        "## o/a: `0123456` -> `89abcde`",
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
        "The next sync renders these files wherever files.yml names them as a source or a block, one sync PR per repository whose rendered bytes moved (auto-merged when clean). Merging this moves the stable tag once green.",
      ].join("\n"),
    );
    expect(prBody([{ ...moved, diffs: new Map() }])).toContain(
      "No fetched file changed between the two commits; the pin moves so the next refresh diffs from here.",
    );
  });
});

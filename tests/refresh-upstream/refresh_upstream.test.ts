import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type Bump,
  decideBump,
  headSha,
  pinnedVersion,
  pins,
  prBody,
  proseBumps,
  refresh,
  repin,
  tagVersion,
  typesBunDirs,
} from "../../.github/scripts/refresh-upstream/refresh_upstream.ts";
import { GitHubClient } from "../../.github/scripts/shared/github.ts";
import { parseFilesConfig, upstreamRefs } from "../../actions/plan/files_config.ts";
import { type FakeReply, type FakeRoutes, fakeGithub } from "../shared/fake_github";
import { tempDirs } from "../shared/temp_dir";

const REPO_ROOT = join(import.meta.dir, "../..");
const FILES_YML = readFileSync(join(REPO_ROOT, "files.yml"), "utf-8");
const OLD = "0123456789abcdef0123456789abcdef01234567";
const NEW = "89abcdef0123456789abcdef0123456789abcdef";

function apiOver(routes: FakeRoutes) {
  const api = fakeGithub(routes);
  const github = new GitHubClient({
    token: "stub-token",
    baseUrl: "https://api.github.test",
    fetch: api.fetch,
    retryBaseMs: 0,
  });
  return { api, github };
}

const ref = (repository: string, sha: string, path: string) => ({ repository, sha, path });
const temp = tempDirs();

describe("the commit pins", () => {
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
      "    sources:",
      "      X:",
      "        repository: o/a",
      `        sha: ${OLD}`,
      "        path: x",
      `  - {path: b.md, class: managed, source: {repository: o/b, sha: ${OLD}, path: b.md}}`,
      "",
    ].join("\n");
    expect(repin(text, { repository: "o/a", sha: OLD }, NEW)).toBe(
      text
        .replace(`"${OLD}"`, NEW)
        .replace(`sha: ${OLD}\n        path`, `sha: ${NEW}\n        path`),
    );
    expect(() => repin(text, { repository: "o/c", sha: OLD }, NEW)).toThrow(
      `files.yml names no pin o/c@${OLD}`,
    );
  });

  // The sha lands in files.yml and in every fetch URL of the next sync; the failure line is the run's public annotation.
  test.each<[string, FakeReply, string]>([
    ["a full sha", { status: 200, body: { sha: NEW } }, NEW],
    [
      "a short sha",
      { status: 200, body: { sha: "abc" } },
      "o/a: commits/HEAD could not be read (the reply: unexpected shape - sha: invalid_format)",
    ],
    [
      "a body that is not JSON",
      { status: 200, body: '{"sha": corrupt}' },
      "o/a: commits/HEAD could not be read (the reply: unexpected shape - (root): invalid_type)",
    ],
  ])("headSha reads the default branch head: %s", async (_name, reply, expected) => {
    const { github } = apiOver({ "repos/o/a/commits/HEAD": [reply] });

    const outcome = await headSha("o/a", github).catch((error: Error) => error.message);

    expect(outcome).toBe(expected);
  });
});

describe("the release pins", () => {
  // Numeric, never lexicographic. A downgrade is never applied and never reads as "current": GitHub's date-ordered
  // /releases/latest can surface a backport on an older line, and a run that saw one aborts rather than let the PR
  // step close a valid refresh PR as caught up.
  const ABORTS = "aborts";
  test.each([
    ["1.3.14", "1.3.14", "current", "equal is a no-op"],
    ["1.3.14", "1.3.15", "bump", "patch ahead"],
    ["2.9.5", "3.0.0", "bump", "major line jump"],
    ["1.9.0", "1.10.0", "bump", "minor 10 > 9 numerically (lexicographic says 1.10 < 1.9)"],
    ["9.99.99", "10.0.0", "bump", "major 10 > 9 numerically (lexicographic says 10 < 9)"],
    ["1.3.15", "1.2.22", ABORTS, "backport on an older line surfaces as date-ordered latest"],
    ["2.0.0", "1.99.99", ABORTS, "major below the pin"],
    ["1.10.0", "1.9.9", ABORTS, "minor 9 < 10 numerically (lexicographic says 1.9 > 1.10)"],
  ] as const)("pin %s, fetched %s -> %s (%s)", (pinned, fetched, verdict) => {
    if (verdict === ABORTS) {
      expect(() => decideBump(pinned, fetched, "bun")).toThrow(
        `bun: upstream latest ${fetched} is OLDER than the pinned ${pinned} (a backport release surfacing as latest?)`,
      );
    } else {
      expect(decideBump(pinned, fetched, "bun")).toBe(verdict);
    }
  });

  // Anchored and escaped: an unanchored match would pin a canary or a foreign tag silently, and a template character
  // read as a regex operator would let a tag of another shape through.
  test.each<{ template: string; tag: unknown; outcome: string | { throws: string } }>([
    { template: "bun-v{version}", tag: "bun-v1.3.14", outcome: "1.3.14" },
    {
      template: "bun-v{version}",
      tag: "bun-v1.3.14-canary.1",
      outcome: { throws: "does not match" },
    },
    { template: "bun-v{version}", tag: "v1.3.14", outcome: { throws: "does not match" } },
    { template: "bun-v{version}", tag: undefined, outcome: { throws: "expected a string" } },
    { template: "v{version}", tag: "v2.9.5", outcome: "2.9.5" },
    { template: "v{version}", tag: "v2.9.5-rc.1", outcome: { throws: "does not match" } },
    { template: "release.{version}", tag: "release.1.0.0", outcome: "1.0.0" },
    { template: "release.{version}", tag: "releasex1.0.0", outcome: { throws: "does not match" } },
  ])("$template reads $tag -> $outcome", ({ template, tag, outcome }) => {
    if (typeof outcome === "string") expect(tagVersion(tag, template, "o/a")).toBe(outcome);
    else expect(() => tagVersion(tag, template, "o/a")).toThrow(outcome.throws);
  });

  // The dotfile is what the setup actions' version-file inputs read verbatim, so every other shape is refused here rather than ordered.
  test.each([
    ["2.9.5", "no trailing newline"],
    ["1.4.0-canary.1\n", "a prerelease"],
    ["v1.4.0\n", "a tag prefix"],
    ["1.4.0\n\n", "a second newline"],
    ["", "an empty file"],
  ])("'%s' throws, naming the file (%s)", (text) => {
    expect(() => pinnedVersion(text, "files/bun/.bun-version")).toThrow(
      "files/bun/.bun-version: '",
    );
  });

  test("typesBunDirs: every lock-carrying package declaring @types/bun as a dev dependency; the rest are not bumped", () => {
    const root = temp.dir("types-bun-dirs-");
    const plant = (dir: string, pkg: Record<string, unknown>, lock = true) => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), JSON.stringify(pkg));
      if (lock) writeFileSync(join(root, dir, "bun.lock"), "");
    };
    plant(".", { devDependencies: { "@types/bun": "0.0.0" } });
    plant("actions/dev", { devDependencies: { "@types/bun": "0.0.0" } });
    plant("actions/plain", { devDependencies: { typescript: "^7" } });
    plant("actions/unlocked", { devDependencies: { "@types/bun": "0.0.0" } }, false);
    expect(typesBunDirs(root)).toEqual([".", "actions/dev"]);
    // The bump runs `bun add --dev`, which would leave a second declaration behind.
    plant("actions/prod", { dependencies: { "@types/bun": "0.0.0" } });
    expect(() => typesBunDirs(root)).toThrow(
      "actions/prod/package.json: @types/bun belongs under devDependencies",
    );
  });

  test("each module pin's file is a version dotfile files.yml delivers, managed, to the repositories selecting the module", () => {
    const config = parseFilesConfig(FILES_YML);
    const pinned = Object.entries(config.modules).flatMap(([module, data]) =>
      data.pin === undefined ? [] : [[module, data.pin.file] as const],
    );
    expect(pinned.length).toBeGreaterThan(0);
    const delivery = pinned.map(([module, file]) => {
      pinnedVersion(readFileSync(join(REPO_ROOT, file), "utf-8"), file);
      const entry = config.files.find((candidate) => candidate.path === basename(file));
      return [
        module,
        entry === undefined
          ? undefined
          : {
              class: entry.class,
              source: "source" in entry ? entry.source : undefined,
              when: entry.when,
            },
      ];
    });
    expect(delivery).toEqual(
      pinned.map(([module, file]) => [
        module,
        { class: "managed", source: file.replace(/^files\//, ""), when: { modules: [module] } },
      ]),
    );
  });

  // Typecheck passes silently under mismatched types; the one refresh writes both.
  test("the committed @types/bun pins equal the bun runtime pin, the shape one refresh writes", () => {
    const version = pinnedVersion(
      readFileSync(join(REPO_ROOT, "files/bun/.bun-version"), "utf-8"),
      "bun",
    );
    const declared = typesBunDirs(REPO_ROOT).map((dir) => {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf-8")) as {
        devDependencies: Record<string, string>;
      };
      return [dir, pkg.devDependencies["@types/bun"]];
    });
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toEqual(declared.map(([dir]) => [dir, version]));
  });
});

describe("the refresh", () => {
  const CONFIG = [
    "placeholders: []",
    "modules:",
    "  bun:",
    "    gitignore_sources: [Node]",
    "    pin:",
    "      file: files/bun/.bun-version",
    "      repository: oven-sh/bun",
    "      tag: bun-v{version}",
    "  uv:",
    "    pin:",
    "      file: files/uv/.uv-version",
    "      repository: astral-sh/uv",
    "      tag: v{version}",
    "files:",
    "  - path: .gitignore",
    "    class: split",
    "    region: hash",
    "    blocks: gitignore_sources",
    "    always: [Linux]",
    "    sources:",
    `      Linux: {repository: o/a, sha: ${OLD}, path: Global/Linux.gitignore}`,
    `      Node: {repository: o/a, sha: ${OLD}, path: Node.gitignore}`,
    "",
  ].join("\n");
  const DOTFILES = { "files/bun/.bun-version": "1.4.0\n", "files/uv/.uv-version": "2.9.5\n" };
  const NODE_DIFF =
    "--- Node.gitignore\n+++ Node.gitignore\n@@ -1,1 +1,2 @@\n node_modules/\n+.bun/";

  const plant = () => {
    const root = temp.dir("refresh-upstream-");
    // The @types/bun hook walks actions/ for lockfiles, as in the repository; none here, so no `bun add` runs.
    mkdirSync(join(root, "actions"));
    for (const [path, text] of [["files.yml", CONFIG], ...Object.entries(DOTFILES)]) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  /** The raw-content host by URL and the API by path; `fetched` is every read of either, in order. */
  const upstream = (raw: Record<string, string>, routes: FakeRoutes) => {
    const fetched: string[] = [];
    const fetch = async (url: string) => {
      fetched.push(url);
      const text = raw[url];
      if (text === undefined) throw new Error(`GET ${url} failed: HTTP 503`);
      return text;
    };
    const api = fakeGithub(routes);
    const github = new GitHubClient({
      token: "stub-token",
      baseUrl: "https://api.github.test",
      retryBaseMs: 0,
      fetch: ((input: string, init?: RequestInit) => {
        fetched.push(new URL(input).pathname.slice(1));
        return api.fetch(input, init);
      }) as typeof globalThis.fetch,
    });
    return { fetched, fetch, github };
  };
  const answers: Record<string, string> = {
    [`h/o/a/${OLD}/Global/Linux.gitignore`]: "*~\r\n",
    [`h/o/a/${NEW}/Global/Linux.gitignore`]: "*~\n",
    [`h/o/a/${OLD}/Node.gitignore`]: "node_modules/\n",
    [`h/o/a/${NEW}/Node.gitignore`]: "node_modules/\n.bun/\n",
  };
  const HEAD = "repos/o/a/commits/HEAD";
  const BUN_LATEST = "repos/oven-sh/bun/releases/latest";
  const UV_LATEST = "repos/astral-sh/uv/releases/latest";
  const routes: FakeRoutes = {
    [HEAD]: [{ status: 200, body: { sha: NEW } }],
    [BUN_LATEST]: [{ status: 200, body: { tag_name: "bun-v1.4.1" } }],
    [UV_LATEST]: [{ status: 200, body: { tag_name: "v3.0.0" } }],
  };

  const rows: {
    kind: "commit" | "release";
    fetched: string[];
    bumps: Bump[];
    written: Record<string, string>;
    prose: string;
    body: string;
  }[] = [
    {
      kind: "commit",
      fetched: [
        HEAD,
        `h/o/a/${OLD}/Global/Linux.gitignore`,
        `h/o/a/${OLD}/Node.gitignore`,
        `h/o/a/${NEW}/Global/Linux.gitignore`,
        `h/o/a/${NEW}/Node.gitignore`,
      ],
      bumps: [
        {
          kind: "commit",
          name: "o/a",
          from: OLD,
          to: NEW,
          diffs: new Map([["Node.gitignore", NODE_DIFF]]),
        },
      ],
      written: { ...DOTFILES, "files.yml": CONFIG.replaceAll(OLD, NEW) },
      prose: "o/a to 89abcde",
      body: [
        "## o/a: `0123456` -> `89abcde`",
        "",
        "### Node.gitignore",
        "",
        "````diff",
        NODE_DIFF,
        "````",
        "",
        "The next sync renders these files wherever files.yml names them as a source or a block, one sync PR per repository whose rendered bytes moved (auto-merged when clean). Merging this moves the stable tag once green.",
      ].join("\n"),
    },
    {
      kind: "release",
      fetched: [BUN_LATEST, UV_LATEST],
      bumps: [
        { kind: "release", name: "bun", from: "1.4.0", to: "1.4.1" },
        { kind: "release", name: "uv", from: "2.9.5", to: "3.0.0" },
      ],
      written: {
        "files.yml": CONFIG,
        "files/bun/.bun-version": "1.4.1\n",
        "files/uv/.uv-version": "3.0.0\n",
      },
      prose: "bun to 1.4.1 and uv to 3.0.0",
      body: [
        "**MAJOR VERSION JUMP: uv 2 -> 3 - review before merging.**",
        "",
        "## bun: `1.4.0` -> `1.4.1`",
        "",
        "## uv: `2.9.5` -> `3.0.0`",
        "",
        "The next sync writes each dotfile to every repository selecting its module (docs/toolchains.md). Merging this moves the stable tag once green.",
      ].join("\n"),
    },
  ];

  test.each(rows)(
    "$kind pins: their files move, the others stay; one fetch per upstream; the PR words the kind",
    async (row) => {
      const root = plant();
      const { fetched, fetch, github } = upstream(answers, routes);
      const bumps = await refresh({ kind: row.kind, root, host: "h", fetch, github });
      expect(bumps).toEqual(row.bumps);
      expect(fetched).toEqual(row.fetched);
      const tree = Object.fromEntries(
        Object.keys(row.written).map((path) => [path, readFileSync(join(root, path), "utf-8")]),
      );
      expect(tree).toEqual(row.written);
      expect(proseBumps(bumps)).toBe(row.prose);
      expect(prBody(row.kind, bumps)).toBe(row.body);
    },
  );

  test("a pin already at upstream is reported current and nothing is written", async () => {
    const root = plant();
    const current = upstream(answers, {
      [HEAD]: [{ status: 200, body: { sha: OLD } }],
      [BUN_LATEST]: [{ status: 200, body: { tag_name: "bun-v1.4.0" } }],
      [UV_LATEST]: [{ status: 200, body: { tag_name: "v2.9.5" } }],
    });
    expect(await refresh({ kind: "commit", root, host: "h", ...current })).toEqual([]);
    expect(await refresh({ kind: "release", root, host: "h", ...current })).toEqual([]);
    expect(current.fetched).toEqual([HEAD, BUN_LATEST, UV_LATEST]);
    expect(readFileSync(join(root, "files.yml"), "utf-8")).toBe(CONFIG);
    expect(proseBumps([])).toBe("");
  });

  // Upstream's HEAD moved on paths files.yml does not fetch (Linux differs by CRLF alone, which the writer's normalization
  // drops): a bump of that pin would render the same bytes everywhere, so the pin stays and no PR opens for it.
  test("a commit pin whose fetched files are unchanged at upstream's new HEAD stays, after every file was compared", async () => {
    const root = plant();
    const same = upstream(
      { ...answers, [`h/o/a/${NEW}/Node.gitignore`]: "node_modules/\n" },
      routes,
    );
    expect(await refresh({ kind: "commit", root, host: "h", ...same })).toEqual([]);
    expect(same.fetched).toEqual([
      HEAD,
      `h/o/a/${OLD}/Global/Linux.gitignore`,
      `h/o/a/${OLD}/Node.gitignore`,
      `h/o/a/${NEW}/Global/Linux.gitignore`,
      `h/o/a/${NEW}/Node.gitignore`,
    ]);
    expect(readFileSync(join(root, "files.yml"), "utf-8")).toBe(CONFIG);
  });

  // A run that cannot see one upstream cannot tell "nothing moved" from "could not look", and an empty bumps output
  // lets the workflow's PR step close a still-valid refresh PR as caught up: every upstream answers, or nothing moves.
  test.each([
    ["commit", HEAD, "o/a: commits/HEAD could not be read (HTTP 503)"],
    ["release", UV_LATEST, "astral-sh/uv: releases/latest could not be read (HTTP 503)"],
  ] as const)(
    "%s pins: one unreachable upstream aborts the run before any pin moves",
    async (kind, failing, message) => {
      const root = plant();
      const down = upstream(answers, { ...routes, [failing]: [{ status: 503 }] });
      await expect(refresh({ kind, root, host: "h", ...down })).rejects.toThrow(message);
      expect(readFileSync(join(root, "files.yml"), "utf-8")).toBe(CONFIG);
      expect(readFileSync(join(root, "files/bun/.bun-version"), "utf-8")).toBe("1.4.0\n");
    },
  );

  // Named incident: one 502 from releases/latest failed the weekly refresh, which had no second attempt.
  test("a 502 followed by a 200 still moves the pin", async () => {
    const root = plant();
    const flaky = upstream(answers, {
      ...routes,
      [UV_LATEST]: [{ status: 502 }, { status: 200, body: { tag_name: "v3.0.0" } }],
    });
    const bumps = await refresh({ kind: "release", root, host: "h", ...flaky });
    expect(bumps.map((bump) => `${bump.name} ${bump.to}`)).toEqual(["bun 1.4.1", "uv 3.0.0"]);
    expect(flaky.fetched).toEqual([BUN_LATEST, UV_LATEST, UV_LATEST]);
  });
});

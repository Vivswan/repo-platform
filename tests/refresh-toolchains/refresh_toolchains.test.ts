import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Bump,
  decideBump,
  fetchJson,
  latestBunVersion,
  latestDenoVersion,
  latestVersions,
  PIN_SOURCES,
  pinnedVersion,
  prBody,
  proseBumps,
  typesBunDirs,
} from "../../.github/scripts/refresh-toolchains/refresh_toolchains";
import { parseFilesConfig } from "../../actions/plan/files_config";
import { tempDirs } from "../shared/temp_dir";

const REPO_ROOT = join(import.meta.dir, "../..");
const temp = tempDirs();

describe("fetchJson", () => {
  test("a malformed body rejects with the fixed diagnostic, never the body", async () => {
    // Loopback server, no upstream network (hostname pinned: the default
    // 0.0.0.0 listener collides in sandboxed runs). The rejection message
    // is the run's public failure line, and runtimes differ on whether
    // their JSON error text embeds the body - so the fixed-string
    // guarantee must hold regardless of what the runtime would say.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response('{"tag_name": corruptbody}'),
    });
    try {
      const url = `http://127.0.0.1:${server.port}/releases/latest`;
      let message = "";
      try {
        await fetchJson(url);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // Exact equality, not substrings: any appended runtime text would
      // reopen the leak this pins closed.
      expect(message).toBe(`GET ${url} returned a body that is not valid JSON`);
    } finally {
      server.stop(true);
    }
  });

  test("a pre-response failure rejects with the fixed diagnostic, never runtime text", async () => {
    // https against a plaintext listener: the TLS handshake fails before
    // any response exists - the rejection path whose message is
    // runtime-generated and must not pass through. The port stays bound
    // to this test's own server throughout, so there is no reuse race.
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    try {
      const url = `https://127.0.0.1:${server.port}/releases/latest`;
      let message = "";
      try {
        await fetchJson(url);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // Exact equality, not substrings: any appended runtime text would
      // reopen the leak this pins closed.
      expect(message).toBe(`GET ${url} failed before a response (network, TLS, or timeout)`);
    } finally {
      server.stop(true);
    }
  });
});

describe("latestVersions", () => {
  const pinned = [
    { module: "bun", version: "1.4.0" },
    { module: "deno", version: "2.9.5" },
  ];
  const upstream = (failing: string) => async (url: string) => {
    if (url.includes(failing)) throw new Error(`GET ${url} failed: 503`);
    return { tag_name: url.includes("oven-sh") ? "bun-v1.4.1" : "v2.9.6" };
  };

  test("every source answers, or the run aborts: one unreachable upstream never reads as an empty refresh", async () => {
    expect(await latestVersions(pinned, upstream("nowhere"))).toEqual([
      { ...pinned[0], latest: "1.4.1" },
      { ...pinned[1], latest: "2.9.6" },
    ]);
    await expect(latestVersions(pinned, upstream("oven-sh"))).rejects.toThrow(
      "GET https://api.github.com/repos/oven-sh/bun/releases/latest failed: 503",
    );
  });
});

describe("decideBump", () => {
  test.each([
    ["1.3.14", "1.3.14", "current", "equal is a no-op"],
    ["1.3.14", "1.3.15", "bump", "patch ahead"],
    ["2.9.5", "3.0.0", "bump", "major line jump"],
    ["1.9.0", "1.10.0", "bump", "minor 10 > 9 numerically (lexicographic says 1.10 < 1.9)"],
    ["9.99.99", "10.0.0", "bump", "major 10 > 9 numerically (lexicographic says 10 < 9)"],
  ] as const)("pin %s, fetched %s -> %s (%s)", (pinned, fetched, verdict) => {
    expect(decideBump(pinned, fetched, "bun")).toBe(verdict);
  });

  // A downgrade is never applied and never reads as "current": GitHub's
  // date-ordered /releases/latest can surface a backport on an older line,
  // and a run that saw one aborts rather than let the PR step close a
  // valid refresh PR as caught up.
  test.each([
    ["1.3.15", "1.2.22", "backport on an older line surfaces as date-ordered latest"],
    ["2.0.0", "1.99.99", "major below the pin"],
    ["1.10.0", "1.9.9", "minor 9 < 10 numerically (lexicographic says 1.9 > 1.10)"],
  ] as const)("pin %s, fetched %s -> the run aborts (%s)", (pinned, fetched) => {
    expect(() => decideBump(pinned, fetched, "bun")).toThrow(
      `bun: upstream latest ${fetched} is OLDER than the pinned ${pinned} (a backport release surfacing as latest?)`,
    );
  });
});

describe("latestBunVersion", () => {
  test("strips the bun-v tag prefix", () => {
    expect(latestBunVersion({ tag_name: "bun-v1.3.14" })).toBe("1.3.14");
  });

  test("rejects prereleases, foreign tags, and missing fields", () => {
    expect(() => latestBunVersion({ tag_name: "bun-v1.3.14-canary.1" })).toThrow("does not match");
    expect(() => latestBunVersion({ tag_name: "v1.3.14" })).toThrow("does not match");
    expect(() => latestBunVersion({})).toThrow("expected a string");
    expect(() => latestBunVersion(null)).toThrow("expected a string");
  });
});

describe("latestDenoVersion", () => {
  test("strips the v tag prefix", () => {
    expect(latestDenoVersion({ tag_name: "v2.9.5" })).toBe("2.9.5");
  });

  test("rejects release-candidate tags and missing fields", () => {
    expect(() => latestDenoVersion({ tag_name: "v2.9.5-rc.1" })).toThrow("does not match");
    expect(() => latestDenoVersion(undefined)).toThrow("expected a string");
  });
});

describe("pinnedVersion", () => {
  test.each([
    ["1.4.0\n", "1.4.0", "the dotfile as written"],
    ["2.9.5", "2.9.5", "no trailing newline"],
  ])("'%s' -> %s (%s)", (text, version) => {
    expect(pinnedVersion(text, "files/bun/.bun-version")).toBe(version);
  });

  test.each([
    ["1.4.0-canary.1\n", "a prerelease"],
    ["v1.4.0\n", "a tag prefix"],
    ["1.4.0\n\n", "a second newline"],
    ["", "an empty file"],
  ])("'%s' throws, naming the file (%s)", (text) => {
    expect(() => pinnedVersion(text, "files/bun/.bun-version")).toThrow(
      "files/bun/.bun-version: '",
    );
  });
});

describe("typesBunDirs", () => {
  test("every lock-carrying package declaring @types/bun under either key; the rest are not bumped", () => {
    const root = temp.dir("types-bun-dirs-");
    const plant = (dir: string, pkg: Record<string, unknown>, lock = true) => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), JSON.stringify(pkg));
      if (lock) writeFileSync(join(root, dir, "bun.lock"), "");
    };
    plant(".", { devDependencies: { "@types/bun": "0.0.0" } });
    plant("actions/dev", { devDependencies: { "@types/bun": "0.0.0" } });
    plant("actions/prod", { dependencies: { "@types/bun": "0.0.0" } });
    plant("actions/plain", { devDependencies: { typescript: "^7" } });
    plant("actions/unlocked", { devDependencies: { "@types/bun": "0.0.0" } }, false);
    expect(typesBunDirs(root)).toEqual([".", "actions/dev", "actions/prod"]);
  });
});

describe("proseBumps", () => {
  test("joins bump descriptions as prose", () => {
    expect(proseBumps([])).toBe("");
    expect(proseBumps([{ module: "bun", from: "1.3.14", version: "1.3.15" }])).toBe(
      "bun to 1.3.15",
    );
    expect(
      proseBumps([
        { module: "bun", from: "1.3.14", version: "1.3.15" },
        { module: "deno", from: "2.9.5", version: "2.9.6" },
      ]),
    ).toBe("bun to 1.3.15 and deno to 2.9.6");
    expect(
      proseBumps([
        { module: "bun", from: "1.3.14", version: "1.3.15" },
        { module: "uv", from: "0.9.0", version: "0.9.1" },
        { module: "deno", from: "2.9.5", version: "2.9.6" },
      ]),
    ).toBe("bun to 1.3.15, uv to 0.9.1, and deno to 2.9.6");
  });
});

describe("prBody", () => {
  const summary = (bumps: string) =>
    `Automated toolchain pin refresh: bump ${bumps} (fleet-wide via the managed version dotfiles - see docs/toolchains.md). Merging this moves the stable tag once green; the next sync pushes it to the fleet.`;

  const rows: { reason: string; bumps: Bump[]; body: string }[] = [
    {
      reason: "a minor refresh is the summary alone",
      bumps: [{ module: "bun", from: "1.3.14", version: "1.4.0" }],
      body: summary("bun to 1.4.0"),
    },
    {
      reason:
        "only the bumps crossing a major line lead the banner, one blank line before the summary",
      bumps: [
        { module: "bun", from: "1.3.14", version: "1.3.15" },
        { module: "uv", from: "0.9.0", version: "1.0.0" },
        { module: "deno", from: "2.9.5", version: "3.0.0" },
      ],
      body: `**MAJOR VERSION JUMP: uv 0 -> 1, deno 2 -> 3 - review before merging.**\n\n${summary("bun to 1.3.15, uv to 1.0.0, and deno to 3.0.0")}`,
    },
  ];

  test.each(rows)("$reason", ({ bumps, body }) => {
    expect(prBody(bumps)).toBe(body);
  });
});

describe("PIN_SOURCES", () => {
  test("each source is a version dotfile files.yml delivers, managed, to the repositories selecting its module", () => {
    const config = parseFilesConfig(
      readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"),
      "files.yml",
    );
    const delivery = Object.entries(PIN_SOURCES).map(([module, source]) => {
      pinnedVersion(readFileSync(join(REPO_ROOT, source.file), "utf-8"), source.file);
      const entry = config.files.find((candidate) => candidate.path === basename(source.file));
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
      Object.entries(PIN_SOURCES).map(([module, source]) => [
        module,
        {
          class: "managed",
          source: source.file.replace(/^files\//, ""),
          when: { modules: [module] },
        },
      ]),
    );
  });

  test("the committed @types/bun pins equal the bun runtime pin, the shape one refresh writes", () => {
    const version = pinnedVersion(
      readFileSync(join(REPO_ROOT, PIN_SOURCES.bun.file), "utf-8"),
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

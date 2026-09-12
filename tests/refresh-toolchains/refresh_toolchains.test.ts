import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Bump,
  bumpFilesPin,
  decideBump,
  fetchJson,
  latestBunVersion,
  latestDenoVersion,
  latestVersions,
  PIN_SOURCES,
  prBody,
  proseBumps,
} from "../../.github/scripts/refresh-toolchains/refresh_toolchains";
import { toolchainPins } from "../../scripts/generate/toolchain_pins";

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
    { module: "bun", pin: { file: ".bun-version", version: "1.4.0" } },
    { module: "deno", pin: { file: ".dvmrc", version: "2.9.5" } },
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

describe("bumpFilesPin", () => {
  const files = [
    "placeholders: []",
    "",
    "modules:",
    "  bun:",
    "    description: bun",
    "    pin: {file: .bun-version, version: 1.4.0}",
    "  deno:",
    "    pin: {file: .dvmrc, version: 2.9.5}",
    "  uv:",
    "    description: no pin",
    "",
    "files: []",
    "",
  ].join("\n");

  test.each([
    ["bun", "1.4.1", "    pin: {file: .bun-version, version: 1.4.0}"],
    ["deno", "3.0.0", "    pin: {file: .dvmrc, version: 2.9.5}"],
  ])("bumps only modules.%s's pin line to %s", (module, version, line) => {
    expect(bumpFilesPin(files, module, version, "files.yml")).toBe(
      files.replace(line, line.replace(/\d+\.\d+\.\d+/, version)),
    );
  });

  test("the current version is idempotent", () => {
    expect(bumpFilesPin(files, "bun", "1.4.0", "files.yml")).toBe(files);
  });

  test.each([
    ["the module carries no pin line", files, "uv", "no pin line"],
    ["the module is not under modules", files, "rust", "no modules.rust entry"],
    ["there is no modules section", "files: []\n", "bun", "no modules section"],
    [
      "the pin is not the one-line flow mapping",
      files.replace(
        "    pin: {file: .bun-version, version: 1.4.0}",
        "    pin:\n      file: .bun-version\n      version: 1.4.0",
      ),
      "bun",
      "pin: {file: X, version: X.Y.Z}",
    ],
    [
      "the pin line carries a trailing comment",
      files.replace("version: 1.4.0}", "version: 1.4.0} # keep"),
      "bun",
      "pin: {file: X, version: X.Y.Z}",
    ],
  ])("throws when %s", (_reason, text, module, thrown) => {
    expect(() => bumpFilesPin(text, module, "9.9.9", "files.yml")).toThrow(thrown);
  });

  test("the committed files.yml carries a bumpable pin for every PIN_SOURCES module", () => {
    const text = readFileSync(join(import.meta.dir, "../../files.yml"), "utf-8");
    for (const module of Object.keys(PIN_SOURCES)) {
      expect(bumpFilesPin(text, module, "0.0.0", "files.yml")).not.toBe(text);
    }
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

describe("PIN_SOURCES coverage", () => {
  test("exactly the pin-carrying files.yml modules have upstream sources", () => {
    const pinned = toolchainPins(readFileSync(join(import.meta.dir, "../../files.yml"), "utf-8"))
      .map((pin) => pin.module)
      .sort();
    expect(Object.keys(PIN_SOURCES).sort()).toEqual(pinned);
  });
});

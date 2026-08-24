// Unit tests for the toolchain-pin refresher's pure pieces: the upstream
// payload parsers (fixture payloads, no network), the line-targeted
// manifest rewrite, the bump prose, and the PIN_SOURCES <-> manifests
// cross-check against the live repo.

import { describe, expect, test } from "bun:test";
import {
  bumpPinVersion,
  compareVersions,
  decideBump,
  fetchJson,
  latestBunVersion,
  latestDenoVersion,
  latestNodeLts,
  majorJumps,
  PIN_SOURCES,
  proseBumps,
} from "../../.github/scripts/refresh-toolchains/refresh_toolchains";
import { loadManifests } from "../../scripts/module_manifests";

describe("fetchJson", () => {
  test("a malformed body rejects with the fixed diagnostic, never the body", async () => {
    // Loopback server, no upstream network (hostname pinned: the default
    // 0.0.0.0 listener collides in sandboxed runs). The rejection message
    // is published as a public ::warning, and runtimes differ on whether
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

describe("decideBump", () => {
  test("a fetched version older than the pin is a downgrade, never applied", () => {
    // The backport shape: 1.3.15 pinned, then a 1.2.22 backport release
    // surfaces as GitHub's date-ordered "latest".
    expect(decideBump("1.3.15", "1.2.22")).toBe("downgrade");
    expect(decideBump("2.0.0", "1.99.99")).toBe("downgrade");
  });

  test("an equal fetched version is current (no-op)", () => {
    expect(decideBump("1.3.14", "1.3.14")).toBe("current");
  });

  test("a newer fetched version is a bump", () => {
    expect(decideBump("1.3.14", "1.3.15")).toBe("bump");
    expect(decideBump("24.19.0", "26.0.0")).toBe("bump");
  });

  test("comparison is numeric per component, not lexicographic", () => {
    expect(decideBump("1.9.0", "1.10.0")).toBe("bump");
    expect(decideBump("1.10.0", "1.9.9")).toBe("downgrade");
    expect(compareVersions("10.0.0", "9.99.99")).toBeGreaterThan(0);
  });
});

describe("latestBunVersion", () => {
  test("strips the bun-v tag prefix", () => {
    expect(latestBunVersion({ tag_name: "bun-v1.3.14" })).toBe("1.3.14");
  });

  test("rejects prereleases, foreign tags, and missing fields", () => {
    expect(() => latestBunVersion({ tag_name: "bun-v1.3.14-canary.1" })).toThrow("bun");
    expect(() => latestBunVersion({ tag_name: "v1.3.14" })).toThrow("bun");
    expect(() => latestBunVersion({})).toThrow("expected a string");
    expect(() => latestBunVersion(null)).toThrow("expected a string");
  });
});

describe("latestNodeLts", () => {
  test("picks the first entry whose lts is a non-empty codename (newest LTS line)", () => {
    expect(
      latestNodeLts([
        { version: "v25.1.0", lts: false },
        { version: "v24.19.0", lts: "Krypton" },
        { version: "v24.18.0", lts: "Krypton" },
      ]),
    ).toBe("24.19.0");
  });

  test("odd lts shapes (true, null, missing, empty) never count as LTS", () => {
    expect(() =>
      latestNodeLts([
        { version: "v25.1.0", lts: true },
        { version: "v25.0.0", lts: null },
        { version: "v24.19.0" },
        { version: "v24.18.0", lts: "" },
      ]),
    ).toThrow("no LTS");
  });

  test("rejects a payload without any LTS entry or with a bad version", () => {
    expect(() => latestNodeLts([{ version: "v25.1.0", lts: false }])).toThrow("no LTS");
    expect(() => latestNodeLts([{ version: "24.19.0", lts: "Krypton" }])).toThrow("does not match");
    expect(() => latestNodeLts({ version: "v24.19.0" })).toThrow("array");
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

describe("bumpPinVersion", () => {
  const manifest = [
    "# yaml-language-server: $schema=../module.schema.json",
    "description: demo toolchain",
    "toolchain:",
    "  codeql_language: python",
    "  pin:",
    "    file: .demo-version",
    "    version: 1.2.3",
    "dependabot:",
    "  ecosystem: pip",
    "",
  ].join("\n");

  test("rewrites only the pin's version line, preserving everything else", () => {
    const next = bumpPinVersion(manifest, "1.3.0", "demo");
    expect(next).toBe(manifest.replace("    version: 1.2.3", "    version: 1.3.0"));
  });

  test("is idempotent for the current version", () => {
    expect(bumpPinVersion(manifest, "1.2.3", "demo")).toBe(manifest);
  });

  test("a manifest without a pin block (or without its version line) throws", () => {
    expect(() => bumpPinVersion("description: x\n", "1.0.0", "demo")).toThrow("no pin block");
    const truncated = manifest.replace("    version: 1.2.3\n", "");
    expect(() => bumpPinVersion(truncated, "1.0.0", "demo")).toThrow("no version line");
  });

  test("a quoted version or a trailing comment fails loudly, naming the expected form", () => {
    for (const line of ['    version: "1.2.3"', "    version: 1.2.3 # keep in step with CI"]) {
      const decorated = manifest.replace("    version: 1.2.3", line);
      expect(() => bumpPinVersion(decorated, "1.3.0", "demo")).toThrow("version: X.Y.Z");
    }
  });

  test("a version line outside the pin block does not count", () => {
    const outside = ["toolchain:", "  pin:", "    file: .demo-version", "version: 9.9.9", ""].join(
      "\n",
    );
    expect(() => bumpPinVersion(outside, "1.0.0", "demo")).toThrow("no version line");
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
        { module: "node", from: "24.19.0", version: "24.20.0" },
        { module: "deno", from: "2.9.5", version: "2.9.6" },
      ]),
    ).toBe("bun to 1.3.15, node to 24.20.0, and deno to 2.9.6");
  });
});

describe("majorJumps", () => {
  test("names only the bumps crossing a major version", () => {
    expect(
      majorJumps([
        { module: "bun", from: "1.3.14", version: "1.3.15" },
        { module: "node", from: "24.19.0", version: "26.0.0" },
        { module: "deno", from: "2.9.5", version: "3.0.0" },
      ]),
    ).toBe("node 24 -> 26, deno 2 -> 3");
    expect(majorJumps([{ module: "bun", from: "1.3.14", version: "1.4.0" }])).toBe("");
    expect(majorJumps([])).toBe("");
  });
});

describe("PIN_SOURCES coverage", () => {
  test("exactly the pin-carrying manifests have upstream sources", () => {
    const pinned = loadManifests()
      .filter((m) => m.toolchain?.pin !== undefined)
      .map((m) => m.module)
      .sort();
    expect(Object.keys(PIN_SOURCES).sort()).toEqual(pinned);
  });
});

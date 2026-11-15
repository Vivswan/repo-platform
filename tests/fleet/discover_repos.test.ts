import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { spawnFakeGithub } from "../shared/fake_github";
import type { LoopbackServer } from "../shared/loopback_server";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

describe("discover_repos.ts", () => {
  const script = join(import.meta.dir, "../../.github/scripts/fleet/discover_repos.ts");
  const root = temp.dir("discover-repos-");
  const bin = join(root, "bin");

  let api: LoopbackServer;
  let downApi: LoopbackServer;

  beforeAll(async () => {
    mkdirSync(bin);
    // The listing still rides gh (fleet/discovery.ts); the token's user is read from the loopback API.
    writeFileSync(join(bin, "gh"), ["#!/usr/bin/env bash", 'cat "$STUB_PAYLOAD"', ""].join("\n"), {
      mode: 0o755,
    });
    api = await spawnFakeGithub({ user: [{ status: 200, body: { login: "Vivswan" } }] });
    downApi = await spawnFakeGithub({ user: [{ status: 503 }] });
  });
  afterAll(() => {
    api.stop();
    downApi.stop();
  });

  function run(name: string, payload: string, server: LoopbackServer = api) {
    const temp = join(root, `temp-${name}`);
    mkdirSync(temp, { recursive: true });
    const proc = boundedSpawnSync(["bun", script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: temp,
        GH_TOKEN: "stub-token",
        GITHUB_API_URL: `${server.host}/${name}`,
        GITHUB_RETRY_BASE_MS: "0",
        STUB_PAYLOAD: payload,
      },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout,
      stderr: proc.stderr,
      discoveredPath: join(temp, "discovered.json"),
    };
  }

  function repoEntry(full_name: string, overrides: Record<string, unknown> = {}) {
    return {
      full_name,
      archived: false,
      private: true,
      owner: { login: full_name.split("/")[0] },
      permissions: { push: true },
      ...overrides,
    };
  }

  test("snapshots the owner's writable repos as {repo, private} rows and logs only the count", () => {
    const payload = join(root, "pages.json");
    writeFileSync(
      payload,
      JSON.stringify([
        [
          repoEntry("Vivswan/hidden"),
          repoEntry("Vivswan/pub", { private: false }),
          repoEntry("Vivswan/archived-out", { archived: true }),
          repoEntry("Vivswan/read-only", { permissions: { push: false } }),
        ],
        // Cross-owner writable repos are the scoping delta over
        // discoverWritableRepos: the sync plan must drop them.
        [repoEntry("Other/cross-owner")],
      ]),
    );
    const r = run("scope", payload);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    // The sync selector (select_sync_repos.ts) parses these rows, and `private` decides what its public log may name.
    expect(readFileSync(r.discoveredPath, "utf-8")).toBe(
      '[{"repo":"Vivswan/hidden","private":true},{"repo":"Vivswan/pub","private":false}]',
    );
    // The public run's log must never carry a repo name.
    expect(r.stdout).toBe("discovered 2 writable repos for Vivswan\n");
  });

  test("an unreadable login fails before any listing or write: the owner scope is the token's user, never a guess", () => {
    const r = run("login-fail", "/dev/null", downApi);
    expect({ ...r, written: existsSync(r.discoveredPath) }).toEqual({
      exitCode: 1,
      stdout: "::error::discover_repos: the token's user could not be read (HTTP 503)\n",
      stderr: "",
      discoveredPath: r.discoveredPath,
      written: false,
    });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { spawnFakeGithub } from "../shared/fake_github";
import type { LoopbackServer } from "../shared/loopback_server";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

describe("discover_repos.ts", () => {
  const script = join(import.meta.dir, "../../.github/scripts/fleet/discover_repos.ts");
  const root = temp.dir("discover-repos-");

  let api: LoopbackServer;
  let downApi: LoopbackServer;

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

  beforeAll(async () => {
    api = await spawnFakeGithub(
      {
        user: [{ status: 200, body: { login: "Vivswan" } }],
        "user/repos": [
          {
            status: 200,
            next: true,
            body: [
              repoEntry("Vivswan/hidden"),
              repoEntry("Vivswan/pub", { private: false }),
              repoEntry("Vivswan/archived-out", { archived: true }),
              repoEntry("Vivswan/read-only", { permissions: { push: false } }),
            ],
          },
          // Cross-owner writable repos are the scoping delta over
          // discoverWritableRepos: the sync plan must drop them.
          { status: 200, body: [repoEntry("Other/cross-owner")] },
        ],
      },
      join(root, "api.log"),
    );
    downApi = await spawnFakeGithub({ user: [{ status: 503 }] }, join(root, "down-api.log"));
  });
  afterAll(() => {
    api.stop();
    downApi.stop();
  });

  function run(name: string, server: LoopbackServer = api) {
    const temp = join(root, `temp-${name}`);
    mkdirSync(temp, { recursive: true });
    const proc = boundedSpawnSync(["bun", script], {
      env: {
        ...process.env,
        RUNNER_TEMP: temp,
        GH_TOKEN: "stub-token",
        GITHUB_API_URL: `${server.host}/${name}`,
        GITHUB_RETRY_BASE_MS: "0",
      },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout,
      stderr: proc.stderr,
      discoveredPath: join(temp, "discovered.json"),
    };
  }

  test("snapshots the owner's writable repos as {repo, private} rows and logs only the count", () => {
    const r = run("scope");
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
    const r = run("login-fail", downApi);
    expect({ ...r, written: existsSync(r.discoveredPath) }).toEqual({
      exitCode: 1,
      stdout: "::error::discover_repos: the token's user could not be read (HTTP 503)\n",
      stderr: "",
      discoveredPath: r.discoveredPath,
      written: false,
    });
  });
});

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end harness for the sync plan's discovery step, stub-gh style
// (see discovery.test.ts). This script replaced sync-repos.yml's inline
// jq pipeline, so the tests pin its two output contracts to the jq era:
// the {repo, private} rows in discovered.json (redact.ts's enrich and
// repos_registry's select parse them; `private` drives redaction) and
// the public log line, which prints only a count and the owner login.
describe("discover_repos.ts", () => {
  const script = join(import.meta.dir, "../../.github/scripts/fleet/discover_repos.ts");
  const root = mkdtempSync(join(tmpdir(), "discover-repos-"));
  const bin = join(root, "bin");

  beforeAll(() => {
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        'if [ "$2" = "user" ]; then',
        '  if [ -n "$STUB_FAIL_LOGIN" ]; then',
        '    echo "gh: login boom" >&2',
        "    exit 9",
        "  fi",
        '  echo "Vivswan"',
        "  exit 0",
        "fi",
        'cat "$STUB_PAYLOAD"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  function run(name: string, extra: Record<string, string>) {
    const temp = join(root, `temp-${name}`);
    mkdirSync(temp, { recursive: true });
    const proc = Bun.spawnSync(["bun", script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: temp,
        ...extra,
      },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
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
    const r = run("scope", { STUB_PAYLOAD: payload });
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    // Row shape and key order pinned to the retired jq step's
    // `{repo: .full_name, private: (.private != false)}` projection.
    expect(readFileSync(r.discoveredPath, "utf-8")).toBe(
      '[{"repo":"Vivswan/hidden","private":true},{"repo":"Vivswan/pub","private":false}]',
    );
    // The log line is this public run's only discovery output: pinned
    // byte-for-byte to the inline step's echo, and it never carries a
    // repo name.
    expect(r.stdout).toBe("discovered 2 writable repos for Vivswan\n");
  });

  test("a failed login exits with gh's code before any listing or write", () => {
    const r = run("login-fail", { STUB_FAIL_LOGIN: "1", STUB_PAYLOAD: "/dev/null" });
    expect(r.exitCode).toBe(9);
    expect(r.stderr).toContain("gh: login boom");
    expect(r.stdout).toBe("");
    expect(existsSync(r.discoveredPath)).toBe(false);
  });

  test("a malformed listing fails loudly with this script's label, never a value", () => {
    const payload = join(root, "malformed.json");
    writeFileSync(payload, JSON.stringify([[{ full_name: "Vivswan/shapeless" }]]));
    const r = run("malformed", { STUB_PAYLOAD: payload });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("::error::discover_repos: user/repos response: unexpected shape");
    expect(r.stdout + r.stderr).not.toContain("shapeless");
    expect(existsSync(r.discoveredPath)).toBe(false);
  });

  test("an unparseable listing fails with a value-free diagnostic (no SyntaxError echo)", () => {
    const payload = join(root, "truncated.json");
    writeFileSync(payload, '[[{"full_name": "Vivswan/hidden-serv');
    const r = run("truncated", { STUB_PAYLOAD: payload });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("::error::discover_repos: user/repos response: not valid JSON");
    expect(r.stdout + r.stderr).not.toContain("hidden-serv");
    expect(existsSync(r.discoveredPath)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/sync/resolve_target_version.ts");

// Records every invocation to CALLS_LOG (\x1f between args, \x1e between
// records) and answers with the canned GH_LATEST; GH_FAIL picks the
// failure stderr (404 vs API outage).
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "gh"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ "\${GH_FAIL:-}" = "404" ]; then
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
fi
if [ "\${GH_FAIL:-}" = "outage" ]; then
  echo "gh: Internal Server Error (HTTP 500)" >&2
  exit 1
fi
echo "\${GH_LATEST:-}"
`;

interface Options {
  requested?: string;
  releaseTag?: string;
  latest?: string;
  fail?: string;
}

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "resolve-target-version-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const output = join(root, "output.txt");
  const calls = join(root, "calls.log");
  const proc = Bun.spawnSync(["bun", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      GITHUB_OUTPUT: output,
      CALLS_LOG: calls,
      REQUESTED: opts.requested ?? "",
      RELEASE_TAG: opts.releaseTag ?? "",
      GH_LATEST: opts.latest ?? "",
      GH_FAIL: opts.fail ?? "",
    },
  });
  const raw = existsSync(calls) ? readFileSync(calls, "utf-8") : "";
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    version: existsSync(output) ? readFileSync(output, "utf-8") : "",
    calls: raw
      .split("\x1e")
      .filter(Boolean)
      .map((record) => record.split("\x1f")),
  };
}

describe("resolve_target_version.ts", () => {
  test("a dispatched version wins without touching the API", () => {
    const r = run({ requested: "v2.0.0", fail: "outage" });
    expect(r.exitCode).toBe(0);
    expect(r.version).toBe("version=v2.0.0\n");
    expect(r.calls).toEqual([]);
  });

  test("resolves the newest stable release from releases/latest", () => {
    const r = run({ latest: "v3.1.4" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual([
      ["gh", "api", "repos/Vivswan/repo-platform/releases/latest", "--jq", ".tag_name"],
    ]);
    expect(r.version).toBe("version=v3.1.4\n");
    expect(r.output).not.toContain("::notice::");
  });

  test("HTTP 404 means no release yet: empty version, green run", () => {
    const r = run({ fail: "404" });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("No release yet; syncing without a version.");
    expect(r.version).toBe("version=\n");
  });

  test("any other API failure fails loudly instead of reading as no release", () => {
    const r = run({ fail: "outage" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::");
    expect(r.output).toContain("an API failure, not a missing release");
    expect(r.output).toContain("HTTP 500");
    expect(r.version).toBe("");
  });

  test("a release published on an older tag only gets a notice", () => {
    const r = run({ releaseTag: "v1.0.0", latest: "v3.1.4" });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(
      "::notice::published release v1.0.0 is not the newest stable release (v3.1.4)",
    );
    expect(r.version).toBe("version=v3.1.4\n");
  });

  test("a release event with no stable release notices 'none exists'", () => {
    const r = run({ releaseTag: "v1.0.0-rc.1", fail: "404" });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("(none exists)");
    expect(r.version).toBe("version=\n");
  });

  test("the matching release tag stays notice-free", () => {
    const r = run({ releaseTag: "v3.1.4", latest: "v3.1.4" });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain("::notice::");
    expect(r.version).toBe("version=v3.1.4\n");
  });
});

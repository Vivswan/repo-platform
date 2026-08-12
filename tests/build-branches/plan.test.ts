import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/build-branches/plan.ts");

// Answers `gh api repos/<slug>/releases/latest --jq .tag_name` with the
// canned GH_LATEST; "404" and "fail" pick the two failure modes the
// script distinguishes.
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
case "\${GH_LATEST:-}" in
  404) echo "gh: Not Found (HTTP 404): releases/latest" >&2; exit 1 ;;
  fail) echo "gh: API rate limit exceeded (HTTP 403)" >&2; exit 1 ;;
  *) echo "\${GH_LATEST}" ;;
esac
`;

// Only \`git ls-remote --exit-code origin <ref>\` reaches this stub; the
// ref exists when GIT_REFS lists it.
const gitStub = `#!/usr/bin/env bash
ref="\${!#}"
for have in \${GIT_REFS:-}; do
  if [ "$have" = "$ref" ]; then exit 0; fi
done
exit 2
`;

interface Options {
  releaseTag?: string;
  dispatchChannel?: string;
  latest?: string;
  refs?: string;
}

function run(eventName: string, opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "plan-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
  const outputFile = join(root, "output.txt");
  writeFileSync(outputFile, "");
  const proc = Bun.spawnSync(["bun", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      EVENT_NAME: eventName,
      DISPATCH_CHANNEL: opts.dispatchChannel ?? "",
      RELEASE_TAG: opts.releaseTag ?? "",
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      GITHUB_OUTPUT: outputFile,
      GH_LATEST: opts.latest ?? "404",
      GIT_REFS: opts.refs ?? "",
    },
  });
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(outputFile, "utf-8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    outputs,
  };
}

describe("plan.ts", () => {
  test("the newest stable release builds latest at its tag", () => {
    const r = run("release", { releaseTag: "v2.0.0", latest: "v2.0.0" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ staging: "false", latest: "true", version: "v2.0.0" });
  });

  test("a release that is not releases/latest builds nothing", () => {
    const r = run("release", { releaseTag: "v2.0.0-rc.1", latest: "v1.9.0" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ staging: "false", latest: "false", version: "" });
    expect(r.output).toContain("::warning::");
    expect(r.output).toContain("not the newest stable release (v1.9.0)");
  });

  test("a prerelease published before any stable release builds nothing", () => {
    const r = run("release", { releaseTag: "v0.1.0-rc.1", latest: "404" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ staging: "false", latest: "false", version: "" });
    expect(r.output).toContain("none exists");
  });

  test("an operational releases/latest failure fails the plan", () => {
    const r = run("release", { releaseTag: "v2.0.0", latest: "fail" });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("releases/latest failed");
  });

  test("a push with healthy build refs plans only staging", () => {
    const r = run("push", {
      latest: "v1.9.0",
      refs: "refs/tags/templates/v1.9.0 refs/heads/latest",
    });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ staging: "true", latest: "false", version: "v1.9.0" });
  });

  test("a schedule self-heals a missing latest build tag", () => {
    const r = run("schedule", { latest: "v1.9.0", refs: "refs/heads/latest" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ staging: "true", latest: "true", version: "v1.9.0" });
  });

  test("a latest-only dispatch rebuilds latest from releases/latest", () => {
    const r = run("workflow_dispatch", { dispatchChannel: "latest", latest: "v1.9.0" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ staging: "false", latest: "true", version: "v1.9.0" });
  });

  test("a staging-only dispatch never reads releases", () => {
    const r = run("workflow_dispatch", { dispatchChannel: "staging", latest: "fail" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ staging: "true", latest: "false", version: "" });
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/sync/wait_for_build.ts");

const MAIN_SHA = "a".repeat(40);

// git: ls-remote HEAD prints GIT_HEAD; ls-remote --exit-code for a tag
// succeeds once the attempt counter reaches GIT_TAG_AFTER (a counter file
// makes retries observable). gh: serves the runs JSON from GH_RUNS_FILE,
// or exits 1 when GH_FAIL is set.
const gitStub = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${2:-}" = "--exit-code" ]; then
  count=$(($(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1))
  echo "$count" >"$COUNT_FILE"
  [ "$count" -ge "\${GIT_TAG_AFTER:-1}" ] && exit 0
  exit 2
fi
printf '%s\\tHEAD\\n' "\${GIT_HEAD:-}"
`;
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${GH_FAIL:-}" ]; then
  echo "gh: boom" >&2
  exit 1
fi
cat "$GH_RUNS_FILE"
`;

interface Options {
  env?: Record<string, string>;
  runs?: unknown;
}

function run(args: string[], opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "wait-for-build-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const runsFile = join(root, "runs.json");
  writeFileSync(runsFile, JSON.stringify(opts.runs ?? { workflow_runs: [] }));
  const countFile = join(root, "count.txt");
  const proc = Bun.spawnSync(["bun", script, ...args], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      GH_RUNS_FILE: runsFile,
      COUNT_FILE: countFile,
      GIT_HEAD: MAIN_SHA,
      WAIT_DELAY_MS: "10",
      ...opts.env,
    },
  });
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    attempts: existsSync(countFile) ? Number(readFileSync(countFile, "utf-8").trim()) : 0,
  };
}

describe("wait_for_build.ts", () => {
  test("rejects a missing or unknown mode", () => {
    for (const args of [[], ["bogus"]]) {
      const r = run(args);
      expect(r.exitCode).toBe(2);
      expect(r.output).toContain("::error::usage");
    }
  });

  test("tag mode requires VERSION", () => {
    const r = run(["tag"]);
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("VERSION must be set");
  });

  test("tag mode returns as soon as the tag exists", () => {
    const r = run(["tag"], { env: { VERSION: "v1.2.3" } });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("templates/v1.2.3 exists.");
    expect(r.output).not.toContain("waiting");
  });

  test("tag mode polls until the tag appears", () => {
    const r = run(["tag"], { env: { VERSION: "v1.2.3", GIT_TAG_AFTER: "3" } });
    expect(r.exitCode).toBe(0);
    expect(r.attempts).toBe(3);
    expect(r.output).toContain("waiting for templates/v1.2.3...");
    expect(r.output).toContain("templates/v1.2.3 exists.");
  });

  test("tag mode warns and exits green after the attempts run out", () => {
    const r = run(["tag"], { env: { VERSION: "v1.2.3", GIT_TAG_AFTER: "99" } });
    expect(r.exitCode).toBe(0);
    expect(r.attempts).toBe(30);
    expect(r.output).toContain("::warning::templates/v1.2.3 is still missing after 5 minutes");
  });

  test("staging mode succeeds on a push run at main HEAD", () => {
    const r = run(["staging"], {
      runs: { workflow_runs: [{ event: "push", head_sha: MAIN_SHA }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(`staging is built from main HEAD ${MAIN_SHA}.`);
  });

  test("staging mode ignores dispatch runs and stale shas, then warns green", () => {
    const r = run(["staging"], {
      runs: {
        workflow_runs: [
          { event: "workflow_dispatch", head_sha: MAIN_SHA },
          { event: "push", head_sha: "b".repeat(40) },
        ],
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("waiting for a successful Build Branches push or schedule run");
    expect(r.output).toContain("::warning::no successful Build Branches push- or schedule-event");
  });

  test("staging mode keeps polling through transient gh failures", () => {
    const r = run(["staging"], { env: { GH_FAIL: "1" } });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::no successful Build Branches");
  });

  test("staging mode fails loudly on a response gh accepted but the schema rejects", () => {
    const r = run(["staging"], { runs: { workflow_runs: [{ event: 7 }] } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::wait_for_build: workflow runs response");
  });

  test("staging mode fails loudly on an unreadable main HEAD", () => {
    const r = run(["staging"], { env: { GIT_HEAD: "not-a-sha" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("could not read main's HEAD sha");
  });
});

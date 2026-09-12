import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { argvStub } from "../shared/argv_stub";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SCRIPTS = join(import.meta.dir, "../../.github/scripts");
const script = join(SCRIPTS, "refresh-toolchains/open_refresh_pr.ts");

const SUMMARY =
  "Automated toolchain pin refresh: bump bun 1.3.0 -> 1.4.0 (fleet-wide via the managed version dotfiles - see docs/toolchains.md). Merging this rebuilds the build branch; the next sync pushes it to the fleet.";

function run(env: Record<string, string | undefined>) {
  const root = temp.dir("open-refresh-pr-");
  const handed = join(root, "handed.txt");
  const stub = argvStub(root, "bun", [
    `printf '%s\\x1f%s' "$PR_BODY" "$COMMIT_MESSAGE" >"${handed}"`,
  ]);
  const proc = boundedSpawnSync([process.execPath, script], {
    env: {
      ...process.env,
      PATH: `${stub.bin}:${process.env.PATH}`,
      BUMPS: "bun 1.3.0 -> 1.4.0",
      MAJOR: "",
      PR_TITLE: "fix(files): bump bun 1.3.0 -> 1.4.0",
      PR_BODY: undefined,
      COMMIT_MESSAGE: undefined,
      STUB_EXIT: undefined,
      ...env,
    },
  });
  const handedValues = existsSync(handed) ? readFileSync(handed, "utf-8").split("\x1f") : null;
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
    calls: stub.calls(),
    body: handedValues?.[0],
    message: handedValues?.[1],
  };
}

describe("open_refresh_pr.ts", () => {
  test.each([
    {
      reason: "a minor refresh hands the fixed summary",
      env: {},
      body: SUMMARY,
    },
    {
      reason: "a major jump puts the review banner ahead of the summary, one blank line between",
      env: { MAJOR: "bun 1 -> 2" },
      body: `**MAJOR VERSION JUMP: bun 1 -> 2 - review before merging.**\n\n${SUMMARY}`,
    },
  ])("$reason", ({ env, body }) => {
    expect(run(env)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
      calls: [["bun", join(SCRIPTS, "shared/open_automation_pr.ts")]],
      body,
      message: "fix(files): bump bun 1.3.0 -> 1.4.0",
    });
  });

  test("the PR opener's exit code is the step's", () => {
    expect(run({ STUB_EXIT: "1" })).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "",
      calls: [["bun", join(SCRIPTS, "shared/open_automation_pr.ts")]],
      body: SUMMARY,
      message: "fix(files): bump bun 1.3.0 -> 1.4.0",
    });
  });

  test("a missing BUMPS exits before opening anything", () => {
    expect(run({ BUMPS: "" })).toEqual({
      exitCode: 2,
      stdout: "::error::BUMPS must be set\n",
      stderr: "",
      calls: [],
      body: undefined,
      message: undefined,
    });
  });
});

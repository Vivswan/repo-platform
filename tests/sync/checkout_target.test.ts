import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argvStub } from "../shared/argv_stub";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../.github/scripts/sync/checkout_target.ts");
const TARGET = "Vivswan/hidden-server";
const PAT = "ghp_SENTINEL";
const URL = `https://x-access-token:${PAT}@github.com/${TARGET}.git`;

function run(branch?: string) {
  const root = temp.dir("checkout-target-");
  const runnerTemp = join(root, "temp");
  mkdirSync(runnerTemp);
  let eventPath = "";
  if (branch !== undefined) {
    eventPath = join(root, "event.json");
    writeFileSync(eventPath, JSON.stringify({ inputs: { repo: TARGET, branch } }));
  }
  const targetDir = join(root, "target");
  const git = argvStub(root, "git");
  const result = boundedSpawnSync(["bun", SCRIPT], {
    cwd: root,
    env: {
      PATH: `${git.bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      RUNNER_TEMP: runnerTemp,
      GITHUB_EVENT_PATH: eventPath,
      TARGET,
      TARGET_DIR: targetDir,
      PAT,
    },
  });
  return {
    ...result,
    targetDir,
    git: git.calls(),
    log: readFileSync(join(runnerTemp, "checkout.log"), "utf-8"),
  };
}

describe("checkout_target.ts", () => {
  // The clone authenticates with the token URL and then strips it from the remote, so only deliver.ts's own lease
  // read and push carry it later; the captured log is redacted, since git quotes target file text in its diagnostics.
  // A dispatched branch is the clone's --branch (resolve_row.ts already proved it exists).
  test.each([
    { reason: "a plain row clones the default branch", branch: undefined, at: [] },
    {
      reason: "a dispatched branch is the clone's --branch",
      branch: "feat/add-site",
      at: ["--branch", "feat/add-site"],
    },
  ])("$reason at depth 1, then strips the token from the remote", ({ branch, at }) => {
    const result = run(branch);
    expect(result.exitCode).toBe(0);
    expect(result.git.map((argv) => argv.slice(1))).toEqual([
      ["clone", "--quiet", "--depth", "1", ...at, URL, result.targetDir],
      ["-C", result.targetDir, "remote", "set-url", "origin", `https://github.com/${TARGET}.git`],
    ]);
    expect(result.log).toContain("$ git clone -> exit 0");
    expect(result.log).not.toContain(PAT);
  });
});

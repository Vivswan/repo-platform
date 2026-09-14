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

const URL = `https://x-access-token:${PAT}@github.com/${TARGET}.git`;

describe("checkout_target.ts", () => {
  test("a plain row clones the default branch at depth 1, then strips the token from the remote", () => {
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.git.map((argv) => argv.slice(1))).toEqual([
      ["clone", "--quiet", "--depth", "1", URL, result.targetDir],
      ["-C", result.targetDir, "remote", "set-url", "origin", `https://github.com/${TARGET}.git`],
    ]);
    expect(result.log).toContain("$ git clone -> exit 0");
    expect(result.log).not.toContain(PAT);
  });

  test("a dispatched branch is the clone's --branch", () => {
    const result = run("feat/add-site");
    expect(result.exitCode).toBe(0);
    expect(result.git[0].slice(1, 8)).toEqual([
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      "feat/add-site",
      URL,
    ]);
  });
});

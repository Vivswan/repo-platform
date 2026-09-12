// Every bun-touching composite action gets its bun's absolute path from the
// shared bun-setup step and its later steps run that path: a bun placed
// first on PATH afterwards (a decoy here) must not be the one that runs.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = join(import.meta.dir, "../..");
const RUNNER_BASH = ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c"];
const BUN_DIR = realpathSync(join(process.execPath, ".."));

type Step = Record<string, unknown>;
const stepsOf = (file: string): Step[] =>
  parseYaml(readFileSync(join(REPO_ROOT, file), "utf8")).runs.steps;

function fill(text: string, actionPath: string): string {
  const filled = text.replaceAll("${{ github.action_path }}", actionPath);
  if (filled.includes("${{")) throw new Error(`unresolved expression in ${filled}`);
  return filled;
}

describe("the actions' recorded bun path", () => {
  test("a later step runs the recorded bun, not a decoy placed first on PATH after the probe", () => {
    const root = temp.dir("recorded-bun-decoy-");
    const actionPath = join(root, "action");
    mkdirSync(actionPath);
    writeFileSync(
      join(actionPath, "validate-commit-names.ts"),
      'console.log("ran on " + process.execPath);\n',
    );
    const decoy = join(root, "decoy");
    mkdirSync(decoy);
    writeFileSync(join(decoy, "bun"), '#!/usr/bin/env bash\necho "decoy bun ran" >&2\nexit 97\n', {
      mode: 0o755,
    });
    const step = stepsOf("actions/validate-commit-names/action.yml").find(
      (s) => s.name === "Validate commit subjects",
    ) as Step;
    expect(step.env).toEqual({ ACTION_BUN: "${{ steps.action-bun.outputs.path }}" });
    const run = fill(String(step.run), actionPath);
    const env = { PATH: `${decoy}:${BUN_DIR}:/usr/bin:/bin`, ACTION_BUN: process.execPath };
    const byPath = boundedSpawnSync([...RUNNER_BASH, run], { env });
    expect([byPath.exitCode, byPath.stdout, byPath.stderr]).toEqual([
      0,
      `ran on ${process.execPath}\n`,
      "",
    ]);
    const byName = run.replace('"$ACTION_BUN"', "bun");
    expect(byName).not.toBe(run);
    const control = boundedSpawnSync([...RUNNER_BASH, byName], { env });
    expect([control.exitCode, control.stdout, control.stderr]).toEqual([97, "", "decoy bun ran\n"]);
  });
});

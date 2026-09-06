// Every bun-touching composite action records its bun's absolute path once,
// after the setup, and its later steps run that path: a bun placed first on
// PATH afterwards (a decoy here) must not be the one that runs.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { actionManifestFiles } from "../../scripts/check_ssot";
import { actionSetsUpBun, BUN_SETUP_ACTION } from "../../scripts/generate";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = join(import.meta.dir, "../..");
const RUNNER_BASH = ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c"];
const BUN_DIR = realpathSync(join(process.execPath, ".."));

type Step = Record<string, unknown>;
const stepsOf = (file: string): Step[] =>
  parseYaml(readFileSync(join(REPO_ROOT, file), "utf8")).runs.steps;

/** Text as the runner would resolve it with the action path pointed at
 *  `actionPath`; any other expression is refused (env is the only other
 *  channel, and each test supplies it). */
function fill(text: string, actionPath: string): string {
  const filled = text.replaceAll("${{ github.action_path }}", actionPath);
  if (filled.includes("${{")) throw new Error(`unresolved expression in ${filled}`);
  return filled;
}

describe("the actions' recorded bun path", () => {
  const files = actionManifestFiles();
  const recording = files.filter((file) => stepsOf(file).some((step) => step.id === "action-bun"));

  test("every action that sets up bun resolves it afterwards, and no other does", () => {
    // The shared setup action installs and resolves in one; it records no
    // action-bun step of its own.
    const setups = files.filter(
      (file) =>
        file !== `${BUN_SETUP_ACTION}/action.yml` &&
        actionSetsUpBun(readFileSync(join(REPO_ROOT, file), "utf8")),
    );
    expect(recording.sort()).toEqual(setups.sort());
    expect(recording.length).toBeGreaterThan(0);
  });

  // The resolver executed as the runner would, with the pinned bun first on
  // PATH (what the setup leaves behind): the recorded path is that bun's.
  test.each(recording)("%s records the absolute path of the bun the setup left on PATH", (file) => {
    const root = temp.dir("recorded-bun-");
    writeFileSync(join(root, ".bun-version"), `${Bun.version}\n`);
    const outputs = join(root, "outputs.txt");
    writeFileSync(outputs, "");
    const step = stepsOf(file).find((s) => s.id === "action-bun") as Step;
    const env = Object.fromEntries(
      Object.entries((step.env ?? {}) as Record<string, string>).map(([k, v]) => [
        k,
        fill(v, root),
      ]),
    );
    const proc = boundedSpawnSync([...RUNNER_BASH, fill(String(step.run), root)], {
      env: { ...env, PATH: `${BUN_DIR}:/usr/bin:/bin`, GITHUB_OUTPUT: outputs },
    });
    const recorded = Object.fromEntries(
      readFileSync(outputs, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("=", 2) as [string, string]),
    );
    expect([proc.exitCode, recorded.path]).toEqual([0, process.execPath]);
  });

  // A later step runs the recorded path even when another bun sits first
  // on PATH by then; the same line spelled `bun ...` runs the decoy.
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

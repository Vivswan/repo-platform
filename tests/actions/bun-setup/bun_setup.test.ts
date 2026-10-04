// The first step of every platform action: a resolver that accepted the caller's bun would run the platform's scripts
// under a foreign bun, and a different bun rewrites bun.lock or picks other dependency versions with no error. The
// probe and the resolve are executed here per PATH state, so the two apply one test.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = join(import.meta.dir, "../../..");
const RUNNER_BASH = ["/bin/bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c"];
const BUN_DIR = realpathSync(join(process.execPath, ".."));

type Step = Record<string, unknown>;
const action = parseYaml(readFileSync(join(REPO_ROOT, "actions/bun-setup/action.yml"), "utf8"));
const steps: Step[] = action.runs.steps;
const stepById = (id: string): Step => {
  const step = steps.find((s) => s.id === id);
  if (step === undefined) throw new Error(`no step '${id}'`);
  return step;
};

function fakeBun(root: string, name: string, script: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "bun"), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  return dir;
}

function pathFor(onPath: "real" | "decoy" | "failing" | "lying" | "none", root: string): string {
  switch (onPath) {
    case "real":
      return BUN_DIR;
    case "decoy":
      return `${fakeBun(root, "decoy", 'echo "0.0.0"')}:${BUN_DIR}`;
    case "failing":
      return fakeBun(root, "failing", "exit 1");
    case "lying":
      return fakeBun(root, "lying", `echo "${Bun.version}"\nexit 97`);
    case "none":
      return join(root, "none");
  }
}

/** The only PATH entry beyond the test's own: `cat`, the one external
 *  command the steps run, so a system bun can never leak into a case. */
function toolsDir(root: string): string {
  const dir = join(root, "tools");
  if (existsSync(dir)) return dir;
  mkdirSync(dir);
  symlinkSync("/bin/cat", join(dir, "cat"));
  return dir;
}

function runStep(
  step: Step,
  fills: Record<string, string>,
  path: string,
  root: string,
): { exitCode: number; stdout: string; outputs: Record<string, string> } {
  const fill = (text: string): string => {
    let filled = text;
    for (const [expr, value] of Object.entries(fills)) filled = filled.replaceAll(expr, value);
    if (filled.includes("${{")) throw new Error(`unresolved expression in ${filled}`);
    return filled;
  };
  const outputs = join(root, `${String(step.id)}-outputs.txt`);
  writeFileSync(outputs, "");
  const env = Object.fromEntries(
    Object.entries((step.env ?? {}) as Record<string, string>).map(([k, v]) => [k, fill(v)]),
  );
  const proc = boundedSpawnSync([...RUNNER_BASH, fill(String(step.run))], {
    env: { ...env, PATH: `${path}:${toolsDir(root)}`, GITHUB_OUTPUT: outputs },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    outputs: Object.fromEntries(
      readFileSync(outputs, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("=", 2) as [string, string]),
    ),
  };
}

describe("actions/bun-setup", () => {
  // GitHub exposes no context for an action repository's root and unpacks a remote action without `.git`, so the
  // marker is found by walking up from a directory the caller names. Each row plants a tree and runs the step on it.
  test.each<{
    reason: string;
    plant: (root: string) => { pin: string; from: string };
    exitCode: number;
    error: (fills: { pin: string; from: string }) => string;
    outputs: (root: string) => Record<string, string>;
  }>([
    {
      reason: "`from` three directories below the marker finds it",
      plant: (root) => {
        writeFileSync(join(root, ".bun-version"), `${Bun.version}\n`);
        mkdirSync(join(root, "a/b/c"), { recursive: true });
        return { pin: "", from: join(root, "a/b/c") };
      },
      exitCode: 0,
      error: () => "",
      outputs: (root) => ({ file: join(root, ".bun-version") }),
    },
    {
      reason: "`from` with no marker anywhere above fails naming the start directory",
      plant: (root) => {
        mkdirSync(join(root, "a/b/c"), { recursive: true });
        return { pin: "", from: join(root, "a/b/c") };
      },
      exitCode: 1,
      error: ({ from }) => `::error::no .bun-version in ${from} or any directory above it`,
      outputs: () => ({}),
    },
    {
      reason: "`pin` and `from` together are refused",
      plant: (root) => ({ pin: join(root, ".bun-version"), from: root }),
      exitCode: 1,
      error: () => "::error::pass exactly one of pin and from",
      outputs: () => ({}),
    },
    {
      reason: "neither `pin` nor `from` is refused",
      plant: () => ({ pin: "", from: "" }),
      exitCode: 1,
      error: () => "::error::pass exactly one of pin and from",
      outputs: () => ({}),
    },
  ])("locate with $reason", ({ plant, exitCode, error, outputs }) => {
    const root = temp.dir("bun-setup-locate-");
    const fills = plant(root);
    const locate = runStep(
      stepById("locate"),
      { "${{ inputs.pin }}": fills.pin, "${{ inputs.from }}": fills.from },
      BUN_DIR,
      root,
    );
    expect([locate.exitCode, locate.outputs]).toEqual([exitCode, outputs(root)]);
    if (exitCode !== 0) expect(locate.stdout).toContain(error(fills));
  });

  test("neither setup attempt can end the action, the retry keys on the first attempt's outcome, and the resolve runs whatever they did", () => {
    // Under continue-on-error GitHub sets outcome to failure and conclusion to success, so a retry keyed on conclusion
    // never fires; actionlint does not read action.yml. Together with an unconditional resolve this is the
    // `required: false` contract validate-managed-files' report step depends on (its two-witness verdict needs the
    // action to reach that step whatever setup did).
    const setups = steps.filter((step) => typeof step.uses === "string");
    expect(setups.map((step) => [step["continue-on-error"], step.if])).toEqual([
      [true, "steps.probe.outputs.pinned != 'true'"],
      [true, "steps.setup-bun.outcome == 'failure'"],
    ]);
    expect(stepById("resolve").if).toBeUndefined();
  });

  const UNRESOLVED = { path: "", version: "", ready: "false", installed: "true" };
  // The probe decides whether setup-bun runs by the resolver's own test: an absolute path on PATH printing exactly the pin
  // and exiting 0. Both steps run here over one PATH; `outcome` is what the resolve would read from the setup step.
  test.each<{
    reason: string;
    onPath: "real" | "decoy" | "failing" | "lying" | "none";
    required: string;
    outcome: string;
    pinned: string;
    exitCode: number;
    outputs: Record<string, string>;
  }>([
    {
      reason: "the pinned bun first on PATH, setup skipped",
      onPath: "real",
      required: "true",
      outcome: "skipped",
      pinned: "true",
      exitCode: 0,
      outputs: { path: process.execPath, version: Bun.version, ready: "true", installed: "false" },
    },
    {
      reason: "the pinned bun first on PATH after an install",
      onPath: "real",
      required: "true",
      outcome: "success",
      pinned: "true",
      exitCode: 0,
      outputs: { path: process.execPath, version: Bun.version, ready: "true", installed: "true" },
    },
    {
      reason: "another version first on PATH, required",
      onPath: "decoy",
      required: "true",
      outcome: "failure",
      pinned: "false",
      exitCode: 1,
      outputs: UNRESOLVED,
    },
    {
      reason: "another version first on PATH, verdict left to the caller",
      onPath: "decoy",
      required: "false",
      outcome: "failure",
      pinned: "false",
      exitCode: 0,
      outputs: UNRESOLVED,
    },
    {
      reason: "a bun that fails to print its version",
      onPath: "failing",
      required: "false",
      outcome: "failure",
      pinned: "false",
      exitCode: 0,
      outputs: UNRESOLVED,
    },
    {
      reason: "a bun printing the pin but exiting nonzero",
      onPath: "lying",
      required: "false",
      outcome: "failure",
      pinned: "false",
      exitCode: 0,
      outputs: UNRESOLVED,
    },
    {
      reason: "no bun on PATH after a failed setup, required",
      onPath: "none",
      required: "true",
      outcome: "failure",
      pinned: "false",
      exitCode: 1,
      outputs: UNRESOLVED,
    },
    {
      reason: "no bun on PATH after a failed setup, verdict left to the caller",
      onPath: "none",
      required: "false",
      outcome: "failure",
      pinned: "false",
      exitCode: 0,
      outputs: UNRESOLVED,
    },
  ])(
    "probe and resolve with $reason",
    ({ onPath, required, outcome, pinned, exitCode, outputs }) => {
      const root = temp.dir("bun-setup-");
      const pin = join(root, ".bun-version");
      writeFileSync(pin, `${Bun.version}\n`);
      const path = pathFor(onPath, root);
      const probe = runStep(
        stepById("probe"),
        { "${{ steps.locate.outputs.file }}": pin },
        path,
        root,
      );
      expect([probe.exitCode, probe.outputs]).toEqual([0, { pinned }]);
      const resolve = runStep(
        stepById("resolve"),
        {
          "${{ steps.locate.outputs.file }}": pin,
          "${{ inputs.required }}": required,
          "${{ steps.setup-bun.outcome }}": outcome,
        },
        path,
        root,
      );
      expect([resolve.exitCode, resolve.outputs]).toEqual([exitCode, outputs]);
      if (exitCode !== 0) expect(resolve.stdout).toContain("::error::no bun matching the pin");
    },
  );
});

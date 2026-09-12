import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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

function fakeBun(root: string, name: string, version: string | null): string {
  const dir = join(root, name);
  mkdirSync(dir);
  const body = version === null ? "exit 1" : `echo "${version}"`;
  writeFileSync(join(dir, "bun"), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return dir;
}

/** The only PATH entry beyond the test's own: `cat`, the one external
 *  command the steps run, so a system bun can never leak into a case. */
function toolsDir(root: string): string {
  const dir = join(root, "tools");
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
  test("action.yml: pin in, path/ready/installed out, probe -> setup -> retry -> resolve with neither setup able to end the action", () => {
    expect(Object.keys(action.inputs)).toEqual(["pin", "required"]);
    expect(action.inputs.pin.required).toBe(true);
    expect(action.inputs.required.default).toBe("true");
    expect(action.outputs).toEqual({
      path: { description: expect.any(String), value: "${{ steps.resolve.outputs.path }}" },
      ready: { description: expect.any(String), value: "${{ steps.resolve.outputs.ready }}" },
      installed: {
        description: expect.any(String),
        value: "${{ steps.resolve.outputs.installed }}",
      },
      version: { description: expect.any(String), value: "${{ steps.resolve.outputs.version }}" },
    });
    expect(steps.map((step) => step.id)).toEqual([
      "probe",
      "setup-bun",
      "setup-bun-retry",
      "resolve",
    ]);
    expect(steps.filter((step) => typeof step.uses === "string")).toEqual([
      {
        name: "Set up bun",
        id: "setup-bun",
        if: "steps.probe.outputs.pinned != 'true'",
        "continue-on-error": true,
        uses: expect.stringMatching(/^oven-sh\/setup-bun@[0-9a-f]{40}$/),
        with: { "bun-version-file": "${{ inputs.pin }}" },
      },
      {
        name: "Set up bun (retry)",
        id: "setup-bun-retry",
        if: "steps.setup-bun.outcome == 'failure'",
        "continue-on-error": true,
        uses: expect.stringMatching(/^oven-sh\/setup-bun@[0-9a-f]{40}$/),
        with: { "bun-version-file": "${{ inputs.pin }}" },
      },
    ]);
    expect(stepById("probe").env).toEqual({ PIN_FILE: "${{ inputs.pin }}" });
    expect(stepById("resolve").env).toEqual({
      PIN_FILE: "${{ inputs.pin }}",
      REQUIRED: "${{ inputs.required }}",
      SETUP_OUTCOME: "${{ steps.setup-bun.outcome }}",
    });
  });

  // The probe's one output decides whether setup-bun runs, by the resolver's
  // own test: an absolute path on PATH printing exactly the pin and exiting 0.
  test.each<{ reason: string; onPath: string | null | "none" | "lying"; pinned: string }>([
    { reason: "the pinned version on PATH", onPath: "1.4.0", pinned: "true" },
    { reason: "another version on PATH", onPath: "1.3.9", pinned: "false" },
    { reason: "a bun that fails to print its version", onPath: null, pinned: "false" },
    { reason: "a bun printing the pin but exiting nonzero", onPath: "lying", pinned: "false" },
    { reason: "no bun on PATH", onPath: "none", pinned: "false" },
  ])("probe with $reason", ({ onPath, pinned }) => {
    const root = temp.dir("bun-setup-probe-");
    const pin = join(root, ".bun-version");
    writeFileSync(pin, "1.4.0\n");
    let path = join(root, "none");
    if (onPath === "lying") {
      path = join(root, "lying");
      mkdirSync(path);
      writeFileSync(join(path, "bun"), '#!/bin/bash\necho "1.4.0"\nexit 97\n', { mode: 0o755 });
    } else if (onPath !== "none") {
      path = fakeBun(root, "fake", onPath);
    }
    const result = runStep(stepById("probe"), { "${{ inputs.pin }}": pin }, path, root);
    expect([result.exitCode, result.outputs]).toEqual([0, { pinned }]);
  });

  test.each<{
    reason: string;
    onPath: "real" | "decoy" | "none";
    required: string;
    outcome: string;
    exitCode: number;
    outputs: Record<string, string>;
  }>([
    {
      reason: "the real bun first on PATH after an install",
      onPath: "real",
      required: "true",
      outcome: "success",
      exitCode: 0,
      outputs: { path: process.execPath, version: Bun.version, ready: "true", installed: "true" },
    },
    {
      reason: "the real bun first on PATH, setup skipped (pin was satisfied)",
      onPath: "real",
      required: "true",
      outcome: "skipped",
      exitCode: 0,
      outputs: { path: process.execPath, version: Bun.version, ready: "true", installed: "false" },
    },
    {
      reason: "a decoy bun first on PATH, required",
      onPath: "decoy",
      required: "true",
      outcome: "failure",
      exitCode: 1,
      outputs: { path: "", version: "", ready: "false", installed: "true" },
    },
    {
      reason: "a decoy bun first on PATH, verdict left to the caller",
      onPath: "decoy",
      required: "false",
      outcome: "failure",
      exitCode: 0,
      outputs: { path: "", version: "", ready: "false", installed: "true" },
    },
    {
      reason: "no bun on PATH after a failed setup, required",
      onPath: "none",
      required: "true",
      outcome: "failure",
      exitCode: 1,
      outputs: { path: "", version: "", ready: "false", installed: "true" },
    },
    {
      reason: "no bun on PATH after a failed setup, verdict left to the caller",
      onPath: "none",
      required: "false",
      outcome: "failure",
      exitCode: 0,
      outputs: { path: "", version: "", ready: "false", installed: "true" },
    },
  ])("resolve with $reason", ({ onPath, required, outcome, exitCode, outputs }) => {
    const root = temp.dir("bun-setup-resolve-");
    const pin = join(root, ".bun-version");
    writeFileSync(pin, `${Bun.version}\n`);
    const path = {
      real: BUN_DIR,
      decoy: `${fakeBun(root, "decoy", "0.0.0")}:${BUN_DIR}`,
      none: join(root, "none"),
    }[onPath];
    const result = runStep(
      stepById("resolve"),
      {
        "${{ inputs.pin }}": pin,
        "${{ inputs.required }}": required,
        "${{ steps.setup-bun.outcome }}": outcome,
      },
      path,
      root,
    );
    expect([result.exitCode, result.outputs]).toEqual([exitCode, outputs]);
    if (exitCode !== 0) expect(result.stdout).toContain("::error::no bun matching the pin");
  });
});

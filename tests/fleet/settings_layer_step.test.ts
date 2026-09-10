// settings_layer_step.ts: the label preflight leg behind run_hidden.
// A stub bun on PATH records every argv the leg spawns (the script itself
// runs under the real bun, by path), so each row's WHOLE call list is
// asserted against argv typed here from the workflow's landed shape - one
// wrapped call, no more - and the child's exit code is proven to be the
// step's.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { argvStub } from "../shared/argv_stub";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SCRIPTS = join(import.meta.dir, "../../.github/scripts");
const script = join(SCRIPTS, "fleet/settings_layer_step.ts");
const SHA = "0123456789abcdef0123456789abcdef01234567";

function run(leg: string | undefined, env: Record<string, string | undefined>) {
  const stub = argvStub(temp.dir("layer-step-"), "bun");
  const proc = boundedSpawnSync([process.execPath, script, ...(leg === undefined ? [] : [leg])], {
    env: {
      ...process.env,
      PATH: `${stub.bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      RUNNER_TEMP: "/rt",
      PINNED: SHA,
      MODE: "check",
      STUB_EXIT: undefined,
      ...env,
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
    calls: stub.calls(),
  };
}

const WRAP = ["bun", join(SCRIPTS, "sync/run_hidden.ts")];
const LABELS = ["bun", join(SCRIPTS, "fleet/label_preflight.ts")];
const OPERATOR = "Vivswan/repo-platform";
const MANAGED = "Vivswan/managed";

describe("settings_layer_step.ts", () => {
  // One row per row kind and mode; the operator row is the checkout,
  // every other target is fetched at the pinned commit. Both modes are
  // judged: a leg that folded apply into check would let an apply delete
  // referenced labels behind a warning.
  test.each<{ leg: string; target: string; mode: string; argv: string[] }>([
    {
      leg: "labels",
      target: OPERATOR,
      mode: "apply",
      argv: [
        ...WRAP,
        "settings labels",
        "--",
        ...LABELS,
        "--merged",
        "/rt/merged-settings.yml",
        "--repo",
        OPERATOR,
        "--target-dir",
        ".",
        "--mode",
        "apply",
      ],
    },
    {
      leg: "labels",
      target: OPERATOR,
      mode: "check",
      argv: [
        ...WRAP,
        "settings labels",
        "--",
        ...LABELS,
        "--merged",
        "/rt/merged-settings.yml",
        "--repo",
        OPERATOR,
        "--target-dir",
        ".",
        "--mode",
        "check",
      ],
    },
    {
      leg: "labels",
      target: MANAGED,
      mode: "apply",
      argv: [
        ...WRAP,
        "settings labels",
        "--",
        ...LABELS,
        "--merged",
        "/rt/merged-settings.yml",
        "--repo",
        MANAGED,
        "--ref",
        SHA,
        "--mode",
        "apply",
      ],
    },
    {
      leg: "labels",
      target: MANAGED,
      mode: "check",
      argv: [
        ...WRAP,
        "settings labels",
        "--",
        ...LABELS,
        "--merged",
        "/rt/merged-settings.yml",
        "--repo",
        MANAGED,
        "--ref",
        SHA,
        "--mode",
        "check",
      ],
    },
  ])(
    "the $leg leg for $target in $mode mode runs exactly one wrapped call with the pinned argv",
    ({ leg, target, mode, argv }) => {
      expect(run(leg, { TARGET: target, MODE: mode })).toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
        calls: [argv],
      });
    },
  );

  test("the wrapped command's exit code is the step's", () => {
    expect(run("labels", { TARGET: MANAGED, STUB_EXIT: "3" })).toEqual({
      exitCode: 3,
      stdout: "",
      stderr: "",
      calls: [
        [
          ...WRAP,
          "settings labels",
          "--",
          ...LABELS,
          "--merged",
          "/rt/merged-settings.yml",
          "--repo",
          MANAGED,
          "--ref",
          SHA,
          "--mode",
          "check",
        ],
      ],
    });
  });

  test("PINNED and MODE pass through empty when unset: the called scripts own that refusal", () => {
    expect(run("labels", { TARGET: MANAGED, PINNED: undefined, MODE: undefined })).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
      calls: [
        [
          ...WRAP,
          "settings labels",
          "--",
          ...LABELS,
          "--merged",
          "/rt/merged-settings.yml",
          "--repo",
          MANAGED,
          "--ref",
          "",
          "--mode",
          "",
        ],
      ],
    });
  });

  test.each([
    {
      reason: "an unknown leg",
      leg: "apply",
      env: {},
      stdout: "::error::settings_layer_step.ts: expected one of labels, got 'apply'\n",
    },
    {
      reason: "no leg at all",
      leg: undefined,
      env: {},
      stdout: "::error::settings_layer_step.ts: expected one of labels, got ''\n",
    },
    {
      reason: "a missing TARGET",
      leg: "labels",
      env: { TARGET: "" },
      stdout: "::error::TARGET must be set\n",
    },
  ])("$reason exits 2 before spawning anything", ({ leg, env, stdout }) => {
    expect(run(leg, env)).toEqual({ exitCode: 2, stdout, stderr: "", calls: [] });
  });
});

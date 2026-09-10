// The zizmor action's contract: the fleet policy is copied into the
// workspace (the upstream container mounts nothing else) unless the
// repository carries its own, the SARIF pass is visibility-keyed and never
// the verdict, the verdict pass fails on high alone, and the copy is
// removed whatever the passes said.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadAction, REPO_ROOT, runBashStep, stepNamed } from "../../shared/action_step";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/zizmor/action.yml");
const [resolve, upload, gate, cleanup] = action.runs.steps;
const ACTION_DIR = join(REPO_ROOT, "actions/zizmor");
const COPY = ".zizmor-fleet-policy.yml";
const UPSTREAM = /^zizmorcore\/zizmor-action@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

describe("actions/zizmor", () => {
  test("one input (the upload switch), four steps: resolve, upload, gate, cleanup", () => {
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs ?? {})).toEqual(["upload-sarif"]);
    expect(action.inputs?.["upload-sarif"]?.default).toBe("true");
    expect(action.runs.steps.map((step) => step.name)).toEqual([
      "Resolve the policy",
      "Upload every finding to code scanning",
      "Fail on a high finding",
      "Remove the copied policy",
    ]);
  });

  test("both zizmor passes ride the same sha-pinned upstream at the same zizmor version and policy", () => {
    // The pin line as written (the parsed uses drops the version comment).
    const pins = readFileSync(join(REPO_ROOT, "actions/zizmor/action.yml"), "utf8")
      .split("\n")
      .filter((line) => line.includes("uses: zizmorcore/"))
      .map((line) => line.trim().replace(/^uses: /, ""));
    expect(pins).toHaveLength(2);
    expect(pins[0]).toMatch(UPSTREAM);
    expect(pins[1]).toBe(pins[0]);
    for (const step of [upload, gate]) {
      const w = step.with as Record<string, string>;
      expect(w.config).toBe("${{ steps.policy.outputs.path }}");
      expect(w.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    // The same zizmor: a finding the upload reports is the one the gate judges.
    expect((gate.with as Record<string, string>).version).toBe(
      (upload.with as Record<string, string>).version,
    );
  });

  test("the upload pass is keyed on the input and uploads medium and above; SARIF mode cannot fail", () => {
    expect(upload.if).toBe("inputs.upload-sarif == 'true'");
    expect(upload.with).toMatchObject({ "advanced-security": true, "min-severity": "medium" });
  });

  test("the gate pass is unconditional, plain-format (exit codes live), high only", () => {
    expect(gate.if).toBeUndefined();
    expect(gate.with).toMatchObject({ "advanced-security": false, "min-severity": "high" });
  });

  const runStep = (name: string, repo: string) =>
    runBashStep(stepNamed(action, name), {
      fills: { "${{ github.action_path }}": ACTION_DIR },
      cwd: repo,
      root: repo,
    });

  test("resolve: the fleet policy beside the action is copied into the workspace when the repository has none", () => {
    const repo = temp.dir("zizmor-none-");
    const run = runStep("Resolve the policy", repo);
    // A workspace-relative path: the container sees /workspace, never the
    // runner's action path.
    expect([run.exitCode, run.outputs]).toEqual([0, { path: COPY }]);
    expect(readFileSync(join(repo, COPY), "utf8")).toBe(
      readFileSync(join(ACTION_DIR, "zizmor.yml"), "utf8"),
    );
    expect(resolve.id).toBe("policy");
  });

  test("resolve: the repository's own .github/zizmor.yml replaces the fleet policy and nothing is copied", () => {
    const repo = temp.dir("zizmor-own-");
    mkdirSync(join(repo, ".github"));
    writeFileSync(join(repo, ".github/zizmor.yml"), "rules: {}\n");
    const run = runStep("Resolve the policy", repo);
    expect([run.exitCode, run.outputs]).toEqual([0, { path: ".github/zizmor.yml" }]);
    expect(existsSync(join(repo, COPY))).toBe(false);
  });

  test("cleanup: always runs, removes the copy, and is a no-op when nothing was copied", () => {
    expect(cleanup.if).toBe("always()");
    const repo = temp.dir("zizmor-cleanup-");
    runStep("Resolve the policy", repo);
    expect(existsSync(join(repo, COPY))).toBe(true);
    expect(runStep("Remove the copied policy", repo).exitCode).toBe(0);
    expect(existsSync(join(repo, COPY))).toBe(false);
    expect(runStep("Remove the copied policy", repo).exitCode).toBe(0);
  });

  test("the fleet policy: ref pins for the delivery channel only, sha pins elsewhere at medium, two managed-file ignores", () => {
    const policy = parseYaml(readFileSync(join(REPO_ROOT, "actions/zizmor/zizmor.yml"), "utf8"));
    expect(policy).toEqual({
      rules: {
        "unpinned-uses": {
          config: { policies: { "Vivswan/repo-platform/*": "ref-pin", "*": "hash-pin" } },
          remap: { severity: "medium" },
        },
        "dangerous-triggers": { ignore: ["auto-assign.yml"] },
        "bot-conditions": { ignore: ["dependabot-bun-lockfile.yml"] },
      },
    });
  });
});

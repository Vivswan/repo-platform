// The zizmor action's contract: the fleet policy is passed unless the
// repository carries its own, the SARIF pass is visibility-keyed and never
// the verdict, and the verdict pass fails on high alone.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadAction, REPO_ROOT, runBashStep, stepNamed } from "../../shared/action_step";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/zizmor/action.yml");
const [resolve, upload, gate] = action.runs.steps;
const UPSTREAM = /^zizmorcore\/zizmor-action@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

describe("actions/zizmor", () => {
  test("one input (the upload switch), three steps: resolve, upload, gate", () => {
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs ?? {})).toEqual(["upload-sarif"]);
    expect(action.inputs?.["upload-sarif"]?.default).toBe("true");
    expect(action.runs.steps.map((step) => step.name)).toEqual([
      "Resolve the policy",
      "Upload every finding to code scanning",
      "Fail on a high finding",
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

  const resolvePolicy = (repo: string) =>
    runBashStep(stepNamed(action, "Resolve the policy"), {
      fills: { "${{ github.action_path }}": "/opt/action" },
      cwd: repo,
      root: repo,
    });

  test("resolve: the fleet policy beside the action when the repository has none", () => {
    const repo = temp.dir("zizmor-none-");
    const run = resolvePolicy(repo);
    expect([run.exitCode, run.outputs]).toEqual([0, { path: "/opt/action/zizmor.yml" }]);
    expect(resolve.id).toBe("policy");
  });

  test("resolve: the repository's own .github/zizmor.yml replaces the fleet policy", () => {
    const repo = temp.dir("zizmor-own-");
    mkdirSync(join(repo, ".github"));
    writeFileSync(join(repo, ".github/zizmor.yml"), "rules: {}\n");
    const run = resolvePolicy(repo);
    expect([run.exitCode, run.outputs]).toEqual([0, { path: ".github/zizmor.yml" }]);
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

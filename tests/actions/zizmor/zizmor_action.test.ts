// The upstream container mounts nothing but the workspace, so the fleet policy is copied into it unless the repository carries its own.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadAction, REPO_ROOT, runBashStep, stepNamed } from "../../shared/action_step";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/zizmor/action.yml");
const [resolve, upload, uploadRetry, gate, gateRetry, cleanup] = action.runs.steps;
const ACTION_DIR = join(REPO_ROOT, "actions/zizmor");
const COPY = ".zizmor-fleet-policy.yml";
const UPSTREAM = /^zizmorcore\/zizmor-action@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

describe("actions/zizmor", () => {
  test("one input (the upload switch), six steps: resolve, each pass with its retry, cleanup", () => {
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs ?? {})).toEqual(["upload-sarif"]);
    expect(action.inputs?.["upload-sarif"]?.default).toBe("true");
    expect(action.runs.steps.map((step) => step.name)).toEqual([
      "Resolve the policy",
      "Upload the high findings to code scanning",
      "Upload the high findings to code scanning (retry)",
      "Fail on a high finding",
      "Fail on a high finding (retry)",
      "Remove the copied policy",
    ]);
  });

  test("every zizmor attempt rides the same sha-pinned upstream at the same zizmor version and policy", () => {
    // The pin line as written (the parsed uses drops the version comment).
    const pins = readFileSync(join(REPO_ROOT, "actions/zizmor/action.yml"), "utf8")
      .split("\n")
      .filter((line) => line.includes("uses: zizmorcore/"))
      .map((line) => line.trim().replace(/^uses: /, ""));
    expect(pins).toHaveLength(4);
    expect(pins[0]).toMatch(UPSTREAM);
    expect(new Set(pins).size).toBe(1);
    for (const step of [upload, uploadRetry, gate, gateRetry]) {
      const w = step.with as Record<string, string>;
      expect(w.config).toBe("${{ steps.policy.outputs.path }}");
      expect(w.version).toMatch(/^\d+\.\d+\.\d+$/);
      // The same zizmor: a finding the upload reports is the one the gate judges.
      expect(w.version).toBe((upload.with as Record<string, string>).version);
    }
  });

  // A high finding fails both judging attempts alike; a transient error
  // fails the first and passes the second.
  test.each([
    {
      pass: "upload",
      first: upload,
      retry: uploadRetry,
      id: "sarif",
      firstIf: "inputs.upload-sarif == 'true'",
      retryName: "Upload the high findings to code scanning (retry)",
      inputs: { "advanced-security": true, "min-severity": "high" },
    },
    {
      pass: "gate",
      first: gate,
      retry: gateRetry,
      id: "gate",
      firstIf: undefined,
      retryName: "Fail on a high finding (retry)",
      inputs: { "advanced-security": false, "min-severity": "high" },
    },
  ])(
    "the $pass pass: a softened first attempt and a verdict-carrying retry of the same invocation",
    ({ first, retry, id, firstIf, retryName, inputs }) => {
      expect(first).toEqual({
        name: retryName.replace(" (retry)", ""),
        id,
        ...(firstIf === undefined ? {} : { if: firstIf }),
        "continue-on-error": true,
        uses: expect.stringMatching(/^zizmorcore\/zizmor-action@[0-9a-f]{40}$/),
        with: {
          config: "${{ steps.policy.outputs.path }}",
          version: expect.any(String),
          ...inputs,
        },
      });
      // No continue-on-error: the retry's result is the pass's.
      expect(retry).toEqual({
        name: retryName,
        if: `steps.${id}.outcome == 'failure'`,
        uses: first.uses,
        with: first.with,
      });
    },
  );

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

  test("the fleet policy: ref pins for the delivery channel only, sha pins elsewhere at zizmor's own severity, two managed-file ignores", () => {
    const policy = parseYaml(readFileSync(join(REPO_ROOT, "actions/zizmor/zizmor.yml"), "utf8"));
    expect(policy).toEqual({
      rules: {
        "unpinned-uses": {
          config: { policies: { "Vivswan/repo-platform/*": "ref-pin", "*": "hash-pin" } },
        },
        "dangerous-triggers": { ignore: ["auto-assign.yml"] },
        "bot-conditions": { ignore: ["dependabot-bun-lockfile.yml"] },
      },
    });
  });
});

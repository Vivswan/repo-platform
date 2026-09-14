// The upstream container mounts nothing but the workspace, so the fleet policy is rendered into it for every repository.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_NAME } from "../../../actions/shared/platform";
import { loadAction, REPO_ROOT, runBashStep, stepNamed } from "../../shared/action_step";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/zizmor/action.yml");
const [, upload, uploadRetry, gate, gateRetry] = action.runs.steps;
const ACTION_DIR = join(REPO_ROOT, "actions/zizmor");
const COPY = ".zizmor-fleet-policy.yml";
const OWNER = "acme";
const UPSTREAM = /^zizmorcore\/zizmor-action@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

const withOf = (step: Record<string, unknown>) => step.with as Record<string, string | boolean>;

describe("actions/zizmor", () => {
  test("every attempt rides one sha-pinned upstream at one zizmor version, a retry keys on its first attempt's outcome, and the gate runs outside SARIF mode", () => {
    // Dependabot bumps the four `uses` lines together; the four `version:` inputs are hand-edited, so a partial edit
    // uploads SARIF from one zizmor and gates on another, green.
    const pins = readFileSync(join(ACTION_DIR, "action.yml"), "utf8")
      .split("\n")
      .filter((line) => line.includes("uses: zizmorcore/"))
      .map((line) => line.trim().replace(/^uses: /, ""));
    expect(pins).toHaveLength(4);
    expect(pins[0]).toMatch(UPSTREAM);
    expect(new Set(pins).size).toBe(1);
    const attempts = [upload, uploadRetry, gate, gateRetry];
    // Without `config` zizmor discovers the repository's own configuration and the rendered fleet policy is dead weight.
    expect(attempts.map((step) => withOf(step).config)).toEqual(
      attempts.map(() => "${{ steps.policy.outputs.path }}"),
    );
    expect(new Set(attempts.map((step) => withOf(step).version)).size).toBe(1);
    expect(withOf(upload).version).toMatch(/^\d+\.\d+\.\d+$/);
    // Under continue-on-error GitHub sets outcome to failure and conclusion to success: a retry keyed on conclusion
    // never runs, and a high finding on a transient first attempt passes. actionlint does not read action.yml.
    expect(
      attempts.map((step) => [step.id, step.if, step["continue-on-error"], step.with]),
    ).toEqual([
      ["sarif", "inputs.upload-sarif == 'true'", true, upload.with],
      [undefined, "steps.sarif.outcome == 'failure'", undefined, upload.with],
      ["gate", undefined, true, gate.with],
      [undefined, "steps.gate.outcome == 'failure'", undefined, gate.with],
    ]);
    // SARIF mode suppresses zizmor's finding exit codes, so a gate in SARIF mode never fails.
    expect([withOf(upload)["advanced-security"], withOf(gate)["advanced-security"]]).toEqual([
      true,
      false,
    ]);
  });

  const render = (repo: string) =>
    runBashStep(stepNamed(action, "Render the fleet policy"), {
      fills: { "${{ github.action_path }}": ACTION_DIR, "${{ github.repository_owner }}": OWNER },
      cwd: repo,
      root: repo,
    });

  test("render: the fleet policy lands in the workspace with the caller's owner filled in", () => {
    // A workspace-relative path: the container sees /workspace, never the runner's action path; an unreadable config
    // path would leave zizmor auditing under its defaults, green.
    const repo = temp.dir("zizmor-render-");
    const run = render(repo);
    expect([run.exitCode, run.outputs]).toEqual([0, { path: COPY }]);
    expect(readFileSync(join(repo, COPY), "utf8")).toBe(
      readFileSync(join(ACTION_DIR, "zizmor.yml"), "utf8").replaceAll("{{github_username}}", OWNER),
    );
  });

  test("the rendered policy: ref pins for the caller's delivery channel only, sha pins elsewhere at zizmor's own severity, no ignores", () => {
    // The fleet's pinning rule in one document (docs/build-provenance.md; .github/pinact.yaml ignores the same
    // channel): a widened first key or a loosened second stops flagging unpinned actions fleet-wide with nothing red.
    const repo = temp.dir("zizmor-policy-");
    render(repo);
    const policy = parseYaml(readFileSync(join(repo, COPY), "utf8"));
    expect(policy).toEqual({
      rules: {
        "unpinned-uses": {
          config: {
            policies: { [`${OWNER}/${PLATFORM_NAME}/*`]: "ref-pin", "*": "hash-pin" },
          },
        },
      },
    });
  });
});

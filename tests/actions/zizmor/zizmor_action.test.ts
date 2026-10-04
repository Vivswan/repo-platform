// The two passes read one rendered policy at one severity floor: split, code scanning shows findings the gate waves
// through, or the gate fails on findings code scanning never saw.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_NAME } from "../../../actions/shared/platform";
import { loadAction, REPO_ROOT, runBashStep, stepNamed } from "../../shared/action_step";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/zizmor/action.yml");
const ACTION_DIR = join(REPO_ROOT, "actions/zizmor");
const OWNER = "acme";
const sarif = stepNamed(action, "Write the high findings as SARIF");
const gate = stepNamed(action, "Fail on a high finding");
const upload = stepNamed(action, "Upload the high findings to code scanning");

describe("actions/zizmor", () => {
  test("the SARIF pass is the gate's command plus the format and its file, and the upload reads that file", () => {
    // zizmor exits 0 in SARIF mode whatever it finds, so a `--format` on the gate judges nothing; a flag or a token on
    // one pass alone (online audits need the token) judges findings the other never saw.
    const sarifRun = String(sarif.run);
    const tail = ` --format sarif . > "$RUNNER_TEMP/zizmor.sarif"`;
    expect(sarifRun.endsWith(tail)).toBe(true);
    expect([`${sarifRun.slice(0, -tail.length)} .`, sarif.env]).toEqual([
      String(gate.run),
      gate.env,
    ]);
    expect(String(gate.run)).not.toContain("--format");
    // The upload runs exactly when the SARIF pass ran, on the file it wrote: a skipped pass leaves none and the upload fails.
    expect([upload.if, (upload.with as Record<string, string>).sarif_file]).toEqual([
      sarif.if,
      "${{ runner.temp }}/zizmor.sarif",
    ]);
  });

  const render = (workspace: string, runnerTemp: string) =>
    runBashStep(stepNamed(action, "Render the fleet policy"), {
      fills: { "${{ github.action_path }}": ACTION_DIR, "${{ github.repository_owner }}": OWNER },
      env: { RUNNER_TEMP: runnerTemp },
      cwd: workspace,
      root: runnerTemp,
    });

  test("render: the fleet policy lands in the runner's temp dir with the caller's owner filled in, and the checkout stays untouched", () => {
    const workspace = temp.dir("zizmor-workspace-");
    const runnerTemp = temp.dir("zizmor-render-");
    expect(render(workspace, runnerTemp).exitCode).toBe(0);
    expect(readFileSync(join(runnerTemp, "zizmor.yml"), "utf8")).toBe(
      readFileSync(join(ACTION_DIR, "zizmor.yml"), "utf8").replaceAll("{{github_username}}", OWNER),
    );
    expect(readdirSync(workspace)).toEqual([]);
  });

  test("the rendered policy: ref pins for the caller's delivery channel only, sha pins elsewhere at zizmor's own severity, no ignores", () => {
    // The fleet's pinning rule in one document (docs/platform/build-provenance.md; .github/pinact.yaml ignores the same
    // channel): a widened first key or a loosened second stops flagging unpinned actions fleet-wide with nothing red.
    const runnerTemp = temp.dir("zizmor-policy-");
    render(temp.dir("zizmor-workspace-"), runnerTemp);
    const policy = parseYaml(readFileSync(join(runnerTemp, "zizmor.yml"), "utf8"));
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

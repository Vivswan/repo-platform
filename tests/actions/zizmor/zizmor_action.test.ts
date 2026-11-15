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

describe("actions/zizmor", () => {
  const render = (workspace: string, runnerTemp: string) =>
    runBashStep(stepNamed(action, "Render the fleet policy"), {
      context: { "github.action_path": ACTION_DIR, "github.repository_owner": OWNER },
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

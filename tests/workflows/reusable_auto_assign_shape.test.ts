// The assignee is the repository owner by expression; CODEOWNERS is not read, so a repo-owned wildcard override below
// the managed region no longer changes it. GitHub's own CODEOWNERS review request covers the review.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { substitute } from "../../.github/scripts/sync/writer/placeholders.ts";

const ROOT = join(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const REUSABLE = ".github/workflows/reusable-auto-assign.yml";
const CALLER = "files/base/.github/workflows/auto-assign.yml";
const ASSIGN =
  'gh api -X POST "repos/$GH_REPO/issues/$NUMBER/assignees" -f "assignees[]=$ASSIGNEE"';

describe("reusable-auto-assign.yml", () => {
  test("one job of two gh steps: the owner by expression, no checkout, no CODEOWNERS read, no review request", () => {
    expect(parseYaml(read(REUSABLE))).toEqual({
      name: "Reusable Auto Assign",
      on: {
        workflow_call: {
          inputs: {
            issue: {
              description: "Issue or PR number to assign (dispatch only; empty means sweep)",
              required: false,
              type: "string",
              default: "",
            },
          },
        },
      },
      jobs: {
        assign: {
          if:
            "((github.event_name == 'issues' || github.event_name == 'pull_request') && github.actor != 'dependabot[bot]') || " +
            "github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'",
          "runs-on": "ubuntu-latest",
          "timeout-minutes": 10,
          permissions: { "issues": "write", "pull-requests": "write" },
          env: {
            GH_TOKEN: "${{ github.token }}",
            GH_REPO: "${{ github.repository }}",
            ASSIGNEE: "${{ github.repository_owner }}",
          },
          steps: [
            {
              name: "Assign the opened or dispatched item to the repository owner",
              if:
                "github.event_name == 'issues' || " +
                "(github.event_name == 'pull_request' && github.event.action == 'opened' && " +
                "github.event.pull_request.head.repo.full_name == github.repository) || " +
                "(github.event_name == 'workflow_dispatch' && inputs.issue != '')",
              env: {
                NUMBER:
                  "${{ github.event.issue.number || github.event.pull_request.number || inputs.issue }}",
              },
              run: ASSIGN,
            },
            {
              name: "Sweep open unassigned issues and PRs to the repository owner",
              if: "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.issue == '')",
              shell: "bash",
              run:
                "gh api --paginate \"repos/$GH_REPO/issues?state=open&per_page=100\" --jq '.[] | select(.assignees == []) | .number' | " +
                'xargs -r -I{} gh api -X POST "repos/$GH_REPO/issues/{}/assignees" -f "assignees[]=$ASSIGNEE"',
            },
          ],
        },
      },
    });
    expect(read(REUSABLE)).not.toMatch(/CODEOWNERS|requestReviewers|github-script/);
  });

  test("the managed caller: one job over one source, no CodeQL variant", () => {
    expect(parseYaml(substitute(read(CALLER), { github_username: "owner" }))).toEqual({
      name: "Auto Assign",
      on: {
        workflow_dispatch: {
          inputs: {
            issue: {
              description:
                "Issue or PR number to assign (leave empty to sweep every open unassigned item)",
              required: false,
              default: "",
            },
          },
        },
        issues: { types: ["opened"] },
        pull_request: { types: ["opened"] },
        schedule: [{ cron: "13 6 * * *" }],
      },
      permissions: {},
      jobs: {
        "auto-assign": {
          permissions: { "contents": "read", "issues": "write", "pull-requests": "write" },
          uses: "owner/repo-platform/.github/workflows/reusable-auto-assign.yml@stable",
          with: { issue: "${{ inputs.issue || '' }}" },
        },
      },
    });
    const entries = (
      parseYaml(read("files.yml")) as { files: Record<string, unknown>[] }
    ).files.filter((entry) => entry.path === ".github/workflows/auto-assign.yml");
    expect(entries).toEqual([{ path: ".github/workflows/auto-assign.yml", class: "managed" }]);
    expect(existsSync(join(ROOT, "files/base/.github/workflows/auto-assign.codeql.yml"))).toBe(
      false,
    );
  });
});

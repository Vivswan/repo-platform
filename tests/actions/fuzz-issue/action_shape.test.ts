// The composite's plumbing: the stock issue action step and its inputs, the mode gates, and the gh lines run against a recording gh stub.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, runBashStep, type Step, stepNamed } from "../../shared/action_step";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/fuzz-issue/action.yml");
const steps = action.runs.steps;

const REPORT = "inputs.mode == 'report'";
const RESOLVE = "inputs.mode == 'resolve'";
const LABEL = "fuzz-nightly";
const CLOSE_COMMENT = "Nightly fuzz passed on 2026-03-04.\n\nClosing.";

const fills = {
  "${{ inputs.token }}": "t",
  "${{ inputs.label }}": LABEL,
  "${{ inputs.label-color }}": "B60205",
  "${{ inputs.label-description }}": "Automated nightly fuzz failure",
};

/** Runs `step` with a gh stub on PATH that records every argv and answers `issue list` with `listed`, exiting `listExit`. */
function runWithGh(
  step: Step,
  listed: string,
  listExit = 0,
): { exitCode: number; outputs: Record<string, string>; gh: string[][] } {
  const root = temp.dir("fuzz-issue-step-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "gh.log");
  const list = join(root, "list.txt");
  writeFileSync(list, listed);
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/bash",
      `printf '%s\\x1f' "$@" >> "${log}"; printf '\\x1e' >> "${log}"`,
      `if [ "$1 $2" = "issue list" ]; then cat "${list}"; exit ${listExit}; fi`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  const comment = join(root, "comment.md");
  writeFileSync(comment, CLOSE_COMMENT);
  const run = runBashStep(step, {
    fills: { ...fills, "${{ steps.body.outputs.file }}": comment },
    cwd: root,
    root,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GITHUB_REPOSITORY: "o/r" },
  });
  const gh = readFileSync(log, "utf8")
    .split("\x1e")
    .filter((record) => record !== "")
    .map((record) => record.split("\x1f").slice(0, -1));
  return { exitCode: run.exitCode, outputs: run.outputs, gh };
}

const list = (label: string, limit: string, jq: string) => [
  "issue",
  "list",
  "--repo",
  "o/r",
  "--label",
  label,
  "--state",
  "open",
  "--limit",
  limit,
  "--json",
  "number",
  "--jq",
  jq,
];

describe("the fuzz-issue composite", () => {
  test("the stock action files or refreshes the newest open labeled issue from the assembled body, owner assigned", () => {
    const issue = stepNamed(action, "File or refresh the issue");
    expect(issue.id).toBe("issue");
    expect(issue.if).toBe(REPORT);
    expect(issue.uses).toMatch(/^peter-evans\/create-issue-from-file@[0-9a-f]{40}$/);
    expect(issue.with).toEqual({
      token: "${{ inputs.token }}",
      "issue-number": "${{ steps.open.outputs.number }}",
      title: "${{ inputs.title }}",
      "content-filepath": "${{ steps.body.outputs.file }}",
      labels: "${{ inputs.label }}",
      assignees: "${{ github.repository_owner }}",
    });
    expect(action.outputs).toEqual({
      "issue-number": expect.objectContaining({
        value: "${{ steps.issue.outputs.issue-number }}",
      }),
    });
  });

  test("the assembly runs in both modes on the action's own bun; the plumbing is gated per mode", () => {
    const gates = steps.map((step) => [step.name, step.if]);
    expect(gates).toEqual([
      ["Set up the action's bun", undefined],
      ["Assemble the issue body or the close comment", undefined],
      ["Find the stream's open issue", REPORT],
      ["Create the stream's label", REPORT],
      ["File or refresh the issue", REPORT],
      ["Close the stream's open issues", RESOLVE],
    ]);
    const body = stepNamed(action, "Assemble the issue body or the close comment");
    expect(body.id).toBe("body");
    expect(body.run).toBe('"$ACTION_BUN" "${{ github.action_path }}/fuzz-issue.ts"');
    expect(body.env).toEqual({
      MODE: "${{ inputs.mode }}",
      ARTIFACTS_DIR: "${{ inputs.artifacts-dir }}",
      ARTIFACT_NAME: "${{ inputs.artifact-name }}",
      STREAM: "${{ inputs.stream }}",
      TITLE: "${{ inputs.title }}",
      LABEL_COLOR: "${{ inputs.label-color }}",
      LABEL_DESCRIPTION: "${{ inputs.label-description }}",
      ACTION_BUN: "${{ steps.action-bun.outputs.path }}",
    });
  });

  test.each([
    {
      listed: "7\n",
      number: "7",
      reason: "the newest open issue is refreshed",
    },
    { listed: "", number: "", reason: "no open issue means a create" },
  ])("find: $reason", ({ listed, number }) => {
    const step = stepNamed(action, "Find the stream's open issue");
    expect(step.id).toBe("open");
    const run = runWithGh(step, listed);
    expect([run.exitCode, run.outputs]).toEqual([0, { number }]);
    expect(run.gh).toEqual([list(LABEL, "1", ".[0].number // empty")]);
  });

  test("find: a failed listing fails the step instead of reading as no open issue (a duplicate create)", () => {
    const run = runWithGh(stepNamed(action, "Find the stream's open issue"), "", 1);
    expect([run.exitCode, run.outputs]).toEqual([1, {}]);
  });

  test("label: created or repainted to the stream's tuple in one forced call", () => {
    const run = runWithGh(stepNamed(action, "Create the stream's label"), "");
    expect(run.exitCode).toBe(0);
    expect(run.gh).toEqual([
      [
        "label",
        "create",
        LABEL,
        "--repo",
        "o/r",
        "--color",
        "B60205",
        "--description",
        "Automated nightly fuzz failure",
        "--force",
      ],
    ]);
  });

  test.each([
    {
      listed: "7\n3\n",
      closed: ["7", "3"],
      reason: "every open labeled issue, not just the first",
    },
    { listed: "", closed: [], reason: "no open issue closes nothing" },
  ])("close: $reason", ({ listed, closed }) => {
    const run = runWithGh(stepNamed(action, "Close the stream's open issues"), listed);
    expect(run.exitCode).toBe(0);
    expect(run.gh).toEqual([
      list(LABEL, "100", ".[].number"),
      ...closed.map((number) => [
        "issue",
        "close",
        number,
        "--repo",
        "o/r",
        "--reason",
        "completed",
        "--comment",
        CLOSE_COMMENT,
      ]),
    ]);
  });
});

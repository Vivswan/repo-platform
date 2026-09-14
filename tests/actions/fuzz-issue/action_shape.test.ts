// The gh lines of the composite, executed against a recording gh stub, and the two `with:` facts of the stock issue step
// that GitHub enforces nowhere.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, runBashStep, type Step, stepNamed } from "../../shared/action_step";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/fuzz-issue/action.yml");

const LABEL = "fuzz-nightly";
const CLOSE_COMMENT = "Nightly fuzz passed on 2026-03-04.\n\nClosing.";

const fills = {
  "${{ github.token }}": "t",
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
  test("the issue step assigns the owner and refreshes by the found number", () => {
    // An issue created with GITHUB_TOKEN fires no issues:opened event for the auto-assign workflow, so every nightly issue
    // would sit unassigned; an empty issue-number is the stock action's create, so the find step's output is the whole switch.
    const issue = stepNamed(action, "File or refresh the issue");
    const with_ = issue.with as Record<string, string>;
    expect([with_.assignees, with_["issue-number"]]).toEqual([
      "${{ github.repository_owner }}",
      "${{ steps.open.outputs.number }}",
    ]);
  });

  test.each<{
    listed: string;
    listExit: number;
    exitCode: number;
    outputs: Record<string, string>;
    reason: string;
  }>([
    {
      listed: "7\n",
      listExit: 0,
      exitCode: 0,
      outputs: { number: "7" },
      reason: "the newest open issue is refreshed",
    },
    {
      listed: "",
      listExit: 0,
      exitCode: 0,
      outputs: { number: "" },
      reason: "no open issue means a create",
    },
    {
      listed: "",
      listExit: 1,
      exitCode: 1,
      outputs: {},
      reason:
        "a failed listing fails the step: read as no open issue it would file a duplicate, both green",
    },
  ])("find: $reason", ({ listed, listExit, exitCode, outputs }) => {
    // gh lists newest first; `.[0].number // empty` writes nothing rather than `null` for an empty list.
    const run = runWithGh(stepNamed(action, "Find the stream's open issue"), listed, listExit);
    expect([run.exitCode, run.outputs, run.gh]).toEqual([
      exitCode,
      outputs,
      [list(LABEL, "1", ".[0].number // empty")],
    ]);
  });

  test.each([
    {
      listed: "7\n3\n",
      closed: ["7", "3"],
      reason: "every open labeled issue: release-health blocks while any carries the label",
    },
    {
      listed: "",
      closed: [],
      reason: "no open issue closes nothing (xargs -r keeps issue '' out)",
    },
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

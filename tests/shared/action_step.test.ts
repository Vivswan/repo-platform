import { expect, test } from "bun:test";
import { runBashStep } from "./action_step";
import { tempDirs } from "./temp_dir";

const temp = tempDirs();

// The runner fills a step once. A filler that reads its own output again turns an input's text into an expression,
// so a step test would pass on a value the runner hands the shell verbatim.
test("a step's env and run are filled once: a value that holds an expression reaches the shell as text", () => {
  const root = temp.dir("action-step-");
  const step = {
    id: "echo",
    env: { TITLE: "${{ inputs.title }}", LABEL: "${{ inputs.label }}" },
    run: 'echo "title=$TITLE" >> "$GITHUB_OUTPUT"\necho "label=$LABEL-${{ inputs.label }}" >> "$GITHUB_OUTPUT"\n',
  };

  const ran = runBashStep(step, {
    context: { "inputs.title": "${{ inputs.label }}", "inputs.label": "bug" },
    cwd: root,
    root,
  });

  expect([ran.exitCode, ran.stderr, ran.outputs]).toEqual([
    0,
    "",
    { title: "${{ inputs.label }}", label: "bug-bug" },
  ]);
});

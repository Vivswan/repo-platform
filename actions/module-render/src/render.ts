#!/usr/bin/env bun
// The module-render check's render and verdict. copier renders the
// template at the tree's recorded build commit into a scratch directory
// seeded with the tree's own answers file - exactly how `copier update`
// seeds the new render the sync merges - with the tree's module selection,
// visibility, and description as data; compare.ts then judges every
// managed file. Stale fails naming the files and the one sync dispatch
// that pushes the render onto the pull request's branch.
//
// Env: RUNNER_TEMP, GITHUB_REPOSITORY, GITHUB_HEAD_REF (the branch the
// remedy names; empty outside a pull request), GITHUB_STEP_SUMMARY
// (optional). Flags: --root <tree> (default cwd) and --src <template
// source> (default the operator repository on GitHub) let the upgrade-path
// harness judge a local fixture against a local clone. Flags, not env: bun
// loads a .env from the cwd, the caller's PR-editable checkout, and the
// source is what the --trust render executes, so only the action's own
// argv (which names neither) may choose it.

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env, error, requireEnv, run } from "../../shared/action_runtime.ts";
import { OPERATOR_REPO } from "../../shared/build_sha.ts";
import { compareManaged, remedyLine } from "./compare.ts";
import { ANSWERS_PATH, readSelection } from "./selection.ts";

const RENDER_TIMEOUT_MS = 600_000;

/** `--root` and `--src` off argv; anything else is a usage error. */
function flags(argv: string[]): { root: string; src: string } {
  const out = { root: ".", src: `gh:${OPERATOR_REPO}` };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if ((argv[i] !== "--root" && argv[i] !== "--src") || value === undefined) {
      error(`module-render: unknown or valueless argument ${argv[i]} (flags: --root, --src)`);
      process.exit(2);
    }
    out[argv[i] === "--root" ? "root" : "src"] = value;
  }
  return out;
}

const { root: rootFlag, src } = flags(process.argv.slice(2));
const root = resolve(rootFlag);
const scratch = join(requireEnv("RUNNER_TEMP"), "module-render");
const renderDir = join(scratch, "render");

function summary(lines: string[]): void {
  const file = env("GITHUB_STEP_SUMMARY");
  if (file !== "") appendFileSync(file, `${lines.join("\n")}\n`);
}

function main(): number {
  const read = readSelection(root);
  if ("refusal" in read) {
    error(`module-render: ${read.refusal}.`);
    return 1;
  }
  const { commit, modules } = read.selection;
  const remedy = remedyLine(requireEnv("GITHUB_REPOSITORY"), env("GITHUB_HEAD_REF"));
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(dirname(join(renderDir, ANSWERS_PATH)), { recursive: true });
  writeFileSync(join(renderDir, ANSWERS_PATH), readFileSync(join(root, ANSWERS_PATH)));
  const exit = run(
    [
      "copier",
      "copy",
      "--answers-file",
      ANSWERS_PATH,
      "--vcs-ref",
      commit,
      "--defaults",
      "--trust",
      "--overwrite",
      "-d",
      `modules=${JSON.stringify(modules)}`,
      "-d",
      `private=${read.selection.private}`,
      "-d",
      `description=${read.selection.description}`,
      src,
      renderDir,
    ],
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  if (exit.kind !== "exited" || exit.code !== 0) {
    const how = exit.kind === "exited" ? `exit ${exit.code}` : exit.kind;
    error(
      `module-render: copier could not render modules ${JSON.stringify(modules)} at build commit ${commit} (${how}; copier's output is above). A module the recorded build does not offer yet renders only from the build tip: ${remedy}`,
    );
    return 1;
  }
  const result = compareManaged(renderDir, root);
  if (result.kind === "unreadable") {
    error(`module-render: ${result.problem}; validate-template reports the repository side.`);
    return 1;
  }
  if (result.stale.length === 0 && result.retired.length === 0) {
    const line = `module-render: the tree carries the render of its module selection (${result.compared} managed files match at ${commit.slice(0, 12)})`;
    console.log(line);
    summary(["### Module render", "", `${line}.`]);
    return 0;
  }
  for (const path of result.stale) {
    error(`module-render: ${path} does not match the render of the selected modules`, path);
  }
  for (const path of result.retired) {
    error(
      `module-render: ${path} is not part of the render of the selected modules (the sync deletes it)`,
      path,
    );
  }
  error(
    `module-render: the module selection changed but its render has not landed on this branch; push it with: ${remedy}`,
  );
  summary([
    "### Module render",
    "",
    "The module selection changed but its render has not landed on this branch.",
    "",
    "| path | finding |",
    "| --- | --- |",
    ...result.stale.map((path) => `| \`${path}\` | does not match the render |`),
    ...result.retired.map((path) => `| \`${path}\` | not in the render; the sync deletes it |`),
    "",
    "Push the render onto the branch:",
    "",
    "```bash",
    remedy,
    "```",
  ]);
  return 1;
}

let code = 1;
try {
  code = main();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(code);

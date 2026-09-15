// The operator's `bun run lint:yaml` and the fleet's action must install from one pin and lint with one invocation, or
// local and fleet lint disagree silently on a rule one yamllint release added or on strictness. The pathspec pin beside
// yamllint is the release the validator's ignore matcher ports; pip would otherwise float it under the port.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PATHSPEC_VERSION } from "../../actions/validate-managed-files/validator/yamllint_ignore";
import { loadAction, REPO_ROOT, stepNamed } from "../shared/action_step";

const PIN_FILE = "actions/yamllint/requirements.txt";
const INVOCATION = "yamllint -s .";

test("the pin file holds a pinned yamllint and the ported pathspec; the lint:yaml script and the action both install from it and run the same invocation", () => {
  const pins = readFileSync(join(REPO_ROOT, PIN_FILE), "utf8")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));
  expect(pins).toEqual([
    expect.stringMatching(/^yamllint==\d+\.\d+\.\d+$/),
    `pathspec==${PATHSPEC_VERSION}`,
  ]);
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  expect(pkg.scripts["lint:yaml"]).toBe(`uvx --with-requirements ${PIN_FILE} ${INVOCATION}`);
  const action = loadAction("actions/yamllint/action.yml");
  expect(stepNamed(action, "Install yamllint").run).toBe(
    `python3 -m pip install --quiet --requirement "$GITHUB_ACTION_PATH/${basename(PIN_FILE)}"`,
  );
  expect(stepNamed(action, "Lint YAML").run).toBe(INVOCATION);
});

// The operator's `bun run lint:yaml` and the fleet's action must install from one pin and lint with one invocation, or
// local and fleet lint disagree silently on a rule one yamllint release added or on strictness.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadAction, REPO_ROOT, stepNamed } from "../shared/action_step";

const PIN_FILE = "actions/yamllint/requirements.txt";
const INVOCATION = "yamllint -s .";

test("the pin file holds exactly one pinned yamllint; the lint:yaml script and the action both install from it and run the same invocation", () => {
  expect(readFileSync(join(REPO_ROOT, PIN_FILE), "utf8")).toMatch(/^yamllint==\d+\.\d+\.\d+\n$/);
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  expect(pkg.scripts["lint:yaml"]).toBe(`uvx --with-requirements ${PIN_FILE} ${INVOCATION}`);
  const action = loadAction("actions/yamllint/action.yml");
  expect(stepNamed(action, "Install yamllint").run).toBe(
    `python3 -m pip install --quiet --requirement "$GITHUB_ACTION_PATH/${basename(PIN_FILE)}"`,
  );
  expect(stepNamed(action, "Lint YAML").run).toBe(INVOCATION);
});

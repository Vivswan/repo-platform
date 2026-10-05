// The pathspec pin beside yamllint is the release the validator's ignore matcher ports, and the action must install
// from that pin file: pip would otherwise float pathspec under the port, and the fleet's ignore lists would match one
// way in the lint and another in the validator.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PATHSPEC_VERSION } from "../../actions/validate-managed-files/validator/yamllint_ignore";
import { loadAction, REPO_ROOT, stepNamed } from "../shared/action_step";

const PIN_FILE = "actions/yamllint/requirements.txt";

test("the pin file holds a pinned yamllint and the ported pathspec, and the action installs from that file", () => {
  const pins = readFileSync(join(REPO_ROOT, PIN_FILE), "utf8")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));
  expect(pins).toEqual([
    expect.stringMatching(/^yamllint==\d+\.\d+\.\d+$/),
    `pathspec==${PATHSPEC_VERSION}`,
  ]);
  const action = loadAction("actions/yamllint/action.yml");
  expect(stepNamed(action, "Install yamllint").run).toBe(
    `python3 -m pip install --quiet --requirement "$GITHUB_ACTION_PATH/${basename(PIN_FILE)}"`,
  );
});

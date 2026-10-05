// The directory the lint step leaves out is a shell literal (GitHub reads no TypeScript there), so it is held to the shared
// constant fleet-ci.yml checks the platform out under; a rename of either side alone fails here, not in the fleet.

import { expect, test } from "bun:test";
import { PLATFORM_CHECKOUT_DIR } from "../../actions/shared/platform";
import { loadAction, stepNamed } from "../shared/action_step";

test("the lint step filters the platform checkout directory out of yamllint's own file list", () => {
  const action = loadAction("actions/yamllint/action.yml");
  expect(stepNamed(action, "Lint YAML").run).toBe(
    `yamllint --list-files . | grep -v '^\\./${PLATFORM_CHECKOUT_DIR.replace(".", "\\.")}/' | tr '\\n' '\\0' | xargs -0 yamllint -s`,
  );
});

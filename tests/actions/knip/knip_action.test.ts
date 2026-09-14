// Dependabot bumps package.json; the version literal in a `run:` line it does not, so the fleet would run an older knip
// than the one this repository's own configuration is exercised against, silently.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, REPO_ROOT } from "../../shared/action_step";

test("the fleet runs the knip this repository tests with", () => {
  const [run] = loadAction("actions/knip/action.yml").runs.steps;
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  expect(run.run).toBe(`npx --yes knip@${pkg.devDependencies.knip}`);
});

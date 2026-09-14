// GitHub hands a job that cannot read the fleet PAT the empty string, never a failure, so this guard is the one
// place an absent token turns red before a fleet write.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FLEET_ENVIRONMENT,
  FLEET_SECRET,
  PAT_RECIPE_URL,
} from "../../.github/scripts/fleet/require_fleet_token.ts";
import { escapeData } from "../../.github/scripts/shared/gha.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = ".github/scripts/fleet/require_fleet_token.ts";
const PATH = process.env.PATH ?? "";

// One ::error:: line naming the secret, the environment, and the recipe. The runner unescapes %25 back to %, so the
// recipe's own query string reaches the log intact where a raw % would misparse the workflow command.
const ERROR_LINE = new RegExp(
  `^::error::[^\\n]*\\b${FLEET_SECRET}\\b[^\\n]*\\b${FLEET_ENVIRONMENT}\\b[^\\n]*` +
    `${RegExp.escape(escapeData(PAT_RECIPE_URL))}[^\\n]*\\n$`,
);

test.each<{ token: string; env: Record<string, string>; exitCode: number; stdout: RegExp }>([
  { token: "present", env: { PAT: "ghp_present" }, exitCode: 0, stdout: /^$/ },
  { token: "missing", env: {}, exitCode: 1, stdout: ERROR_LINE },
  { token: "empty", env: { PAT: "" }, exitCode: 1, stdout: ERROR_LINE },
])(
  "the step with a $token token: an absent one fails with one ::error:: line naming the secret, the environment, and the recipe",
  ({ env, exitCode, stdout }) => {
    const run = boundedSpawnSync(["bun", SCRIPT], { cwd: ROOT, env: { PATH, ...env } });
    expect(run).toEqual({ exitCode, stdout: expect.stringMatching(stdout), stderr: "" });
  },
);

test("README.md's credentials recipe is the guard's URL", () => {
  expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain(`(${PAT_RECIPE_URL})`);
});

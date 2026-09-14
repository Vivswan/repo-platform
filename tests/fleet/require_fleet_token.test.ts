// GitHub hands a job that cannot read the fleet PAT the empty string, never a failure, so this guard is the one
// place an absent token turns red before a fleet write.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FLEET_ENVIRONMENT,
  FLEET_SECRET,
  PAT_RECIPE_URL,
  requireFleetToken,
} from "../../.github/scripts/fleet/require_fleet_token.ts";
import { escapeData } from "../../.github/scripts/shared/gha.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = ".github/scripts/fleet/require_fleet_token.ts";
const PATH = process.env.PATH ?? "";

test("a present token is returned, and the step prints nothing", () => {
  expect(requireFleetToken({ PAT: "ghp_present" })).toBe("ghp_present");
  expect(
    boundedSpawnSync(["bun", SCRIPT], { cwd: ROOT, env: { PATH, PAT: "ghp_present" } }),
  ).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});

test.each([
  ["missing", {}],
  ["empty", { PAT: "" }],
])(
  "a %s token fails the step with one ::error:: line naming the secret, the environment, and the recipe",
  (_, env) => {
    const run = boundedSpawnSync(["bun", SCRIPT], { cwd: ROOT, env: { PATH, ...env } });
    expect([run.exitCode, run.stderr]).toEqual([1, ""]);
    // The runner unescapes %25 back to %: the recipe's own query string reaches the log intact.
    expect(run.stdout).toMatch(
      new RegExp(
        `^::error::[^\\n]*\\b${FLEET_SECRET}\\b[^\\n]*\\b${FLEET_ENVIRONMENT}\\b[^\\n]*${escapeData(PAT_RECIPE_URL).replaceAll(/[.?+]/g, "\\$&")}[^\\n]*\\n$`,
      ),
    );
  },
);

test("README.md's credentials recipe is the guard's URL", () => {
  expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain(`(${PAT_RECIPE_URL})`);
});

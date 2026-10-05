// The hygiene walk must leave out exactly the directory fleet-ci.yml checks the platform out under (the shared constant;
// tests/workflows/fleet_ci_shape.test.ts holds the yaml literal to it), a cross-file fact context.ts alone cannot state,
// and only at the root, where fleet-ci.yml puts it.

import { expect, test } from "bun:test";
import { PLATFORM_CHECKOUT_DIR } from "../../../../actions/shared/platform.ts";
import { tempDirs } from "../../../shared/temp_dir.ts";
import { validatorRunner } from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

const MARKER_FILE = [
  `${"<".repeat(7)} ours`,
  "theirs",
  "=".repeat(7),
  `${">".repeat(7)} theirs`,
  "",
].join("\n");

test("a conflict marker under the platform checkout at the root is not judged; the same directory name deeper is", () => {
  const atRoot = runValidator({ [`${PLATFORM_CHECKOUT_DIR}/notes.md`]: MARKER_FILE });
  const nested = runValidator({ [`tools/${PLATFORM_CHECKOUT_DIR}/notes.md`]: MARKER_FILE });
  expect({
    atRoot: atRoot.exitCode,
    nested: [
      nested.exitCode,
      nested.stderr.includes(
        `tools/${PLATFORM_CHECKOUT_DIR}/notes.md: carries conflict-marker lines`,
      ),
    ],
  }).toEqual({ atRoot: 0, nested: [1, true] });
});

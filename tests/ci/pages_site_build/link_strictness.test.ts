// The fleet fixture's checkout with the dead link its history seals written into HEAD, built as the deploy and as the
// PR check: site_build.test.ts shows the link lenient in the tag tier, these two builds show it strict on HEAD.

import { beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../shared/temp_dir.ts";
import {
  buildSite,
  describeRun,
  FLEET_BASE,
  FLEET_ENV,
  FLEET_REPO,
  fleetRepo,
  runnerTemp,
  SEALED_DEAD_LINK,
  TEST_TIMEOUT_MS,
} from "./fixtures.ts";

const temp = tempDirs();

let rotten = "";

beforeAll(() => {
  rotten = temp.dir("pages-site-rotten-");
  fleetRepo(rotten);
  const setup = join(rotten, "docs", "setup.md");
  writeFileSync(setup, `${readFileSync(setup, "utf-8")}\n${SEALED_DEAD_LINK}`);
});

test(
  "the dead link history seals lenient fails the deploy and the PR check on HEAD, naming it",
  () => {
    // Hardcoding strictness either way in the builder turns exactly one of the deploy runs the wrong color:
    // history cannot be fixed, HEAD can. pages-site.test reads the wiring as a value; only a build shows it armed.
    const deploy = buildSite(rotten, FLEET_REPO, runnerTemp(temp, FLEET_BASE), FLEET_ENV);
    const check = buildSite(rotten, FLEET_REPO, runnerTemp(temp, FLEET_BASE), {
      CHECK: "true",
      CONFIG: FLEET_ENV.CONFIG,
    });
    for (const result of [deploy, check]) {
      expect(result.exitCode, describeRun(result)).toBe(1);
      expect(result.stderr).toContain("missing-page");
    }
  },
  TEST_TIMEOUT_MS,
);

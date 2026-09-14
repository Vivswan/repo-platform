// The schedule fires in every managed repository and cannot be conditioned on visibility, so a job that runs on it
// alone carries the visibility gate itself: a private repository pays for every job that runs, a rounded-up minute
// each, and a skipped job bills nothing.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_OWNER } from "../../actions/shared/platform.ts";

const ROOT = join(import.meta.dir, "../..");
const skeleton = parseYaml(
  readFileSync(join(ROOT, "files/base/.github/workflows/ci.yml"), "utf8").replaceAll(
    "{{github_username}}",
    PLATFORM_OWNER,
  ),
) as { jobs: Record<string, { if?: string }> };

const EXCLUDES_SCHEDULE = "github.event_name!='schedule'";
const PUBLIC_SCHEDULE_ONLY = "github.event_name=='schedule'&&!github.event.repository.private";

test("every skeleton job that names the schedule event excludes it or runs on it in public repositories alone", () => {
  const census = Object.fromEntries(
    Object.entries(skeleton.jobs)
      .map(([name, job]) => [name, (job.if ?? "").replaceAll(/\s+/g, "")] as const)
      .filter(([, condition]) => condition.includes("schedule"))
      .map(([name, condition]) => [
        name,
        condition === PUBLIC_SCHEDULE_ONLY
          ? "public repositories only"
          : condition === EXCLUDES_SCHEDULE
            ? "excluded"
            : `unrecognized: ${condition}`,
      ]),
  );
  expect(census).toEqual({ checks: "excluded", nightly: "public repositories only" });
});

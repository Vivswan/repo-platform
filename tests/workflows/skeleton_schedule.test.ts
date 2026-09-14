// The schedule fires in every managed repository and cannot be conditioned on visibility, so the gate sits on the
// job: a private repository pays for every job that runs, a rounded-up minute each, and a skipped job bills nothing.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_OWNER } from "../../actions/shared/platform.ts";

const SKELETONS = join(import.meta.dir, "../../files/base/.github/workflows");

interface Workflow {
  on: { schedule?: unknown };
  jobs: Record<string, { if?: string }>;
}

const SHAPES: Record<string, string> = {
  "github.event_name!='schedule'": "excluded",
  "github.event_name=='schedule'&&!github.event.repository.private":
    "schedule-only, public repositories",
  "github.event_name!='schedule'||!github.event.repository.private":
    "every event; the schedule in public repositories only",
};

test("every job of a scheduled skeleton excludes the schedule, runs on it in public repositories alone, or names no clause", () => {
  const census = Object.fromEntries(
    readdirSync(SKELETONS)
      .map((file) => {
        const text = readFileSync(join(SKELETONS, file), "utf8")
          .replaceAll("{{github_username}}", PLATFORM_OWNER)
          .replace(/^\{\{blocks\}\}$/gm, "");
        return [file, parseYaml(text) as Workflow] as const;
      })
      .filter(([, workflow]) => workflow.on.schedule !== undefined)
      .map(([file, workflow]) => [
        file,
        Object.fromEntries(
          Object.entries(workflow.jobs)
            .map(([name, job]) => [name, (job.if ?? "").replaceAll(/\s+/g, "")] as const)
            .map(([name, condition]) => [
              name,
              condition.includes("schedule")
                ? (SHAPES[condition] ?? `unrecognized: ${condition}`)
                : "names no schedule clause",
            ]),
        ),
      ]),
  );
  // ci.yml's `ci`, `all-green`, and `site` run on a private repository's schedule too: skipping the gate would post
  // a non-success all-green check run at main's head.
  const unclaused = "names no schedule clause";
  expect(census).toEqual({
    "auto-assign.yml": { "auto-assign": "every event; the schedule in public repositories only" },
    "ci.yml": {
      checks: "excluded",
      ci: unclaused,
      nightly: "schedule-only, public repositories",
      "all-green": unclaused,
      "post-green": unclaused,
      release: unclaused,
      "update-release": unclaused,
      "publish-release": unclaused,
      "update-release-pr": unclaused,
      site: unclaused,
    },
  });
});

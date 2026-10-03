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
  const shapes = Object.values(census).flatMap((jobs) => Object.values(jobs));
  expect(shapes.length).toBeGreaterThan(0);
  expect(shapes.filter((shape) => shape.startsWith("unrecognized"))).toEqual([]);
  // ci.yml's `ci` and `all-green` run on a private repository's schedule too: skipping the gate would post a
  // non-success all-green check run at main's head.
  const unclaused = "names no schedule clause";
  expect([census["ci.yml"]?.ci, census["ci.yml"]?.["all-green"]]).toEqual([unclaused, unclaused]);
});

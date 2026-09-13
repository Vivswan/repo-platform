// GitHub validates every called job's permissions against the CALLER job's grant when the call is expanded, before any
// `if` runs, so one scope over the ceiling fails every run of the caller at once (fleet-wide for the skeleton's callers).
// The pairs are derived from the `uses:` lines, so a new call is judged without being registered anywhere.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_OWNER, PLATFORM_SLUG } from "../../actions/shared/platform.ts";

type Permissions = Record<string, string> | string | undefined;
interface Job {
  uses?: string;
  permissions?: Permissions;
}
interface Workflow {
  permissions?: Permissions;
  jobs: Record<string, Job>;
}

const ROOT = join(import.meta.dir, "../..");
const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };

// The skeleton is the fleet's ci.yml: its `./` calls resolve against the starters beside it, its @stable calls against
// this repository's workflows.
const CALLER_ROOTS = [".github/workflows", "files/base/.github/workflows"];
const LOCAL_CALL = /^\.\/\.github\/workflows\/(.+)$/;
const PLATFORM_CALL = new RegExp(`^${PLATFORM_SLUG}/(\\.github/workflows/.+)@`);

/** The writer's two placeholders become YAML before parsing: the owner slug, and the `{{blocks}}` line a starter opens with. */
function load(rel: string): Workflow {
  const text = readFileSync(join(ROOT, rel), "utf8")
    .replaceAll("{{github_username}}", PLATFORM_OWNER)
    .replace(/^\{\{blocks\}\}$/gm, "");
  return parseYaml(text) as Workflow;
}

/** A reusable workflow of this repository, whichever spelling the caller uses; a third-party call is GitHub's alone to judge. */
function calledPath(uses: string, callerRoot: string): string | null {
  const local = LOCAL_CALL.exec(uses);
  if (local !== null) return `${callerRoot}/${local[1]}`;
  return PLATFORM_CALL.exec(uses)?.[1] ?? null;
}

// A read-all or write-all shorthand is refused on either side, not expanded: the ceiling is read per scope, and a shorthand
// hides which scopes a job holds.
const isMapping = (value: unknown): value is Record<string, string> =>
  typeof value === "object" && value !== null;

test("every called job's permissions fit its caller job's ceiling", () => {
  const pairs: string[] = [];
  const overCeiling: string[] = [];
  for (const callerRoot of CALLER_ROOTS) {
    for (const file of readdirSync(join(ROOT, callerRoot)).filter((name) =>
      name.endsWith(".yml"),
    )) {
      const callerRel = `${callerRoot}/${file}`;
      const caller = load(callerRel);
      for (const [callerJob, job] of Object.entries(caller.jobs)) {
        const calledRel = job.uses === undefined ? null : calledPath(job.uses, callerRoot);
        if (calledRel === null) continue;
        const site = `${callerRel} job '${callerJob}' -> ${calledRel}`;
        pairs.push(site);
        const ceiling = job.permissions ?? caller.permissions;
        if (!isMapping(ceiling)) {
          overCeiling.push(`${site}: caller grant is ${String(ceiling)}, not a per-scope mapping`);
          continue;
        }
        const called = load(calledRel);
        for (const [calledJob, raw] of Object.entries(called.jobs)) {
          const grant = raw.permissions ?? called.permissions;
          if (grant === undefined) continue;
          if (!isMapping(grant)) {
            overCeiling.push(
              `${site} job '${calledJob}': grant is ${grant}, not a per-scope mapping`,
            );
            continue;
          }
          for (const [scope, level] of Object.entries(grant)) {
            const allowed = ceiling[scope] ?? "none";
            if ((RANK[level] ?? Infinity) > (RANK[allowed] ?? -1)) {
              overCeiling.push(`${site} job '${calledJob}': ${scope}: ${level} exceeds ${allowed}`);
            }
          }
        }
      }
    }
  }
  // One resolved pair per caller root proves the derivation reached both, so an empty root cannot pass quietly.
  const controls = [
    "files/base/.github/workflows/ci.yml job 'ci' -> .github/workflows/fleet-ci.yml",
    ".github/workflows/ci.yml job 'post-green' -> .github/workflows/post-green.yml",
  ];
  expect({ resolved: controls.filter((pair) => pairs.includes(pair)), overCeiling }).toEqual({
    resolved: controls,
    overCeiling: [],
  });
});

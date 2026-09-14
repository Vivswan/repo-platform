// The two facts GitHub reads at call expansion and never cross-checks for us, judged over every caller job to called
// workflow pair derived from the `uses:` lines, so a new call is judged without being registered anywhere:
//   permissions  -> validated against the CALLER job's grant before any `if` runs; one scope over fails every caller run at once
//   lanes        -> a caller waiting on a group its callee takes pends forever, never red; github.workflow inside a called
//                   workflow is the CALLER's name, so a group built from it splits one lane between called and dispatched runs

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_OWNER, PLATFORM_SLUG } from "../../actions/shared/platform.ts";

type Permissions = Record<string, string> | string | undefined;
interface Concurrency {
  group: string;
}
interface Job {
  uses?: string;
  permissions?: Permissions;
  concurrency?: Concurrency;
}
interface Workflow {
  on: unknown;
  permissions?: Permissions;
  concurrency?: Concurrency;
  jobs: Record<string, Job>;
}
interface Call {
  site: string;
  job: Job;
  ceiling: Permissions;
  called: Workflow;
  /** Every group the caller job and each caller above it hold, lowercased (GitHub reads group names case-insensitively). */
  heldByChain: Set<string>;
}

const ROOT = join(import.meta.dir, "../..");
const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };

// The skeleton is the fleet's ci.yml: its `./` calls resolve against the starters beside it, its @stable calls against
// this repository's workflows.
const CALLER_ROOTS = [".github/workflows", "files/base/.github/workflows"];
const LOCAL_CALL = /^\.\/\.github\/workflows\/(.+)$/;
const PLATFORM_CALL = new RegExp(`^${PLATFORM_SLUG}/(\\.github/workflows/.+)@`);
// A called run keyed per run_id, falling back to the cron's lane: the literal is what the caller job holds.
const FALLBACK_LANE =
  /^\$\{\{ inputs\.[\w-]+ != '' && format\('[\w-]+-called-\{0\}', github\.run_id\) \|\| '([\w-]+)' \}\}$/;

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

const workflowFiles = (root: string) =>
  readdirSync(join(ROOT, root))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `${root}/${name}`);

const lanesOf = (workflow: Workflow): [string, string][] => {
  const lanes: [string, string][] = [];
  if (workflow.concurrency !== undefined) lanes.push(["workflow", workflow.concurrency.group]);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (job.concurrency !== undefined) lanes.push([`job '${id}'`, job.concurrency.group]);
  }
  return lanes;
};

/** A workflow that also runs on its own (a dispatch, a cron) is walked from an empty chain too. */
function deriveCalls(): Call[] {
  const bySite = new Map<string, Call>();
  const visit = (callerRel: string, chain: string[], held: Set<string>) => {
    if (chain.includes(callerRel))
      throw new Error(`call cycle: ${[...chain, callerRel].join(" -> ")}`);
    const caller = load(callerRel);
    for (const [callerJob, job] of Object.entries(caller.jobs)) {
      const calledRel = job.uses === undefined ? null : calledPath(job.uses, dirname(callerRel));
      if (calledRel === null) continue;
      const heldHere = new Set([
        ...held,
        ...[caller.concurrency?.group, job.concurrency?.group]
          .filter((group): group is string => group !== undefined)
          .map((group) => group.toLowerCase()),
      ]);
      const site = `${callerRel} job '${callerJob}' -> ${calledRel}`;
      const known = bySite.get(site);
      if (known === undefined) {
        bySite.set(site, {
          site,
          job,
          ceiling: job.permissions ?? caller.permissions,
          called: load(calledRel),
          heldByChain: heldHere,
        });
      } else {
        for (const group of heldHere) known.heldByChain.add(group);
      }
      visit(calledRel, [...chain, callerRel], heldHere);
    }
  };
  for (const rel of CALLER_ROOTS.flatMap(workflowFiles)) visit(rel, [], new Set());
  return [...bySite.values()];
}

const CALLS = deriveCalls();

// A read-all or write-all shorthand is refused on either side, not expanded: the ceiling is read per scope, and a shorthand
// hides which scopes a job holds.
const isMapping = (value: unknown): value is Record<string, string> =>
  typeof value === "object" && value !== null;

test("every called job's permissions fit its caller job's ceiling", () => {
  const overCeiling: string[] = [];
  for (const { site, ceiling, called } of CALLS) {
    if (!isMapping(ceiling)) {
      overCeiling.push(`${site}: caller grant is ${String(ceiling)}, not a per-scope mapping`);
      continue;
    }
    for (const [calledJob, raw] of Object.entries(called.jobs)) {
      const grant = raw.permissions ?? called.permissions;
      if (grant === undefined) continue;
      if (!isMapping(grant)) {
        overCeiling.push(`${site} job '${calledJob}': grant is ${grant}, not a per-scope mapping`);
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
  // One resolved pair per caller root proves the derivation reached both, so an empty root cannot pass quietly.
  const controls = [
    "files/base/.github/workflows/ci.yml job 'ci' -> .github/workflows/fleet-ci.yml",
    ".github/workflows/ci.yml job 'post-green' -> .github/workflows/post-green.yml",
  ];
  const sites = CALLS.map((call) => call.site);
  expect({ resolved: controls.filter((pair) => sites.includes(pair)), overCeiling }).toEqual({
    resolved: controls,
    overCeiling: [],
  });
});

// The sync and settings lanes are single-writer only while the cron run and the post-green call spell ONE literal: the
// callee keys a called run per run_id and falls back to the lane its caller job holds by name, so a rename on either side
// lets the two runs write the fleet at once, both green.
test("no called lane is one its caller chain holds or reads github.workflow; a fallback lane is the caller job's by name", () => {
  const findings: string[] = [];
  const fallbackSites: string[] = [];
  for (const { site, job, called, heldByChain } of CALLS) {
    for (const [where, group] of lanesOf(called)) {
      const fallback = FALLBACK_LANE.exec(group)?.[1];
      if (fallback !== undefined) {
        fallbackSites.push(site);
        if (job.concurrency?.group.toLowerCase() !== fallback.toLowerCase()) {
          findings.push(
            `${site} ${where}: falls back to '${fallback}', the caller job holds ${job.concurrency?.group}`,
          );
        }
      } else if (heldByChain.has(group.toLowerCase())) {
        findings.push(`${site} ${where}: group '${group}' is held by the caller chain`);
      }
    }
  }
  for (const rel of CALLER_ROOTS.flatMap(workflowFiles)) {
    const workflow = load(rel);
    if (!JSON.stringify(workflow.on).includes("workflow_call")) continue;
    for (const [where, group] of lanesOf(workflow)) {
      if (group.includes("github.workflow"))
        findings.push(`${rel} ${where}: '${group}' reads github.workflow`);
    }
  }
  // The armed controls: the two fallback-shaped callees were seen, and the sync callee's chain holds ci.yml's run lane as
  // well as the sync-fleet job's, so the walk descended through the post-green call.
  const syncSite =
    ".github/workflows/post-green.yml job 'sync-fleet' -> .github/workflows/sync-repos.yml";
  const syncCall = CALLS.find((call) => call.site === syncSite);
  const ciLane = load(".github/workflows/ci.yml").concurrency?.group.toLowerCase() ?? "";
  expect({
    findings,
    fallbackSites: fallbackSites.sort(),
    syncChain: syncCall?.heldByChain,
  }).toEqual({
    findings: [],
    fallbackSites: [
      ".github/workflows/post-green.yml job 'settings-fleet' -> .github/workflows/settings-repos.yml",
      syncSite,
    ],
    syncChain: new Set([ciLane, syncCall?.job.concurrency?.group.toLowerCase() ?? ""]),
  });
});

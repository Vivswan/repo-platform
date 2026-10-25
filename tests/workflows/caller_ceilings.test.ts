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
  with?: Record<string, unknown>;
  permissions?: Permissions;
  concurrency?: Concurrency;
}
interface Workflow {
  on: unknown;
  permissions?: Permissions;
  concurrency?: Concurrency;
  jobs: Record<string, Job>;
}
/** One caller job to called workflow pair; `heldByChain` is every group the caller job and each caller above it hold,
 *  lowercased, since GitHub reads group names case-insensitively. */
interface Call {
  site: string;
  job: Job;
  ceiling: Permissions;
  called: Workflow;
  heldByChain: Set<string>;
}

const ROOT = join(import.meta.dir, "../..");
const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
const SKELETON = "files/base/.github/workflows/ci.yml";
const CALLER_ROOTS = [".github/workflows", "files/base/.github/workflows"];
const LOCAL_CALL = /^[.$]\/\.github\/workflows\/(.+)$/;
const PLATFORM_CALL = new RegExp(`^${PLATFORM_SLUG}/(\\.github/workflows/.+)@`);
const FALLBACK_LANE =
  /^\$\{\{ inputs\.([\w-]+) != '' && format\('[\w-]+-called-\{0\}', github\.run_id\) \|\| '([\w-]+)' \}\}$/;

/** The writer's two placeholders become YAML before parsing: the owner slug, and the `{{blocks}}` line a starter opens with. */
function load(rel: string): Workflow {
  const text = readFileSync(join(ROOT, rel), "utf8")
    .replaceAll("{{github_username}}", PLATFORM_OWNER)
    .replace(/^\{\{blocks\}\}$/gm, "");
  return parseYaml(text) as Workflow;
}

/** A reusable workflow of this repository, whichever spelling the caller uses; a third-party call is GitHub's alone to
 *  judge. The skeleton is the fleet's ci.yml: its `./` calls resolve against the starters beside it, its @stable calls
 *  against this repository's workflows, whose own `$/` calls resolve against the workflows beside them. */
function calledPath(uses: string, callerRoot: string): string | null {
  const local = LOCAL_CALL.exec(uses);
  if (local !== null) {
    return `${callerRoot}/${local[1]}`;
  }
  return PLATFORM_CALL.exec(uses)?.[1] ?? null;
}

const workflowFiles = (root: string) =>
  readdirSync(join(ROOT, root))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `${root}/${name}`);

const lanesOf = (workflow: Workflow): [string, string][] => {
  const lanes: [string, string][] = [];
  if (workflow.concurrency !== undefined) {
    lanes.push(["workflow", workflow.concurrency.group]);
  }
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (job.concurrency !== undefined) {
      lanes.push([`job '${id}'`, job.concurrency.group]);
    }
  }
  return lanes;
};

/** A workflow that also runs on its own (a dispatch, a cron) is walked from an empty chain too. */
function deriveCalls(): Call[] {
  const bySite = new Map<string, Call>();
  const visit = (callerRel: string, chain: string[], held: Set<string>) => {
    if (chain.includes(callerRel)) {
      throw new Error(`call cycle: ${[...chain, callerRel].join(" -> ")}`);
    }
    const caller = load(callerRel);
    for (const [callerJob, job] of Object.entries(caller.jobs)) {
      const calledRel = job.uses === undefined ? null : calledPath(job.uses, dirname(callerRel));
      if (calledRel === null) {
        continue;
      }
      const heldHere = new Set([
        ...held,
        ...[caller.concurrency?.group, job.concurrency?.group]
          .filter((group): group is string => group !== undefined)
          .map((group) => group.toLowerCase()),
      ]);
      const site = `${callerRel} job '${callerJob}' -> ${calledRel}`;
      const known = bySite.get(site) ?? {
        site,
        job,
        ceiling: job.permissions ?? caller.permissions,
        called: load(calledRel),
        heldByChain: new Set<string>(),
      };
      bySite.set(site, known);
      for (const group of heldHere) {
        known.heldByChain.add(group);
      }
      visit(calledRel, [...chain, callerRel], heldHere);
    }
  };
  for (const rel of CALLER_ROOTS.flatMap(workflowFiles)) {
    visit(rel, [], new Set());
  }
  return [...bySite.values()];
}

const CALLS = deriveCalls();

/** A per-scope grant. A read-all or write-all shorthand is refused on either side, not expanded: the ceiling is read
 *  per scope, and a shorthand hides which scopes a job holds. */
function isMapping(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null;
}

/** Every scope a called job holds over its caller job's ceiling, one line each. */
function overCeilingGaps({ site, ceiling, called }: Call): string[] {
  if (!isMapping(ceiling)) {
    return [`${site}: caller grant is ${String(ceiling)}, not a per-scope mapping`];
  }
  const gaps: string[] = [];
  for (const [calledJob, raw] of Object.entries(called.jobs)) {
    const grant = raw.permissions ?? called.permissions;
    if (grant === undefined) {
      continue;
    }
    if (!isMapping(grant)) {
      gaps.push(`${site} job '${calledJob}': grant is ${grant}, not a per-scope mapping`);
      continue;
    }
    for (const [scope, level] of Object.entries(grant)) {
      const allowed = ceiling[scope] ?? "none";
      if ((RANK[level] ?? Infinity) > (RANK[allowed] ?? -1)) {
        gaps.push(`${site} job '${calledJob}': ${scope}: ${level} exceeds ${allowed}`);
      }
    }
  }
  return gaps;
}

function raiseTo(union: Record<string, string>, grant: Record<string, string>): void {
  for (const [scope, level] of Object.entries(grant)) {
    if ((RANK[level] ?? Infinity) > (RANK[union[scope] ?? "none"] ?? -1)) {
      union[scope] = level;
    }
  }
}

/** Raises `union` by every running job below the workflow, following each call once (`seen`). */
function absorbGrants(
  callerRel: string,
  workflow: Workflow,
  union: Record<string, string>,
  seen: Set<string>,
): void {
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const calledRel = job.uses === undefined ? null : calledPath(job.uses, dirname(callerRel));
    if (calledRel !== null) {
      if (!seen.has(calledRel)) {
        seen.add(calledRel);
        absorbGrants(calledRel, load(calledRel), union, seen);
      }
      continue;
    }
    const grant = job.permissions ?? workflow.permissions;
    if (!isMapping(grant)) {
      throw new Error(`${callerRel} job '${id}': grant is ${String(grant)}`);
    }
    raiseTo(union, grant);
  }
}

/** The highest level per scope any running job behind the calls asks; a call job's own grant is a ceiling, not a need. */
function unionOfGrants(platformCalls: Call[]): Record<string, string> {
  const union: Record<string, string> = {};
  const seen = new Set<string>();
  for (const call of platformCalls) {
    const calledRel = calledPath(call.job.uses ?? "", dirname(SKELETON)) ?? "";
    if (!seen.has(calledRel)) {
      seen.add(calledRel);
      absorbGrants(calledRel, call.called, union, seen);
    }
  }
  return union;
}

/** The lane findings of one call: a fallback lane must be keyed on an input the caller passes and named for the caller
 *  job's own lane; any other lane must not be one the caller chain holds. */
function laneFindings({ site, job, called, heldByChain }: Call): string[] {
  const findings: string[] = [];
  for (const [where, group] of lanesOf(called)) {
    const fallback = FALLBACK_LANE.exec(group);
    if (fallback === null) {
      if (heldByChain.has(group.toLowerCase())) {
        findings.push(`${site} ${where}: group '${group}' is held by the caller chain`);
      }
      continue;
    }
    const [, input, lane] = fallback;
    if (!(input in (job.with ?? {}))) {
      findings.push(
        `${site} ${where}: keys the called run on inputs.${input}, which the caller does not pass`,
      );
    }
    if (job.concurrency?.group.toLowerCase() !== lane.toLowerCase()) {
      findings.push(
        `${site} ${where}: falls back to '${lane}', the caller job holds ${job.concurrency?.group}`,
      );
    }
  }
  return findings;
}

/** The lanes of every callable workflow whose group reads github.workflow, the CALLER's name inside a called run. */
function lanesReadingGithubWorkflow(): string[] {
  const findings: string[] = [];
  for (const rel of CALLER_ROOTS.flatMap(workflowFiles)) {
    const workflow = load(rel);
    if (!JSON.stringify(workflow.on).includes("workflow_call")) {
      continue;
    }
    for (const [where, group] of lanesOf(workflow)) {
      if (group.includes("github.workflow")) {
        findings.push(`${rel} ${where}: '${group}' reads github.workflow`);
      }
    }
  }
  return findings;
}

test("every called job's permissions fit its caller job's ceiling", () => {
  const overCeiling = CALLS.flatMap(overCeilingGaps);
  // One resolved pair per caller root proves the derivation reached both, and the nested pair that it descended through
  // a platform call, so an empty root or a flat walk cannot pass quietly.
  const controls = [
    "files/base/.github/workflows/ci.yml job 'platform' -> .github/workflows/fleet.yml",
    ".github/workflows/fleet.yml job 'codeql' -> .github/workflows/reusable-codeql.yml",
    ".github/workflows/ci.yml job 'post-green' -> .github/workflows/post-green.yml",
  ];
  const sites = CALLS.map((call) => call.site);
  expect({ resolved: controls.filter((pair) => sites.includes(pair)), overCeiling }).toEqual({
    resolved: controls,
    overCeiling: [],
  });
});

// The skeleton grants every platform call one fixed block, the union of what the jobs behind those calls ask. The test
// above refuses a job over the block; nothing refuses a block over the jobs, so an unused scope (a `packages: write` no
// platform job asked) would sit granted fleet-wide. A call job's own grant is a ceiling, not a need: the union reads the
// running jobs below it.
test("the skeleton's platform calls share one block, and the block is exactly the union of what the jobs behind them ask", () => {
  const platformCalls = CALLS.filter(
    (call) => call.site.startsWith(`${SKELETON} job`) && PLATFORM_CALL.test(call.job.uses ?? ""),
  );
  const blocks = new Set(platformCalls.map((call) => JSON.stringify(call.ceiling)));
  expect({
    calls: platformCalls.length > 1,
    blocks: [...blocks].map((block) => JSON.parse(block) as Permissions),
  }).toEqual({ calls: true, blocks: [unionOfGrants(platformCalls)] });
});

// The sync and settings lanes are single-writer only while the cron run and the post-green call spell ONE literal: the
// callee keys a called run per run_id and falls back to the lane its caller job holds by name, so a rename on either side
// lets the two runs write the fleet at once, both green.
test("no called lane is one its caller chain holds or reads github.workflow; a fallback lane is the caller job's by name", () => {
  const findings = [...CALLS.flatMap(laneFindings), ...lanesReadingGithubWorkflow()];
  const fallbackSites = CALLS.flatMap((call) =>
    lanesOf(call.called)
      .filter(([, group]) => FALLBACK_LANE.test(group))
      .map(() => call.site),
  );
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

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_NAME, PLATFORM_OWNER } from "../../../actions/shared/platform.ts";
import { escapeRegExp, type Mismatch } from "./comparison.ts";
import { REPO_ROOT, read } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

export function settingsGreenGateMismatches(text: string): Mismatch[] {
  const rel = ".github/workflows/settings-repos.yml";
  const mismatches: Mismatch[] = [];
  const mapping = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const steps = (job: Record<string, unknown>): Record<string, unknown>[] =>
    Array.isArray(job.steps) ? (job.steps as unknown[]).map(mapping) : [];
  const jobs = mapping(mapping(parseYaml(text)).jobs);
  // Trim-equal, never a substring: an `echo bun ...` decoy carries the
  // command in its text without running it.
  const runs = (job: Record<string, unknown>) =>
    steps(job).map((step) => String(step.run ?? "").trim());
  const selecting = Object.entries(jobs).filter(([, job]) =>
    runs(mapping(job)).includes("bun .github/scripts/fleet/select_settings_repos.ts"),
  );
  if (selecting.length !== 1)
    throw new Error(`${rel}: no single target-selection job - anchor lost`);
  const [jobName, selectJob] = selecting[0];
  const selectSteps = steps(mapping(selectJob));
  const selectRuns = runs(mapping(selectJob));
  const gateAt = selectRuns.indexOf("bun .github/scripts/fleet/require_green_commit.ts");
  const selectAt = selectRuns.indexOf("bun .github/scripts/fleet/select_settings_repos.ts");
  if (gateAt === -1) {
    mismatches.push({
      file: rel,
      expected: `a step running fleet/require_green_commit.ts in the ${jobName} job`,
      got: "missing - the fleet-wide settings writer would run ungated from raw pushes",
    });
  } else if (gateAt > selectAt) {
    mismatches.push({
      file: rel,
      expected: "the green gate BEFORE the target selection",
      got: "the gate runs after targets are computed",
    });
  } else if (String(selectSteps[gateAt].if ?? "") !== "") {
    mismatches.push({
      file: rel,
      expected: "an unconditional green gate (every trigger reads main's tip)",
      got: `if: ${String(selectSteps[gateAt].if)}`,
    });
  }
  for (const [name, job] of Object.entries(jobs)) {
    const checkouts = steps(mapping(job)).filter((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    if (checkouts.length !== 1) {
      mismatches.push({
        file: rel,
        expected: `exactly one checkout in the ${name} job (a second one could replace the judged tree)`,
        got: `${checkouts.length} checkout step(s)`,
      });
    } else if ("ref" in mapping(checkouts[0].with)) {
      mismatches.push({
        file: rel,
        expected: `the ${name} job's checkout without a ref - it lands on the trigger commit the gate judged`,
        got: `ref: ${String(mapping(checkouts[0].with).ref)}`,
      });
    }
  }
  return mismatches;
}

/** The fleet writers (workflows mutating managed repositories) as post-green.yml's `callerJob`
 *  reaches them: `lane` is the writer's own cron/dispatch group, `callKey` the call-only input
 *  keying a called run's per-run group, `callEnv` the exact steps that must read the call inputs. */
export const FLEET_WRITERS: Record<
  string,
  {
    lane: string;
    callerJob: string;
    callKey: string;
    callEnv: Record<string, { run: string; value: string }>;
  }
> = {
  ".github/workflows/sync-repos.yml": {
    lane: "sync-repos",
    callerJob: "sync-fleet",
    callKey: "repos",
    callEnv: {
      ONLY_REPO: {
        run: "bun .github/scripts/fleet/select_sync_repos.ts",
        value: "${{ inputs.repos }}",
      },
      TARGET_SHA: {
        run: "bun .github/scripts/fleet/select_sync_repos.ts",
        value: "${{ inputs.sha }}",
      },
    },
  },
  ".github/workflows/settings-repos.yml": {
    lane: "settings-repos",
    callerJob: "settings-fleet",
    callKey: "sha",
    callEnv: {
      SOURCE_SHA: {
        run: "bun .github/scripts/fleet/require_green_commit.ts",
        value: "${{ inputs.sha }}",
      },
      ONLY_REPO: {
        run: "bun .github/scripts/fleet/select_settings_repos.ts",
        value: "${{ inputs.repos }}",
      },
    },
  },
};

/** The writer's triggers: the post-green call plus the two self-woken
 *  paths whose in-script gates vouch for the commit themselves. Any other
 *  trigger - a `push` above all - would apply to the fleet outside the
 *  all-green gate, racing the CI run that judges the very commit. */
export const FLEET_WRITER_TRIGGERS = ["schedule", "workflow_dispatch", "workflow_call"];

export const POST_GREEN_REL = ".github/workflows/post-green.yml";

/** A workflow job calling one of this repository's workflows: where it
 *  sits and whether it calls the LOCAL `./path` spelling - the same-commit
 *  call - or the canonical `<owner>/<name>/path@ref`, which runs
 *  whatever that ref holds. */
export interface WorkflowCaller {
  site: string;
  local: boolean;
  uses: string;
}

export function callersOf(
  workflows: Record<string, string>,
  rel: string,
  owner: string,
): WorkflowCaller[] {
  if (!/^[A-Za-z0-9-]+$/.test(owner)) {
    throw new Error(`callersOf: owner '${owner}' is not a plain GitHub username`);
  }
  // Built from the validated owner and an escaped path, never from input.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const canonical = new RegExp(`^${owner}/${PLATFORM_NAME}/${escapeRegExp(rel)}@`, "i");
  const mapping = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const callers: WorkflowCaller[] = [];
  for (const [file, source] of Object.entries(workflows)) {
    for (const [jobId, job] of Object.entries(mapping(mapping(parseYaml(source)).jobs))) {
      const uses = String(mapping(job).uses ?? "");
      const local = uses === `./${rel}`;
      if (local || canonical.test(uses))
        callers.push({ site: `${file} job ${jobId}`, local, uses });
    }
  }
  return callers;
}

/** A canonical `@ref` call from the right job would run an unjudged ref's copy of the workflow, so only the local spelling passes. */
function soleLocalCallerProblem(callers: WorkflowCaller[], expectedSite: string): string | null {
  if (callers.length === 1 && callers[0].site === expectedSite && callers[0].local) return null;
  if (callers.length === 0) return "no caller at all";
  return `called by ${callers
    .map((caller) => (caller.local ? caller.site : `${caller.site} via ${caller.uses}`))
    .join(", ")}`;
}

/** post-green.yml's callers ARE the all-green gate's one exit: a second caller would run every post-green leg, the fleet writers included,
 *  behind whatever that workflow's trigger is. allGreenGateMismatches judges the caller's needs edge; the workflow_dispatch way in runs
 *  the two delivery legs alone behind their in-script gates (tests/build-branches/publish_wiring.test.ts pins that). */
export function postGreenCallerMismatches(
  workflows: Record<string, string>,
  owner: string,
): Mismatch[] {
  const expected = ".github/workflows/ci.yml job post-green";
  const problem = soleLocalCallerProblem(callersOf(workflows, POST_GREEN_REL, owner), expected);
  if (problem === null) return [];
  return [
    {
      file: POST_GREEN_REL,
      expected: `${expected} as its only caller, in the local ./ spelling (the all-green gate's one exit, at the judged commit)`,
      got: problem,
    },
  ];
}

/** The PAT is the one credential that can mutate managed repositories, so holding it is the independent census of "could this be a fleet writer":
 *  every holder is in FLEET_WRITERS or classified here with why it holds the token. */
export const FLEET_TOKEN_NON_WRITERS: Record<string, string> = {
  ".github/workflows/ci.yml": "passes the secret through to post-green.yml",
  ".github/workflows/post-green.yml":
    "pushes THIS repository's build branch (workflow-scope files GITHUB_TOKEN may not push) " +
    "and passes the secret through to the two writers it calls",
  ".github/workflows/refresh-gitignore.yml": "opens PRs in THIS repository",
  ".github/workflows/refresh-toolchains.yml": "opens PRs in THIS repository",
  ".github/workflows/fleet-release.yml":
    "workflow_call-only; a managed ci.yml hands it the secret so release-please's PR runs its checks in THAT repository",
  ".github/workflows/fleet-release-publish.yml":
    "workflow_call-only; a managed ci.yml hands it the secret to publish THAT repository's draft release",
};

/** Conservative on purpose: a false holder costs a classification line, a missed one a silent writer.
 *    `secrets.OTHER_NAME` only            -> not a holder
 *    `toJSON(secrets)`, `secrets[name]`   -> a holder: a whole or computed access reaches the PAT too
 *    `secrets: inherit` on a call         -> a holder: every secret is handed on without naming one */
export function readsFleetToken(doc: unknown): boolean {
  // Case-insensitive throughout: Actions resolves the context and the secret name in any case.
  const named =
    /\bsecrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)\b|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/gi;
  const reads = (text: string): boolean => {
    const expressions = [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
    return expressions.some((expression) => {
      let namesFleetToken = false;
      const rest = expression.replace(named, (_, dotName, bracketName) => {
        if ((dotName ?? bracketName).toUpperCase() === "REPO_PLATFORM_TOKEN") {
          namesFleetToken = true;
        }
        return "";
      });
      return namesFleetToken || /\bsecrets\b/i.test(rest);
    });
  };
  const walk = (node: unknown): boolean => {
    if (typeof node === "string") return reads(node);
    if (Array.isArray(node)) return node.some(walk);
    if (typeof node === "object" && node !== null) {
      const record = node as Record<string, unknown>;
      if (record.secrets === "inherit" && "uses" in record) return true;
      return Object.values(record).some(walk);
    }
    return false;
  };
  return walk(doc);
}

export function fleetTokenHolderMismatches(workflows: Record<string, string>): Mismatch[] {
  const holders = Object.entries(workflows)
    .filter(([, text]) => readsFleetToken(parseYaml(text)))
    .map(([rel]) => rel);
  if (holders.length === 0) throw new Error("no workflow reads the fleet token - anchor lost");
  const classified = [...Object.keys(FLEET_WRITERS), ...Object.keys(FLEET_TOKEN_NON_WRITERS)];
  const mismatches: Mismatch[] = [];
  for (const rel of holders) {
    if (!classified.includes(rel)) {
      mismatches.push({
        file: rel,
        expected:
          "a fleet-token holder registered in scripts/check/ssot/post_green.ts: FLEET_WRITERS (it mutates managed repos - then it rides post-green) or FLEET_TOKEN_NON_WRITERS (with why it holds the token)",
        got: "reads secrets.REPO_PLATFORM_TOKEN unclassified",
      });
    }
  }
  for (const rel of classified) {
    if (!holders.includes(rel)) {
      mismatches.push({
        file: `scripts/check/ssot/post_green.ts ${rel in FLEET_WRITERS ? "FLEET_WRITERS" : "FLEET_TOKEN_NON_WRITERS"}`,
        expected: `${rel} reading secrets.REPO_PLATFORM_TOKEN`,
        got: "no such holder - a stale entry; remove it in the same change, deliberately",
      });
    }
  }
  return mismatches;
}

export function fleetWriterMismatches(
  rel: string,
  text: string,
  workflows: Record<string, string>,
  owner: string,
): Mismatch[] {
  const writer = FLEET_WRITERS[rel];
  if (writer === undefined) throw new Error(`${rel}: not a registered fleet writer`);
  const postGreen = workflows[POST_GREEN_REL];
  if (postGreen === undefined)
    throw new Error(`${POST_GREEN_REL}: not among the workflows handed in`);
  const mismatches: Mismatch[] = [];
  const mapping = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const doc = mapping(parseYaml(text));
  const on = mapping(doc.on);
  if (Object.keys(on).length === 0) throw new Error(`${rel}: no triggers - anchor lost`);
  const triggers = Object.keys(on).sort();
  if (triggers.join(",") !== [...FLEET_WRITER_TRIGGERS].sort().join(",")) {
    mismatches.push({
      file: rel,
      expected: `triggers exactly ${FLEET_WRITER_TRIGGERS.join(", ")} - the post-green call is the gate's one exit, and a push (or any other event) would apply fleet-wide outside it`,
      got: `on: ${triggers.join(", ")}`,
    });
  }
  const callInputs = Object.keys(mapping(mapping(on.workflow_call).inputs)).sort();
  if (callInputs.join(",") !== "repos,sha") {
    mismatches.push({
      file: rel,
      expected: "workflow_call inputs exactly repos and sha (the scope and the judged commit)",
      got: callInputs.length === 0 ? "no workflow_call inputs" : `inputs: ${callInputs.join(", ")}`,
    });
  }
  // The call inputs stay call-only: the concurrency ternary and the gate
  // read "is this a called run" off their presence, so a dispatch input
  // of the same name would silently take the called path - a per-run
  // lane - on a hand-dispatched run.
  const dispatchInputs = Object.keys(mapping(mapping(on.workflow_dispatch).inputs));
  const shadowing = dispatchInputs.filter((name) => name === "repos" || name === "sha").sort();
  if (shadowing.length > 0) {
    mismatches.push({
      file: rel,
      expected:
        "no workflow_dispatch input named repos or sha (call-only inputs: their presence IS the called-run signal)",
      got: `workflow_dispatch inputs: ${shadowing.join(", ")}`,
    });
  }
  const lane = `\${{ inputs.${writer.callKey} != '' && format('${writer.lane}-called-{0}', github.run_id) || '${writer.lane}' }}`;
  const group = String(mapping(doc.concurrency).group ?? "");
  if (group !== lane) {
    mismatches.push({
      file: rel,
      expected: `concurrency group: ${lane} (the lane on cron and dispatch, a per-run group when called - a called run must never wait on the lane its caller holds)`,
      got: group === "" ? "no workflow-level concurrency group" : `group: ${group}`,
    });
  }
  const steps: Record<string, unknown>[] = [];
  for (const job of Object.values(mapping(doc.jobs))) {
    const jobSteps = mapping(job).steps;
    if (Array.isArray(jobSteps)) steps.push(...jobSteps.map(mapping));
  }
  for (const [name, { run, value }] of Object.entries(writer.callEnv)) {
    const consumers = steps.filter((step) => String(step.run ?? "").trim() === run);
    if (consumers.length !== 1) {
      throw new Error(
        `${rel}: expected exactly one step running '${run}', found ${consumers.length} - anchor lost`,
      );
    }
    const got = String(mapping(consumers[0].env)[name] ?? "");
    if (got !== value) {
      mismatches.push({
        file: rel,
        expected: `the step running ${run} reads ${name}: ${value}`,
        got:
          got === ""
            ? `no ${name} env - the call input never reaches the step, so a called run silently takes the self-woken path`
            : `${name}: ${got}`,
      });
    }
  }
  // An absent caller is reported once, by the job check below.
  const expectedCaller = `${POST_GREEN_REL} job ${writer.callerJob}`;
  const callers = callersOf(workflows, rel, owner);
  const censusProblem = soleLocalCallerProblem(callers, expectedCaller);
  if (callers.length > 0 && censusProblem !== null) {
    mismatches.push({
      file: rel,
      expected: `${expectedCaller} as the only caller of ./${rel}, in the local ./ spelling (the one gated way into the fleet)`,
      got: censusProblem,
    });
  }
  const caller = mapping(mapping(mapping(parseYaml(postGreen)).jobs)[writer.callerJob]);
  if (Object.keys(caller).length === 0) {
    mismatches.push({
      file: ".github/workflows/post-green.yml",
      expected: `a '${writer.callerJob}' job calling ./${rel} behind the all-green gate`,
      got: "no such job - the writer has no gated way into the fleet",
    });
    return mismatches;
  }
  if (String(caller.uses ?? "") !== `./${rel}`) {
    mismatches.push({
      file: `.github/workflows/post-green.yml job ${writer.callerJob}`,
      expected: `uses: ./${rel}`,
      got: caller.uses === undefined ? "no uses" : `uses: ${String(caller.uses)}`,
    });
  }
  const sha = String(mapping(caller.with).sha ?? "");
  if (sha !== "${{ inputs.sha }}") {
    mismatches.push({
      file: `.github/workflows/post-green.yml job ${writer.callerJob}`,
      expected: "with.sha: ${{ inputs.sha }} - the judged commit, explicit, never re-derived",
      got: sha === "" ? "no sha passed" : `sha: ${sha}`,
    });
  }
  const callerGroup = String(mapping(caller.concurrency).group ?? "");
  if (callerGroup !== writer.lane) {
    mismatches.push({
      file: `.github/workflows/post-green.yml job ${writer.callerJob}`,
      expected: `concurrency group ${writer.lane} - the literal lane the writer's cron and dispatch runs hold`,
      got: callerGroup === "" ? "no lane held" : `group: ${callerGroup}`,
    });
  }
  return mismatches;
}

export const postGreenRules: Rule[] = [
  {
    // The one fleet-wide settings WRITER's gate: trimming it would leave the
    // workflow applying from raw pushed commits with every other gate green.
    name: "settings-green-gate",
    run: () => settingsGreenGateMismatches(read(".github/workflows/settings-repos.yml")),
  },
  {
    // A `push` trigger on a fleet writer would apply fleet-wide concurrently with the CI run judging that very commit;
    // post-green.yml calls each writer in a green main push's own run, and the self-woken cron and dispatch paths gate in-script.
    name: "fleet-writers-ride-post-green",
    run: () => {
      const workflows = Object.fromEntries(
        readdirSync(join(REPO_ROOT, ".github/workflows"))
          .filter((name) => /\.ya?ml$/.test(name))
          .map((name) => [`.github/workflows/${name}`, read(`.github/workflows/${name}`)]),
      );
      return [
        ...postGreenCallerMismatches(workflows, PLATFORM_OWNER),
        ...fleetTokenHolderMismatches(workflows),
        ...Object.keys(FLEET_WRITERS).flatMap((rel) =>
          fleetWriterMismatches(rel, read(rel), workflows, PLATFORM_OWNER),
        ),
      ];
    },
  },
];

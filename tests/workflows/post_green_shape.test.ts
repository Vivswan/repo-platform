import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

interface Job {
  needs?: string[];
  if?: string;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  uses?: string;
  with?: Record<string, string>;
  secrets?: Record<string, string>;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: {
    id?: string;
    name?: string;
    if?: string;
    run?: string;
    uses?: string;
    with?: Record<string, unknown>;
    env?: unknown;
  }[];
}

/** A missing context read is the empty string, as an unrun job's output is in Actions. */
function evaluateCondition(expression: string, context: Record<string, string>): boolean {
  const tokens = expression.match(/'[^']*'|[A-Za-z_][\w.-]*(?:\(\))?|==|!=|&&|\|\||[()!]/g) ?? [];
  if (tokens.join("").replace(/\s/g, "") !== expression.replace(/\s/g, "")) {
    throw new Error(`unsupported expression: ${expression}`);
  }
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  const value = (): string | boolean => {
    const token = next();
    if (token === undefined) throw new Error(`unexpected end of ${expression}`);
    if (token === "!") return !value();
    if (token === "(") {
      const inner = or();
      if (next() !== ")") throw new Error(`unbalanced parentheses in ${expression}`);
      return inner;
    }
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token === "cancelled()") return false;
    return context[token] ?? "";
  };
  const comparison = (): string | boolean => {
    const left = value();
    if (peek() === "==" || peek() === "!=") {
      const op = next();
      const right = value();
      return op === "==" ? left === right : left !== right;
    }
    return left;
  };
  const and = (): boolean => {
    let result = Boolean(comparison());
    while (peek() === "&&") {
      next();
      result = Boolean(comparison()) && result;
    }
    return result;
  };
  const or = (): boolean => {
    let result = and();
    while (peek() === "||") {
      next();
      result = and() || result;
    }
    return result;
  };
  const result = or();
  if (at !== tokens.length) throw new Error(`trailing tokens in ${expression}`);
  return result;
}

/** Simulates GitHub's own rules, which the body mirrors; `outputs` stands in for the step outputs
 * of every job that ran. "A failure or skip applies to all jobs in the dependency chain from the
 * point of failure or skip onwards", even through a job a status function let continue.
 *   an unrun need                       -> result `skipped`, empty outputs
 *   a condition with no status function -> implicit success() over the WHOLE ancestry */
function jobsRunning(
  jobs: Record<string, Job>,
  event: string,
  outputs: Record<string, string>,
  failed: string[] = [],
): string[] {
  const ran = new Set<string>();
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(jobs[id].needs ?? [])];
    for (let need = stack.pop(); need !== undefined; need = stack.pop()) {
      if (seen.has(need)) continue;
      seen.add(need);
      stack.push(...(jobs[need].needs ?? []));
    }
    return seen;
  };
  const pending = Object.keys(jobs);
  while (pending.length > 0) {
    const id = pending.shift() as string;
    const job = jobs[id];
    const needs = job.needs ?? [];
    if (needs.some((need) => pending.includes(need))) {
      pending.push(id);
      continue;
    }
    if (failed.includes(id)) continue;
    const context: Record<string, string> = { "github.event_name": event };
    for (const need of needs) {
      context[`needs.${need}.result`] = ran.has(need)
        ? "success"
        : failed.includes(need)
          ? "failure"
          : "skipped";
      for (const [name, value] of Object.entries(outputs)) {
        context[`needs.${need}.outputs.${name}`] = ran.has(need) ? value : "";
      }
    }
    const condition = job.if ?? "";
    const statusFunction = /\b(always|cancelled|success|failure)\(\)/.test(condition);
    const chainRan = [...ancestors(id)].every((need) => ran.has(need));
    const passes = condition === "" || evaluateCondition(condition, context);
    if (passes && (statusFunction || chainRan)) ran.add(id);
  }
  return [...ran];
}

describe("post-green wiring", () => {
  const ciYml = read(".github/workflows/ci.yml");
  const postGreen = read(".github/workflows/post-green.yml");
  const postGreenDoc = parseYaml(postGreen) as {
    on: Record<string, { inputs?: Record<string, { required?: boolean; type?: string }> }>;
    jobs: Record<string, Job>;
  };

  test("both ways in hand the mover the sha input, and nothing else names a source", () => {
    // The caller is needs-ordered behind the gate in the SAME run, so github.sha is the judged commit by
    // construction - and it must still flow caller -> input -> mover env explicitly (a leg re-deriving it
    // from context could be handed the wrong commit by a future caller). A dispatch declares the SAME input,
    // required, so the one SOURCE_SHA line serves both. The push base rides the same discipline.
    expect(ciYml).toContain("sha: ${{ github.sha }}");
    expect(ciYml).toContain("before: ${{ github.event.before }}");
    expect(Object.keys(postGreenDoc.on)).toEqual(["workflow_call", "workflow_dispatch"]);
    expect(Object.keys(postGreenDoc.on.workflow_call.inputs ?? {})).toEqual(["sha", "before"]);
    expect(postGreenDoc.on.workflow_dispatch.inputs).toEqual({
      sha: expect.objectContaining({ required: true, type: "string" }),
    });
    // No leg re-derives a commit from context (the parsed jobs, so the
    // header may NAME github.sha while explaining this rule).
    for (const derived of ["github.sha", "github.event.before"]) {
      expect(JSON.stringify(postGreenDoc.jobs)).not.toContain(derived);
    }
    expect(ciYml).not.toContain("workflow_run");
  });

  test("a dispatch runs the mover ALONE; the call runs every leg", () => {
    // Simulated on the parsed job graph, so a reworded condition that lets a
    // call-only leg fire on a dispatch fails here whatever its spelling. The
    // call arm is the moved control: every output armed, every leg runs.
    const jobs = postGreenDoc.jobs;
    const armed = { armed: "true", previous: "a".repeat(40) };
    expect(jobsRunning(jobs, "workflow_dispatch", armed).sort()).toEqual(["move-stable"]);
    expect(jobsRunning(jobs, "push", armed).sort()).toEqual(Object.keys(jobs).sort());
    // No directive skips the sync and nothing else: the settings apply
    // runs on every call, its targets never derived from the sync's.
    expect(jobsRunning(jobs, "push", { ...armed, armed: "false" }).sort()).toEqual([
      "move-stable",
      "read-directives",
      "settings-fleet",
    ]);
    // A mover that moved nothing reports no base, and the read still syncs on the push's own before;
    // the mover has no word that stands the read down.
    //   a replay at the tag's own commit                 -> the judged commit alone (re-run the FAILED jobs to keep the mover's previous)
    //   a re-run after a newer commit moved the tag past -> the newer run's range, exclusive at its base, may have excluded this commit
    expect(jobsRunning(jobs, "push", { armed: "true", previous: "" }).sort()).toEqual(
      Object.keys(jobs).sort(),
    );
    expect(jobs["read-directives"].if).not.toContain("needs.move-stable.outputs");
    // A red mover (a lost lease, a refused push) leaves the read on the push's own before and skips the
    // sync (the tag names a stale commit), nothing else.
    expect(jobsRunning(jobs, "push", { armed: "true" }, ["move-stable"]).sort()).toEqual([
      "read-directives",
      "settings-fleet",
    ]);
    expect(jobs["move-stable"].if).toBeUndefined();
    expect(jobs["move-stable"].needs).toBeUndefined();
  });

  test("post-green releases only on the gate's OWN green result, on a push to main", () => {
    // The result clause is deliberate redundancy (GitHub implies
    // success() on an `if` with no status function, but the release
    // condition must not depend on remembering that rule), and the
    // event/ref clauses keep PR, dispatch, and schedule runs out.
    for (const clause of [
      "needs.all-green.result == 'success'",
      "github.event_name == 'push'",
      "github.ref == 'refs/heads/main'",
    ]) {
      expect(ciYml).toContain(clause);
    }
  });

  test("post-green.yml's leg roster is pinned for per-leg green review", () => {
    // A leg that MUTATES shared state keeps its own verification
    // (post-green.yml's header): that requirement lives in review, so the
    // roster is pinned here - adding a leg fails this test until the new
    // job's verification story is written down and the roster updated.
    const jobs = postGreenDoc.jobs;
    expect(Object.keys(jobs)).toEqual([
      "move-stable",
      "read-directives",
      "sync-fleet",
      "settings-fleet",
    ]);
    // move-stable's own verification is move_stable.ts's; its wiring is pinned whole. The tag push
    // rides the checkout's persisted default token: contents: write, under ci.yml's caller ceiling.
    //   GH_TOKEN: github.token  -> the gh check-run lookup
    //   fetch-depth: 0          -> the ancestry reads
    //   outputs.previous        -> the one output the directives leg consumes
    const moveSteps = jobs["move-stable"].steps ?? [];
    const moveStep = moveSteps.find((step) =>
      (step.run ?? "").includes("post-green/move_stable.ts"),
    );
    if (moveStep === undefined) throw new Error("move-stable has no move_stable.ts step");
    const moveCheckout = moveSteps.find((step) =>
      (step.uses ?? "").startsWith("actions/checkout@"),
    );
    if (moveCheckout === undefined) throw new Error("move-stable has no checkout step");
    expect({
      id: moveStep.id,
      env: moveStep.env,
      checkout: moveCheckout.with,
      permissions: jobs["move-stable"].permissions,
      outputs: jobs["move-stable"].outputs,
    }).toEqual({
      id: "move",
      env: { GH_TOKEN: "${{ github.token }}", SOURCE_SHA: "${{ inputs.sha }}" },
      checkout: { "fetch-depth": 0 },
      permissions: { contents: "write", checks: "read" },
      outputs: {
        previous: "${{ steps.move.outputs.previous }}",
      },
    });
    // A called job cannot exceed its caller's grant, so ci.yml's post-green
    // job carries the ceiling of every post-green.yml job.
    //   contents: write      -> move-stable's tag push with the run token
    //   checks: read         -> the green gate's check-run lookup
    //   pull-requests: read  -> read-directives' merged pull request lookup
    const ci = parseYaml(ciYml) as {
      jobs: Record<string, { permissions?: unknown }>;
    };
    expect(ci.jobs["post-green"].permissions).toEqual({
      contents: "write",
      checks: "read",
      "pull-requests": "read",
    });
    // read-directives mutates nothing, so its wiring is its verification, pinned whole. BEFORE_SHA is
    // the commit the tag named before this run moved it, else the push's `before` (judged_range.ts).
    //   GH_TOKEN: github.token  -> the pull request lookups; the squash commit carries the title alone
    //   fetch-depth: 0          -> the tag's previous commit can sit many commits below the judged one
    const readSteps = jobs["read-directives"].steps ?? [];
    const readStep = readSteps.find((step) =>
      (step.run ?? "").includes("fleet/fleet_sync_marker.ts"),
    );
    if (readStep === undefined) throw new Error("read-directives has no fleet_sync_marker.ts step");
    const checkout = readSteps.find((step) => (step.uses ?? "").startsWith("actions/checkout@"));
    if (checkout === undefined) throw new Error("read-directives has no checkout step");
    expect({
      needs: jobs["read-directives"].needs,
      if: jobs["read-directives"].if,
      env: readStep.env,
      permissions: jobs["read-directives"].permissions,
      checkout: checkout.with,
      outputs: jobs["read-directives"].outputs,
    }).toEqual({
      needs: ["move-stable"],
      if: "github.event_name != 'workflow_dispatch' && !cancelled()",
      env: {
        GH_TOKEN: "${{ github.token }}",
        SOURCE_SHA: "${{ inputs.sha }}",
        BEFORE_SHA: "${{ needs.move-stable.outputs.previous || inputs.before }}",
      },
      permissions: { contents: "read", "pull-requests": "read" },
      checkout: { ref: "${{ inputs.sha }}", "fetch-depth": 0 },
      outputs: {
        armed: "${{ steps.directives.outputs.armed }}",
        repos: "${{ steps.directives.outputs.repos }}",
      },
    });
    // sync-fleet's own verification is the called sync's (resolve_build.ts re-reads main history and the
    // green check at the commit the tag names); it rides the mover.
    const syncFleet = jobs["sync-fleet"];
    expect(syncFleet.needs).toEqual(["move-stable", "read-directives"]);
    expect(syncFleet.if).toBe(
      "!cancelled() && needs.move-stable.result == 'success' && needs.read-directives.outputs.armed == 'true'",
    );
    // The fleet's single-writer lane is held HERE (the raw group census
    // below cannot tell which job holds it).
    expect(syncFleet.concurrency).toEqual({
      group: "sync-repos",
      "cancel-in-progress": false,
    });
    expect(syncFleet.uses).toBe("./.github/workflows/sync-repos.yml");
    // The sync is handed THIS commit, never main's live HEAD.
    expect(syncFleet.with).toEqual({
      repos: "${{ needs.read-directives.outputs.repos }}",
      sha: "${{ inputs.sha }}",
    });
    expect(syncFleet.secrets).toEqual({
      REPO_PLATFORM_TOKEN: "${{ secrets.REPO_PLATFORM_TOKEN }}",
    });
    // settings-fleet's own verification is the called workflow's gate
    // (require_green_commit.ts's called path).
    const settingsFleet = jobs["settings-fleet"];
    expect(settingsFleet.needs).toEqual(["sync-fleet"]);
    expect(settingsFleet.if).toBe("github.event_name != 'workflow_dispatch' && !cancelled()");
    expect(settingsFleet.concurrency).toEqual({
      group: "settings-repos",
      "cancel-in-progress": false,
    });
    expect(settingsFleet.uses).toBe("./.github/workflows/settings-repos.yml");
    expect(settingsFleet.with).toEqual({
      repos: "all",
      sha: "${{ inputs.sha }}",
    });
    expect(settingsFleet.secrets).toEqual({
      REPO_PLATFORM_TOKEN: "${{ secrets.REPO_PLATFORM_TOKEN }}",
    });
  });

  test("the called settings apply never waits on the lane its caller holds, and has no push way in", () => {
    // The mirror of the sync's contract: settings-fleet holds the
    // settings-repos lane by its literal name, so settings-repos.yml's
    // group resolves to a per-run one on a called run (keyed on the
    // call-only sha input) while cron and dispatch keep the lane. The
    // retired push trigger and its paths list must stay gone - the
    // post-green call applies every target on every green main run.
    const settingsRepos = read(".github/workflows/settings-repos.yml");
    const doc = parseYaml(settingsRepos) as {
      on: Record<string, { inputs?: Record<string, unknown>; secrets?: Record<string, unknown> }>;
      concurrency: { group: string; "cancel-in-progress": boolean };
    };
    expect(Object.keys(doc.on)).toEqual(["schedule", "workflow_dispatch", "workflow_call"]);
    expect(Object.keys(doc.on.workflow_call.inputs ?? {})).toEqual(["repos", "sha"]);
    expect(Object.keys(doc.on.workflow_call.secrets ?? {})).toEqual(["REPO_PLATFORM_TOKEN"]);
    expect(doc.concurrency).toEqual({
      group:
        "${{ inputs.sha != '' && format('settings-repos-called-{0}', github.run_id) || 'settings-repos' }}",
      "cancel-in-progress": false,
    });
    expect(settingsRepos).not.toContain("paths:");
    expect(settingsRepos).toContain("ONLY_REPO: ${{ inputs.repos }}");
    expect(settingsRepos).not.toContain("ONLY_REPO: ${{ inputs.repo }}");
    expect(settingsRepos).toContain("SOURCE_SHA: ${{ inputs.sha }}");
  });

  test("the called sync never waits on the lane its caller holds", () => {
    // sync-fleet holds the fleet's single-writer lane by its literal
    // name; sync-repos.yml's workflow-level group must therefore resolve
    // to something ELSE on a called run (keyed on the call-only input,
    // never github.workflow) while cron and dispatch runs keep the lane.
    const syncRepos = read(".github/workflows/sync-repos.yml");
    const doc = parseYaml(syncRepos) as {
      on: Record<string, { inputs?: Record<string, unknown>; secrets?: Record<string, unknown> }>;
      concurrency: { group: string; "cancel-in-progress": boolean };
    };
    expect(Object.keys(doc.on)).toEqual(["schedule", "workflow_dispatch", "workflow_call"]);
    expect(Object.keys(doc.on.workflow_call.inputs ?? {})).toEqual(["repos", "sha"]);
    expect(Object.keys(doc.on.workflow_call.secrets ?? {})).toEqual(["REPO_PLATFORM_TOKEN"]);
    expect(doc.concurrency).toEqual({
      group:
        "${{ inputs.repos != '' && format('sync-repos-called-{0}', github.run_id) || 'sync-repos' }}",
      "cancel-in-progress": false,
    });
    // The scope reaches the selector as ONLY_REPO from the call input
    // only - the dispatch input stays out of step env (private slugs).
    expect(syncRepos).toContain("ONLY_REPO: ${{ inputs.repos }}");
    expect(syncRepos).not.toContain("ONLY_REPO: ${{ inputs.repo }}");
  });

  test("ci.yml keys a push run by its commit and never cancels it; only pull-request lanes cancel", () => {
    // A ref-keyed group keeps one pending run and replaces it with the newest: a burst of merges drops the middle commits' runs.
    // Keyed by the commit, every push run completes; PR pushes keep cancelling their stale runs.
    // The skeleton every fleet repository runs carries the same block (its only placeholder is the owner).
    const skeleton = read("files/base/.github/workflows/ci.yml").replaceAll(
      "{{github_username}}",
      "owner",
    );
    for (const text of [ciYml, skeleton]) {
      const doc = parseYaml(text) as {
        concurrency: { group: string; "cancel-in-progress": string | boolean };
      };
      expect(doc.concurrency).toEqual({
        group:
          "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
        "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      });
    }
  });

  test("ONE mover lane, literal, and no lane on the caller", () => {
    // The groups must be literals - NEVER derived from github.workflow,
    // which inside a workflow_call'd workflow resolves to the CALLER's
    // name and would split a lane between called and dispatched runs.
    // ci.yml legitimately keys its RUN-level serialization on
    // github.workflow (a trigger workflow, never workflow_call'd).
    expect(postGreenDoc.jobs["move-stable"].concurrency).toEqual({
      group: "stable-tag-move",
      "cancel-in-progress": false,
    });
    const groupsOf = (text: string) => [...text.matchAll(/^\s*group: (.*)$/gm)].map((m) => m[1]);
    expect(groupsOf(postGreen)).toEqual(["stable-tag-move", "sync-repos", "settings-repos"]);
    for (const group of groupsOf(postGreen)) {
      expect(group).not.toContain("github.workflow");
    }
    // Delivery legs never cancel a running one: an interrupted move
    // between read and push is exactly the wedge the lease exists for.
    expect(postGreen).not.toContain("cancel-in-progress: true");
    // A caller must never hold the resource its called workflow requires (the mover lane above
    // all), so ci.yml's post-green job holds no job-level lane. Asserted on the parsed job:
    // comments may NAME the lane while explaining this rule.
    const doc = parseYaml(ciYml) as { jobs: Record<string, Record<string, unknown>> };
    expect(doc.jobs["post-green"]).toBeDefined();
    expect(doc.jobs["post-green"].concurrency).toBeUndefined();
  });
});

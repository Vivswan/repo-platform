// The build-publish wiring the provenance path depends on, pinned where a
// silent edit would reintroduce the regression: the publisher's
// SOURCE_SHA must track the sha input on both ways in (github.sha in
// ci.yml's post-green caller - same run, so it IS the judged commit - and
// the operator's sha on a dispatch, never a re-derived ref), a dispatch
// must run the two delivery legs (publish-build and move-stable) ALONE,
// each delivery lane must stay one literal repo-scoped group (and NO lane
// on the caller), and a publish must COMMIT exactly when the composed tree
// changed or the tip's stamp needs recovery - never an empty commit in
// normal operation (no content-free fleet _commit bumps), never a silent
// skip that strands a broken stamp (the stamp-health guard keeps dispatch
// as a real escape hatch).

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

/** Evaluates the subset of the Actions expression grammar post-green.yml's
 * job conditions use - string literals, `==`/`!=`, `&&`/`||`, parentheses,
 * `!cancelled()`, and dotted context reads - against `context` (a missing
 * context read is the empty string, as an unrun job's output is). */
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

/** The jobs that run under `event`, by GitHub's rules: a job's condition
 * is evaluated against its needs' results (an unrun need is `skipped`
 * with empty outputs), and a condition without a status function carries
 * the implicit success(), read over the WHOLE ancestry: "a failure or skip
 * applies to all jobs in the dependency chain from the point of failure
 * or skip onwards", through a job that a status function let continue.
 * `outputs` stands in for the step outputs of every job that ran. */
function jobsRunning(
  jobs: Record<string, Job>,
  event: string,
  outputs: Record<string, string>,
  // Jobs that run and go red: their dependents see result failure and
  // empty outputs, and only a status-function condition lets them run.
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

describe("post-green publish wiring", () => {
  const ciYml = read(".github/workflows/ci.yml");
  const postGreen = read(".github/workflows/post-green.yml");
  const postGreenDoc = parseYaml(postGreen) as {
    on: Record<string, { inputs?: Record<string, { required?: boolean; type?: string }> }>;
    jobs: Record<string, Job>;
  };

  test("both ways in hand the publisher the sha input, and nothing else names a source", () => {
    // The caller is needs-ordered behind the gate in the SAME run, so
    // github.sha is the judged commit by construction - and it must still
    // flow caller -> input -> publish env explicitly (a leg re-deriving
    // it from context could be handed the wrong commit by a future
    // caller). A dispatch declares the SAME input, required, so the one
    // SOURCE_SHA line serves both.
    expect(ciYml).toContain("sha: ${{ github.sha }}");
    // The push base rides the same explicit-input discipline: declared on
    // the call, passed by the caller, never read off context inside a
    // leg (post-green.yml's header).
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
    const publishSteps = (postGreenDoc.jobs["publish-build"].steps ?? []).filter((step) =>
      (step.run ?? "").includes("build-branches/publish.ts"),
    );
    expect(publishSteps).toHaveLength(1);
    expect((publishSteps[0].env as Record<string, string>).SOURCE_SHA).toBe("${{ inputs.sha }}");
    // The retired workflow_run machinery and the retired pending-tree
    // handoff must stay gone.
    expect(ciYml).not.toContain("workflow_run");
    for (const retired of ["PREBUILT_REF", "build-pending", "refs/build-meta", "noop_claim"]) {
      expect(postGreen).not.toContain(retired);
      expect(read(".github/scripts/build-branches/publish.ts")).not.toContain(retired);
    }
  });

  test("a dispatch runs the two delivery legs ALONE; the call runs every leg", () => {
    // Evaluated by GitHub's own rules on the parsed job graph (a
    // condition without a status function implies success() over the
    // needs; an unrun need is skipped with empty outputs), so a reworded
    // condition that lets a call-only leg fire on a dispatch fails here
    // whatever its spelling. The call arm is the moved control: with the
    // caller's push event and every output armed, every leg runs.
    const jobs = postGreenDoc.jobs;
    const armed = { armed: "true", previous: "a".repeat(40) };
    expect(jobsRunning(jobs, "workflow_dispatch", armed).sort()).toEqual([
      "move-stable",
      "publish-build",
    ]);
    expect(jobsRunning(jobs, "push", armed).sort()).toEqual(Object.keys(jobs).sort());
    // No directive skips the sync and nothing else: the settings apply
    // runs on every call, its targets never derived from the sync's.
    expect(jobsRunning(jobs, "push", { ...armed, armed: "false" }).sort()).toEqual([
      "move-stable",
      "publish-build",
      "read-directives",
      "settings-fleet",
    ]);
    // A mover that moved nothing reports no base - a replay at the tag's own
    // commit, or a re-run of this commit's jobs after a newer commit moved
    // the tag past it - and the read still runs and syncs on its fallback
    // base: re-running every job after a failed sync must recover it, and a
    // newer run's range (exclusive at its base, which can be this commit)
    // need not have held it. The mover has no word that stands the read
    // down, so its condition reads none of the mover's outputs.
    expect(jobsRunning(jobs, "push", { armed: "true", previous: "" }).sort()).toEqual(
      Object.keys(jobs).sort(),
    );
    expect(jobs["read-directives"].if).not.toContain("needs.move-stable.outputs");
    // A red mover (a lost lease) leaves the read on its fallback base
    // instead of losing this commit's directive, and the sync it arms
    // still runs: the publish and the opt-in are judged by name.
    expect(jobsRunning(jobs, "push", { armed: "true" }, ["move-stable"]).sort()).toEqual([
      "publish-build",
      "read-directives",
      "settings-fleet",
      "sync-fleet",
    ]);
    // That sync runs on the strength of sync-fleet's !cancelled() alone:
    // the red mover is its ancestor through read-directives, so the
    // implicit success() a bare condition carries would skip it, however
    // green its direct needs. The mutant dropping the status function is
    // red here, which is what proves the simulator reads the whole chain.
    const mutant = structuredClone(jobs);
    mutant["sync-fleet"].if = (mutant["sync-fleet"].if ?? "").replace("!cancelled() && ", "");
    expect(mutant["sync-fleet"].if).not.toContain("cancelled()");
    expect(jobsRunning(mutant, "push", { armed: "true" }, ["move-stable"]).sort()).toEqual([
      "publish-build",
      "read-directives",
      "settings-fleet",
    ]);
    // The control for that failure model: a red publish still skips the sync.
    expect(jobsRunning(jobs, "push", armed, ["publish-build"]).sort()).toEqual([
      "move-stable",
      "read-directives",
      "settings-fleet",
    ]);
    // And the two delivery legs have no condition to get wrong.
    for (const leg of ["publish-build", "move-stable"]) {
      expect(jobs[leg].if).toBeUndefined();
      expect(jobs[leg].needs).toBeUndefined();
    }
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
      "publish-build",
      "move-stable",
      "read-directives",
      "sync-fleet",
      "settings-fleet",
    ]);
    // move-stable's own verification is move_stable.ts's (main history,
    // the all-green check at the sha, the lease). Its wiring: the sha
    // input as the one source, the default token as the push credential
    // (contents: write, under ci.yml's caller ceiling), a full-history
    // checkout for the ancestry reads, and the one output the directives
    // leg consumes.
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
      permissions: (jobs["move-stable"] as unknown as { permissions: unknown }).permissions,
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
    // contents write: move-stable's tag push with the run token (the build publish pushes with its own PAT and reads only).
    // checks read: the green gate's check-run lookup.
    // pull-requests read: read-directives' merged pull request lookup.
    const ci = parseYaml(ciYml) as {
      jobs: Record<string, { permissions?: unknown }>;
    };
    expect(ci.jobs["post-green"].permissions).toEqual({
      contents: "write",
      checks: "read",
      "pull-requests": "read",
    });
    // read-directives mutates nothing; it reads every commit since the last
    // published build (never a re-derived ref) into the two outputs
    // sync-fleet consumes. The whole wiring of that range read is pinned as
    // one shape: the judged sha and the base (the commit the tag named
    // before this run moved it, else the push's `before` - judged_range.ts's
    // fallback base) as the step's env, the read token its pull request
    // lookups need (the squash commit carries the title alone), a
    // full-history checkout, since the stamped base can sit many commits
    // below the judged one, and a condition that stands down for no mover
    // result (the scenarios above).
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
    // sync-fleet's own verification is the called sync's (green source +
    // provenance gates in resolve_refs.ts); its wiring is pinned: gated
    // on the opt-in output, ordered behind the publish, fed the scope,
    // and given the PAT the sync writes with.
    const syncFleet = jobs["sync-fleet"];
    expect(syncFleet.needs).toEqual(["publish-build", "read-directives"]);
    expect(syncFleet.if).toBe(
      "!cancelled() && needs.publish-build.result == 'success' && needs.read-directives.outputs.armed == 'true'",
    );
    // The fleet's single-writer lane is held HERE (the raw group census
    // below cannot tell which job holds it).
    expect(syncFleet.concurrency).toEqual({
      group: "sync-repos",
      "cancel-in-progress": false,
    });
    expect(syncFleet.uses).toBe("./.github/workflows/sync-repos.yml");
    // The sync is handed THIS commit, never main's live HEAD: a refused
    // called scope names the judged commit (select_sync_repos.ts).
    expect(syncFleet.with).toEqual({
      repos: "${{ needs.read-directives.outputs.repos }}",
      sha: "${{ inputs.sha }}",
    });
    expect(syncFleet.secrets).toEqual({
      REPO_PLATFORM_TOKEN: "${{ secrets.REPO_PLATFORM_TOKEN }}",
    });
    // settings-fleet's own verification is the called workflow's gate
    // (require_green_commit.ts's called path). Its wiring: every target on
    // every called run, no changed flag anywhere, ordered behind the sync.
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
    expect(syncRepos).toContain("TARGET_SHA: ${{ inputs.sha }}");
  });

  test("ci.yml's main lane serializes without cancelling; only pull-request lanes cancel", () => {
    // The directive-loss fix reads a RANGE because GitHub keeps one pending
    // run per group and replaces it (a burst of three loses the middle
    // run); cancel-in-progress must never add a second loss by killing the
    // running main run, while PR pushes keep cancelling their stale runs.
    const doc = parseYaml(ciYml) as {
      concurrency: { group: string; "cancel-in-progress": string | boolean };
    };
    expect(doc.concurrency).toEqual({
      group: "${{ github.workflow }}-${{ github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
  });

  test("ONE lane per delivery ref: a literal group on each delivery job, and no lane on the caller", () => {
    // The groups must be literals - NEVER derived from github.workflow,
    // which inside a workflow_call'd workflow resolves to the CALLER's
    // name and would split a lane between called and dispatched runs.
    // ci.yml legitimately keys its RUN-level serialization on
    // github.workflow (a trigger workflow, never workflow_call'd).
    expect(postGreenDoc.jobs["publish-build"].concurrency).toEqual({
      group: "build-branches-publish",
      "cancel-in-progress": false,
    });
    expect(postGreenDoc.jobs["move-stable"].concurrency).toEqual({
      group: "stable-tag-move",
      "cancel-in-progress": false,
    });
    const groupsOf = (text: string) => [...text.matchAll(/^\s*group: (.*)$/gm)].map((m) => m[1]);
    expect(groupsOf(postGreen)).toEqual([
      "build-branches-publish",
      "stable-tag-move",
      "sync-repos",
      "settings-repos",
    ]);
    for (const group of groupsOf(postGreen)) {
      expect(group).not.toContain("github.workflow");
    }
    // Delivery legs never cancel a running one: an interrupted publish
    // between commit and push is exactly the wedge the CAS exists for.
    expect(postGreen).not.toContain("cancel-in-progress: true");
    // No self-deadlock: ci.yml's post-green job must hold no job-level
    // concurrency at all (a caller must never hold the resource its
    // called workflow requires; ci.yml's run-level lane already
    // serializes main runs) - and above all never the publisher lane the
    // called job waits for. Asserted structurally on the parsed job
    // (comments may NAME the lane while explaining this very rule).
    const doc = parseYaml(ciYml) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    expect(doc.jobs["post-green"]).toBeDefined();
    expect(doc.jobs["post-green"].concurrency).toBeUndefined();
  });

  test("no-change skips ONLY behind the stamp-health guard, then the commit segment is condition-free", () => {
    // The no-empty-commits rule and its one exception, pinned as source
    // shape (publish_behavior.test.ts proves it against real git). The skip
    // needs an unchanged tree AND a healthy tip stamp: health gating keeps
    // a dispatch able to heal a broken stamp instead of skipping forever.
    // Nothing between the note and the push may be an `if` or `return` (an
    // `if (staged)` around the commit would bring a diff-gate back), and
    // --allow-empty appears EXACTLY once, ternary-scoped to the unstaged
    // recovery case, so a regression to blanket empty commits fails here.
    const publish = read(".github/scripts/build-branches/publish.ts");
    expect(publish).toContain('if (branchExists && !staged && stampProblem === "") {');
    const body = publish.slice(
      publish.indexOf("function publish("),
      publish.indexOf('const sourceSha = requireEnv("SOURCE_SHA")'),
    );
    // The two skips return early; the push route runs to the end of the
    // function, so no third return may appear.
    const returns = body.match(/return\b[^;]*;/g) ?? [];
    expect(returns).toEqual(["return;", "return;"]);
    const skipEnd = body.indexOf("const note =");
    expect(skipEnd).toBeGreaterThan(-1);
    const commitSegment = body.slice(skipEnd, body.indexOf('"push"'));
    expect(commitSegment).toContain('"commit"');
    expect(commitSegment).not.toMatch(/\bif\s*\(/);
    expect(commitSegment).not.toContain("return");
    expect(body.match(/"--allow-empty"/g) ?? []).toHaveLength(1);
    expect(commitSegment).toContain('...(staged ? [] : ["--allow-empty"])');
  });

  test("no tree without actions/ ever publishes (the bootstrap shape guard)", () => {
    // A dispatch naming a PRE-unification main commit composes the
    // retired template-only tree with that commit's own branch_tree.ts;
    // minting `build` from it would 404 every fleet @build ref. The guard
    // must run BEFORE the first commit or push inside publish() - moving
    // it later would leave the window open while this test stayed green
    // on presence alone.
    const publish = read(".github/scripts/build-branches/publish.ts");
    expect(publish).toContain("carries no actions/ subtree");
    const body = publish.slice(publish.indexOf("function publish("));
    const guardAt = body.indexOf('hasActionManifest(join(scratch.tree, "actions"))');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(body.indexOf('"commit"'));
    expect(guardAt).toBeLessThan(body.indexOf('"push"'));
  });
});

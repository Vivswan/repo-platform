// The build-publish wiring the provenance path depends on, pinned where a
// silent edit would reintroduce the regression: the green-path publisher's
// SOURCE_SHA must track the JUDGED CI run's head_sha (not github.sha,
// which is main's current tip on a workflow_run event), the single
// publisher lane must survive the post-green split (one repo-scoped
// concurrency group, literal in both workflows), and a publish must
// COMMIT exactly when the composed tree changed or the tip's stamp needs
// recovery - never an empty commit in normal operation (no content-free
// fleet _commit bumps), never a silent skip that strands a broken stamp
// (the stamp-health guard keeps dispatch as a real escape hatch).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("post-green publish wiring", () => {
  const allGreen = read(".github/workflows/all-green.yml");
  const postGreen = read(".github/workflows/post-green.yml");
  const buildBranches = read(".github/workflows/build-branches.yml");

  test("the green path publishes the JUDGED commit, never github.sha", () => {
    // On a workflow_run event github.sha is main's CURRENT tip, not the
    // commit whose CI completed - so a green A superseded by red B would
    // never publish. The judged head_sha must flow caller -> input ->
    // publish env, and the pending-ref promotion must key off the same
    // input.
    expect(allGreen).toContain("sha: ${{ github.event.workflow_run.head_sha }}");
    expect(postGreen).toContain("SOURCE_SHA: ${{ inputs.sha }}");
    expect(postGreen).toContain("PREBUILT_REF: refs/heads/build-pending/${{ inputs.sha }}");
    // The self-heal leg is the one place github.sha is correct: on
    // schedule/dispatch the trigger commit IS the tip, and no pending
    // ref is promoted (publish.ts composes).
    expect(buildBranches).toContain("SOURCE_SHA: ${{ github.sha }}");
    // No PREBUILT_REF env here (the header may still NAME it): the
    // self-heal composes rather than promoting a parked tree.
    expect(buildBranches).not.toMatch(/^\s*PREBUILT_REF:/m);
    // The workflow_run publisher leg is GONE from Build Branches: its
    // triggers are exactly the pending build plus the two self-heal
    // publishers.
    const doc = parseYaml(buildBranches) as Record<string, unknown>;
    expect(Object.keys(doc.on as Record<string, unknown>)).toEqual([
      "push",
      "schedule",
      "workflow_dispatch",
    ]);
  });

  test("post-green releases only on a green verdict over a green push-to-main CI run", () => {
    // A custom `if` replaces the implicit success(), so the verdict
    // dependency must be spelled out - and the event gate must pin all
    // three of event, branch, and conclusion (any one missing releases
    // publishes for PR runs, non-main pushes, or red runs).
    for (const clause of [
      "needs.verdict.result == 'success'",
      "github.event_name == 'workflow_run'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.conclusion == 'success'",
    ]) {
      expect(allGreen).toContain(clause);
    }
  });

  test("post-green.yml is workflow_call ONLY (the verdict is the sole way in)", () => {
    const doc = parseYaml(postGreen) as Record<string, unknown>;
    expect(Object.keys(doc.on as Record<string, unknown>)).toEqual(["workflow_call"]);
  });

  test("post-green leg roster: every leg must be reviewed for its own green verification", () => {
    // The caller's gate is a PROXY (post-green.yml's header): until the
    // verdict reusable exposes its conclusion as an output, each leg must
    // hard-verify green itself. That requirement lives in review, so the
    // roster is pinned here - adding a leg fails this test until the new
    // job's verification story is written down and the roster updated.
    const doc = parseYaml(postGreen) as Record<string, unknown>;
    const jobs = doc.jobs as Record<string, { steps?: { run?: string; env?: unknown }[] }>;
    expect(Object.keys(jobs)).toEqual(["publish-build"]);
    // The one current leg verifies green via publish.ts (its
    // allGreenFailure gate), fed the judged sha input.
    const publishStep = (jobs["publish-build"].steps ?? []).find((step) =>
      (step.run ?? "").includes("build-branches/publish.ts"),
    );
    if (publishStep === undefined) throw new Error("publish-build has no publish.ts step");
    expect((publishStep.env as Record<string, string>).SOURCE_SHA).toBe("${{ inputs.sha }}");
  });

  test("ONE publisher lane: a literal group, shared by name across both workflows", () => {
    // The group must be a literal (or an explicit input) - NEVER derived
    // from github.workflow, which inside a workflow_call'd workflow
    // resolves to the CALLER's name and silently splits the lane. The
    // called job's literal and the self-heal leg's ternary arm must
    // spell the same string.
    const lane = "build-branches-publish";
    expect(postGreen).toContain(`group: ${lane}\n`);
    expect(buildBranches).toContain(
      "group: build-branches-${{ github.event_name == 'push' && 'pending' || 'publish' }}",
    );
    // The ban is scoped to the two publisher-lane holders: all-green.yml
    // legitimately keys its VERDICT serialization on github.workflow (it
    // is a trigger workflow, never workflow_call'd, and its post-green
    // job group is pinned exactly in the self-deadlock test below).
    for (const text of [postGreen, buildBranches]) {
      const groups = [...text.matchAll(/^\s*group: (.*)$/gm)].map((m) => m[1]);
      expect(groups.length).toBeGreaterThan(0);
      for (const group of groups) {
        expect(group).not.toContain("github.workflow");
      }
    }
    // Publishers never cancel a running publish: an interrupted publish
    // between commit and push is exactly the wedge the CAS exists for.
    expect(postGreen).not.toContain("cancel-in-progress: true");
    expect(buildBranches).not.toContain("cancel-in-progress: true");
  });

  test("no self-deadlock: the caller's group and the called publisher's group differ", () => {
    // all-green.yml's post-green job HOLDS post-green-<ref> while the
    // called publish job WAITS for the publisher lane; if the called
    // workflow ever requested the caller's group (or vice versa) the
    // call would deadlock against itself. Asserted on the actual group
    // declarations (comments may NAME the other lane while explaining
    // this very rule).
    const groupsOf = (text: string) => [...text.matchAll(/^\s*group: (.*)$/gm)].map((m) => m[1]);
    expect(groupsOf(allGreen)).toContain("post-green-${{ github.event.workflow_run.head_branch }}");
    expect(groupsOf(allGreen)).not.toContain("build-branches-publish");
    expect(groupsOf(postGreen)).toEqual(["build-branches-publish"]);
  });

  test("no-change skips ONLY behind the stamp-health guard, then the commit segment is condition-free", () => {
    // The no-empty-commits rule and its one exception, pinned as source
    // shape (tests/build-branches/publish_behavior.test.ts proves the
    // same behaviorally against real git):
    //   - the skip fires on an existing branch with an unchanged tree
    //     AND a healthy tip stamp (shared/stamp_checks.ts) - health
    //     gating is what keeps "dispatch Build Branches" able to heal a
    //     tampered or unparseable stamp instead of skipping forever;
    //   - after the skip, nothing between the note and the push is an
    //     `if` or a `return` (an `if (staged)` wrapped around the commit
    //     would silently bring a diff-gate back);
    //   - --allow-empty appears EXACTLY once, ternary-scoped to the
    //     unstaged (stamp recovery) case - normal publishes never carry
    //     it, so a regression to blanket empty commits fails here.
    const publish = read(".github/scripts/build-branches/publish.ts");
    expect(publish).toContain('if (branchExists && !staged && stampProblem === "") {');
    const body = publish.slice(
      publish.indexOf("function publish("),
      publish.indexOf("function sweepPendingRefs("),
    );
    const returns = body.match(/return[;\s]/g) ?? [];
    expect(returns).toHaveLength(2);
    const skipEnd = body.indexOf("const note =");
    expect(skipEnd).toBeGreaterThan(-1);
    const commitSegment = body.slice(skipEnd, body.indexOf('"push"'));
    expect(commitSegment).toContain('"commit"');
    expect(commitSegment).not.toMatch(/\bif\s*\(/);
    expect(commitSegment).not.toContain("return");
    expect(body.match(/"--allow-empty"/g) ?? []).toHaveLength(1);
    expect(commitSegment).toContain('...(staged ? [] : ["--allow-empty"])');
    // The retired refs/build-meta no-op marker system must stay gone.
    for (const rel of [
      ".github/scripts/build-branches/publish.ts",
      ".github/workflows/build-branches.yml",
      ".github/workflows/post-green.yml",
    ]) {
      expect(read(rel)).not.toContain("refs/build-meta");
      expect(read(rel)).not.toContain("noop_claim");
    }
  });

  test("no tree without actions/ ever publishes (the bootstrap shape guard)", () => {
    // A queued CI completion for a PRE-unification main commit runs the
    // new publisher with an old SOURCE_SHA whose own branch_tree.ts
    // composes the retired template-only tree; minting `build` from it
    // would 404 every fleet @build ref. The guard must check the tree on
    // EVERY path (pre-built included), and it must run BEFORE the first
    // commit or push inside publish() - moving it later would leave the
    // window open while this test stayed green on presence alone.
    const publish = read(".github/scripts/build-branches/publish.ts");
    expect(publish).toContain("carries no actions/ subtree");
    const body = publish.slice(publish.indexOf("function publish("));
    const guardAt = body.indexOf('hasActionManifest("/tmp/tree/actions")');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(body.indexOf('"commit"'));
    expect(guardAt).toBeLessThan(body.indexOf('"push"'));
  });
});

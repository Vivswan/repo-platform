// The build-publish wiring the provenance path depends on, pinned where a
// silent edit would reintroduce the regression: the green-path publisher's
// SOURCE_SHA must track the judged commit (github.sha in ci.yml's
// post-green caller - same run, so it IS the judged commit - passed as an
// explicit input so a future caller cannot silently hand a leg the wrong
// commit), the single publisher lane must survive the post-green split
// (one repo-scoped concurrency group, literal, and NO lane on the
// caller), and a publish must COMMIT exactly when the composed tree
// changed or the tip's stamp needs recovery - never an empty commit in
// normal operation (no content-free fleet _commit bumps), never a silent
// skip that strands a broken stamp (the stamp-health guard keeps
// dispatch as a real escape hatch).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("post-green publish wiring", () => {
  const ciYml = read(".github/workflows/ci.yml");
  const postGreen = read(".github/workflows/post-green.yml");
  const buildBranches = read(".github/workflows/build-branches.yml");

  test("the green path publishes the judged commit through the explicit sha input", () => {
    // The caller is needs-ordered behind the gate in the SAME run, so
    // github.sha is the judged commit by construction - and it must still
    // flow caller -> input -> publish env explicitly (a leg re-deriving
    // it from context could be handed the wrong commit by a future
    // caller), with the pending-ref promotion keyed off the same input.
    expect(ciYml).toContain("sha: ${{ github.sha }}");
    expect(postGreen).toContain("SOURCE_SHA: ${{ inputs.sha }}");
    expect(postGreen).toContain("PREBUILT_REF: refs/heads/build-pending/${{ inputs.sha }}");
    // The retired workflow_run machinery must stay gone from ci.yml.
    expect(ciYml).not.toContain("workflow_run");
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

  test("post-green.yml is workflow_call ONLY, and its leg roster is pinned for per-leg green review", () => {
    // The verdict is the sole way in: a second trigger would be a second,
    // unguarded path into release-shaped work.
    const doc = parseYaml(postGreen) as Record<string, unknown>;
    expect(Object.keys(doc.on as Record<string, unknown>)).toEqual(["workflow_call"]);
    // The caller gates on the verdict's conclusion output, but a leg
    // that MUTATES shared state keeps its own verification (post-green
    // .yml's header): that requirement lives in review, so the roster is
    // pinned here - adding a leg fails this test until the new job's
    // verification story is written down and the roster updated.
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
    // The ban is scoped to the two publisher-lane holders: ci.yml
    // legitimately keys its RUN-level serialization on github.workflow
    // (it is a trigger workflow, never workflow_call'd).
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

  test("no self-deadlock: the caller holds NO lane while the called publisher takes its group", () => {
    // ci.yml's post-green job must hold no job-level concurrency at all
    // (a caller must never hold the resource its called workflow
    // requires; ci.yml's run-level lane already serializes main runs) -
    // and above all never the publisher lane the called job waits for.
    // Asserted structurally on the parsed job (comments may NAME the
    // lane while explaining this very rule).
    const doc = parseYaml(ciYml) as { jobs: Record<string, Record<string, unknown>> };
    expect(doc.jobs["post-green"]).toBeDefined();
    expect(doc.jobs["post-green"].concurrency).toBeUndefined();
    const groupsOf = (text: string) => [...text.matchAll(/^\s*group: (.*)$/gm)].map((m) => m[1]);
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

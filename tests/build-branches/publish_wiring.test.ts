// The build-publish wiring the provenance path depends on, pinned where a
// silent edit would reintroduce the regression: the publisher's SOURCE_SHA
// must track the COMPLETED CI run's head_sha (not github.sha, which is
// main's current tip on a workflow_run event), and a publish must COMMIT
// exactly when the composed tree changed or the tip's stamp needs
// recovery - never an empty commit in normal operation (no content-free
// fleet _commit bumps), never a silent skip that strands a broken stamp
// (the stamp-health guard keeps dispatch as a real escape hatch).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("build-branches publish wiring", () => {
  const workflow = read(".github/workflows/build-branches.yml");

  test("SOURCE_SHA and PREBUILT_REF key off workflow_run.head_sha, not github.sha", () => {
    // On a workflow_run event github.sha is main's CURRENT tip, not the
    // commit whose CI completed - so a green A superseded by red B would
    // never publish. Both must derive from the event's head_sha, falling
    // back to github.sha only off the workflow_run path (schedule/dispatch,
    // where github.sha IS the trigger commit).
    expect(workflow).toContain(
      "SOURCE_SHA: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}",
    );
    expect(workflow).toContain(
      "PREBUILT_REF: ${{ github.event_name == 'workflow_run' && format('refs/heads/build-pending/{0}', github.event.workflow_run.head_sha) || '' }}",
    );
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

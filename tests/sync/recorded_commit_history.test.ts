// The recorded-commit resolver judges ancestry against origin/build and
// the ladder walks the build commits from the recorded base, so every
// checkout they run over must carry the FULL build history: a shallow
// clone makes every honest recording read as not-ancestor and blocks every
// fleet sync. The wiring is pinned structurally here - the checkout steps'
// `fetch-depth: 0` and the rehearsal's whole-ref fetch - with a control
// showing the check reds when a depth is dropped.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");

interface Step {
  uses?: string;
  with?: Record<string, unknown>;
}

/** Every actions/checkout step of every job, in file order, as
 * `<job>#<index>` -> its `with` block. */
export function checkoutSteps(workflowText: string): Map<string, Record<string, unknown>> {
  const doc = parseYaml(workflowText) as { jobs: Record<string, { steps?: Step[] }> };
  const found = new Map<string, Record<string, unknown>>();
  for (const [job, spec] of Object.entries(doc.jobs)) {
    (spec.steps ?? []).forEach((step, index) => {
      if (step.uses?.startsWith("actions/checkout@")) found.set(`${job}#${index}`, step.with ?? {});
    });
  }
  return found;
}

/** Every checkout of each workflow the resolver runs in, by `<job>#<index>`,
 * and whether the resolver's history lives there: `full` checkouts must
 * declare `fetch-depth: 0`; `shallow` ones are read for other reasons and
 * the resolver never runs over them. */
const CHECKOUTS: Record<string, Record<string, "full" | "shallow">> = {
  ".github/workflows/reusable-template-sync.yml": {
    "sync#0": "full", // repo-platform: origin/build for the recorded base and the ladder's walk
    "sync#5": "full", // the target: copier's own update base
    "sync#25": "shallow", // the version-aligned validator, a single ref
  },
};

/** The one assertion path the control and the live check share: every
 * checkout rostered, the full ones at depth 0, the shallow ones without a
 * depth. Throws (via expect) on any deviation. */
function assertHistory(workflowText: string, roster: Record<string, "full" | "shallow">): void {
  const checkouts = checkoutSteps(workflowText);
  // Every checkout in the file is accounted for by name, so a moved or
  // added step cannot slip past the roster silently.
  expect([...checkouts.keys()]).toEqual(Object.keys(roster));
  for (const [key, kind] of Object.entries(roster)) {
    const depth = checkouts.get(key)?.["fetch-depth"];
    if (kind === "full") expect(depth).toBe(0);
    else expect(depth).toBeUndefined();
  }
}

describe("full history under the recorded-commit resolver", () => {
  test.each(Object.entries(CHECKOUTS))(
    "%s: every checkout is rostered, and the full ones declare fetch-depth: 0",
    (rel, roster) => {
      assertHistory(read(rel), roster);
    },
  );

  test("the control: dropping a fetch-depth reds the same assertion path", () => {
    const rel = ".github/workflows/reusable-template-sync.yml";
    const shallowed = read(rel).replace(/^\s*fetch-depth: 0\n/m, "");
    expect(shallowed).not.toBe(read(rel));
    expect(() => assertHistory(shallowed, CHECKOUTS[rel])).toThrow();
  });

  test("the rehearsal's platform-clone fetch is the whole build ref with no depth", () => {
    const source = read(".github/scripts/sync/rehearse.ts");
    // The whole `const fetch = capture([...])` statement, argv included: a
    // `--depth` anywhere in it would shallow the platform clone the
    // resolver probes and the ladder walks. The TARGET clone, cloned
    // earlier with `--depth 1`, sits outside this statement on purpose -
    // neither runs over it.
    const statement = /const fetch = capture\([\s\S]*?\n {4}\);/.exec(source)?.[0] ?? "";
    expect(statement).toContain('"+refs/heads/build:refs/heads/build"');
    expect(statement).toContain('"fetch"');
    expect(statement).not.toContain("depth");
  });
});

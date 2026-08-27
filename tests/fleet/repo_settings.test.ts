// Pins this repository's OWN build-branch protection in
// .github/settings.yml, the same way merge_settings_layers.test.ts pins
// the override layer's protection policy. The `actions` ref is executable
// fleet-wide - rendered workflows pin `uses: ...@actions` and run its tree
// directly, with no provenance verify like the sync-side check guarding
// `template` - so a settings edit that reopens it to plain pushes must
// fail here, loudly.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

type Ruleset = {
  name: string;
  target?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: { type: string }[];
  bypass_actors?: Record<string, unknown>[];
};

const doc = parseYaml(readFileSync(".github/settings.yml", "utf-8")) as {
  rulesets: Ruleset[];
};

describe("the repo's own build-branch rulesets", () => {
  test("deletion and force-pushes stay blocked for everyone, publisher included", () => {
    const buildBranches = doc.rulesets.find((r) => r.name === "build-branches");
    expect(buildBranches).toBeDefined();
    expect(buildBranches?.target).toBe("branch");
    expect(buildBranches?.enforcement).toBe("active");
    expect(buildBranches?.conditions?.ref_name?.include?.sort()).toEqual(["actions", "template"]);
    expect(buildBranches?.conditions?.ref_name?.exclude).toEqual([]);
    expect(buildBranches?.rules?.map((r) => r.type).sort()).toEqual([
      "deletion",
      "non_fast_forward",
    ]);
    // Declared EMPTY, never omitted: only the explicit empty list lets
    // the nightly heal clear an out-of-band bypass actor - the
    // publish-only ruleset below is separate precisely so its bypass
    // actor cannot leak into these rules.
    expect(buildBranches?.bypass_actors).toEqual([]);
  });

  test("the actions ref blocks every write, creation included, bypassed only by the publish identity", () => {
    const publishOnly = doc.rulesets.find((r) => r.name === "actions-ref-publish-only");
    expect(publishOnly).toBeDefined();
    expect(publishOnly?.target).toBe("branch");
    expect(publishOnly?.enforcement).toBe("active");
    expect(publishOnly?.conditions?.ref_name?.include).toEqual(["actions"]);
    expect(publishOnly?.conditions?.ref_name?.exclude).toEqual([]);
    // creation is a SEPARATE GitHub rule from update: without it, any
    // push-capable principal could claim the executable ref whenever it is
    // absent (initial rollout, or recovery after an out-of-band deletion).
    // deletion and non_fast_forward ride along so the whole write surface
    // is one shape; the publisher stays bound to them anyway through the
    // bypass-free build-branches ruleset above.
    expect(publishOnly?.rules).toEqual([
      { type: "creation" },
      { type: "update" },
      { type: "deletion" },
      { type: "non_fast_forward" },
    ]);
    // 15368 is the GitHub Actions integration - the identity of the
    // GITHUB_TOKEN build-branches.yml publishes with. The narrowest actor
    // the ruleset dialect can express; see the comment in settings.yml
    // for the residual this accepts.
    expect(publishOnly?.bypass_actors).toEqual([
      { actor_id: 15368, actor_type: "Integration", bypass_mode: "always" },
    ]);
  });
});

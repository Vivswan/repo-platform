// Pins this repository's OWN build-branch protection in
// .github/settings.yml, the same way merge_settings_layers.test.ts pins
// the override layer's protection policy. The `actions` ref is executable
// fleet-wide - rendered workflows pin `uses: ...@actions` and run its tree
// directly - so a settings edit that drops it from the append-only ruleset
// must fail here, loudly. Also pins, fleet-wide: no settings layer may
// declare an Integration bypass actor, because GitHub rejects one on a
// user-owned repository's ruleset (POST /rulesets, 422 "Actor GitHub
// Actions integration must be part of the ruleset source or owner
// organization") and the settings apply dies at ruleset creation.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

type Ruleset = {
  name: string;
  target?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: { type: string }[];
  bypass_actors?: { actor_type?: string }[];
};

function readRulesets(path: string): Ruleset[] {
  const doc = parseYaml(readFileSync(path, "utf-8")) as { rulesets?: Ruleset[] } | null;
  return doc?.rulesets ?? [];
}

describe("the repo's own build-branch ruleset", () => {
  test("every generated ref, the executable build ref included, stays append-only for everyone", () => {
    const buildBranches = readRulesets(".github/settings.yml").find(
      (r) => r.name === "build-branches",
    );
    expect(buildBranches).toBeDefined();
    expect(buildBranches?.target).toBe("branch");
    expect(buildBranches?.enforcement).toBe("active");
    expect(buildBranches?.conditions?.ref_name?.include?.sort()).toEqual([
      "actions",
      "build",
      "template",
    ]);
    expect(buildBranches?.conditions?.ref_name?.exclude).toEqual([]);
    expect(buildBranches?.rules?.map((r) => r.type).sort()).toEqual([
      "deletion",
      "non_fast_forward",
    ]);
    // Declared EMPTY, never omitted: only the explicit empty list lets
    // the nightly heal clear an out-of-band bypass actor.
    expect(buildBranches?.bypass_actors).toEqual([]);
  });
});

describe("every settings layer", () => {
  test("no ruleset declares an Integration bypass actor", () => {
    const layerFiles = [
      // dot: true, or the glob silently skips the dotted .github/ paths.
      ...new Bun.Glob(".github/settings*.yml").scanSync({ dot: true }),
      ...new Bun.Glob("templates/*/settings*.yml").scanSync(),
    ].sort();
    // Controls: the scan must reach the layers known to carry bypass
    // actors, or an empty glob would pass vacuously.
    expect(layerFiles).toContain(".github/settings-override.yml");
    expect(layerFiles).toContain("templates/release-please/settings.yml");
    let actorsSeen = 0;
    const violations = layerFiles.flatMap((file) =>
      readRulesets(file).flatMap((ruleset) =>
        (ruleset.bypass_actors ?? [])
          .filter((actor) => {
            actorsSeen += 1;
            // Required-check integration_id pins are a different field
            // and stay valid on user-owned rulesets; only bypass actors
            // of type Integration are rejected.
            return actor.actor_type === "Integration";
          })
          .map(() => `${file}: ruleset ${ruleset.name}`),
      ),
    );
    expect(actorsSeen).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});

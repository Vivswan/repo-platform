// Pins this repository's OWN build-branch and stable-tag protection in
// its settings overlay, the same way merge_settings_layers.test.ts pins the override
// layer's protection policy. The `build` ref is executable fleet-wide -
// rendered workflows pin `uses: ...@build` and run its actions/ subtree
// directly - so a settings edit that drops it from the append-only
// ruleset must fail here, loudly. Also pins, fleet-wide: no settings
// layer may declare an Integration bypass actor, because GitHub rejects
// one on a user-owned repository's ruleset (POST /rulesets, 422 "Actor
// GitHub Actions integration must be part of the ruleset source or owner
// organization") and the settings apply dies at ruleset creation.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/** The overlay once this repository renders its own settings document;
 *  its hand-written settings.yml until then. */
const OWN_OVERLAY = existsSync(".github/settings.local.yml")
  ? ".github/settings.local.yml"
  : ".github/settings.yml";

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
  test("the executable build ref stays append-only for everyone", () => {
    const buildBranches = readRulesets(OWN_OVERLAY).find((r) => r.name === "build-branches");
    expect(buildBranches).toBeDefined();
    expect(buildBranches?.target).toBe("branch");
    expect(buildBranches?.enforcement).toBe("active");
    // build is the sole delivery ref this ruleset protects.
    expect(buildBranches?.conditions?.ref_name?.include?.sort()).toEqual(["build"]);
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

describe("the repo's own stable-tag ruleset", () => {
  test("the stable tag is undeletable and otherwise unruled, so the lease move stays allowed", () => {
    const stableTag = readRulesets(OWN_OVERLAY).find((r) => r.name === "stable-tag");
    expect(stableTag).toBeDefined();
    expect(stableTag?.target).toBe("tag");
    expect(stableTag?.enforcement).toBe("active");
    expect(stableTag?.conditions?.ref_name?.include).toEqual(["stable"]);
    expect(stableTag?.conditions?.ref_name?.exclude).toEqual([]);
    // Deletion ONLY: git classifies every update of an existing tag as a
    // forced update, so an update or non_fast_forward rule would block
    // the mover (docs/build-provenance.md).
    expect(stableTag?.rules?.map((r) => r.type)).toEqual(["deletion"]);
    expect(stableTag?.bypass_actors).toEqual([]);
  });
});

describe("every settings layer", () => {
  test("no ruleset declares an Integration bypass actor", () => {
    const layerFiles = [
      ...new Bun.Glob("files/settings/*.yml").scanSync(),
      ...new Bun.Glob("files/*/settings*.yml").scanSync(),
      OWN_OVERLAY,
    ].sort();
    // Controls: the scan must reach the layers known to carry bypass
    // actors, or an empty glob would pass vacuously.
    expect(layerFiles).toContain("files/settings/override.yml");
    expect(layerFiles).toContain("files/release-please/settings.yml");
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

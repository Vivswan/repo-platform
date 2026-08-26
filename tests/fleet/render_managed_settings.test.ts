// Unit tests for the managed settings layers (layers 1 to 4): which layer
// files a repo's facts select, what the merged labels and rulesets come
// out as, and the fact resolvers' fail-closed reads. Uses the REAL layer
// files and module manifests - they are on-disk constants, and what they
// merge to is exactly what the fleet's applies ship. The repo layer and
// the fleet override (layers 5 and 6) are merge_settings_layers' tests.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declaredPrivate,
  enableCodeql,
  factsFromOperatorAnswers,
  factsFromTargetDir,
  layerPaths,
  loadLayer,
  managedLabelNames,
  managedLabels,
  managedRulesets,
  managedSettings,
  modulesFrom,
  type RepoFacts,
  renderManagedYaml,
  trackingLabelsFrom,
} from "../../.github/scripts/fleet/render_managed_settings";
import { loadManifests } from "../../scripts/module_manifests";

const manifests = loadManifests();
const privateLayerLabels = (loadLayer(".github/settings-private.yml").labels ?? []) as {
  name: string;
}[];
const releaseLabels = (loadLayer("templates/release-please/settings.yml").labels ?? []) as {
  name: string;
}[];

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return { modules: [], private: false, trackingLabels: [], ...overrides };
}

function labelNames(f: RepoFacts): string[] {
  return managedLabels(f, manifests).map((label) => label.name);
}

describe("managedLabels", () => {
  test("a bare selection gets the baseline's unconditional roster alone", () => {
    expect(labelNames(facts())).toEqual([
      "dependencies",
      "github_actions",
      "bug",
      "enhancement",
      "fix-lint",
    ]);
  });

  test("toolchain modules add their dependabot labels, shared ones once", () => {
    expect(labelNames(facts({ modules: ["uv"] }))).toContain("python:uv");
    const shared = labelNames(facts({ modules: ["bun", "node"] }));
    expect(shared.filter((name) => name === "javascript")).toHaveLength(1);
  });

  test("a selected module contributes its own settings layer's labels", () => {
    expect(releaseLabels.map((label) => label.name)).toEqual([
      "autorelease: pending",
      "autorelease: tagged",
      "release-blocker",
      "release-override",
    ]);
    const names = labelNames(facts({ modules: ["release-please"] }));
    for (const label of releaseLabels) {
      expect(names).toContain(label.name);
    }
    expect(labelNames(facts())).not.toContain("release-blocker");
  });

  test("a private repo carries the fleet private layer's labels", () => {
    for (const label of privateLayerLabels) {
      expect(labelNames(facts({ private: true }))).toContain(label.name);
      expect(labelNames(facts())).not.toContain(label.name);
    }
  });

  test("tracking labels render the repo's answer with the manifest tuple", () => {
    const withFuzzer = managedLabels(
      facts({ modules: ["fuzzer"], trackingLabels: [{ module: "fuzzer", label: "my-fuzz" }] }),
      manifests,
    );
    const label = withFuzzer.find((l) => l.name === "my-fuzz");
    expect(label).toBeDefined();
    expect(label?.color).toBe(
      manifests.find((m) => m.module === "fuzzer")?.tracking_label?.color ?? "",
    );
  });

  test("a tracking label for a module without a tracking_label manifest throws", () => {
    expect(() =>
      managedLabels(facts({ trackingLabels: [{ module: "uv", label: "x" }] }), manifests),
    ).toThrow("declares no tracking_label");
  });
});

describe("managedRulesets", () => {
  const rulesetNames = (f: RepoFacts) => managedRulesets(f, manifests).map((r) => r.name);
  const mainRuleTypes = (f: RepoFacts) => {
    const main = managedRulesets(f, manifests).find((r) => r.name === "main");
    return ((main?.rules ?? []) as { type: string }[]).map((r) => r.type);
  };

  test("the fleet protection rulesets are NOT in these layers", () => {
    // main and non-bypassable live in .github/settings-override.yml, which
    // merges above the repo layer at apply time - a repo must not be able
    // to beat them, so they cannot sit in a layer the repo wins over.
    expect(rulesetNames(facts())).toEqual([]);
    expect(rulesetNames(facts({ private: true }))).toEqual([]);
  });

  test("release-please adds the release-tags ruleset", () => {
    expect(rulesetNames(facts({ modules: ["release-please"] }))).toContain("release-tags");
  });

  test("code_scanning renders exactly for a public repo with a toolchain", () => {
    // The toolchain modules' settings-public.yml layers contribute it to
    // the main ruleset; the override's own main rules are appended to at
    // apply time (merge_settings_layers' tests pin that).
    expect(mainRuleTypes(facts({ modules: ["bun"] }))).toContain("code_scanning");
    expect(mainRuleTypes(facts({ modules: ["bun"], private: true }))).not.toContain(
      "code_scanning",
    );
    expect(mainRuleTypes(facts({ modules: ["rust"] }))).not.toContain("code_scanning");
  });

  test("two analyzable toolchains contribute code_scanning once", () => {
    expect(
      mainRuleTypes(facts({ modules: ["bun", "uv"] })).filter((t) => t === "code_scanning"),
    ).toHaveLength(1);
  });
});

describe("layerPaths", () => {
  const names = (f: RepoFacts) =>
    layerPaths(f, manifests).map((p) => p.split("/").slice(-2).join("/"));

  test("a bare public selection is the baseline plus the public overlay", () => {
    expect(names(facts())).toEqual([
      ".github/settings-baseline.yml",
      ".github/settings-public.yml",
    ]);
  });

  test("visibility picks exactly one fleet overlay", () => {
    expect(names(facts({ private: true }))).toEqual([
      ".github/settings-baseline.yml",
      ".github/settings-private.yml",
    ]);
  });

  test("all module base layers come before all module visibility layers", () => {
    // Precedence: a module's visibility overlay must be able to win over
    // any module's base layer, so the two groups cannot interleave.
    expect(names(facts({ modules: ["bun", "release-please"] }))).toEqual([
      ".github/settings-baseline.yml",
      ".github/settings-public.yml",
      "bun/settings.yml",
      "release-please/settings.yml",
      "bun/settings-public.yml",
    ]);
  });

  test("a module with no layer files contributes none", () => {
    // agents ships no settings layer at all, so it must not appear.
    expect(names(facts({ modules: ["agents"] }))).toEqual([
      ".github/settings-baseline.yml",
      ".github/settings-public.yml",
    ]);
  });
});

describe("managedSettings", () => {
  test("public repos get security_and_analysis; private ones must not (422)", () => {
    const publicDoc = managedSettings(facts(), manifests).repository as Record<string, unknown>;
    expect(publicDoc.security_and_analysis).toBeDefined();
    const privateDoc = managedSettings(facts({ private: true }), manifests).repository as Record<
      string,
      unknown
    >;
    expect(privateDoc.security_and_analysis).toBeUndefined();
  });

  test("identity keys are absent on purpose: they live in the repo's own settings.yml", () => {
    const repository = managedSettings(facts(), manifests).repository as Record<string, unknown>;
    for (const key of ["description", "homepage", "topics", "private"]) {
      expect(repository[key]).toBeUndefined();
    }
  });

  test("the YAML render carries the generator's self-identifying header", () => {
    expect(renderManagedYaml(facts(), manifests)).toContain("render_managed_settings.ts");
  });
});

describe("enableCodeql", () => {
  test("matches copier.yml's computed default: public plus a toolchain", () => {
    expect(enableCodeql(facts({ modules: ["bun"] }), manifests)).toBe(true);
    expect(enableCodeql(facts({ modules: ["bun"], private: true }), manifests)).toBe(false);
    expect(enableCodeql(facts({ modules: ["rust"] }), manifests)).toBe(false);
  });
});

describe("fact resolvers", () => {
  test("modulesFrom reads the top-level list and refuses anything else", () => {
    expect(modulesFrom("modules: [uv, settings-sync]\n", "f")).toEqual(["uv", "settings-sync"]);
    expect(() => modulesFrom("notmodules: true\n", "f")).toThrow("modules list");
    // A typo must be LOUD: layerPaths finds no layer files for it, so the
    // document would look valid while missing that module's labels, and
    // the apply deletes undeclared labels off the live repository.
    expect(() => modulesFrom("modules: [uv, setings-sync]\n", "f")).toThrow("unknown module");
    // A retired module is tolerated, matching sync/modules.ts.
    expect(
      modulesFrom(
        "modules: [uv, gone]\n",
        "f",
        manifests.filter((m) => m.module === "uv"),
        new Set(["gone"]),
      ),
    ).toEqual(["uv"]);
    expect(() => modulesFrom("a: [unclosed\n", "f")).toThrow("YAML parse error");
  });

  test("trackingLabelsFrom resolves selected streams and fails closed on a missing answer", () => {
    expect(trackingLabelsFrom("fuzzer_label: my-fuzz\n", ["fuzzer"], manifests, "f")).toEqual([
      { module: "fuzzer", label: "my-fuzz" },
    ]);
    expect(trackingLabelsFrom("{}\n", ["uv"], manifests, "f")).toEqual([]);
    expect(() => trackingLabelsFrom("{}\n", ["fuzzer"], manifests, "f")).toThrow(
      "cannot be resolved",
    );
  });

  test("declaredPrivate reads only a boolean repository.private", () => {
    expect(declaredPrivate("repository:\n  private: true\n")).toBe(true);
    expect(declaredPrivate("repository:\n  private: false\n")).toBe(false);
    expect(declaredPrivate("repository:\n  private: 'false'\n")).toBeNull();
    expect(declaredPrivate("repository: {}\n")).toBeNull();
    expect(declaredPrivate("a: [unclosed\n")).toBeNull();
    expect(declaredPrivate(null)).toBeNull();
  });

  test("factsFromTargetDir prefers the checkout's declared visibility over the recorded answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "facts-"));
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".repo-platform.yml"), "modules: [settings-sync]\n");
    writeFileSync(join(dir, ".copier-answers.yml"), "private: false\n");
    writeFileSync(join(dir, ".github/settings.yml"), "repository:\n  private: true\n");
    expect(factsFromTargetDir(dir, manifests).private).toBe(true);
    // Undeclared falls back to the recorded answer.
    writeFileSync(join(dir, ".github/settings.yml"), "repository: {}\n");
    expect(factsFromTargetDir(dir, manifests).private).toBe(false);
  });

  test("the operator's own selection is validated too", () => {
    // repo-platform is always a settings target, so a typo in its answers
    // file is the same destructive path as one in a client repo.
    const dir = mkdtempSync(join(tmpdir(), "operator-"));
    const file = join(dir, "answers.yml");
    const real = readFileSync(".repo-platform-answers.yml", "utf-8");
    writeFileSync(file, real.replace("- bun", "- bnu"));
    expect(() => factsFromOperatorAnswers(file, manifests)).toThrow("unknown module");
  });

  test("the operator answers reproduce this repository's own facts", () => {
    // Runs against the real .repo-platform-answers.yml (cwd is the repo
    // root under bun test), so a drifted answers schema fails here first.
    const operatorFacts = factsFromOperatorAnswers(".repo-platform-answers.yml");
    expect(operatorFacts.private).toBe(false);
    expect(operatorFacts.modules).toContain("release-please");
    expect(operatorFacts.trackingLabels).toEqual([]);
    // The operator baseline must carry the release labels its release
    // machinery recreates - the delete/recreate loop tripwire.
    const names = managedLabels(operatorFacts, manifests).map((label) => label.name);
    for (const required of ["dependencies", "github_actions", "javascript", "release-blocker"]) {
      expect(names).toContain(required);
    }
  });
});

describe("managedLabelNames", () => {
  test("covers every emittable label for the reserved-roster consumers", () => {
    const names = managedLabelNames(manifests);
    const baselineLabels = (loadLayer(".github/settings-baseline.yml").labels ?? []) as {
      name: string;
    }[];
    for (const label of [...baselineLabels, ...privateLayerLabels, ...releaseLabels]) {
      expect(names).toContain(label.name);
    }
    // A toolchain module's own layer, reachable for ANY selection.
    expect(names).toContain("javascript");
  });
});

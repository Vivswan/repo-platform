// Unit tests for the managed settings baseline generator: the module
// matrix -> labels/rulesets derivations, the visibility-gated blocks, and
// the fact resolvers' fail-closed reads. Uses the REAL module manifests -
// they are on-disk constants, and the roster tuples are exactly what the
// fleet's applies ship.

import { describe, expect, test } from "bun:test";
import {
  enableCodeql,
  factsFromOperatorAnswers,
  managedLabelNames,
  managedLabels,
  managedRulesets,
  managedSettings,
  modulesFrom,
  privateReportLabel,
  type RepoFacts,
  releasePleaseLabels,
  renderManagedYaml,
  staticLabels,
  trackingLabelsFrom,
} from "../../.github/scripts/fleet/render_managed_settings";
import { loadManifests } from "../../scripts/module_manifests";

const manifests = loadManifests();

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return { modules: [], private: false, trackingLabels: [], ...overrides };
}

function labelNames(f: RepoFacts): string[] {
  return managedLabels(f, manifests).map((label) => label.name);
}

describe("managedLabels", () => {
  test("a bare selection gets the static roster alone", () => {
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

  test("release-please adds the autorelease pair and the release-health gates", () => {
    const names = labelNames(facts({ modules: ["release-please"] }));
    for (const label of releasePleaseLabels()) {
      expect(names).toContain(label.name);
    }
  });

  test("a private repo carries the settings-as-code-report marker label", () => {
    expect(labelNames(facts({ private: true }))).toContain(privateReportLabel().name);
    expect(labelNames(facts())).not.toContain(privateReportLabel().name);
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

  test("every selection carries main and non-bypassable", () => {
    expect(rulesetNames(facts())).toEqual(["main", "non-bypassable"]);
  });

  test("release-please adds the release-tags ruleset", () => {
    expect(rulesetNames(facts({ modules: ["release-please"] }))).toContain("release-tags");
  });

  test("code_scanning renders exactly for a public repo with a toolchain", () => {
    expect(mainRuleTypes(facts({ modules: ["bun"] }))).toContain("code_scanning");
    expect(mainRuleTypes(facts({ modules: ["bun"], private: true }))).not.toContain(
      "code_scanning",
    );
    expect(mainRuleTypes(facts({ modules: ["rust"] }))).not.toContain("code_scanning");
  });

  test("non-bypassable declares the explicit empty bypass list", () => {
    const ruleset = managedRulesets(facts(), manifests).find((r) => r.name === "non-bypassable");
    expect(ruleset?.bypass_actors).toEqual([]);
  });

  test("main requires exactly the all-green check", () => {
    const main = managedRulesets(facts(), manifests).find((r) => r.name === "main");
    const rules = (main?.rules ?? []) as Record<string, unknown>[];
    const checks = rules.find((rule) => rule.type === "required_status_checks")?.parameters as {
      required_status_checks: { context: string }[];
    };
    expect(checks.required_status_checks.map((c) => c.context)).toEqual(["all-green"]);
  });

  test("main's PR gate requires resolved review threads, fleet wide", () => {
    const main = managedRulesets(facts(), manifests).find((r) => r.name === "main");
    const rules = (main?.rules ?? []) as Record<string, unknown>[];
    const pr = rules.find((rule) => rule.type === "pull_request")?.parameters as Record<
      string,
      unknown
    >;
    expect(pr.required_review_thread_resolution).toBe(true);
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

  test("the operator answers reproduce this repository's own facts", () => {
    // Runs against the real .repo-platform-answers.yml (cwd is the repo
    // root under bun test), so a drifted answers schema fails here first.
    const operatorFacts = factsFromOperatorAnswers(".");
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
    for (const label of [...staticLabels(), privateReportLabel(), ...releasePleaseLabels()]) {
      expect(names).toContain(label.name);
    }
    expect(names).toContain("javascript");
  });
});

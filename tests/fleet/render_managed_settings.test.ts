// Unit tests for the managed settings layers (layers 1 to 4): which layer
// files a repo's facts select, what the merged labels and rulesets come
// out as, and the fact resolvers' fail-closed reads. Uses the REAL layer
// files and module manifests - they are on-disk constants, and what they
// merge to is exactly what the fleet's applies ship. The repo layer and
// the fleet override (layers 5 and 6) are merge_settings_layers' tests.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  declaredPrivate,
  enableCodeql,
  factsFromFetch,
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
  renderDecision,
  renderManagedYaml,
  trackingLabelsFrom,
} from "../../.github/scripts/fleet/render_managed_settings";
import { capture } from "../../.github/scripts/shared/proc";
import { loadManifests } from "../../scripts/module_manifests";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const manifests = loadManifests();
const privateLayerLabels = (loadLayer(".github/settings-private.yml").labels ?? []) as {
  name: string;
}[];
const releaseLabels = (loadLayer("templates/release-please/settings.yml").labels ?? []) as {
  name: string;
}[];

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return {
    modules: [],
    private: false,
    trackingLabels: [],
    prTitleWorkflowPresent: true,
    ...overrides,
  };
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
  const mainRules = (f: RepoFacts) => {
    const main = managedRulesets(f, manifests).find((r) => r.name === "main");
    return (main?.rules ?? []) as { type: string; parameters?: Record<string, unknown> }[];
  };
  const mainRuleTypes = (f: RepoFacts) => mainRules(f).map((r) => r.type);

  test("the fleet protection rulesets are NOT in these layers", () => {
    // main and non-bypassable PROTECTION rules live in
    // .github/settings-override.yml, which merges above the repo layer at
    // apply time - a repo must not be able to beat them, so they cannot
    // sit in a layer the repo wins over. The public overlay contributes a
    // main ENTRY, but it carries only the code_quality rule and the
    // public-only copilot_code_review auto-request (Copilot reviews are
    // disabled on private repos); the private side contributes no
    // ruleset at all. The baseline's pr-title ruleset IS here - repos may
    // beat module policy - and renders on every visibility (the disabled
    // deselection heal must reach every managed repo).
    expect(rulesetNames(facts())).toEqual(["pr-title", "main"]);
    expect(mainRuleTypes(facts())).toEqual(["code_quality", "copilot_code_review"]);
    expect(rulesetNames(facts({ private: true }))).toEqual(["pr-title"]);
  });

  test("the pr-title module flips the baseline's disabled required-check ruleset active", () => {
    const enforcement = (f: RepoFacts) =>
      managedRulesets(f, manifests).find((r) => r.name === "pr-title")?.enforcement;
    expect(enforcement(facts())).toBe("disabled");
    expect(enforcement(facts({ modules: ["pr-title"] }))).toBe("active");
    // Visibility-independent: pr-title checks run on private repos too.
    expect(enforcement(facts({ modules: ["pr-title"], private: true }))).toBe("active");
    // The presence gate: selection alone must not activate a required
    // check the pinned revision has no workflow to create (the sync
    // delivering pr-title.yml and the apply run in either order).
    expect(enforcement(facts({ modules: ["pr-title"], prTitleWorkflowPresent: false }))).toBe(
      "disabled",
    );
    // The flip must not lose the baseline's shape: the merged entry still
    // carries the pinned required check.
    const merged = managedRulesets(facts({ modules: ["pr-title"] }), manifests).find(
      (r) => r.name === "pr-title",
    ) as { rules?: { type: string; parameters?: Record<string, unknown> }[] };
    const checks = merged.rules?.find((r) => r.type === "required_status_checks")?.parameters
      ?.required_status_checks as { context: string; integration_id: number }[];
    expect(checks).toEqual([{ context: "pr-title", integration_id: 15368 }]);
  });

  test("code_quality renders for every public repo, toolchain or not", () => {
    // The fleet public overlay contributes it: the rule gates on GitHub
    // Code Quality's own analysis and stands down where the feature is
    // not enabled, so unlike code_scanning it needs no module gate (the
    // placement reasoning lives in .github/settings-public.yml).
    expect(mainRuleTypes(facts({ modules: ["rust"] }))).toContain("code_quality");
    expect(mainRuleTypes(facts({ modules: ["bun"] }))).toContain("code_quality");
    expect(mainRuleTypes(facts({ private: true }))).not.toContain("code_quality");
    expect(mainRuleTypes(facts({ modules: ["bun"], private: true }))).not.toContain("code_quality");
    // The parameters, not just the type: a misspelled enum value renders
    // fine and dies at apply time, fleet-wide.
    const rule = mainRules(facts()).find((r) => r.type === "code_quality");
    expect(rule?.parameters).toEqual({ severity: "warnings" });
  });

  test("release-please adds the release-tags ruleset", () => {
    expect(rulesetNames(facts({ modules: ["release-please"] }))).toContain("release-tags");
  });

  test("code_scanning renders exactly for a public repo with a toolchain", () => {
    // The toolchain modules' settings-public.yml layers contribute it to
    // the main ruleset; the override's own main rules are appended to at
    // apply time (merge_settings_layers' tests pin that). EVERY CodeQL
    // toolchain module, with the exact threshold tuple: a stale module
    // layer or a misspelled enum value would otherwise pass on types
    // alone and weaken (or 422) that module's repos at apply time.
    const codeqlModules = manifests.filter((m) => m.toolchain !== undefined).map((m) => m.module);
    expect(codeqlModules.length).toBeGreaterThan(0);
    for (const module of codeqlModules) {
      const rule = mainRules(facts({ modules: [module] })).find((r) => r.type === "code_scanning");
      expect(rule?.parameters).toEqual({
        code_scanning_tools: [
          {
            tool: "CodeQL",
            security_alerts_threshold: "high_or_higher",
            alerts_threshold: "errors_and_warnings",
          },
        ],
      });
      expect(mainRuleTypes(facts({ modules: [module], private: true }))).not.toContain(
        "code_scanning",
      );
    }
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

describe("the layer topology fails CLOSED", () => {
  // layerPaths used to select layer files by existence, which failed
  // OPEN: a deleted templates/uv/settings.yml just vanished from the
  // stack, the roster came out short but valid-looking, and the apply's
  // delete-undeclared pass removed the module's labels from live repos.
  // The module declaration now lives in each module.yml (settings_layers)
  // and the manifest LOADER holds it against the tree in both directions
  // (assertSettingsLayerFiles, tests/scripts/module_manifests.test.ts);
  // what the render still owns is the fleet layer files and the
  // declaration-driven selection proven here.

  test("selection follows the manifest declaration, never the tree", () => {
    // templates/uv/settings.yml exists on disk, but a manifest that does
    // not declare it must not select it - the tree is not the source.
    const undeclared = manifests.map((m) =>
      m.module === "uv" ? { ...m, settings_layers: undefined } : m,
    );
    const paths = layerPaths(facts({ modules: ["uv"] }), undeclared).map((p) =>
      p.split("/").slice(-2).join("/"),
    );
    expect(paths).not.toContain("uv/settings.yml");
    expect(paths).not.toContain("uv/settings-public.yml");
  });

  test("a deleted FLEET layer is a hard error", () => {
    const exists = (path: string) =>
      !path.endsWith(join(".github", "settings-baseline.yml")) && existsSync(path);
    expect(() => layerPaths(facts(), manifests, exists)).toThrow("fleet settings layer is missing");
  });

  test("the real tree satisfies the manifests' declarations", () => {
    // loadManifests already asserted every settings_layers entry against
    // the tree; a genuine drift fails there - never as a shorter render.
    expect(() => layerPaths(facts(), manifests)).not.toThrow();
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

describe("the render CLI acts on the recheck", () => {
  // renderDecision being right proves nothing if main() stops calling it,
  // so these drive the script itself and assert what the workflow gates
  // on: the output file, and whether a document was written at all.
  const script = resolve(import.meta.dir, "../../.github/scripts/fleet/render_managed_settings.ts");

  function runCli(modules: string): {
    exitCode: number | null;
    outputs: string;
    wroteDocument: boolean;
    head: string;
  } {
    // A real checkout: a local fact source pins to its HEAD like a fetched
    // one does, and the freshness step refuses an empty pin.
    const root = mkdtempSync(join(tmpdir(), "render-cli-"));
    const git = (command: string[]) => {
      const result = capture(command);
      if (result.exitCode !== 0) throw new Error(`${command.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    git(["git", "-C", root, "init", "-q", "-b", "main"]);
    git(["git", "-C", root, "config", "user.email", "t@example.com"]);
    git(["git", "-C", root, "config", "user.name", "t"]);
    git(["git", "-C", root, "config", "commit.gpgsign", "false"]);
    git(["git", "-C", root, "config", "core.hooksPath", "/dev/null"]);
    writeFileSync(join(root, ".repo-platform.yml"), `modules: [${modules}]\n`);
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".github/settings.yml"), "repository:\n  private: false\n");
    writeFileSync(join(root, ".copier-answers.yml"), "github_username: o\n");
    git(["git", "-C", root, "add", "-A"]);
    git(["git", "-C", root, "commit", "-qm", "facts"]);
    const head = git(["git", "-C", root, "rev-parse", "HEAD"]);
    const outPath = join(root, "managed.yml");
    const outputPath = join(root, "step-output.txt");
    const proc = boundedSpawnSync(
      ["bun", script, "--repo", "o/r", "--target-dir", root, "--out", outPath],
      { env: { ...process.env, GITHUB_OUTPUT: outputPath } },
    );
    return {
      exitCode: proc.exitCode,
      outputs: existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : "",
      wroteDocument: existsSync(outPath),
      head,
    };
  }

  test("dropping settings-sync writes NO document and publishes skipped=true", () => {
    const result = runCli("uv");
    expect(result.exitCode).toBe(0);
    expect(result.wroteDocument).toBe(false);
    expect(result.outputs).toContain("skipped=true");
  });

  test("keeping it writes the document and publishes skipped=false", () => {
    const result = runCli("uv, settings-sync");
    expect(result.exitCode).toBe(0);
    expect(result.wroteDocument).toBe(true);
    expect(result.outputs).toContain("skipped=false");
    // The pin the freshness step compares against: without it that step
    // refuses, and the apply never runs.
    expect(result.outputs).toContain(`ref=${result.head}`);
  });
});

describe("renderDecision rechecks the opt-in at the pinned commit", () => {
  const withModules = (modules: string[]): RepoFacts => facts({ modules });

  test("a target that dropped settings-sync is REFUSED", () => {
    // Selection ran in the plan job against an older revision. Applying
    // now would reconcile - and delete - labels on a repository that has
    // turned central settings off.
    const decision = renderDecision(withModules(["uv"]), "fetch", "owner/name");
    expect(decision.kind).toBe("skip");
    if (decision.kind !== "skip") throw new Error("expected a skip");
    expect(decision.reason).toContain("owner/name");
    expect(decision.reason).toContain("no longer managed");
  });

  test("a target that still selects it renders", () => {
    expect(renderDecision(withModules(["uv", "settings-sync"]), "fetch", "r").kind).toBe("render");
  });

  test("the self-apply's local fact source is rechecked too", () => {
    expect(renderDecision(withModules(["uv"]), "target-dir", "r").kind).toBe("skip");
  });

  test("the operator repository is exempt: it has no .repo-platform.yml", () => {
    expect(renderDecision(withModules([]), "operator", "r").kind).toBe("render");
  });
});

describe("factsFromFetch pins every read to one ref", () => {
  test("all reads use the SAME ref, never the moving branch", () => {
    // A push between two reads would otherwise pair an old module
    // selection with a new repo layer, and the apply deletes the labels
    // of a module the repo had just selected.
    const seen: { path: string; ref: string }[] = [];
    const fetcher = (_repo: string, path: string, ref: string): string | null => {
      seen.push({ path, ref });
      if (path === ".repo-platform.yml") return "modules: [uv, fuzzer, settings-sync]\n";
      if (path === ".github/settings.yml") return "repository:\n  private: false\n";
      if (path === ".copier-answers.yml") return "fuzzer_label: my-fuzz\n";
      return null;
    };
    const facts = factsFromFetch(
      "owner/name",
      manifests,
      "000000000000000000000000000000000000000a",
      fetcher,
    );
    expect(facts.modules).toContain("uv");
    expect(facts.trackingLabels).toEqual([{ module: "fuzzer", label: "my-fuzz" }]);
    // Every read pinned, and the files that matter actually read.
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen.map((s) => s.ref))).toEqual(
      new Set(["000000000000000000000000000000000000000a"]),
    );
    expect(seen.map((s) => s.path)).toContain(".repo-platform.yml");
    expect(seen.map((s) => s.path)).toContain(".github/settings.yml");
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
    // repo-platform runs no release pipeline of its own, so release-please
    // is deliberately absent from its dogfooded modules.
    expect(operatorFacts.modules).not.toContain("release-please");
    expect(operatorFacts.modules).toContain("bun");
    // The dogfooded docs-site module is a tracking-stream module, so the
    // operator facts must resolve its label from the recorded answer.
    expect(operatorFacts.trackingLabels).toEqual([{ module: "docs-site", label: "docs-link-rot" }]);
    // The operator baseline must carry the labels its own machinery
    // recreates (dependabot, the docs-site link-rot stream) - the
    // delete/recreate loop tripwire.
    const names = managedLabels(operatorFacts, manifests).map((label) => label.name);
    for (const required of ["dependencies", "github_actions", "javascript", "docs-link-rot"]) {
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

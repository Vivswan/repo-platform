// Unit tests for the managed settings layers (layers 1 to 4): which layer
// files a repo's facts select, what the merged labels and rulesets come
// out as, and the fact resolvers' fail-closed reads. Uses the REAL layer
// files and files.yml - they are on-disk constants, and what they merge to
// is exactly what the fleet's applies ship, so the expectations below are
// the rosters spelled out, never re-read from the files (a loop over an
// emptied layer file would pass vacuously). The repo layer and the fleet
// override (layers 5 and 6) are merge_settings_layers' tests.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertLayerFiles,
  declaredPrivate,
  factsFromFetch,
  factsFromTargetDir,
  layerPaths,
  leftManagementReason,
  loadModules,
  managedLabelNames,
  managedLabels,
  managedRulesets,
  managedSettings,
  type RepoFacts,
  registrationFacts,
  renderManagedYaml,
} from "../../.github/scripts/fleet/render_managed_settings";
import { capture } from "../../.github/scripts/shared/proc";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const modules = loadModules();

// The baseline's unconditional roster: dependabot's base pair, the triage
// trio, then the fleet-wide nightly security stream. Every selection starts from it.
const BASELINE_LABELS = [
  "dependencies",
  "github_actions",
  "bug",
  "enhancement",
  "fix-lint",
  "security-nightly",
];

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
  return managedLabels(f, modules).map((label) => label.name);
}

describe("managedLabels", () => {
  test.each<{ reason: string; facts: RepoFacts; labels: string[] }>([
    {
      reason: "a bare selection gets the baseline's unconditional roster alone",
      facts: facts(),
      labels: BASELINE_LABELS,
    },
    {
      reason: "a private repo carries the fleet private layer's marker label; a public one not",
      facts: facts({ private: true }),
      labels: [...BASELINE_LABELS, "settings-as-code-report"],
    },
    {
      reason: "a toolchain module adds its dependabot label",
      facts: facts({ modules: ["uv"] }),
      labels: [...BASELINE_LABELS, "python:uv"],
    },
    {
      reason: "two toolchains sharing a dependabot label contribute it once",
      facts: facts({ modules: ["bun", "node"] }),
      labels: [...BASELINE_LABELS, "javascript"],
    },
    {
      reason: "a selected module contributes its own settings layer's labels",
      facts: facts({ modules: ["release-please"] }),
      labels: [
        ...BASELINE_LABELS,
        "autorelease: pending",
        "autorelease: tagged",
        "release-blocker",
        "release-override",
      ],
    },
  ])("$reason", ({ facts: f, labels }) => {
    expect(labelNames(f)).toEqual(labels);
  });

  test("tracking labels render the repo's label with the data file's tuple", () => {
    const withFuzzer = managedLabels(
      facts({ modules: ["fuzzer"], trackingLabels: [{ module: "fuzzer", label: "my-fuzz" }] }),
      modules,
    );
    const tuple = modules.find((m) => m.name === "fuzzer")?.tracking_label;
    if (tuple === undefined)
      throw new Error("files.yml's fuzzer module declares no tracking_label");
    expect(withFuzzer.find((l) => l.name === "my-fuzz")).toEqual({
      name: "my-fuzz",
      color: tuple.color as string,
      description: tuple.description as string,
    });
  });

  test("a tracking label for a module without a tracking_label throws", () => {
    expect(() =>
      managedLabels(facts({ trackingLabels: [{ module: "uv", label: "x" }] }), modules),
    ).toThrow("declares no tracking_label");
  });
});

describe("managedRulesets", () => {
  const rulesetNames = (f: RepoFacts) => managedRulesets(f, modules).map((r) => r.name);
  const mainRules = (f: RepoFacts) => {
    const main = managedRulesets(f, modules).find((r) => r.name === "main");
    return (main?.rules ?? []) as { type: string; parameters?: Record<string, unknown> }[];
  };
  const mainRuleTypes = (f: RepoFacts) => mainRules(f).map((r) => r.type);

  test("the fleet protection rulesets are NOT in these layers", () => {
    // main and non-bypassable PROTECTION rules live in
    // .github/settings-override.yml, which merges above the repo layer, so
    // a repo cannot beat them. The public overlay's main ENTRY carries only
    // the code_quality rule and the public-only copilot_code_review
    // auto-request (Copilot reviews are disabled on private repos); the
    // private side contributes no ruleset. The baseline's pr-title ruleset
    // IS here (repos may beat module policy) and renders on every
    // visibility, so the disabled deselection heal reaches every repo.
    expect(rulesetNames(facts())).toEqual(["pr-title", "main"]);
    expect(mainRuleTypes(facts())).toEqual(["code_quality", "copilot_code_review"]);
    expect(rulesetNames(facts({ private: true }))).toEqual(["pr-title"]);
  });

  test("the pr-title module flips the baseline's disabled required-check ruleset active", () => {
    const enforcement = (f: RepoFacts) =>
      managedRulesets(f, modules).find((r) => r.name === "pr-title")?.enforcement;
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
    const merged = managedRulesets(facts({ modules: ["pr-title"] }), modules).find(
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
    // The whole ruleset, not its name: the tag-protection rules, the v*
    // condition, and the admin bypass are why it exists, and a stale or
    // misspelled module layer would otherwise pass here and die
    // fleet-wide at apply time.
    expect(rulesetNames(facts({ modules: ["release-please"] }))).toEqual([
      "pr-title",
      "main",
      "release-tags",
    ]);
    expect(
      managedRulesets(facts({ modules: ["release-please"] }), modules).find(
        (r) => r.name === "release-tags",
      ),
    ).toEqual({
      name: "release-tags",
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["v*"], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "update" }],
      bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
    });
  });

  test("code_scanning renders exactly for a public repo with a CodeQL toolchain", () => {
    // The toolchain modules' settings-public.yml layers contribute it to
    // the main ruleset; the override's own main rules are appended to at
    // apply time (merge_settings_layers' tests pin that). EVERY CodeQL
    // toolchain module, with the exact threshold tuple: a stale module
    // layer or a misspelled enum value would otherwise pass on types
    // alone and weaken (or 422) that module's repos at apply time.
    const codeqlModules = modules.filter((m) => m.codeql_language !== undefined).map((m) => m.name);
    expect(codeqlModules).toEqual(["bun", "node", "deno", "uv"]);
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
    // The whole main rule list, not a count: the rule appears ONCE, and
    // nothing else joins the ruleset.
    expect(mainRuleTypes(facts({ modules: ["bun", "uv"] }))).toEqual([
      "code_quality",
      "copilot_code_review",
      "code_scanning",
    ]);
  });
});

describe("layerPaths", () => {
  const names = (f: RepoFacts) =>
    layerPaths(f, modules).map((p) => p.split("/").slice(-2).join("/"));

  test.each<{ reason: string; facts: RepoFacts; paths: string[] }>([
    {
      reason: "a bare public selection is the baseline plus the public overlay",
      facts: facts(),
      paths: [".github/settings-baseline.yml", ".github/settings-public.yml"],
    },
    {
      reason: "visibility picks exactly one fleet overlay",
      facts: facts({ private: true }),
      paths: [".github/settings-baseline.yml", ".github/settings-private.yml"],
    },
    {
      // Precedence: a module's visibility overlay must be able to win
      // over any module's base layer, so the two groups cannot interleave.
      reason: "all module base layers come before all module visibility layers",
      facts: facts({ modules: ["bun", "release-please"] }),
      paths: [
        ".github/settings-baseline.yml",
        ".github/settings-public.yml",
        "bun/settings.yml",
        "release-please/settings.yml",
        "bun/settings-public.yml",
      ],
    },
    {
      // issue-templates ships no settings layer at all, so it must not appear.
      reason: "a module with no layer files contributes none",
      facts: facts({ modules: ["issue-templates"] }),
      paths: [".github/settings-baseline.yml", ".github/settings-public.yml"],
    },
  ])("$reason", ({ facts: f, paths }) => {
    expect(names(f)).toEqual(paths);
  });
});

describe("the layer topology fails CLOSED", () => {
  // Selecting layer files by existence fails OPEN: a deleted
  // files/uv/settings.yml would vanish from the stack, the roster come out
  // short but valid-looking, and the apply's delete-undeclared pass remove
  // the module's labels from live repos. The declaration lives in
  // files.yml (settings_layers) and the render holds it against the tree.

  test("selection follows the declaration, never the tree", () => {
    // A module that declares no layer selects none, whatever the tree
    // holds (the listing is injected empty: the topology check below owns
    // the undeclared-file case). The fleet layers still render: the
    // undeclared module contributes nothing, nothing else goes missing.
    const undeclared = modules.map((m) =>
      m.name === "uv" ? { ...m, settings_layers: undefined } : m,
    );
    const paths = layerPaths(
      facts({ modules: ["uv"] }),
      undeclared,
      existsSync,
      undefined,
      () => [],
    ).map((p) => p.split("/").slice(-2).join("/"));
    expect(paths).toEqual([".github/settings-baseline.yml", ".github/settings-public.yml"]);
  });

  test("a deleted FLEET layer is a hard error", () => {
    const exists = (path: string) =>
      !path.endsWith(join(".github", "settings-baseline.yml")) && existsSync(path);
    expect(() => layerPaths(facts(), modules, exists)).toThrow("fleet settings layer is missing");
  });

  test("a declared MODULE layer missing from files/ is a hard error, selected or not", () => {
    const exists = (path: string) =>
      !path.endsWith(join("files", "uv", "settings.yml")) && existsSync(path);
    expect(() => layerPaths(facts({ modules: ["bun"] }), modules, exists)).toThrow(
      "declared in files.yml modules.uv.settings_layers but missing",
    );
  });

  test("a present MODULE layer file no declaration names is a hard error, selected or not", () => {
    // The reverse direction: dropping modules.uv.settings_layers while
    // files/uv/settings.yml stays on disk would silently shorten the stack
    // (python:uv leaves the roster and the apply deletes it).
    const undeclared = modules.map((m) => (m.name === "uv" ? { ...m, settings_layers: [] } : m));
    expect(() => assertLayerFiles(undeclared)).toThrow(
      "files/uv/settings.yml: a settings layer file files.yml modules.uv.settings_layers does not declare",
    );
    // The control: the committed declarations match the tree in both directions.
    expect(() => assertLayerFiles(modules)).not.toThrow();
  });
});

describe("managedSettings", () => {
  // The baseline's repository block. Identity keys (description, homepage,
  // topics, private) are absent on purpose: they live in the repo's own
  // settings.yml, and an exact block proves the absence.
  const baselineRepository = {
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    has_discussions: false,
    default_branch: "main",
    delete_branch_on_merge: true,
    allow_update_branch: true,
    enable_automated_security_fixes: true,
  };

  test.each([
    {
      // The overlay heals an out-of-band disable of BOTH keys.
      reason: "public repos get security_and_analysis on top of the baseline block",
      facts: facts(),
      repository: {
        ...baselineRepository,
        security_and_analysis: {
          secret_scanning: { status: "enabled" },
          secret_scanning_push_protection: { status: "enabled" },
        },
      },
    },
    {
      // Private repos without Advanced Security 422 on those keys.
      reason: "private repos get the baseline block alone",
      facts: facts({ private: true }),
      repository: baselineRepository,
    },
  ])("$reason", ({ facts: f, repository }) => {
    expect(managedSettings(f, modules).repository).toEqual(repository);
  });
});

describe("the render CLI acts on the adoption recheck", () => {
  // A null fact source being right proves nothing if main() stops acting
  // on it, so these drive the script itself and assert what the workflow
  // gates on: the output file's content, and whether a document was
  // written at all.
  const script = resolve(import.meta.dir, "../../.github/scripts/fleet/render_managed_settings.ts");

  function runCli(registration: string | null): {
    exitCode: number | null;
    stdout: string;
    outputs: string;
    document: string | null;
    root: string;
    head: string;
  } {
    // A real checkout: a local fact source pins to its HEAD like a fetched
    // one does, and the freshness step refuses an empty pin.
    const root = temp.dir("render-cli-");
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
    if (registration !== null) writeFileSync(join(root, ".repo-platform.yml"), registration);
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".github/settings.yml"), "repository:\n  private: false\n");
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
      stdout: proc.stdout,
      outputs: existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : "",
      document: existsSync(outPath) ? readFileSync(outPath, "utf-8") : null,
      root,
      head,
    };
  }

  test("a checkout without .repo-platform.yml writes NO document and publishes skipped=true", () => {
    const result = runCli(null);
    expect(result.exitCode).toBe(0);
    expect(result.document).toBeNull();
    expect(result.outputs).toContain("skipped=true");
  });

  test("an adopted checkout writes the document and publishes skipped=false", () => {
    const result = runCli("modules: [uv]\n");
    expect(result.exitCode).toBe(0);
    // The written file IS the render for the checkout's facts - the
    // document the workflow applies - and it carries the generator's
    // self-identifying header.
    const factsRead = factsFromTargetDir(result.root, modules);
    expect(factsRead).not.toBeNull();
    expect(result.document).toBe(renderManagedYaml(factsRead as RepoFacts, modules));
    expect(result.document).toContain("render_managed_settings.ts");
    expect(result.outputs).toContain("skipped=false");
    // The pin the freshness step compares against: without it that step
    // refuses, and the apply never runs.
    expect(result.outputs).toContain(`ref=${result.head}`);
  });

  test("a selected stream module renders its registration label, else the module default", () => {
    const defaulted = runCli("modules: [uv, fuzzer]\n");
    expect(defaulted.exitCode).toBe(0);
    expect(defaulted.document).toContain("name: fuzz-nightly");
    const declared = runCli("modules: [uv, fuzzer]\nlabels: {fuzzer: my-fuzz}\n");
    expect(declared.exitCode).toBe(0);
    expect(declared.document).toContain("name: my-fuzz");
    expect(declared.document).not.toContain("fuzz-nightly");
  });

  test("an unreadable registration fails the render, naming the file", () => {
    const result = runCli("modules: [uv, pgaes]\n");
    expect(result.exitCode).toBe(1);
    expect(result.document).toBeNull();
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain('unknown module(s) "pgaes"');
  });
});

describe("adoption is rechecked at the pinned commit", () => {
  // Selection ran in the plan job against an older revision. A repository
  // whose .repo-platform.yml left in between has no selection to compute
  // a baseline from, and applying one built from the older revision would
  // reconcile - and delete - labels on a repository that left management.
  test("a fetched target without .repo-platform.yml at the pin is null; nothing else is read", () => {
    const seen: string[] = [];
    const fetcher = (_repo: string, path: string): string | null => {
      seen.push(path);
      return null;
    };
    expect(factsFromFetch("owner/name", modules, "0".repeat(40), fetcher)).toBeNull();
    expect(seen).toEqual([".repo-platform.yml"]);
  });

  test("the local fact source is null without the file, facts with it", () => {
    const dir = temp.dir("adoption-");
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github/settings.yml"), "repository:\n  private: false\n");
    expect(factsFromTargetDir(dir, modules)).toBeNull();
    writeFileSync(join(dir, ".repo-platform.yml"), "modules: [uv]\n");
    expect(factsFromTargetDir(dir, modules)).toEqual({
      modules: ["uv"],
      private: false,
      trackingLabels: [],
      prTitleWorkflowPresent: false,
    });
  });

  test("the skip reason names the repository and the deletion it avoids", () => {
    expect(leftManagementReason("owner/name")).toBe(
      "owner/name: no .repo-platform.yml at the revision these facts were read from - the " +
        "repository left management, so this apply is SKIPPED. Applying anyway would reconcile " +
        "- and delete - labels on a repository that is no longer managed.",
    );
  });
});

describe("factsFromFetch pins every read to one ref", () => {
  test("all reads use the SAME ref, never the moving branch", () => {
    // A push between two reads would otherwise pair an old module
    // selection with a new repo layer, and the apply deletes the labels
    // of a module the repo had just selected.
    const PIN = "000000000000000000000000000000000000000a";
    const seen: { path: string; ref: string }[] = [];
    const fetcher = (_repo: string, path: string, ref: string): string | null => {
      seen.push({ path, ref });
      if (path === ".repo-platform.yml")
        return "modules: [uv, fuzzer]\nlabels: {fuzzer: my-fuzz}\n";
      if (path === ".github/settings.yml") return "repository:\n  private: false\n";
      return null;
    };
    expect(factsFromFetch("owner/name", modules, PIN, fetcher)).toEqual({
      modules: ["uv", "fuzzer"],
      private: false,
      trackingLabels: [{ module: "fuzzer", label: "my-fuzz" }],
      prTitleWorkflowPresent: false,
    });
    // Exactly the files that matter, in read order, every one at the pin;
    // pr-title.yml is not probed because the module is unselected.
    expect(seen).toEqual(
      [".repo-platform.yml", ".github/settings.yml"].map((path) => ({ path, ref: PIN })),
    );
  });

  test("the pr-title workflow is probed at the pin only where the module is selected", () => {
    const PIN = "000000000000000000000000000000000000000b";
    const seen: string[] = [];
    const fetcher = (_repo: string, path: string, ref: string): string | null => {
      seen.push(`${path}@${ref}`);
      if (path === ".repo-platform.yml") return "modules: [pr-title]\n";
      if (path === ".github/settings.yml") return "repository:\n  private: true\n";
      if (path === ".github/workflows/pr-title.yml") return "name: pr-title\n";
      return null;
    };
    expect(factsFromFetch("owner/name", modules, PIN, fetcher)).toEqual({
      modules: ["pr-title"],
      private: true,
      trackingLabels: [],
      prTitleWorkflowPresent: true,
    });
    expect(seen).toEqual([
      `.repo-platform.yml@${PIN}`,
      `.github/settings.yml@${PIN}`,
      `.github/workflows/pr-title.yml@${PIN}`,
    ]);
  });
});

describe("registrationFacts", () => {
  const WHERE = "owner/name/.repo-platform.yml";

  test("reads the selection and refuses anything the grammar refuses", () => {
    expect(registrationFacts("modules: [uv, pages]\n", WHERE, modules).modules).toEqual([
      "uv",
      "pages",
    ]);
    expect(() => registrationFacts("notmodules: true\n", WHERE, modules)).toThrow(
      "no module selection found",
    );
    // The plan's registration grammar: a duplicate entry is unreadable.
    expect(() => registrationFacts("modules: [uv, uv]\n", WHERE, modules)).toThrow(
      "duplicate modules entry",
    );
    // An unknown key is refused too: the grammar is strict for every reader.
    expect(() => registrationFacts("modules: [uv]\nextra: 1\n", WHERE, modules)).toThrow(
      "Unrecognized key",
    );
    expect(() => registrationFacts("a: [unclosed\n", WHERE, modules)).toThrow("YAML parse error");
  });

  test("a typo in a module name is LOUD", () => {
    // layerPaths finds no layer files for it, so the document would look
    // valid while missing that module's labels, and the apply deletes
    // undeclared labels off the live repository.
    expect(() => registrationFacts("modules: [uv, pgaes]\n", WHERE, modules)).toThrow(
      "unknown module",
    );
  });

  test.each<{
    reason: string;
    registration: string;
    labels: { module: string; label: string }[];
  }>([
    {
      reason: "a declared label is the label",
      registration: "modules: [fuzzer]\nlabels: {fuzzer: my-fuzz}\n",
      labels: [{ module: "fuzzer", label: "my-fuzz" }],
    },
    {
      reason: "no selected stream module resolves nothing",
      registration: "modules: [uv]\n",
      labels: [],
    },
    {
      reason: "an undeclared label for a selected stream is the module default",
      registration: "modules: [uv, fuzzer]\n",
      labels: [{ module: "fuzzer", label: "fuzz-nightly" }],
    },
    {
      reason: "the fallback is per stream, in canonical module order",
      registration: "modules: [nightly, fuzzer]\nlabels: {nightly: my-nightly}\n",
      labels: [
        { module: "fuzzer", label: "fuzz-nightly" },
        { module: "nightly", label: "my-nightly" },
      ],
    },
  ])("$reason", ({ registration, labels }) => {
    expect(registrationFacts(registration, WHERE, modules).trackingLabels).toEqual(labels);
  });

  test("a tracking label the layers already manage is refused, case-insensitively, like the plan does", () => {
    for (const label of ["javascript", "Javascript", "release-blocker", "dependencies"]) {
      expect(() =>
        registrationFacts(`modules: [fuzzer]\nlabels: {fuzzer: ${label}}\n`, WHERE, modules),
      ).toThrow(`tracking label "${label}" (fuzzer) is a label the platform already manages`);
    }
    // The roster is injectable, so the refusal is proven against a name the
    // committed layers do not carry, and a default is judged like a key.
    expect(() =>
      registrationFacts("modules: [fuzzer]\n", WHERE, modules, new Set(["fuzz-nightly"])),
    ).toThrow('tracking label "fuzz-nightly" (fuzzer) is a label the platform already manages');
    expect(
      registrationFacts("modules: [fuzzer]\nlabels: {fuzzer: my-fuzz}\n", WHERE, modules)
        .trackingLabels,
    ).toEqual([{ module: "fuzzer", label: "my-fuzz" }]);
  });

  test("a labels key naming no selected stream throws", () => {
    expect(() =>
      registrationFacts("modules: [uv]\nlabels: {fuzzer: my-fuzz}\n", WHERE, modules),
    ).toThrow("labels.fuzzer names no selected tracking stream");
  });

  test("a label shaped outside the grammar throws, naming the key", () => {
    expect(() =>
      registrationFacts('modules: [fuzzer]\nlabels: {fuzzer: "-bad"}\n', WHERE, modules),
    ).toThrow("labels.fuzzer");
  });

  test.each([
    {
      reason: "two declared labels",
      registration: "modules: [fuzzer, nightly]\nlabels: {fuzzer: same, nightly: same}\n",
      error: 'tracking label "same" is shared by two streams (fuzzer, nightly)',
    },
    {
      reason: "two declared labels differing only in case",
      registration: "modules: [fuzzer, nightly]\nlabels: {fuzzer: Same, nightly: same}\n",
      error: 'tracking label "same" is shared by two streams (fuzzer, nightly)',
    },
    {
      reason: "a declared label that is another stream's default",
      registration: "modules: [docs-site, fuzzer]\nlabels: {docs_site: fuzz-nightly}\n",
      error: 'tracking label "fuzz-nightly" is shared by two streams (docs_site, fuzzer)',
    },
  ])(
    "a label shared by two streams is refused at the facts boundary: $reason",
    ({ registration, error }) => {
      expect(() => registrationFacts(registration, WHERE, modules)).toThrow(error);
    },
  );

  test("two settings layers claiming one label name fail the render", () => {
    // Bypassing registrationFacts, which refuses the shared label first:
    // the render's own collision check guards the merged layers.
    const trackingLabels = [
      { module: "docs-site", label: "fuzz-nightly" },
      { module: "fuzzer", label: "fuzz-nightly" },
    ];
    expect(() =>
      managedSettings(facts({ modules: ["docs-site", "fuzzer"], trackingLabels }), modules),
    ).toThrow("which collide");
  });
});

describe("fact resolvers", () => {
  test("declaredPrivate reads only a boolean repository.private", () => {
    expect(declaredPrivate("repository:\n  private: true\n")).toBe(true);
    expect(declaredPrivate("repository:\n  private: false\n")).toBe(false);
    expect(declaredPrivate("repository:\n  private: 'false'\n")).toBeNull();
    expect(declaredPrivate("repository: {}\n")).toBeNull();
    expect(declaredPrivate("a: [unclosed\n")).toBeNull();
    expect(declaredPrivate(null)).toBeNull();
  });

  test("factsFromTargetDir reads the checkout's declared visibility and refuses an undeclared one", () => {
    const dir = temp.dir("facts-");
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".repo-platform.yml"), "modules: [uv]\n");
    writeFileSync(join(dir, ".github/settings.yml"), "repository:\n  private: true\n");
    expect(factsFromTargetDir(dir, modules)?.private).toBe(true);
    writeFileSync(join(dir, ".github/settings.yml"), "repository: {}\n");
    expect(() => factsFromTargetDir(dir, modules)).toThrow(
      "declares no boolean repository.private",
    );
  });

  test("this repository's own registration reproduces its facts", () => {
    // Runs against the real checkout (cwd is the repo root under bun
    // test), the way settings-repos.yml's operator row reads it.
    const operatorFacts = factsFromTargetDir(".", modules);
    if (operatorFacts === null) throw new Error("this repository carries no .repo-platform.yml");
    expect(operatorFacts.private).toBe(false);
    // repo-platform runs no release pipeline of its own, so release-please
    // is deliberately absent from its own modules.
    expect(operatorFacts.modules).not.toContain("release-please");
    expect(operatorFacts.modules).toContain("bun");
    // The docs-site module is a tracking-stream module, so the operator
    // facts resolve its label from the registration.
    expect(operatorFacts.trackingLabels).toEqual([{ module: "docs-site", label: "docs-link-rot" }]);
    // The operator baseline must carry the labels its own machinery
    // recreates (dependabot, the docs-site link-rot stream) - the
    // delete/recreate loop tripwire.
    const names = managedLabels(operatorFacts, modules).map((label) => label.name);
    for (const required of ["dependencies", "github_actions", "javascript", "docs-link-rot"]) {
      expect(names).toContain(required);
    }
  });
});

describe("managedLabelNames", () => {
  test("covers every emittable label for the reserved-roster consumers", () => {
    // The whole roster, spelled out: every fleet layer's labels, every
    // toolchain module's dependabot label (reachable for ANY selection),
    // and the release-please module's own. A pure function of on-disk
    // constants, so the exact list is the claim - a loop re-reading the
    // layer files would pass on an emptied one.
    expect(managedLabelNames(modules)).toEqual([
      ...BASELINE_LABELS,
      "settings-as-code-report",
      "javascript",
      "deno",
      "python:uv",
      "rust",
      "autorelease: pending",
      "autorelease: tagged",
      "release-blocker",
      "release-override",
    ]);
  });
});

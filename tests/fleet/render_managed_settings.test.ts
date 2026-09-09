// Unit tests for the managed settings layers (layers 1 to 4): which layer
// files a repo's facts select, what the merged labels and rulesets come
// out as, and the fact resolvers' fail-closed reads. Uses the REAL layer
// files and module manifests - they are on-disk constants, and what they
// merge to is exactly what the fleet's applies ship, so the expectations
// below are the rosters spelled out, never re-read from the files (a loop
// over an emptied layer file would pass vacuously). The repo layer and
// the fleet override (layers 5 and 6) are merge_settings_layers' tests.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  declaredPrivate,
  enableCodeql,
  factsFromFetch,
  factsFromOperatorAnswers,
  factsFromTargetDir,
  layerPaths,
  leftManagementReason,
  managedLabelNames,
  managedLabels,
  managedRulesets,
  managedSettings,
  modulesFrom,
  type RepoFacts,
  renderManagedYaml,
  trackingLabelsFrom,
} from "../../.github/scripts/fleet/render_managed_settings";
import { capture } from "../../.github/scripts/shared/proc";
import { loadManifests } from "../../scripts/lib/module_manifests";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const manifests = loadManifests();

// The baseline's unconditional roster: dependabot's base pair, then the
// triage trio. Every selection starts from it.
const BASELINE_LABELS = ["dependencies", "github_actions", "bug", "enhancement", "fix-lint"];

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

  test("tracking labels render the repo's answer with the manifest tuple", () => {
    const withFuzzer = managedLabels(
      facts({ modules: ["fuzzer"], trackingLabels: [{ module: "fuzzer", label: "my-fuzz" }] }),
      manifests,
    );
    const tuple = manifests.find((m) => m.module === "fuzzer")?.tracking_label;
    if (tuple === undefined) throw new Error("the fuzzer manifest declares no tracking_label");
    expect(withFuzzer.find((l) => l.name === "my-fuzz")).toEqual({
      name: "my-fuzz",
      color: tuple.color,
      description: tuple.description,
    });
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
      managedRulesets(facts({ modules: ["release-please"] }), manifests).find(
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
    layerPaths(f, manifests).map((p) => p.split("/").slice(-2).join("/"));

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
  // layerPaths used to select layer files by existence, which failed
  // OPEN: a deleted templates/uv/settings.yml just vanished from the
  // stack, the roster came out short but valid-looking, and the apply's
  // delete-undeclared pass removed the module's labels from live repos.
  // The module declaration now lives in each module.yml (settings_layers)
  // and the manifest LOADER holds it against the tree in both directions
  // (assertSettingsLayerFiles, tests/scripts/lib/module_manifests.test.ts),
  // so a genuine drift fails at loadManifests - never as a shorter render;
  // what the render still owns is the fleet layer files and the
  // declaration-driven selection proven here.

  test("selection follows the manifest declaration, never the tree", () => {
    // templates/uv/settings.yml exists on disk, but a manifest that does
    // not declare it must not select it - the tree is not the source. The
    // fleet layers still render: the undeclared module contributes
    // nothing, nothing else goes missing.
    const undeclared = manifests.map((m) =>
      m.module === "uv" ? { ...m, settings_layers: undefined } : m,
    );
    const paths = layerPaths(facts({ modules: ["uv"] }), undeclared).map((p) =>
      p.split("/").slice(-2).join("/"),
    );
    expect(paths).toEqual([".github/settings-baseline.yml", ".github/settings-public.yml"]);
  });

  test("a deleted FLEET layer is a hard error", () => {
    const exists = (path: string) =>
      !path.endsWith(join(".github", "settings-baseline.yml")) && existsSync(path);
    expect(() => layerPaths(facts(), manifests, exists)).toThrow("fleet settings layer is missing");
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
    expect(managedSettings(f, manifests).repository).toEqual(repository);
  });
});

describe("enableCodeql", () => {
  test("matches copier.yml's computed default: public plus a toolchain", () => {
    expect(enableCodeql(facts({ modules: ["bun"] }), manifests)).toBe(true);
    expect(enableCodeql(facts({ modules: ["bun"], private: true }), manifests)).toBe(false);
    expect(enableCodeql(facts({ modules: ["rust"] }), manifests)).toBe(false);
  });
});

describe("the render CLI acts on the adoption recheck", () => {
  // A null fact source being right proves nothing if main() stops acting
  // on it, so these drive the script itself and assert what the workflow
  // gates on: the output file's content, and whether a document was
  // written at all.
  const script = resolve(import.meta.dir, "../../.github/scripts/fleet/render_managed_settings.ts");

  function runCli(modules: string | null): {
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
    if (modules !== null)
      writeFileSync(join(root, ".repo-platform.yml"), `modules: [${modules}]\n`);
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".github/settings.yml"), "repository:\n  private: false\n");
    writeFileSync(join(root, ".github/.copier-answers.yml"), "github_username: o\n");
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
    const result = runCli("uv");
    expect(result.exitCode).toBe(0);
    // The written file IS the render for the checkout's facts - the
    // document the workflow applies - and it carries the generator's
    // self-identifying header.
    const factsRead = factsFromTargetDir(result.root, manifests);
    expect(factsRead).not.toBeNull();
    expect(result.document).toBe(renderManagedYaml(factsRead as RepoFacts, manifests));
    expect(result.document).toContain("render_managed_settings.ts");
    expect(result.outputs).toContain("skipped=false");
    // The pin the freshness step compares against: without it that step
    // refuses, and the apply never runs.
    expect(result.outputs).toContain(`ref=${result.head}`);
  });

  test("a selected stream module with no recorded answer renders on its default with a notice", () => {
    // The unit tests inject the report sink; this proves the script's own
    // sink is the workflow command the apply log shows, and that the render
    // still writes the document (the label is the default, not a failure).
    const result = runCli("uv, fuzzer");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `::notice::${join(result.root, ".github/.copier-answers.yml")}: the fuzzer module is ` +
        "selected but the file records no fuzzer_label answer yet, so this apply assumes the " +
        "module's default label 'fuzz-nightly'.",
    );
    expect(result.document).toContain("name: fuzz-nightly");
    expect(result.outputs).toContain("skipped=false");
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
    expect(factsFromFetch("owner/name", manifests, "0".repeat(40), fetcher)).toBeNull();
    expect(seen).toEqual([".repo-platform.yml"]);
  });

  test("the local fact source is null without the file, facts with it", () => {
    const dir = temp.dir("adoption-");
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github/.copier-answers.yml"), "private: false\n");
    expect(factsFromTargetDir(dir, manifests)).toBeNull();
    writeFileSync(join(dir, ".repo-platform.yml"), "modules: [uv]\n");
    expect(factsFromTargetDir(dir, manifests)).toEqual({
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
      if (path === ".repo-platform.yml") return "modules: [uv, fuzzer]\n";
      if (path === ".github/settings.yml") return "repository:\n  private: false\n";
      if (path === ".github/.copier-answers.yml") return "fuzzer_label: my-fuzz\n";
      return null;
    };
    expect(factsFromFetch("owner/name", manifests, PIN, fetcher)).toEqual({
      modules: ["uv", "fuzzer"],
      private: false,
      trackingLabels: [{ module: "fuzzer", label: "my-fuzz" }],
      prTitleWorkflowPresent: false,
    });
    // Exactly the files that matter, in read order, every one at the pin;
    // pr-title.yml is not probed because the module is unselected.
    expect(seen).toEqual(
      [".repo-platform.yml", ".github/settings.yml", ".github/.copier-answers.yml"].map((path) => ({
        path,
        ref: PIN,
      })),
    );
  });
});

describe("fact resolvers", () => {
  test("modulesFrom reads the top-level list and refuses anything else", () => {
    expect(modulesFrom("modules: [uv, pages]\n", "f")).toEqual(["uv", "pages"]);
    expect(() => modulesFrom("notmodules: true\n", "f")).toThrow("modules list");
    // The sync's registration grammar: a duplicate entry is unreadable.
    expect(() => modulesFrom("modules: [uv, uv]\n", "f")).toThrow("modules list");
    // A typo must be LOUD: layerPaths finds no layer files for it, so the
    // document would look valid while missing that module's labels, and
    // the apply deletes undeclared labels off the live repository.
    expect(() => modulesFrom("modules: [uv, pgaes]\n", "f")).toThrow("unknown module");
    // A folded name is unknown too: the repository's pending sync PR drops
    // it (its rung), and the message says so instead of tolerating it.
    expect(() => modulesFrom("modules: [uv, settings-sync]\n", "f")).toThrow("merge that PR first");
    expect(() => modulesFrom("a: [unclosed\n", "f")).toThrow("YAML parse error");
  });

  describe("trackingLabelsFrom", () => {
    // A module lands in .repo-platform.yml one PR before the sync PR that
    // records its label answer, so an ABSENT answer is a normal state of
    // every module addition and resolves to the manifest default with this
    // notice; a PRESENT but unreadable answer is an answers-file defect.
    const WHERE = "owner/name/.github/.copier-answers.yml";
    const PENDING_FUZZER_NOTICE =
      "owner/name/.github/.copier-answers.yml: the fuzzer module is selected but the file " +
      "records no fuzzer_label answer yet, so this apply assumes the module's default label " +
      "'fuzz-nightly'. The repository's pending sync PR writes the answer; the first apply " +
      "after it merges reads the recorded value, so a label customized in that PR takes " +
      "effect then.";
    test.each<{
      reason: string;
      answers: string;
      modules: string[];
      labels: { module: string; label: string }[] | "throws";
      notices: string[];
    }>([
      {
        reason: "a recorded answer is the label, no notice",
        answers: "fuzzer_label: my-fuzz\n",
        modules: ["fuzzer"],
        labels: [{ module: "fuzzer", label: "my-fuzz" }],
        notices: [],
      },
      {
        reason: "no selected stream module resolves nothing",
        answers: "{}\n",
        modules: ["uv"],
        labels: [],
        notices: [],
      },
      {
        reason: "an absent answer for a selected stream is the manifest default, with the notice",
        answers: "github_username: o\n",
        modules: ["uv", "fuzzer"],
        labels: [{ module: "fuzzer", label: "fuzz-nightly" }],
        notices: [PENDING_FUZZER_NOTICE],
      },
      {
        reason: "the fallback is per stream: the recorded one stays recorded",
        answers: "nightly_label: my-nightly\n",
        modules: ["fuzzer", "nightly"],
        labels: [
          { module: "fuzzer", label: "fuzz-nightly" },
          { module: "nightly", label: "my-nightly" },
        ],
        notices: [PENDING_FUZZER_NOTICE],
      },
      {
        reason: "a present but empty answer still fails",
        answers: 'fuzzer_label: ""\n',
        modules: ["fuzzer"],
        labels: "throws",
        notices: [],
      },
      {
        reason: "a present but null answer still fails",
        answers: "fuzzer_label:\n",
        modules: ["fuzzer"],
        labels: "throws",
        notices: [],
      },
      {
        reason: "a present but non-string answer still fails",
        answers: "fuzzer_label: [a]\n",
        modules: ["fuzzer"],
        labels: "throws",
        notices: [],
      },
    ])("$reason", ({ answers, modules, labels, notices }) => {
      const seen: string[] = [];
      const absent = {
        fallback: "default",
        report: (message: string) => seen.push(message),
      } as const;
      if (labels === "throws") {
        expect(() => trackingLabelsFrom(answers, modules, manifests, WHERE, absent)).toThrow(
          "the fuzzer module is selected but its fuzzer_label answer is not readable",
        );
      } else {
        expect(trackingLabelsFrom(answers, modules, manifests, WHERE, absent)).toEqual(labels);
      }
      expect(seen).toEqual(notices);
    });

    test("an assumed default that collides with another stream's recorded label still fails", () => {
      // A repo may record another stream's default as its own label while
      // that stream is unselected. Selecting the stream then has no
      // resolvable label until its sync PR records a distinct one (copier's
      // validator refuses the equal pair), so the render fails as on any
      // label collision instead of guessing.
      const absent = { fallback: "default", report: () => {} } as const;
      const trackingLabels = trackingLabelsFrom(
        "docs_site_label: fuzz-nightly\n",
        ["docs-site", "fuzzer"],
        manifests,
        WHERE,
        absent,
      );
      expect(trackingLabels).toEqual([
        { module: "docs-site", label: "fuzz-nightly" },
        { module: "fuzzer", label: "fuzz-nightly" },
      ]);
      expect(() =>
        managedSettings(facts({ modules: ["docs-site", "fuzzer"], trackingLabels }), manifests),
      ).toThrow("which collide");
    });

    test("under the fail policy an absent answer throws instead of assuming the default", () => {
      expect(() =>
        trackingLabelsFrom("github_username: o\n", ["fuzzer"], manifests, WHERE, {
          fallback: "fail",
        }),
      ).toThrow(
        "owner/name/.github/.copier-answers.yml: the fuzzer module is selected but the file " +
          "records no fuzzer_label answer - no sync PR records this file, so the tracking " +
          "label cannot be resolved; record the answer",
      );
    });

    test("the fetched facts resolve a pending answer the same way, naming the repository", () => {
      // The observed shape: .repo-platform.yml already lists the module,
      // the sync PR rendering it (and recording fuzzer_label) is still open.
      const fetcher = (_repo: string, path: string): string | null => {
        if (path === ".repo-platform.yml") return "modules: [uv, fuzzer]\n";
        if (path === ".github/settings.yml") return "repository:\n  private: false\n";
        if (path === ".github/.copier-answers.yml") return "github_username: o\nprivate: false\n";
        return null;
      };
      const seen: string[] = [];
      const report = (message: string) => seen.push(message);
      expect(factsFromFetch("owner/name", manifests, "0".repeat(40), fetcher, report)).toEqual({
        modules: ["uv", "fuzzer"],
        private: false,
        trackingLabels: [{ module: "fuzzer", label: "fuzz-nightly" }],
        prTitleWorkflowPresent: false,
      });
      expect(seen).toEqual([PENDING_FUZZER_NOTICE]);
    });
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
    const dir = temp.dir("facts-");
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".repo-platform.yml"), "modules: [uv]\n");
    writeFileSync(join(dir, ".github/.copier-answers.yml"), "private: false\n");
    writeFileSync(join(dir, ".github/settings.yml"), "repository:\n  private: true\n");
    expect(factsFromTargetDir(dir, manifests)?.private).toBe(true);
    // Undeclared falls back to the recorded answer.
    writeFileSync(join(dir, ".github/settings.yml"), "repository: {}\n");
    expect(factsFromTargetDir(dir, manifests)?.private).toBe(false);
  });

  test("the operator's own selection is validated too", () => {
    // repo-platform is always a settings target, so a typo in its answers
    // file is the same destructive path as one in a client repo.
    const dir = temp.dir("operator-");
    const file = join(dir, "answers.yml");
    const real = readFileSync(".repo-platform-answers.yml", "utf-8");
    writeFileSync(file, real.replace("- bun", "- bnu"));
    expect(() => factsFromOperatorAnswers(file, manifests)).toThrow("unknown module");
  });

  test("the operator's absent stream answer is a defect, not a pending render", () => {
    // No sync PR writes .repo-platform-answers.yml, so the client-side
    // default fallback must not engage: the file is hand-maintained.
    const dir = temp.dir("operator-label-");
    const file = join(dir, "answers.yml");
    const real = readFileSync(".repo-platform-answers.yml", "utf-8");
    const stripped = real.replace(/^docs_site_label: .*\n/m, "");
    if (stripped === real) throw new Error("the real operator answers record no docs_site_label");
    writeFileSync(file, stripped);
    expect(() => factsFromOperatorAnswers(file, manifests)).toThrow(
      "records no docs_site_label answer - no sync PR records this file",
    );
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
    // The whole roster, spelled out: every fleet layer's labels, every
    // toolchain module's dependabot label (reachable for ANY selection),
    // and the release-please module's own. A pure function of on-disk
    // constants, so the exact list is the claim - a loop re-reading the
    // layer files would pass on an emptied one.
    expect(managedLabelNames(manifests)).toEqual([
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

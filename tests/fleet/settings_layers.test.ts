// settings_layers.ts: the ordered layer list github-settings-as-code merges
// for a repository, the tracking scratch layer, the labels-only fold the
// sync's roster check reads, and the override lint. Uses the REAL layer
// files and module manifests (on-disk constants), so the expectations below
// are the stack spelled out, never re-read from the files.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RepoFacts } from "../../.github/scripts/fleet/settings_facts";
import {
  ALL_GREEN_CONTEXT,
  allLayerLabels,
  GITHUB_ACTIONS_APP_ID,
  layerLabelNames,
  layerStack,
  layersInput,
  loadLayer,
  loadOverrideLayer,
  managedLabelNames,
  OVERRIDE_PATH,
  SCRATCH_REPO_LAYER,
  SCRATCH_TRACKING_LAYER,
  selectedLayerPaths,
  trackingLabels,
} from "../../.github/scripts/fleet/settings_layers";
import { capture } from "../../.github/scripts/shared/proc";
import { loadManifests } from "../../scripts/lib/module_manifests";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const manifests = loadManifests();
const REPO_ROOT = resolve(import.meta.dir, "../..");
const script = join(REPO_ROOT, ".github/scripts/fleet/settings_layers.ts");

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return {
    modules: [],
    private: false,
    trackingLabels: [],
    prTitleWorkflowPresent: true,
    ...overrides,
  };
}

const rel = (paths: string[]) => paths.map((path) => relative(REPO_ROOT, path));

describe("selectedLayerPaths", () => {
  test.each<{ reason: string; facts: RepoFacts; paths: string[] }>([
    {
      reason: "no modules, public: the baseline and the public overlay",
      facts: facts(),
      paths: [".github/settings-baseline.yml", ".github/settings-public.yml"],
    },
    {
      reason: "private: the private overlay instead, and no public module overlays",
      facts: facts({ modules: ["uv"], private: true }),
      paths: [
        ".github/settings-baseline.yml",
        ".github/settings-private.yml",
        "templates/uv/settings.yml",
      ],
    },
    {
      reason: "module layers in MODULE_ORDER, then their public overlays",
      facts: facts({ modules: ["release-please", "uv", "bun"] }),
      paths: [
        ".github/settings-baseline.yml",
        ".github/settings-public.yml",
        "templates/bun/settings.yml",
        "templates/uv/settings.yml",
        "templates/release-please/settings.yml",
        "templates/bun/settings-public.yml",
        "templates/uv/settings-public.yml",
      ],
    },
    {
      reason: "pr-title's activation waits for the workflow at the pinned revision",
      facts: facts({ modules: ["pr-title"], prTitleWorkflowPresent: false }),
      paths: [".github/settings-baseline.yml", ".github/settings-public.yml"],
    },
    {
      reason: "pr-title's layer joins once the workflow is on the branch",
      facts: facts({ modules: ["pr-title"] }),
      paths: [
        ".github/settings-baseline.yml",
        ".github/settings-public.yml",
        "templates/pr-title/settings.yml",
      ],
    },
  ])("$reason", ({ facts: f, paths }) => {
    expect(rel(selectedLayerPaths(f, manifests))).toEqual(paths);
  });

  test("a deleted FLEET layer is a hard error, never a shorter stack", () => {
    const exists = (path: string) => !path.endsWith("settings-private.yml");
    expect(() => selectedLayerPaths(facts(), manifests, exists)).toThrow(
      "fleet settings layer is missing",
    );
  });

  test("selection follows the manifest declaration, never the tree", () => {
    // A manifest declaring no layer files selects none, however many files
    // sit beside its module.yml (the loader keeps the two in step).
    const stripped = manifests.map((m) =>
      m.module === "uv" ? { ...m, settings_layers: undefined } : m,
    );
    expect(rel(selectedLayerPaths(facts({ modules: ["uv"] }), stripped))).toEqual([
      ".github/settings-baseline.yml",
      ".github/settings-public.yml",
    ]);
  });
});

describe("trackingLabels", () => {
  test("renders the repo's answer with the manifest tuple", () => {
    expect(
      trackingLabels(
        facts({ trackingLabels: [{ module: "fuzzer", label: "my-fuzz" }] }),
        manifests,
      ),
    ).toEqual([
      { name: "my-fuzz", color: "B60205", description: "Automated nightly fuzz failure" },
    ]);
  });

  test("a module without a tracking_label manifest throws", () => {
    expect(() =>
      trackingLabels(facts({ trackingLabels: [{ module: "uv", label: "x" }] }), manifests),
    ).toThrow("declares no tracking_label");
  });
});

describe("layerStack", () => {
  test("tracking labels sit above the module layers and below the repo layer; the override tops the stack", () => {
    const stack = layerStack(
      facts({ modules: ["uv", "fuzzer"], trackingLabels: [{ module: "fuzzer", label: "f" }] }),
      manifests,
      "/target/.github/settings.yml",
    );
    expect(
      stack.map((layer) =>
        layer.kind === "file"
          ? relative(REPO_ROOT, layer.path)
          : `tracking:${layer.labels[0].name}`,
      ),
    ).toEqual([
      ".github/settings-baseline.yml",
      ".github/settings-public.yml",
      "templates/uv/settings.yml",
      "templates/uv/settings-public.yml",
      "tracking:f",
      relative(REPO_ROOT, "/target/.github/settings.yml"),
      ".github/settings-override.yml",
    ]);
  });

  test("no tracking labels means no tracking layer", () => {
    const kinds = layerStack(facts(), manifests, "/t/.github/settings.yml").map((l) => l.kind);
    expect(kinds).toEqual(["file", "file", "file", "file"]);
  });
});

describe("layerLabelNames", () => {
  test("unions by case-folded name, higher wins, renames yield the post-apply name", () => {
    expect(
      layerLabelNames([
        { labels: [{ name: "Bug" }, { name: "docs" }] },
        { repository: {} },
        {
          labels: [
            { name: "bug", color: "x" },
            { name: "old", new_name: "new" },
          ],
        },
      ]),
    ).toEqual(["bug", "docs", "new"]);
  });

  test("the wrapped {_undeclared, entries} form reads like the plain list", () => {
    expect(
      layerLabelNames([{ labels: { _undeclared: "delete", entries: [{ name: "a" }] } }]),
    ).toEqual(["a"]);
  });

  test("a higher null drops the lower roster; nothing managed reads as null", () => {
    expect(layerLabelNames([{ labels: [{ name: "a" }] }, { labels: null }])).toBeNull();
    expect(
      layerLabelNames([{ labels: [{ name: "a" }] }, { labels: null }, { labels: [{ name: "b" }] }]),
    ).toEqual(["b"]);
    expect(layerLabelNames([{ repository: {} }, {}])).toBeNull();
    expect(layerLabelNames([{ labels: [] }])).toEqual([]);
  });
});

describe("the label roster", () => {
  test("covers every emittable label for the reserved-roster consumers", () => {
    const names = managedLabelNames(manifests);
    for (const required of [
      "dependencies",
      "github_actions",
      "bug",
      "enhancement",
      "fix-lint",
      "settings-as-code-report",
      "javascript",
      "python:uv",
      "deno",
      "rust",
      "autorelease: pending",
      "release-blocker",
    ]) {
      expect(names).toContain(required);
    }
    // Tracking labels render from per-repo answers, never from a layer file.
    expect(names).not.toContain("fuzz-nightly");
    expect(allLayerLabels(manifests).find((l) => l.name === "dependencies")).toEqual({
      name: "dependencies",
      color: "0366d6",
      description: "Dependency updates",
    });
  });
});

describe("the override layer", () => {
  test("the shipped override layer pins the whole protection policy", () => {
    // These are the invariants the override exists to make unbeatable, so
    // they are pinned here rather than left to whatever the file happens
    // to say. Losing any of them silently weakens every managed repo.
    const shipped = loadOverrideLayer();
    const rulesets = shipped.rulesets as Record<string, unknown>[];
    const main = rulesets.find((r) => r.name === "main");
    const mainRules = main?.rules as Record<string, unknown>[];
    // copilot_code_review is deliberately NOT here: it lives in the fleet
    // PUBLIC visibility overlay.
    expect(mainRules.map((r) => r.type).sort()).toEqual([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_linear_history",
      "required_status_checks",
    ]);
    // Exactly one required context, all-green, pinned to the Actions app.
    const checks = mainRules.find((r) => r.type === "required_status_checks")?.parameters;
    expect(checks).toEqual({
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: true,
      required_status_checks: [
        { context: ALL_GREEN_CONTEXT, integration_id: GITHUB_ACTIONS_APP_ID },
      ],
    });
    const pr = mainRules.find((r) => r.type === "pull_request")?.parameters as Record<
      string,
      unknown
    >;
    expect(pr.required_review_thread_resolution).toBe(true);
    expect(pr.require_code_owner_review).toBe(true);
    expect(pr.allowed_merge_methods).toEqual(["squash"]);
    expect(main?.bypass_actors).toEqual([
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ]);
    const nonBypassable = rulesets.find((r) => r.name === "non-bypassable");
    expect(
      ((nonBypassable?.rules ?? []) as Record<string, unknown>[]).map((r) => r.type).sort(),
    ).toEqual(["deletion", "required_linear_history"]);
    // Declared EMPTY on purpose: an omitted key is invisible to drift
    // detection, so the empty list is what heals an out-of-band bypass.
    expect(nonBypassable?.bypass_actors).toEqual([]);
    const repository = shipped.repository as Record<string, unknown>;
    expect(repository.allow_merge_commit).toBe(false);
    expect(repository.allow_rebase_merge).toBe(false);
    expect(repository.allow_squash_merge).toBe(true);
    expect(repository.squash_merge_commit_title).toBe("PR_TITLE");
  });

  test("an override that drops the required check or its Actions pin is refused", () => {
    const shipped = () =>
      parseYaml(readFileSync(OVERRIDE_PATH, "utf-8")) as Record<string, unknown>;
    const checksParams = (doc: Record<string, unknown>) => {
      const main = (doc.rulesets as { name: string; rules: Record<string, unknown>[] }[]).find(
        (r) => r.name === "main",
      );
      return main?.rules.find((r) => r.type === "required_status_checks")?.parameters as {
        required_status_checks: { context: string; integration_id?: number }[];
      };
    };
    const load = (doc: Record<string, unknown>) => {
      const file = join(temp.dir("override-"), "settings-override.yml");
      writeFileSync(file, stringifyYaml(doc));
      return loadOverrideLayer(file);
    };
    expect(() => load(shipped())).not.toThrow();

    const dropped = shipped();
    const params = checksParams(dropped);
    params.required_status_checks = params.required_status_checks.filter(
      (entry) => entry.context !== ALL_GREEN_CONTEXT,
    );
    expect(() => load(dropped)).toThrow(`must require the ${ALL_GREEN_CONTEXT} status check`);

    const unpinned = shipped();
    delete checksParams(unpinned).required_status_checks[0].integration_id;
    expect(() => load(unpinned)).toThrow("must pin integration_id");

    // A malformed (non-mapping) entry is refused, never silently dropped.
    const malformed = shipped();
    (checksParams(malformed).required_status_checks as unknown[]).push("all-green");
    expect(() => load(malformed)).toThrow("is not a mapping");
  });
});

describe("loadLayer", () => {
  test("an empty document is an empty layer, like the action reads it; a list is refused", () => {
    const dir = temp.dir("load-layer-");
    const empty = join(dir, "empty.yml");
    writeFileSync(empty, "# nothing yet\n");
    expect(loadLayer(empty)).toEqual({});
    const list = join(dir, "list.yml");
    writeFileSync(list, "- a\n");
    expect(() => loadLayer(list)).toThrow("not a YAML mapping");
  });
});

describe("layersInput", () => {
  test("joins with the action's separator and refuses a path carrying one", () => {
    expect(layersInput(["a.yml", "/tmp/b.yml"])).toBe("a.yml,/tmp/b.yml");
    expect(() => layersInput(["a,b.yml"])).toThrow("cannot contain a comma");
    expect(() => layersInput(["a\nb.yml"])).toThrow("cannot contain a comma or a newline");
  });
});

/** A real checkout: the local source pins to its HEAD like a fetched one
 *  does, and the freshness step refuses an empty pin. */
function checkout(files: Record<string, string>): { root: string; head: string } {
  const root = temp.dir("layers-cli-");
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
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(["git", "-C", root, "add", "-A"]);
  git(["git", "-C", root, "commit", "-qm", "facts"]);
  return { root, head: git(["git", "-C", root, "rev-parse", "HEAD"]) };
}

interface CliRun {
  exitCode: number | null;
  stdout: string;
  outputs: Record<string, string>;
  scratch: string;
}

function runCli(args: string[], env: Record<string, string | undefined>, scratch: string): CliRun {
  const outputPath = join(temp.dir("layers-out-"), "step-output.txt");
  const proc = boundedSpawnSync(["bun", script, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, GITHUB_OUTPUT: outputPath, ...env },
  });
  const outputs: Record<string, string> = {};
  if (existsSync(outputPath)) {
    for (const line of readFileSync(outputPath, "utf-8").split("\n")) {
      const at = line.indexOf("=");
      if (at !== -1) outputs[line.slice(0, at)] = line.slice(at + 1);
    }
  }
  return { exitCode: proc.exitCode, stdout: proc.stdout + proc.stderr, outputs, scratch };
}

describe("the layers CLI on a local checkout", () => {
  const SETTINGS = "repository:\n  private: false\n";

  test("an adopted checkout publishes the ordered list, its pin, and the tracking scratch layer", () => {
    const { root, head } = checkout({
      ".repo-platform.yml": "modules: [uv, fuzzer]\n",
      ".github/settings.yml": SETTINGS,
      ".github/.copier-answers.yml": "fuzzer_label: my-fuzz\n",
    });
    const scratch = join(temp.dir("layers-scratch-"), "settings-layers");
    const run = runCli(["--target-dir", root, "--scratch-dir", scratch], {}, scratch);
    expect(run.exitCode).toBe(0);
    expect(run.outputs.skipped).toBe("false");
    expect(run.outputs.skip_reason).toBe("");
    expect(run.outputs.ref).toBe(head);
    expect(run.outputs.layers.split(",")).toEqual([
      ".github/settings-baseline.yml",
      ".github/settings-public.yml",
      "templates/uv/settings.yml",
      "templates/uv/settings-public.yml",
      join(scratch, SCRATCH_TRACKING_LAYER),
      join(root, ".github/settings.yml"),
      ".github/settings-override.yml",
    ]);
    expect(parseYaml(readFileSync(join(scratch, SCRATCH_TRACKING_LAYER), "utf-8"))).toEqual({
      labels: [{ name: "my-fuzz", color: "B60205", description: "Automated nightly fuzz failure" }],
    });
    // Every published path is a readable YAML mapping: what the action's
    // merge reads.
    for (const path of run.outputs.layers.split(",")) {
      expect(parseYaml(readFileSync(resolve(REPO_ROOT, path), "utf-8"))).toBeInstanceOf(Object);
    }
  });

  test("a checkout without .repo-platform.yml skips as left management and publishes no list", () => {
    const { root, head } = checkout({ ".github/settings.yml": SETTINGS });
    const scratch = temp.dir("layers-scratch-");
    const run = runCli(["--target-dir", root, "--scratch-dir", scratch], {}, scratch);
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toEqual({
      ref: head,
      skipped: "true",
      skip_reason: "left-management",
      layers: "",
    });
    expect(run.stdout).toContain("::warning::no .repo-platform.yml at the revision");
  });

  test("a checkout without settings.yml skips as not onboarded", () => {
    const { root } = checkout({
      ".repo-platform.yml": "modules: [uv]\n",
      ".github/.copier-answers.yml": "private: false\n",
    });
    const scratch = temp.dir("layers-scratch-");
    const run = runCli(["--target-dir", root, "--scratch-dir", scratch], {}, scratch);
    expect(run.exitCode).toBe(0);
    expect(run.outputs.skipped).toBe("true");
    expect(run.outputs.skip_reason).toBe("not-onboarded");
    expect(run.stdout).toContain("::warning::no .github/settings.yml at the pinned revision");
  });

  test("an unknown module fails closed with the action's diagnostic", () => {
    const { root } = checkout({
      ".repo-platform.yml": "modules: [pgaes]\n",
      ".github/settings.yml": SETTINGS,
      ".github/.copier-answers.yml": "private: false\n",
    });
    const scratch = temp.dir("layers-scratch-");
    const run = runCli(["--target-dir", root, "--scratch-dir", scratch], {}, scratch);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("::error::");
    expect(run.stdout).toContain('unknown module(s) "pgaes"');
    expect(run.outputs).toEqual({});
  });

  test("the operator row (TARGET is this repository) reads its own checkout", () => {
    const runnerTemp = temp.dir("layers-runner-");
    const run = runCli(
      [],
      {
        TARGET: "Vivswan/repo-platform",
        GITHUB_REPOSITORY: "Vivswan/repo-platform",
        RUNNER_TEMP: runnerTemp,
      },
      join(runnerTemp, "settings-layers"),
    );
    expect(run.exitCode).toBe(0);
    expect(run.outputs.skipped).toBe("false");
    expect(run.outputs.ref).toMatch(/^[0-9a-f]{40}$/);
    const layers = run.outputs.layers.split(",");
    expect(layers[0]).toBe(".github/settings-baseline.yml");
    expect(layers).toContain("templates/bun/settings.yml");
    expect(layers).toContain("templates/pr-title/settings.yml");
    expect(layers).toContain(join(runnerTemp, "settings-layers", SCRATCH_TRACKING_LAYER));
    expect(layers.at(-2)).toBe(".github/settings.yml");
    expect(layers.at(-1)).toBe(".github/settings-override.yml");
    expect(
      readFileSync(join(runnerTemp, "settings-layers", SCRATCH_TRACKING_LAYER), "utf-8"),
    ).toContain("name: docs-link-rot");
  });
});

describe("the layers CLI on a fetched target", () => {
  // A stub gh serves the two ref-resolution calls and the raw file fetches
  // at the pin; SETTINGS_TEXT is the target's settings.yml (a 404 when empty).
  const HEAD = "a".repeat(40);
  function runFetched(settingsText: string | null, extraEnv: Record<string, string> = {}) {
    const root = temp.dir("layers-gh-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        'args="$*"',
        'case "$args" in',
        `  *"/commits/main"*) echo ${HEAD} ;;`,
        '  *"contents/.repo-platform.yml?ref="*) printf "modules: [uv]\\n" ;;',
        '  *"contents/.github/settings.yml?ref="*)',
        '    if [ -z "${SETTINGS_TEXT:-}" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi',
        '    printf "%s" "$SETTINGS_TEXT" ;;',
        '  *"repos/o/r --jq .default_branch"*) echo main ;;',
        '  *"repos/o/r --jq .private"*) echo false ;;',
        '  *) echo "gh stub: unmodeled call: $args" >&2; exit 64 ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const runnerTemp = join(root, "temp");
    mkdirSync(runnerTemp);
    return runCli(
      [],
      {
        PATH: `${bin}:${process.env.PATH}`,
        TARGET: "o/r",
        GITHUB_REPOSITORY: "Vivswan/repo-platform",
        RUNNER_TEMP: runnerTemp,
        SETTINGS_TEXT: settingsText ?? "",
        ...extraEnv,
      },
      join(runnerTemp, "settings-layers"),
    );
  }

  test("the repo layer is fetched at the pin into the neutral scratch file", () => {
    const run = runFetched("repository:\n  private: false\n  description: mine\n");
    expect(run.exitCode).toBe(0);
    expect(run.outputs.ref).toBe(HEAD);
    expect(run.outputs.skipped).toBe("false");
    const repoLayer = join(run.scratch, SCRATCH_REPO_LAYER);
    expect(run.outputs.layers.split(",")).toEqual([
      ".github/settings-baseline.yml",
      ".github/settings-public.yml",
      "templates/uv/settings.yml",
      "templates/uv/settings-public.yml",
      repoLayer,
      ".github/settings-override.yml",
    ]);
    expect(readFileSync(repoLayer, "utf-8")).toBe(
      "repository:\n  private: false\n  description: mine\n",
    );
  });

  test("a hide-details target publishes only numbered scratch copies", () => {
    // The merge step's settings-file input prints in the public log, so a
    // module layer's path would name a private target's module selection.
    const run = runFetched("repository:\n  private: true\n", { HIDE_DETAILS: "true" });
    expect(run.exitCode).toBe(0);
    const layers = run.outputs.layers.split(",");
    expect(layers).toEqual(
      ["01", "02", "03", "04", "05"].map((n) => join(run.scratch, `layer-${n}.yml`)),
    );
    // Every copy carries its source's bytes, in stack order.
    expect(readFileSync(layers[0], "utf-8")).toBe(
      readFileSync(join(REPO_ROOT, ".github/settings-baseline.yml"), "utf-8"),
    );
    expect(readFileSync(layers[1], "utf-8")).toBe(
      readFileSync(join(REPO_ROOT, ".github/settings-private.yml"), "utf-8"),
    );
    expect(readFileSync(layers[2], "utf-8")).toBe(
      readFileSync(join(REPO_ROOT, "templates/uv/settings.yml"), "utf-8"),
    );
    expect(readFileSync(layers[3], "utf-8")).toBe("repository:\n  private: true\n");
    expect(readFileSync(layers[4], "utf-8")).toBe(readFileSync(OVERRIDE_PATH, "utf-8"));
    expect(run.outputs.layers).not.toContain("templates/");
  });

  test("a 404 on settings.yml is the not-onboarded skip", () => {
    const run = runFetched(null);
    expect(run.exitCode).toBe(0);
    expect(run.outputs.skipped).toBe("true");
    expect(run.outputs.skip_reason).toBe("not-onboarded");
    expect(existsSync(join(run.scratch, SCRATCH_REPO_LAYER))).toBe(false);
  });

  test("a settings.yml that is not YAML fails here, behind the hidden boundary, not in the action", () => {
    const run = runFetched("repository: [unclosed\n");
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain(`::error::o/r/.github/settings.yml@${HEAD}: YAML parse error`);
    expect(existsSync(join(run.scratch, SCRATCH_REPO_LAYER))).toBe(false);
  });
});

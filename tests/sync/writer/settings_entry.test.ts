import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { trackingTuples } from "../../../.github/scripts/sync/writer/files_config.ts";
import {
  RENDERED_HEADER,
  renderSettings,
  type SettingsRenderInput,
} from "../../../.github/scripts/sync/writer/settings_entry.ts";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import { parseRegistration } from "../../../actions/plan/registration.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

const FILES_YML = [
  "placeholders: []",
  "modules:",
  "  bun: {}",
  "  rust: {}",
  "  fuzzer: {tracking_label: {key: fuzzer, default: fuzz-nightly, color: B60205, description: Automated nightly fuzz failure}}",
  "  nightly: {tracking_label: {key: nightly, default: nightly-failure, color: D93F0B, description: Automated nightly CI failure}}",
  "  site: {tracking_label: {key: site, default: docs-link-rot, color: D4A72C, description: Automated docs-site link-rot report}}",
  "settings:",
  "  baseline: files/settings/baseline.yml",
  "  layers:",
  "    - {source: files/settings/public.yml, when: {private: false}}",
  "    - {source: files/settings/private.yml, when: {private: true}}",
  "    - {source: files/bun/settings.yml, when: {modules: [bun]}}",
  "    - {source: files/rust/settings.yml, when: {modules: [rust]}}",
  "    - {source: files/settings/codeql-public.yml, when: {private: false, any: [bun]}}",
  "  override: files/settings/override.yml",
  "files:",
  "  - {path: .github/settings.local.yml, class: starter}",
  "  - {path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.local.yml}",
  "",
].join("\n");

const LAYERS: Record<string, string> = {
  "settings/baseline.yml": [
    "repository: {has_wiki: false, allow_merge_commit: true}",
    "labels:",
    '  - {name: bug, color: d73a4a, description: "Something isn\'t working"}',
    '  - {name: dependencies, color: "0366d6", description: Dependency updates}',
    "rulesets:",
    "  - {name: pr-title, target: branch, enforcement: disabled, rules: [{type: required_status_checks}]}",
    "",
  ].join("\n"),
  "settings/public.yml": [
    "repository: {security_and_analysis: {secret_scanning: {status: enabled}}}",
    "rulesets:",
    "  - {name: main, rules: [{type: code_quality, parameters: {severity: warnings}}]}",
    "",
  ].join("\n"),
  "settings/private.yml": [
    "labels:",
    '  - {name: settings-as-code-report, color: "0e2a47", description: private reporting}',
    "",
  ].join("\n"),
  "settings/override.yml": [
    "repository: {allow_merge_commit: false, squash_merge_commit_title: PR_TITLE}",
    "rulesets:",
    "  _undeclared: delete",
    "  entries:",
    "    - name: main",
    "      target: branch",
    "      enforcement: active",
    "      rules:",
    "        - type: deletion",
    "        - type: required_status_checks",
    "          parameters: {required_status_checks: [{context: all-green, integration_id: 15368}]}",
    "",
  ].join("\n"),
  "bun/settings.yml": 'labels:\n  - {name: javascript, color: "168700", description: JS updates}\n',
  "rust/settings.yml": 'labels:\n  - {name: rust, color: "000000", description: Rust updates}\n',
  "settings/codeql-public.yml":
    "rulesets:\n  - {name: main, rules: [{type: code_scanning, parameters: {code_scanning_tools: []}}]}\n",
};

const OVERLAY = [
  "# my overlay",
  "repository:",
  "  description: Mine",
  '  homepage: ""',
  '  topics: ""',
  "  private: false",
  "rulesets:",
  "  - name: release-branches",
  "    target: branch",
  "    enforcement: active",
  "    rules: [{type: deletion}]",
  "",
].join("\n");

function tree(layers: Record<string, string> = LAYERS): string {
  const root = temp.dir("settings-entry-");
  for (const [rel, text] of Object.entries(layers)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const TREE = tree();
const CONFIG = (() => {
  const config = parseFilesConfig(FILES_YML);
  return { ...config, trackingTuples: trackingTuples(config).tuples };
})();

function registration(text: string) {
  const read = parseRegistration(`${text}project: {name: Demo, slug: demo, description: Mine}\n`);
  if ("errors" in read) throw new Error(read.errors.join("\n"));
  return read.registration;
}

function input(overrides: Partial<SettingsRenderInput> = {}): SettingsRenderInput {
  return {
    config: CONFIG,
    tree: TREE,
    modules: ["bun"],
    registration: registration("modules: [bun]\n"),
    overlay: OVERLAY,
    overlayPath: ".github/settings.local.yml",
    owner: "OwnerOrg",
    ...overrides,
  };
}

/** The rendered document, its header stripped and parsed; a hold is a failure. */
function rendered(overrides: Partial<SettingsRenderInput> = {}): {
  text: string;
  doc: Record<string, unknown>;
} {
  const result = renderSettings(input(overrides));
  if ("held" in result) throw new Error(`held: ${result.held}`);
  return { text: result.content, doc: parseYaml(result.content) as Record<string, unknown> };
}

const held = (overrides: Partial<SettingsRenderInput>) => {
  const result = renderSettings(input(overrides));
  return "held" in result ? result.held : `rendered:\n${result.content}`;
};

/** A name-keyed section's entries out of the fold's `{entries, _undeclared}` wrapper. */
const entries = (section: unknown) =>
  (section as { entries: Record<string, unknown>[] } | undefined)?.entries;
const names = (section: unknown) => (entries(section) ?? []).map((entry) => entry.name);
const ruleset = (doc: Record<string, unknown>, name: string) =>
  entries(doc.rulesets)?.find((entry) => entry.name === name);

describe("renderSettings", () => {
  test("folds the layers low to high for a public selection, the override last", () => {
    const { text, doc } = rendered({ modules: ["bun", "rust"] });
    expect(
      text.startsWith(`${RENDERED_HEADER}\n# Rendered by the sync from the fleet settings layers`),
    ).toBe(true);
    expect(text).toContain("\n# Applied by OwnerOrg/repo-platform's settings run.\n");
    expect(doc.repository).toEqual({
      has_wiki: false,
      // The overlay's identity keys ride through; the override beats the baseline's merge flag.
      description: "Mine",
      homepage: "",
      topics: "",
      private: false,
      security_and_analysis: { secret_scanning: { status: "enabled" } },
      allow_merge_commit: false,
      squash_merge_commit_title: "PR_TITLE",
    });
    // Every layer's labels sorted by name, in the wrapper form the apply
    // reads: undeclared labels are deleted by the apply's default, undeclared
    // rulesets by the override's policy, both spelled out by the fold.
    expect(names(doc.labels)).toEqual(["bug", "dependencies", "javascript", "rust"]);
    expect(doc.labels).toMatchObject({ _undeclared: "delete" });
    expect(doc.rulesets).toMatchObject({ _undeclared: "delete" });
    // The public layer's main entry grown by the module layer and the
    // override, the baseline's, and the overlay's own, sorted by name.
    expect(names(doc.rulesets)).toEqual(["main", "pr-title", "release-branches"]);
    // The baseline's ruleset rides through whole: still disabled, its rule intact.
    expect(ruleset(doc, "pr-title")).toEqual({
      name: "pr-title",
      target: "branch",
      enforcement: "disabled",
      rules: [{ type: "required_status_checks" }],
    });
    expect(ruleset(doc, "main")).toEqual({
      name: "main",
      target: "branch",
      enforcement: "active",
      rules: [
        { type: "code_quality", parameters: { severity: "warnings" } },
        { type: "code_scanning", parameters: { code_scanning_tools: [] } },
        { type: "deletion" },
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "all-green", integration_id: 15368 }] },
        },
      ],
    });
    expect(ruleset(doc, "release-branches")).toEqual({
      name: "release-branches",
      target: "branch",
      enforcement: "active",
      rules: [{ type: "deletion" }],
    });
  });

  test("the override's ruleset policy beats an overlay asking to keep undeclared rulesets", () => {
    // The override merges above the overlay, so its policy is the fleet's
    // answer for every repository; the overlay's own entry still rides along.
    const { doc } = rendered({
      overlay: [
        "repository: {description: Mine, homepage: '', topics: '', private: false}",
        "rulesets:",
        "  _undeclared: keep",
        "  entries:",
        "    - {name: release-branches, target: branch, enforcement: active, rules: [{type: deletion}]}",
        "",
      ].join("\n"),
    });
    expect(doc.rulesets).toMatchObject({ _undeclared: "delete" });
    expect(names(doc.rulesets)).toEqual(["main", "pr-title", "release-branches"]);
  });

  test.each<{ reason: string; overlay: string; privateLayers: boolean }>([
    {
      reason: "an overlay declaring private selects the private layers",
      overlay: OVERLAY.replace("private: false", "private: true"),
      privateLayers: true,
    },
    {
      reason: "an overlay declaring public selects the public layers",
      overlay: OVERLAY,
      privateLayers: false,
    },
  ])("$reason", ({ overlay, privateLayers }) => {
    const { doc } = rendered({ overlay });
    const labels = names(doc.labels);
    const security = (doc.repository as Record<string, unknown>).security_and_analysis;
    const mainRules = ((ruleset(doc, "main")?.rules ?? []) as { type: string }[]).map(
      (r) => r.type,
    );
    if (privateLayers) {
      expect(labels).toEqual(["bug", "dependencies", "javascript", "settings-as-code-report"]);
      expect(security).toBeUndefined();
      expect(mainRules).toEqual(["deletion", "required_status_checks"]);
    } else {
      expect(labels).toEqual(["bug", "dependencies", "javascript"]);
      expect(security).toEqual({ secret_scanning: { status: "enabled" } });
      expect(mainRules).toEqual([
        "code_quality",
        "code_scanning",
        "deletion",
        "required_status_checks",
      ]);
    }
  });

  test("an overlay declaring no visibility holds the row: the render follows the overlay alone, never the operator's fact", () => {
    expect(held({ overlay: "repository: {description: x}\n" })).toBe(
      ".github/settings.local.yml declares no repository.private; the render follows the overlay's visibility alone",
    );
    expect(held({ overlay: "repository: {description: x, private: 'false'}\n" })).toBe(
      ".github/settings.local.yml declares no repository.private; the render follows the overlay's visibility alone",
    );
  });

  test("an overlay may beat the layers below the override and null one of their keys out", () => {
    const { doc } = rendered({
      overlay: [
        "repository: {description: Mine, has_wiki: null, allow_merge_commit: true, private: false}",
        'labels: [{name: bug, color: "000000", description: Restyled}]',
        "",
      ].join("\n"),
    });
    expect(entries(doc.labels)?.[0]).toEqual({
      name: "bug",
      color: "000000",
      description: "Restyled",
    });
    expect(doc.repository).not.toHaveProperty("has_wiki");
    expect((doc.repository as Record<string, unknown>).allow_merge_commit).toBe(false);
  });

  test("tracking labels are appended with the module's tuple, the registration's name beating the default", () => {
    const { doc } = rendered({
      modules: ["bun", "fuzzer", "nightly"],
      registration: registration("modules: [bun, fuzzer, nightly]\nlabels: {fuzzer: fuzz-me}\n"),
    });
    expect(entries(doc.labels)).toEqual([
      { name: "bug", color: "d73a4a", description: "Something isn't working" },
      { name: "dependencies", color: "0366d6", description: "Dependency updates" },
      { name: "fuzz-me", color: "B60205", description: "Automated nightly fuzz failure" },
      { name: "javascript", color: "168700", description: "JS updates" },
      { name: "nightly-failure", color: "D93F0B", description: "Automated nightly CI failure" },
    ]);
  });

  test.each<{
    reason: string;
    modules: string[];
    overlay: string;
    labels: Record<string, unknown>[] | undefined;
  }>([
    {
      reason: "labels: null with a tracking stream renders no labels key",
      modules: ["fuzzer"],
      overlay: `${OVERLAY}labels: null\n`,
      labels: undefined,
    },
    {
      reason: "labels: null with no stream renders no labels key",
      modules: [],
      overlay: `${OVERLAY}labels: null\n`,
      labels: undefined,
    },
    {
      reason:
        "an overlay declaring visibility alone, with a tracking stream, renders the roster and the tuple",
      modules: ["fuzzer"],
      overlay: "repository: {private: false}\n",
      labels: [
        { name: "bug", color: "d73a4a", description: "Something isn't working" },
        { name: "dependencies", color: "0366d6", description: "Dependency updates" },
        { name: "fuzz-nightly", color: "B60205", description: "Automated nightly fuzz failure" },
      ],
    },
  ])("$reason", ({ modules, overlay, labels }) => {
    // The opt-out leaves the labels to the repository; a roster of tracking
    // labels alone would have the apply delete every other label.
    const { doc } = rendered({
      modules,
      overlay,
      registration: registration(`modules: [${modules}]\n`),
    });
    expect(entries(doc.labels)).toEqual(labels);
    expect(names(doc.rulesets)).toEqual(
      overlay.includes("rulesets")
        ? ["main", "pr-title", "release-branches"]
        : ["main", "pr-title"],
    );
  });

  test("a layer naming one label twice is the operator's error: the render throws, naming the layer", () => {
    // A hold would leave every target waiting on a fix only files/ can take.
    const damaged = tree({
      ...LAYERS,
      "bun/settings.yml":
        'labels:\n  - {name: javascript, color: "168700"}\n  - {name: JavaScript, color: "168700"}\n',
    });
    expect(() => renderSettings(input({ tree: damaged }))).toThrow(
      `layer "${join(damaged, "bun/settings.yml")}": labels[0] and labels[1] both claim one name; each name belongs to one entry within a layer`,
    );
  });

  test("two fleet layers valid alone but not together are the operator's error: the render throws, never holds", () => {
    // Each layer passes its own judgment; only the fold refuses. The overlay
    // is the one per-repository input, so a fold the fleet layers alone
    // already fail cannot be the repository's to fix.
    const conflicting = tree({
      ...LAYERS,
      "settings/baseline.yml": `${LAYERS["settings/baseline.yml"]}actions: {allowed_actions: all}\n`,
      "settings/public.yml": `${LAYERS["settings/public.yml"]}actions: {selected_actions: {github_owned_allowed: true}}\n`,
    });
    expect(() => renderSettings(input({ tree: conflicting }))).toThrow(
      "the fleet settings layers has malformed section entries: actions.selected_actions",
    );
  });

  test("a fleet label renaming into a tracking label's name reserves that name too", () => {
    // The library pairs a renaming label by both names, so without the
    // reservation the tracking layer would replace the fleet's rename and
    // the apply would delete the old label instead of renaming it.
    const renaming = tree({
      ...LAYERS,
      "settings/baseline.yml": LAYERS["settings/baseline.yml"].replace(
        "{name: bug, color: d73a4a,",
        "{name: bug, new_name: Fuzz-Nightly, color: d73a4a,",
      ),
    });
    expect(
      held({
        tree: renaming,
        modules: ["bun", "fuzzer"],
        registration: registration("modules: [bun, fuzzer]\n"),
      }),
    ).toBe(
      'tracking label "fuzz-nightly" (fuzzer) is a label the platform already manages; a green night would close whatever issues carry it and every settings apply would fight over it',
    );
  });

  test("an undeclared-policy knob in the overlay is the repository's choice and rides through", () => {
    const { doc } = rendered({ overlay: `${OVERLAY}labels: {_undeclared: keep, entries: []}\n` });
    expect(names(doc.labels)).toEqual(["bug", "dependencies", "javascript"]);
    expect(doc.labels).toMatchObject({ _undeclared: "keep" });
  });

  test("rules: null in the overlay drops the lower layers' rules and keeps the override's", () => {
    const { doc } = rendered({ overlay: `${OVERLAY}  - {name: main, rules: null}\n` });
    const entries = (doc.rulesets as { entries: { name: string; rules: { type: string }[] }[] })
      .entries;
    expect(entries.find((r) => r.name === "main")?.rules.map((r) => r.type)).toEqual([
      "deletion",
      "required_status_checks",
    ]);
  });

  test("two renders of the same inputs are byte-identical, the library's own merged-file bytes", () => {
    const long = "word ".repeat(24).trim();
    const overrides = {
      overlay: `${OVERLAY}labels:\n  - {name: wide, color: "000000", description: ${long}}\n`,
    };
    const first = rendered(overrides);
    expect(first.text).toBe(rendered(overrides).text);
    // The library folds a long plain scalar at its width; the apply reads it back as one string.
    expect((first.doc.labels as { entries: unknown[] }).entries.at(-1)).toEqual({
      name: "wide",
      color: "000000",
      description: long,
    });
  });

  test.each<{ reason: string; overrides: Partial<SettingsRenderInput>; detail: unknown }>([
    {
      reason: "no overlay",
      overrides: { overlay: null },
      detail: "no overlay at .github/settings.local.yml (its starter is held or missing)",
    },
    {
      reason: "a malformed overlay",
      overrides: { overlay: "repository: {private: false}\nlabels: {bug: x}\n" },
      detail: expect.stringContaining(
        ".github/settings.local.yml has malformed section entries: labels.entries: Invalid input: expected array",
      ),
    },
    {
      reason: "an overlay whose alias names its own ancestor",
      overrides: { overlay: "repository: &r {private: false, self: *r}\n" },
      detail:
        'layer ".github/settings.local.yml": the document contains a reference cycle (a YAML anchor that includes itself); layers must be trees',
    },
    {
      reason: "an overlay declaring one label twice",
      overrides: {
        overlay: `${OVERLAY}labels:\n  - {name: mine, color: "000000"}\n  - {name: Mine, color: "000000"}\n`,
      },
      detail:
        'layer ".github/settings.local.yml": labels[0] and labels[1] both claim one name; each name belongs to one entry within a layer',
    },
    {
      // Formerly rode through to the apply, which refused it by name; the
      // library's boundary refuses it where the repository can read why.
      reason: "an overlay label without a name",
      overrides: { overlay: `${OVERLAY}labels:\n  - {color: fff}\n` },
      detail: expect.stringContaining(
        ".github/settings.local.yml has malformed section entries: labels[0].name: Invalid input: expected string",
      ),
    },
    {
      reason: "an overlay naming a section the apply does not know",
      overrides: { overlay: `${OVERLAY}labels_v2: []\n` },
      detail: expect.stringContaining(
        "unknown top-level section in .github/settings.local.yml: labels_v2",
      ),
    },
    {
      reason: "an overlay nulling a section the apply does not know",
      overrides: { overlay: `${OVERLAY}labels_v2: null\n` },
      detail: expect.stringContaining(
        "unknown top-level section in .github/settings.local.yml: labels_v2",
      ),
    },
    {
      reason: "a tracking label the layers already manage",
      overrides: {
        modules: ["bun", "fuzzer"],
        registration: registration("modules: [bun, fuzzer]\nlabels: {fuzzer: Javascript}\n"),
      },
      detail:
        'tracking label "Javascript" (fuzzer) is a label the platform already manages; a green night would close whatever issues carry it and every settings apply would fight over it',
    },
    {
      reason: "a labels key naming no selected stream",
      overrides: { registration: registration("modules: [bun]\nlabels: {fuzzer: fuzz-me}\n") },
      detail:
        ".repo-platform.yml: labels.fuzzer names no selected tracking stream (selected: none)",
    },
    {
      reason: "one label shared by two streams",
      overrides: {
        modules: ["fuzzer", "nightly"],
        registration: registration(
          "modules: [fuzzer, nightly]\nlabels: {fuzzer: same, nightly: Same}\n",
        ),
      },
      detail:
        'tracking label "same" is shared by two streams (GitHub label names are case-insensitive); each stream needs its own',
    },
    {
      // The library pairs a renaming label by BOTH its names, so the tracking
      // layer would replace the whole entry and the rename would vanish.
      reason: "an overlay label renaming into a tracking label's name",
      overrides: {
        modules: ["bun", "fuzzer"],
        registration: registration("modules: [bun, fuzzer]\n"),
        overlay: `${OVERLAY}labels:\n  - {name: old-fuzz, new_name: Fuzz-Nightly, color: "000000"}\n`,
      },
      detail:
        'the repository\'s .github/settings.local.yml declares label "old-fuzz", one name to GitHub with the tracking label "fuzz-nightly" (label names are case-insensitive, and a rename claims both its names); rename one',
    },
    {
      // `_layering: replace` would drop the fleet roster and have the apply
      // delete every managed label; the fleet's sections union by name.
      reason: "an overlay re-layering a section",
      overrides: { overlay: `${OVERLAY}labels: {_layering: replace, entries: [{name: mine}]}\n` },
      detail:
        "the repository's .github/settings.local.yml declares _layering under labels; the fleet's sections union by name and only labels: null opts out",
    },
    {
      reason: "an overlay re-layering every section",
      overrides: { overlay: `_layering: replace\n${OVERLAY}` },
      detail:
        "the repository's .github/settings.local.yml declares _layering at the top level; the fleet's sections union by name and only labels: null opts out",
    },
    {
      reason: "an overlay label colliding with a tracking label",
      overrides: {
        modules: ["bun", "fuzzer"],
        registration: registration("modules: [bun, fuzzer]\n"),
        overlay: `${OVERLAY}labels:\n  - {name: Fuzz-Nightly, color: "000000", description: mine}\n`,
      },
      detail:
        'the repository\'s .github/settings.local.yml declares label "Fuzz-Nightly", one name to GitHub with the tracking label "fuzz-nightly" (label names are case-insensitive, and a rename claims both its names); rename one',
    },
  ])("holds on $reason", ({ overrides, detail }) => {
    expect<unknown>(held(overrides)).toEqual(detail);
  });
});

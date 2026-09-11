// The settings render over a scratch tree: the layer order and what each
// layer contributes, the override on top, the overlay's visibility fact,
// the tracking labels with their tuples, every hold the repository's own
// files earn, the header, and byte-for-byte determinism.

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
  "  bun: {settings_layers: [settings.yml, settings-public.yml]}",
  "  rust: {settings_layers: [settings.yml]}",
  "  fuzzer: {tracking_label: {key: fuzzer, default: fuzz-nightly, color: B60205, description: Automated nightly fuzz failure}}",
  "  nightly: {tracking_label: {key: nightly, default: nightly-failure, color: D93F0B, description: Automated nightly CI failure}}",
  "  site: {tracking_label: {key: site, default: docs-link-rot, color: D4A72C, description: Automated docs-site link-rot report}}",
  "settings:",
  "  baseline: files/settings/baseline.yml",
  "  public: files/settings/public.yml",
  "  private: files/settings/private.yml",
  "  override: files/settings/override.yml",
  "files:",
  "  - {path: .github/settings.local.yml, class: starter}",
  "  - {path: .github/settings.yml, class: managed, render: settings, displaces: .github/settings.local.yml}",
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
    "  - name: main",
    "    target: branch",
    "    enforcement: active",
    "    rules:",
    "      - type: deletion",
    "      - type: required_status_checks",
    "        parameters: {required_status_checks: [{context: all-green, integration_id: 15368}]}",
    "",
  ].join("\n"),
  "bun/settings.yml": 'labels:\n  - {name: javascript, color: "168700", description: JS updates}\n',
  "bun/settings-public.yml":
    "rulesets:\n  - {name: main, rules: [{type: code_scanning, parameters: {code_scanning_tools: []}}]}\n",
  "rust/settings.yml": 'labels:\n  - {name: rust, color: "000000", description: Rust updates}\n',
};

const OVERLAY = [
  "# my overlay",
  "repository:",
  "  description: Mine",
  '  homepage: ""',
  '  topics: ""',
  "  private: false",
  "rulesets:",
  "  - name: build-branches",
  "    target: branch",
  "    enforcement: active",
  "    rules: [{type: deletion}]",
  "",
].join("\n");

function tree(): string {
  const root = temp.dir("settings-entry-");
  for (const [rel, text] of Object.entries(LAYERS)) {
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
  const read = parseRegistration(text);
  if ("errors" in read) throw new Error(read.errors.join("\n"));
  return read.registration;
}

function input(overrides: Partial<SettingsRenderInput> = {}): SettingsRenderInput {
  return {
    config: CONFIG,
    tree: TREE,
    modules: ["bun"],
    private: false,
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

const names = (list: unknown) => (list as { name: string }[]).map((entry) => entry.name);
const ruleset = (doc: Record<string, unknown>, name: string) =>
  (doc.rulesets as Record<string, unknown>[]).find((entry) => entry.name === name);

describe("renderSettings", () => {
  test("folds the six layers low to high for a public selection, the override last", () => {
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
    // Baseline, then each selected module's layer in files.yml order.
    expect(names(doc.labels)).toEqual(["bug", "dependencies", "javascript", "rust"]);
    // Baseline ruleset, the public overlay's main entry grown by the module
    // layer and the override, then the overlay's own.
    expect(names(doc.rulesets)).toEqual(["pr-title", "main", "build-branches"]);
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
    expect(ruleset(doc, "build-branches")).toEqual({
      name: "build-branches",
      target: "branch",
      enforcement: "active",
      rules: [{ type: "deletion" }],
    });
  });

  test.each<{ reason: string; overlay: string; operator: boolean; privateLayers: boolean }>([
    {
      reason: "an overlay declaring private beats the operator's public",
      overlay: OVERLAY.replace("private: false", "private: true"),
      operator: false,
      privateLayers: true,
    },
    {
      reason: "an overlay declaring public beats the operator's private",
      overlay: OVERLAY,
      operator: true,
      privateLayers: false,
    },
    {
      reason: "an overlay declaring no visibility leaves the operator's private standing",
      overlay: "repository: {description: x}\n",
      operator: true,
      privateLayers: true,
    },
    {
      reason: "an overlay declaring no visibility leaves the operator's public standing",
      overlay: "repository: {description: x}\n",
      operator: false,
      privateLayers: false,
    },
  ])("$reason", ({ overlay, operator, privateLayers }) => {
    const { doc } = rendered({ overlay, private: operator });
    const labels = names(doc.labels);
    const security = (doc.repository as Record<string, unknown>).security_and_analysis;
    const mainRules = ((ruleset(doc, "main")?.rules ?? []) as { type: string }[]).map(
      (r) => r.type,
    );
    if (privateLayers) {
      expect(labels).toEqual(["bug", "dependencies", "settings-as-code-report", "javascript"]);
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

  test("an overlay may beat the layers below the override and null one of their keys out", () => {
    const { doc } = rendered({
      overlay: [
        "repository: {description: Mine, has_wiki: null, allow_merge_commit: true}",
        'labels: [{name: bug, color: "000000", description: Restyled}]',
        "",
      ].join("\n"),
    });
    expect((doc.labels as unknown[])[0]).toEqual({
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
    expect(doc.labels).toEqual([
      { name: "bug", color: "d73a4a", description: "Something isn't working" },
      { name: "dependencies", color: "0366d6", description: "Dependency updates" },
      { name: "javascript", color: "168700", description: "JS updates" },
      { name: "fuzz-me", color: "B60205", description: "Automated nightly fuzz failure" },
      { name: "nightly-failure", color: "D93F0B", description: "Automated nightly CI failure" },
    ]);
  });

  test.each<{ reason: string; modules: string[]; overlay: string; labels: unknown }>([
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
      reason: "an empty overlay with a tracking stream renders the roster and the tuple",
      modules: ["fuzzer"],
      overlay: "",
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
    expect(doc.labels).toEqual(labels);
    expect(names(doc.rulesets)).toEqual(
      overlay === "" ? ["pr-title", "main"] : ["pr-title", "main", "build-branches"],
    );
  });

  test("an alias reused without a cycle renders the shared value at both keys", () => {
    const { doc } = rendered({ overlay: "repository: &r {description: Mine}\ncopy: *r\n" });
    expect((doc.repository as Record<string, unknown>).description).toBe("Mine");
    expect(doc.copy).toEqual({ description: "Mine" });
  });

  test("two renders of the same inputs are byte-identical, long descriptions unwrapped", () => {
    // Spaced, so the default folding would wrap it.
    const long = "word ".repeat(24).trim();
    const overrides = {
      overlay: `${OVERLAY}labels:\n  - {name: wide, color: "000000", description: ${long}}\n`,
    };
    const first = rendered(overrides);
    expect(first.text).toBe(rendered(overrides).text);
    expect(first.text).toContain(`description: ${long}\n`);
  });

  test.each<{ reason: string; overrides: Partial<SettingsRenderInput>; detail: string }>([
    {
      reason: "no overlay",
      overrides: { overlay: null },
      detail: "no overlay at .github/settings.local.yml (its starter is held or missing)",
    },
    {
      reason: "a malformed overlay",
      overrides: { overlay: "labels: {bug: x}\n" },
      detail:
        ".github/settings.local.yml: labels: labels must be a list of mappings, got a mapping. " +
        "The merge unions labels by name; any other shape would replace the managed labels " +
        "wholesale, and the apply would silently enforce less than the layers declare. Declare " +
        "each entry as a '- name: ...' list item.",
    },
    {
      reason: "an overlay whose alias names its own ancestor",
      overrides: { overlay: "repository: &r {self: *r}\n" },
      detail:
        ".github/settings.local.yml: a cyclic alias at repository.self - the document contains itself and cannot be merged",
    },
    {
      reason: "an overlay declaring one label twice",
      overrides: {
        overlay: `${OVERLAY}labels:\n  - {name: mine, color: "000000"}\n  - {name: Mine, color: "000000"}\n`,
      },
      detail: `the repository's .github/settings.local.yml declares labels "mine" and "Mine", which the apply treats as one name - only the first entry takes effect in the merge; remove the duplicate`,
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
      reason: "an overlay label colliding with a tracking label",
      overrides: {
        modules: ["bun", "fuzzer"],
        registration: registration("modules: [bun, fuzzer]\n"),
        overlay: `${OVERLAY}labels:\n  - {name: Fuzz-Nightly, color: "000000", description: mine}\n`,
      },
      detail:
        'the merged labels declare "Fuzz-Nightly" and "fuzz-nightly", which collide - two settings layers claim one name; rename one',
    },
  ])("holds on $reason", ({ overrides, detail }) => {
    expect(held(overrides)).toBe(detail);
  });
});

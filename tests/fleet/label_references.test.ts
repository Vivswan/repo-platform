// label_references.ts: the extraction rule for labels a repository's own
// files reference (issue forms' top-level labels, the workflow key/
// expression heuristic with its stated limits), the case-folded
// aggregation, and the roster comparisons. The workflow fixture mirrors
// the litellm incident (actions/stale keys) and the issue-form fixture the
// chromium-bridge one - the two real fleet breaks this guard exists for.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReferences,
  finalLabelNames,
  issueFormLabels,
  missingFromRoster,
  type ReferenceFile,
  referenceFilesFromDir,
  referenceNames,
  workflowLabelRefs,
} from "../../.github/scripts/fleet/label_references.ts";

describe("issueFormLabels", () => {
  test("a list value is taken element-whole (the chromium-bridge shape)", () => {
    const form = 'name: Bug report\nlabels: ["type:bug", "needs triage, maybe"]\nbody: []\n';
    expect(issueFormLabels(form)).toEqual(["type:bug", "needs triage, maybe"]);
  });

  test("a scalar value is comma-split like front matter", () => {
    expect(issueFormLabels("labels: bug, help wanted\n")).toEqual(["bug", "help wanted"]);
  });

  test("no labels key, a non-mapping document, and broken YAML all read as no references", () => {
    expect(issueFormLabels("name: x\nbody: []\n")).toEqual([]);
    expect(issueFormLabels("- just\n- a list\n")).toEqual([]);
    expect(issueFormLabels("name: [unclosed\n")).toEqual([]);
  });

  test("only the TOP-LEVEL labels key counts - a body attribute's `label` is form text", () => {
    const form = [
      "name: Bug report",
      "body:",
      "  - type: textarea",
      "    attributes:",
      "      label: What happened",
      "    labels: [not-a-real-key-but-nested]",
    ].join("\n");
    expect(issueFormLabels(form)).toEqual([]);
  });
});

describe("workflowLabelRefs", () => {
  test("the litellm shape: actions/stale label keys are all extracted", () => {
    const workflow = [
      "jobs:",
      "  close:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/stale@v11",
      "        with:",
      "          any-of-issue-labels: awaiting-reply",
      "          stale-issue-label: auto-closed",
      "          labels-to-remove-when-unstale: awaiting-reply",
    ].join("\n");
    expect(workflowLabelRefs(workflow).sort()).toEqual([
      "auto-closed",
      "awaiting-reply",
      "awaiting-reply",
    ]);
  });

  test("runner labels under runs-on are excluded; dynamic values are dropped", () => {
    const workflow = [
      "jobs:",
      "  build:",
      "    runs-on:",
      "      group: big",
      "      labels: [self-hosted, linux-x64]",
      "    steps:",
      "      - uses: some/labeler@v1",
      "        with:",
      "          labels: ${{ inputs.labels }}",
    ].join("\n");
    expect(workflowLabelRefs(workflow)).toEqual([]);
  });

  test("the litellm false-positive shapes are silent while a real label: still extracts", () => {
    // The nightly fuzz-issue call: label-color/label-description CONFIGURE
    // attributes of the label the sibling `label:` key names, and a docker
    // matrix's `labels` shard selector is a job variable - only the one
    // genuine name may reach the missing-label warning.
    const workflow = [
      "jobs:",
      "  shards:",
      "    strategy:",
      "      matrix:",
      "        labels: [shard-1, shard-2]",
      "        include:",
      "          - labels: shard-3",
      "  file-issue:",
      "    steps:",
      "      - uses: viv/repo-platform/actions/fuzz-issue@build",
      "        with:",
      "          label: fuzz-failure",
      '          label-color: "D93F0B"',
      "          label-description: Automated nightly CI failure",
    ].join("\n");
    expect(workflowLabelRefs(workflow)).toEqual(["fuzz-failure"]);
    const missing = missingFromRoster(
      collectReferences([
        { path: ".github/workflows/nightly.yml", kind: "workflow", text: workflow },
      ]),
      [],
    );
    expect(missing.map((reference) => reference.label)).toEqual(["fuzz-failure"]);
  });

  test("expression shapes are extracted in both operand orders, plus contains()", () => {
    const workflow = [
      "jobs:",
      "  gate:",
      "    if: >-",
      "      github.event.label.name == 'answered' ||",
      "      'blocked' != github.event.label.name ||",
      "      contains(github.event.issue.labels.*.name, 'triaged') ||",
      "      contains(github.event.pull_request.labels.*.name, 'ship-it')",
    ].join("\n");
    expect(workflowLabelRefs(workflow).sort()).toEqual([
      "answered",
      "blocked",
      "ship-it",
      "triaged",
    ]);
  });

  test("a file YAML rejects still gets the regex pass (the grep-level floor)", () => {
    const broken = "jobs: [unclosed\nif: github.event.label.name == 'answered'\n";
    expect(workflowLabelRefs(broken)).toEqual(["answered"]);
  });
});

describe("collectReferences and the roster comparisons", () => {
  const files: ReferenceFile[] = [
    { path: ".github/ISSUE_TEMPLATE/bug.yml", kind: "issue-form", text: 'labels: ["Answered"]\n' },
    {
      path: ".github/workflows/close.yml",
      kind: "workflow",
      text: "jobs:\n  x:\n    if: github.event.label.name == 'answered'\n",
    },
    {
      path: ".github/workflows/stale.yml",
      kind: "workflow",
      text: "jobs:\n  x:\n    steps:\n      - with:\n          stale-issue-label: auto-closed\n",
    },
  ];

  test("references fold case-insensitively, first spelling wins, files aggregate", () => {
    const references = collectReferences(files);
    expect(references).toEqual([
      {
        label: "Answered",
        files: [".github/ISSUE_TEMPLATE/bug.yml", ".github/workflows/close.yml"],
      },
      { label: "auto-closed", files: [".github/workflows/stale.yml"] },
    ]);
  });

  test("missingFromRoster folds like GitHub's label dedup", () => {
    const references = collectReferences(files);
    expect(missingFromRoster(references, ["ANSWERED", "auto-closed"])).toEqual([]);
    expect(missingFromRoster(references, ["auto-closed"]).map((r) => r.label)).toEqual([
      "Answered",
    ]);
  });

  test("finalLabelNames: an undeclared labels key means no reconciliation (null)", () => {
    expect(finalLabelNames({})).toBeNull();
    expect(finalLabelNames({ labels: [{ name: "bug" }, { color: "nameless" }] })).toEqual(["bug"]);
  });

  test("finalLabelNames: a new_name rename contributes the POST-APPLY name, not the source", () => {
    // The action upserts by name and renames via new_name, so after the
    // apply the label exists only under the new name - a reference to the
    // source name breaks exactly like a deletion (the fail-open the gate
    // reproduced: the source name reading as declared stood the guard
    // down while the apply renamed the label out from under the form).
    // An empty-string new_name wins the action's ?? too, but that PATCH
    // 422s before the undeclared-label deletion pass (and the source
    // stays declared, so it is never deleted as undeclared) - keeping ""
    // instead of the source here is the conservative read: a reference to
    // the source blocks an apply that could not have succeeded anyway.
    const merged = {
      labels: [
        { name: "awaiting-reply", new_name: "needs-response" },
        { name: "bug", new_name: "" },
      ],
    };
    expect(finalLabelNames(merged)).toEqual(["needs-response", ""]);
    const references = collectReferences([
      {
        path: ".github/ISSUE_TEMPLATE/q.yml",
        kind: "issue-form",
        text: 'labels: ["awaiting-reply"]\n',
      },
    ]);
    expect(
      missingFromRoster(references, finalLabelNames(merged) ?? []).map((r) => r.label),
    ).toEqual(["awaiting-reply"]);
    // The rename TARGET is covered: a form already referencing the new
    // name must not warn.
    const targetRefs = collectReferences([
      {
        path: ".github/ISSUE_TEMPLATE/q.yml",
        kind: "issue-form",
        text: 'labels: ["needs-response"]\n',
      },
    ]);
    expect(missingFromRoster(targetRefs, finalLabelNames(merged) ?? [])).toEqual([]);
  });
});

describe("referenceFilesFromDir", () => {
  test("reads issue forms (config.yml excluded) and workflows; missing dirs are no files", () => {
    const root = mkdtempSync(join(tmpdir(), "label-refs-"));
    mkdirSync(join(root, ".github/ISSUE_TEMPLATE"), { recursive: true });
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/ISSUE_TEMPLATE/bug.yml"), "labels: [a]\n");
    writeFileSync(join(root, ".github/ISSUE_TEMPLATE/config.yml"), "blank_issues_enabled: false\n");
    writeFileSync(join(root, ".github/ISSUE_TEMPLATE/readme.md"), "labels: not-yaml\n");
    writeFileSync(join(root, ".github/workflows/ci.yaml"), "jobs: {}\n");
    expect(referenceFilesFromDir(root).map((file) => [file.path, file.kind])).toEqual([
      [".github/ISSUE_TEMPLATE/bug.yml", "issue-form"],
      [".github/workflows/ci.yaml", "workflow"],
    ]);

    const bare = mkdtempSync(join(tmpdir(), "label-refs-bare-"));
    expect(referenceFilesFromDir(bare)).toEqual([]);
  });

  test("referenceNames keeps config.yml for workflows (only forms exclude it)", () => {
    expect(referenceNames(["config.yml", "b.yaml", "x.txt"], "workflow")).toEqual([
      "b.yaml",
      "config.yml",
    ]);
    expect(referenceNames(["config.yml", "b.yaml"], "issue-form")).toEqual(["b.yaml"]);
  });
});

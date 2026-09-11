// The pr-title model (scripts/check/ssot/pr_title.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prTitleWorkflowMismatches } from "../../../scripts/check/ssot/pr_title.ts";

describe("prTitleWorkflowMismatches", () => {
  const workflow = [
    "name: PR Title",
    "",
    "on:",
    "  pull_request:",
    "    types: [opened, edited, reopened, synchronize]",
    "",
    "jobs:",
    "  pr-title:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: amannn/action-semantic-pull-request@v6",
    "",
  ].join("\n");
  const baseline = [
    "rulesets:",
    "  - name: pr-title",
    "    target: branch",
    "    enforcement: disabled",
    "    conditions:",
    "      ref_name:",
    "        include:",
    '          - "~DEFAULT_BRANCH"',
    "        exclude: []",
    "    rules:",
    "      - type: required_status_checks",
    "        parameters:",
    "          required_status_checks:",
    "            - context: pr-title",
    "              integration_id: 15368",
    "",
  ].join("\n");
  const moduleLayer = ["rulesets:", "  - name: pr-title", "    enforcement: active", ""].join("\n");

  test("passes the compliant trio", () => {
    expect(prTitleWorkflowMismatches(workflow, baseline, moduleLayer)).toEqual([]);
  });

  test("a tag target, a non-default-branch include, or a re-excluded branch goes red - the check would gate no merges", () => {
    const tagged = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("target: branch", "target: tag"),
      moduleLayer,
    );
    expect(tagged.some((m) => m.expected.includes("target: branch"))).toBe(true);
    const rebranched = prTitleWorkflowMismatches(
      workflow,
      baseline.replace('- "~DEFAULT_BRANCH"', "- refs/heads/develop"),
      moduleLayer,
    );
    expect(rebranched.some((m) => m.expected.includes("~DEFAULT_BRANCH"))).toBe(true);
    const unconditioned = prTitleWorkflowMismatches(
      workflow,
      baseline.replace(
        '\n    conditions:\n      ref_name:\n        include:\n          - "~DEFAULT_BRANCH"\n        exclude: []',
        "",
      ),
      moduleLayer,
    );
    expect(unconditioned.some((m) => m.expected.includes("~DEFAULT_BRANCH"))).toBe(true);
    const carvedOut = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("        exclude: []", '        exclude: ["~DEFAULT_BRANCH"]'),
      moduleLayer,
    );
    expect(carvedOut.some((m) => m.expected.includes("exclude exactly []"))).toBe(true);
  });

  test("a types list without synchronize goes red - the required check must exist at every pushed head", () => {
    const found = prTitleWorkflowMismatches(
      workflow.replace(
        "    types: [opened, edited, reopened, synchronize]",
        "    types: [opened, edited]",
      ),
      baseline,
      moduleLayer,
    );
    expect(found.some((m) => m.expected.includes("synchronize"))).toBe(true);
  });

  test("renaming the job or overriding its display name goes red - the id is the required context", () => {
    const renamed = prTitleWorkflowMismatches(
      workflow.replace("  pr-title:", "  title:"),
      baseline,
      moduleLayer,
    );
    expect(renamed.some((m) => m.expected.includes('"  pr-title:"'))).toBe(true);
    const displayNamed = prTitleWorkflowMismatches(
      workflow.replace("    runs-on:", "    name: info-title\n    runs-on:"),
      baseline,
      moduleLayer,
    );
    expect(displayNamed.some((m) => m.expected.includes("no job-level name:"))).toBe(true);
  });

  test("a swapped-out judgment step or any condition goes red - a required check must never be a green no-op", () => {
    const swapped = prTitleWorkflowMismatches(
      workflow.replace("      - uses: amannn/action-semantic-pull-request@v6", "      - run: true"),
      baseline,
      moduleLayer,
    );
    expect(swapped.some((m) => m.expected.includes("action-semantic-pull-request"))).toBe(true);
    const conditioned = prTitleWorkflowMismatches(
      workflow.replace("    runs-on:", "    if: false\n    runs-on:"),
      baseline,
      moduleLayer,
    );
    expect(conditioned.some((m) => m.expected.includes("no job- or step-level if:"))).toBe(true);
    const softened = prTitleWorkflowMismatches(
      workflow.replace("    runs-on:", "    continue-on-error: true\n    runs-on:"),
      baseline,
      moduleLayer,
    );
    expect(softened.some((m) => m.expected.includes("no continue-on-error"))).toBe(true);
  });

  test("a dropped integration pin, a renamed context, or an extra context goes red", () => {
    const unpinned = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("\n              integration_id: 15368", ""),
      moduleLayer,
    );
    expect(unpinned.some((m) => m.expected.includes("integration_id 15368"))).toBe(true);
    const renamed = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("- context: pr-title", "- context: pr-check"),
      moduleLayer,
    );
    expect(renamed.some((m) => m.expected.includes("context 'pr-title'"))).toBe(true);
    const extra = prTitleWorkflowMismatches(
      workflow,
      baseline.replace(
        "              integration_id: 15368",
        "              integration_id: 15368\n            - context: decoy\n              integration_id: 15368",
      ),
      moduleLayer,
    );
    expect(extra.some((m) => m.expected.includes("exactly one required check"))).toBe(true);
  });

  test("a missing baseline ruleset or an ACTIVE baseline copy goes red", () => {
    const missing = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("- name: pr-title", "- name: decoy"),
      moduleLayer,
    );
    expect(missing.some((m) => m.expected.includes("a 'pr-title' ruleset"))).toBe(true);
    const active = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("enforcement: disabled", "enforcement: active"),
      moduleLayer,
    );
    expect(active.some((m) => m.expected.includes("enforcement: disabled"))).toBe(true);
  });

  test("a module layer that does more (or less) than the enforcement flip goes red", () => {
    const disabled = prTitleWorkflowMismatches(
      workflow,
      baseline,
      moduleLayer.replace("enforcement: active", "enforcement: disabled"),
    );
    expect(disabled.some((m) => m.expected.includes("enforcement: active"))).toBe(true);
    const shadowing = prTitleWorkflowMismatches(
      workflow,
      baseline,
      moduleLayer.replace("    enforcement: active", "    enforcement: active\n    rules: []"),
    );
    expect(shadowing.some((m) => m.expected.includes("nothing else"))).toBe(true);
    const empty = prTitleWorkflowMismatches(workflow, baseline, "labels: []\n");
    expect(empty.some((m) => m.file.includes("files/pr-title/settings.yml"))).toBe(true);
  });

  // The live-file forcing test: the exact judgment the pr-title-workflow
  // rule runs on the REAL sources, so breaking any of the three files
  // goes red here.
  const livePrTitle = () =>
    prTitleWorkflowMismatches(
      readFileSync("files/pr-title/.github/workflows/pr-title.yml", "utf-8"),
      readFileSync("files/settings/baseline.yml", "utf-8"),
      readFileSync("files/pr-title/settings.yml", "utf-8"),
    );

  test("the pr-title workflow is ARMED: every link the rule pins holds on the live sources", () => {
    expect(livePrTitle()).toEqual([]);
  });
});

// A knob with one value across every caller is a constant, so each action declares only the inputs its callers vary.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadAction, REPO_ROOT } from "../shared/action_step";

type Input = { required: boolean; default?: string };

const ACTIONS: Record<string, Record<string, Input>> = {
  "bun-setup": { pin: { required: true }, required: { required: false, default: "true" } },
  "check-file-size": {},
  "check-typography": {},
  "dependency-review": {},
  knip: {},
  "pages-site": {
    "site-dir": { required: false, default: "" },
    config: { required: false, default: "" },
    check: { required: false, default: "false" },
    "custom-domain": { required: false, default: "" },
    "max-versions": { required: false, default: "5" },
  },
  plan: {
    mode: { required: false, default: "default" },
    private: { required: false, default: "" },
  },
  semgrep: {},
  trivy: { mode: { required: false, default: "blocking" } },
  typos: {},
  "validate-commit-names": {},
  "validate-skills": {
    "skills-dir": { required: false, default: "skills" },
    "plugin-manifest": { required: false, default: ".claude-plugin/plugin.json" },
    mode: { required: false, default: "structure" },
  },
  yamllint: {},
  "validate-managed-files": {
    "github-token": { required: false, default: "${{ github.token }}" },
    private: { required: true },
  },
  "release-health": {
    mode: { required: true },
    "tracking-labels": { required: false, default: "" },
  },
  "fuzz-issue": {
    mode: { required: true },
    label: { required: true },
    title: { required: false },
    "artifacts-dir": { required: false, default: "" },
    "artifact-name": { required: false, default: "" },
    "label-color": { required: false },
    "label-description": { required: false },
    stream: { required: true },
    token: { required: false, default: "${{ github.token }}" },
  },
  zizmor: { "upload-sarif": { required: false, default: "true" } },
};

describe("action inputs", () => {
  test("the table names every action", () => {
    const discovered = readdirSync(join(REPO_ROOT, "actions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "shared")
      .map((entry) => entry.name)
      .sort();
    expect(Object.keys(ACTIONS).sort()).toEqual(discovered);
  });

  test.each(Object.entries(ACTIONS))(
    "actions/%s declares exactly its varying inputs",
    (name, expected) => {
      const action = loadAction(`actions/${name}/action.yml`);
      const declared = Object.fromEntries(
        Object.entries(action.inputs ?? {}).map(([input, spec]) => [
          input,
          {
            required: spec.required === true,
            ...(spec.default === undefined ? {} : { default: spec.default }),
          },
        ]),
      );
      expect(declared).toEqual(expected);
    },
  );
});

// A knob with one value across every caller is a constant, so each action declares only the inputs its callers vary.

import { describe, expect, test } from "bun:test";
import { loadAction } from "../shared/action_step";

type Input = { required: boolean; default?: string };

const ACTIONS: Record<string, Record<string, Input>> = {
  "check-file-size": {},
  "check-typography": {},
  "dependency-review": {},
  knip: {},
  typos: {},
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

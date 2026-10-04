// A composite action runs in the CALLER's checkout, whose bun may predate the lockfiles this repository's bun writes, so
// every action running a script sets up its own bun first, from the fleet's one pin, and runs it by the recorded path.
// GitHub gives a composite no shared preamble, so the shape is asserted here over every manifest. A script importing
// node builtins and actions/shared alone ships no lockfile and installs nothing; one with dependencies ships both.

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { actionManifestPaths } from "../../scripts/lib/action_steps";
import { REPO_ROOT } from "../shared/action_step";

type Step = Record<string, unknown>;

const setupStep = {
  id: "action-bun",
  uses: "Vivswan/repo-platform/actions/bun-setup@stable",
  from: "${{ github.action_path }}",
};

// The shared setup action is the one place setup-bun runs (tests/actions/bun-setup pins its shape).
const manifests = actionManifestPaths(join(REPO_ROOT, "actions")).filter(
  (file) => dirname(file) !== "actions/bun-setup",
);

const runsScripts = (dir: string): boolean =>
  readdirSync(dir).some((name) => name.endsWith(".ts")) || existsSync(join(dir, "bun.lock"));

test.each(manifests)(
  "%s sets up the pinned bun first and runs it by path, or never touches bun",
  (file) => {
    const dir = join(REPO_ROOT, dirname(file));
    const manifest = parseYaml(readFileSync(join(REPO_ROOT, file), "utf8")) as {
      runs: { steps: Step[] };
    };
    const steps = manifest.runs.steps;
    const [first, ...rest] = steps;
    const shape = {
      first: { id: first.id, uses: first.uses, from: (first.with as Step | undefined)?.from },
      bareBunLines: steps.flatMap((step) =>
        String(step.run ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("bun ")),
      ),
      // A second setup, shared or direct, can overwrite the binary behind the recorded path.
      laterSetups: rest.filter((step) => /bun-setup|setup-bun/i.test(String(step.uses ?? "")))
        .length,
      mentionsBun: /bun/i.test(JSON.stringify(steps)),
    };
    expect(shape).toEqual(
      runsScripts(dir)
        ? { first: setupStep, bareBunLines: [], laterSetups: 0, mentionsBun: true }
        : { first: shape.first, bareBunLines: [], laterSetups: 0, mentionsBun: false },
    );
  },
);

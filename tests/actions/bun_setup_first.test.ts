// A composite action runs in the CALLER's checkout, whose bun may predate the lockfiles this repository's bun writes, so
// every action shipping a bun.lock sets up its own bun first, from the fleet's one pin, and runs it by the recorded path.
// GitHub gives a composite no shared preamble, so the shape is asserted here over every manifest.

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { actionManifestPaths } from "../../scripts/lib/action_steps";
import { REPO_ROOT } from "../shared/action_step";

type Step = Record<string, unknown>;

// GitHub resolves the pin against the manifest's own directory, so a nested action climbs one level more.
const setupStep = (file: string) => ({
  id: "action-bun",
  uses: "Vivswan/repo-platform/actions/bun-setup@stable",
  pin: `\${{ github.action_path }}/${relative(dirname(file), "files/bun/.bun-version")}`,
});

// The shared setup action is the one place setup-bun runs (tests/actions/bun-setup pins its shape).
const manifests = actionManifestPaths(join(REPO_ROOT, "actions")).filter(
  (file) => dirname(file) !== "actions/bun-setup",
);

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
      first: { id: first.id, uses: first.uses, pin: (first.with as Step | undefined)?.pin },
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
      existsSync(join(dir, "bun.lock"))
        ? { first: setupStep(file), bareBunLines: [], laterSetups: 0, mentionsBun: true }
        : { first: shape.first, bareBunLines: [], laterSetups: 0, mentionsBun: false },
    );
  },
);

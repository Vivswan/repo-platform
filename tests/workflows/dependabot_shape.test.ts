// Dependabot's `directories` globs replaced a hand-kept roster of every action directory (and one bun block per
// package), so the whole document is pinned: a directory listed by hand again, or a bun or pip block that drifts from its
// twin, fails here rather than growing back quietly.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ACTIONS = "/actions/**/*";
const CADENCE = { schedule: { interval: "monthly" }, cooldown: { "default-days": 7 } };
const BUILD = { ...CADENCE, "commit-message": { prefix: "build", include: "scope" } };

test("dependabot.yml is three entries, each globbing every action directory", () => {
  const source = readFileSync(join(import.meta.dir, "../../.github/dependabot.yml"), "utf8");
  expect(parseYaml(source)).toEqual({
    version: 2,
    updates: [
      {
        "package-ecosystem": "github-actions",
        directories: ["/", ACTIONS],
        groups: { actions: { patterns: ["*"] } },
        ...CADENCE,
        "commit-message": { prefix: "ci", include: "scope" },
      },
      { "package-ecosystem": "bun", directories: ["/", ACTIONS], ...BUILD },
      { "package-ecosystem": "pip", directories: [ACTIONS], ...BUILD },
    ],
  });
});

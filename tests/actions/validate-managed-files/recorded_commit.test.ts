// The recorded commit is the fleet action's whole reading of the manifest, and its two step outputs are what the
// clone step and run.ts read: `commit` must be empty on every problem, or the clone would be attempted at whatever
// text was recorded, and `problem` is the red check's whole instruction to the operator.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MANIFEST_NAME } from "../../../actions/shared/platform";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const READ_COMMIT = join(
  import.meta.dir,
  "../../../actions/validate-managed-files/src/read_commit.ts",
);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const manifest = (self: string) =>
  `{\n  "files": {\n    ".bun-version": {"class": "managed", "hash": "${"a".repeat(64)}"},\n    ${JSON.stringify(MANIFEST_NAME)}: ${self}\n  }\n}\n`;
const STAMPED = manifest(`{"class": "managed", "hash": null, "commit": "${COMMIT}"}`);

const REVERT = "revert the edit (git history has the stamped original) or dispatch a sync";
const NOT_A_SHA = `${MANIFEST_NAME} names no full 40-hex commit in its own entry; ${REVERT}`;

describe("the read-commit step", () => {
  test.each<{ reason: string; tree: Record<string, string>; outputs: string }>([
    {
      reason: "a stamped self entry",
      tree: { [MANIFEST_NAME]: STAMPED },
      outputs: `commit=${COMMIT}\nproblem=\n`,
    },
    {
      reason: "no manifest",
      tree: {},
      outputs: `commit=\nproblem=${MANIFEST_NAME} is missing; every sync writes it, so restore it from git history or dispatch a sync\n`,
    },
    {
      reason: "a directory at the manifest's path",
      tree: { [`${MANIFEST_NAME}/keep`]: "" },
      outputs: `commit=\nproblem=${MANIFEST_NAME} cannot be read (EISDIR); restore the file from git history or dispatch a sync\n`,
    },
    {
      reason: "a manifest that is not JSON",
      tree: { [MANIFEST_NAME]: "{ not json" },
      outputs: `commit=\nproblem=${MANIFEST_NAME} does not parse as a manifest (invalid JSON); ${REVERT}\n`,
    },
    {
      reason: "a self entry without its commit",
      tree: { [MANIFEST_NAME]: manifest('{"class": "managed", "hash": null}') },
      outputs: `commit=\nproblem=${NOT_A_SHA}\n`,
    },
    {
      reason: "no self entry at all",
      tree: {
        [MANIFEST_NAME]: `{"files": {".bun-version": {"class": "managed", "hash": "${"a".repeat(64)}"}}}`,
      },
      outputs: `commit=\nproblem=${NOT_A_SHA}\n`,
    },
    {
      reason: "a short sha",
      tree: {
        [MANIFEST_NAME]: manifest(
          `{"class": "managed", "hash": null, "commit": "${COMMIT.slice(0, 12)}"}`,
        ),
      },
      outputs: `commit=\nproblem=${NOT_A_SHA}\n`,
    },
    {
      reason: "an uppercase sha",
      tree: {
        [MANIFEST_NAME]: manifest(
          `{"class": "managed", "hash": null, "commit": "${COMMIT.toUpperCase()}"}`,
        ),
      },
      outputs: `commit=\nproblem=${NOT_A_SHA}\n`,
    },
    {
      reason: "a commit that is not a string",
      tree: { [MANIFEST_NAME]: manifest('{"class": "managed", "hash": null, "commit": null}') },
      outputs: `commit=\nproblem=${NOT_A_SHA}\n`,
    },
  ])("$reason", ({ tree, outputs }) => {
    const root = temp.dir("read-commit-");
    for (const [rel, text] of Object.entries(tree)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const file = join(root, "outputs.txt");
    writeFileSync(file, "");
    const run = boundedSpawnSync([process.execPath, READ_COMMIT], {
      cwd: root,
      env: { GITHUB_OUTPUT: file },
    });
    expect([run.exitCode, readFileSync(file, "utf8")]).toEqual([0, outputs]);
  });
});

// The recorded commit is the fleet action's whole reading of the manifest, and its two step outputs are what the
// checkout's `ref:` and run.ts read: `commit` must be empty on every problem, or the checkout would be attempted at
// whatever text was recorded, and `problem` is the red check's whole instruction to the operator.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MANIFEST_NAME } from "../../../actions/shared/platform";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../../shared/fixture_git";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const READ_COMMIT = join(
  import.meta.dir,
  "../../../actions/validate-managed-files/src/read_commit.ts",
);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const JUDGE = ".repo-platform-judge";

const manifest = (self: string) =>
  `{\n  "files": {\n    ".bun-version": {"class": "managed", "hash": "${"a".repeat(64)}"},\n    ${JSON.stringify(MANIFEST_NAME)}: ${self}\n  }\n}\n`;
const STAMPED = manifest(`{"class": "managed", "hash": null, "commit": "${COMMIT}"}`);

const REVERT = "revert the edit (git history has the stamped original) or dispatch a sync";
const NOT_A_SHA = `${MANIFEST_NAME} records a synced commit that is not a full 40-hex sha; ${REVERT}`;
const NONE = "no synced commit recorded; merge the pending sync PR or dispatch a sync";

describe("the read-commit step", () => {
  const OCCUPIED = `commit=\nproblem=the repository holds a path at ${JUDGE}, where the check places its checkout of repo-platform; move it\n`;
  test.each<{
    reason: string;
    tree: Record<string, string>;
    /** Paths of the tree to commit before the platform directory is removed whole: in the index alone. */
    deleted?: string[];
    outputs: string;
  }>([
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
      reason: "a self entry from before the field",
      tree: { [MANIFEST_NAME]: manifest('{"class": "managed", "hash": null}') },
      outputs: `commit=\nproblem=${NONE}\n`,
    },
    {
      reason: "no self entry at all",
      tree: {
        [MANIFEST_NAME]: `{"files": {".bun-version": {"class": "managed", "hash": "${"a".repeat(64)}"}}}`,
      },
      outputs: `commit=\nproblem=${NONE}\n`,
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
    // The checkout would stand where the repository's own content does, and check.ts would read repo-platform's bytes
    // as the repository's: a file on disk, or a tracked path deleted from the working tree that the index still lists.
    {
      reason: "a repository file where the platform checkout goes, the manifest stamped",
      tree: { [MANIFEST_NAME]: STAMPED, [`${JUDGE}/.bun-version`]: "1.4.0\n" },
      outputs: OCCUPIED,
    },
    {
      reason: "a tracked file where the platform checkout goes, deleted from the working tree",
      tree: { [MANIFEST_NAME]: STAMPED, [`${JUDGE}/.bun-version`]: "1.4.0\n" },
      deleted: [`${JUDGE}/.bun-version`],
      outputs: OCCUPIED,
    },
  ])("$reason", ({ tree, deleted = [], outputs }) => {
    // Resolved as the step resolves its cwd (macOS's /var is /private/var), so the relative path in the problem is short.
    const root = realpathSync(temp.dir("read-commit-"));
    fixtureGit(root, ["init", "-q", "-b", "main"]);
    for (const [rel, text] of Object.entries(tree)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    if (deleted.length > 0) {
      fixtureGit(root, ["add", "--", ...deleted]);
      fixtureGit(root, [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@e",
        "commit",
        "-q",
        "-m",
        "tracked",
      ]);
      rmSync(join(root, JUDGE), { recursive: true });
    }
    const file = join(root, "outputs.txt");
    writeFileSync(file, "");
    const run = boundedSpawnSync([process.execPath, READ_COMMIT], {
      cwd: root,
      env: { ...fixtureGitEnv(), GITHUB_OUTPUT: file, PLATFORM_DIR: join(root, JUDGE) },
    });
    expect([run.exitCode, readFileSync(file, "utf8")]).toEqual([0, outputs]);
  });
});

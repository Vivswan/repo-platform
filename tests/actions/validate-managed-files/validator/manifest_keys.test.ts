import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkManifestParity } from "../../../../actions/validate-managed-files/validator/checks/manifest_parity.ts";
import { checkManifestShape } from "../../../../actions/validate-managed-files/validator/checks/manifest_shape.ts";
import { loadContext } from "../../../../actions/validate-managed-files/validator/context.ts";
import { errorsOf } from "../../../../actions/validate-managed-files/validator/findings.ts";
import { tempDirs } from "../../../shared/temp_dir.ts";
import {
  BASELINE,
  FILES_YML,
  MANIFEST,
  manifestOf,
  stampedBaseline,
  validatorRunner,
} from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

describe("manifest keys are the repository paths the sync writes", () => {
  const CI = ".github/workflows/ci.yml";
  const keyError = (key: string, problem: string) =>
    `${MANIFEST}: entry '${key}' is not a repository path the sync writes (the path ${problem}) - ` +
    "a hand edit; the sync ignores such a record and no class can be judged for it; delete the entry " +
    "(git history has the stamped original) or re-run the sync (dispatch sync-repos.yml in " +
    "repo-platform with repo=<owner>/<name>), which replaces platform files whole";

  const STARTER = '{"class": "starter"}';
  const MANAGED = `{"class": "managed", "hash": "${"0".repeat(64)}"}`;
  // Every key breaks the path grammar; `./x` and `a//b` also resolve to the
  // declared file while string-matching no declaration, so without the rule
  // the class gate never saw them. The parse refuses the key once, so the
  // record behind it is never read: parity would read the traversal key's
  // hash from outside the repository, and the field check would report the
  // stray field a second time.
  test.each([
    [`./${CI}`, "carries an empty, '.', or '..' segment", STARTER],
    [".github//workflows/ci.yml", "carries an empty, '.', or '..' segment", STARTER],
    ["..", "carries an empty, '.', or '..' segment", STARTER],
    [".github/workflows/ci.yml/", "carries an empty, '.', or '..' segment", STARTER],
    [".github\\workflows\\ci.yml", "contains a backslash", STARTER],
    ["../../../../etc/passwd", "carries an empty, '.', or '..' segment", MANAGED],
    [`./${CI}`, "carries an empty, '.', or '..' segment", '{"class": "starter", "extra": true}'],
  ])(
    "the parse refuses the key with its reason, and shape and parity report it once: %s",
    (key, problem, record) => {
      const root = temp.dir("validate-managed-keys-");
      const { [CI]: _canonical, ...accepted } = stampedBaseline();
      const tree = {
        ...BASELINE,
        [CI]: "name: edited\non: [push]\njobs: {}\n",
        [MANIFEST]: manifestOf({ ...accepted, [key]: record }),
      };
      for (const [rel, content] of Object.entries(tree)) {
        mkdirSync(join(root, dirname(rel)), { recursive: true });
        writeFileSync(join(root, rel), content);
      }
      const dataFile = join(temp.dir("validate-managed-keys-data-"), "files.yml");
      writeFileSync(dataFile, FILES_YML);
      const ctx = loadContext(root, dataFile, { mode: "render", private: false });
      expect(ctx.manifest).toEqual({
        state: "parsed",
        records: Object.fromEntries(
          Object.entries(accepted).map(([path, body]) => [path, JSON.parse(body)]),
        ),
        refused: [{ key, problem }],
      });
      expect(errorsOf([...checkManifestShape(ctx), ...checkManifestParity(ctx)])).toEqual([
        keyError(key, problem),
      ]);
    },
  );

  test("the sync's own keys pass (control)", () => {
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(stampedBaseline()) });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  });
});

// The validator reads files.yml through the plan's loader, so its verdict on a conditioned entry is the plan's: a
// spelling the loader refuses is one vocabulary finding in the loader's words, and a spelling it accepts selects the
// entry for the validator exactly when selectEntries selects it for the plan.

import { describe, expect, test } from "bun:test";
import {
  FilesConfigError,
  parseFilesConfig,
  selectEntries,
} from "../../../../actions/plan/files_config.ts";
import { tempDirs } from "../../../shared/temp_dir.ts";
import { FILES_YML, MANIFEST, manifestOf, stampedBaseline, validatorRunner } from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

const PATH = "docs/conditioned.md";
const errors = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith("error:"));

const dataFile = (modules: string | null, when: string) =>
  `${FILES_YML.replace(/modules:\n( {2}.*\n)*/, modules === null ? "" : `${modules}\n`)}  - {path: ${PATH}, class: managed, when: ${when}}\n`;

const NOT_JUDGED =
  "neither the registration's module names nor the manifest's classes can be judged";

const UV = "modules: {uv: {description: a bun repository}}";

/** Every spelling the deleted hand reader answered differently from the loader, and the controls both answered alike. */
const CASES = [
  { reason: "an unconditional entry", modules: UV, when: "{}" },
  { reason: "a selected module", modules: UV, when: "{modules: [uv]}" },
  { reason: "one of the modules", modules: UV, when: "{any: [uv]}" },
  { reason: "a forbidden module", modules: UV, when: "{without: [uv]}" },
  { reason: "a matching visibility", modules: UV, when: "{private: false}" },
  { reason: "the other visibility", modules: UV, when: "{private: true}" },
  {
    reason: "a derived list the module data resolves",
    modules: UV,
    when: "{any: {declaring: description}}",
  },
  {
    reason: "a visibility clause in a data file with no modules block",
    modules: null,
    when: "{private: false}",
  },
  { reason: "a key outside the grammar", modules: UV, when: "{module: [uv]}" },
  ...["modules", "any", "without"].flatMap((key) => [
    { reason: `an empty ${key} list`, modules: UV, when: `{${key}: []}` },
    { reason: `an empty name in ${key}`, modules: UV, when: `{${key}: [""]}` },
    { reason: `an unknown module in ${key}`, modules: UV, when: `{${key}: [nope]}` },
    {
      reason: `a derived ${key} list naming no module`,
      modules: UV,
      when: `{${key}: {declaring: pin}}`,
    },
    {
      reason: `a derived ${key} list with an empty key`,
      modules: UV,
      when: `{${key}: {declaring: ""}}`,
    },
  ]),
];

describe("the validator's verdict on a when-conditioned entry is the plan's", () => {
  test.each(CASES)("$reason", ({ modules, when }) => {
    const text = dataFile(modules, when);
    const registration = modules === null ? "modules: []\n" : "modules: [uv]\n";
    const selection = { modules: modules === null ? [] : ["uv"], private: false };
    // The path is recorded as a starter, so a live managed declaration is one class finding and a dead one is none.
    const { exitCode, stderr } = runValidator(
      {
        ".repo-platform.yml": registration,
        [PATH]: "conditioned\n",
        [MANIFEST]: manifestOf({ ...stampedBaseline(), [PATH]: '{"class": "starter"}' }),
      },
      [],
      { filesYml: text },
    );
    let plan: { refused: string[] } | { selected: boolean };
    try {
      const config = parseFilesConfig(text);
      plan = { selected: selectEntries(config, selection).some((entry) => entry.path === PATH) };
    } catch (error) {
      if (!(error instanceof FilesConfigError)) throw error;
      plan = { refused: error.problems };
    }
    if ("refused" in plan) {
      expect(errors(stderr)).toHaveLength(1);
      for (const problem of plan.refused) expect(errors(stderr)[0]).toContain(problem);
      expect(errors(stderr)[0]).toContain(NOT_JUDGED);
      expect(exitCode).toBe(1);
    } else if (plan.selected) {
      expect(errors(stderr)).toHaveLength(1);
      expect(errors(stderr)[0]).toContain(
        `entry '${PATH}' is recorded as starter but files.yml declares the path managed`,
      );
      expect(exitCode).toBe(1);
    } else {
      expect([exitCode, stderr]).toEqual([0, ""]);
    }
  });
});

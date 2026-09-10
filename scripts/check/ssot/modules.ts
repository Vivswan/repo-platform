// Rules anchored on the module manifests: the hand-ordered module roster
// sites, this repository's own smoke row, and the pages token grammar.

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  GATED_MODULES,
  MODULES as SMOKE_GATING_MODULES,
} from "../../../tests/ci/smoke_gating/expectations.ts";
import { ANSWERS_FILE, parseAnswers } from "../../generate/render_dogfood.ts";
import { type Mismatch, mustMatch, setMismatch } from "./comparison.ts";
import { asRecord, ciJobs, loadManifests, REPO_ROOT, read, repoCi } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** The named smoke-generate matrix row; a missing row throws (a rule keyed
 *  on a row must fail loudly when the row is renamed or deleted). */
function smokeMatrixRow(name: string): Record<string, unknown> {
  const smoke = asRecord(ciJobs(repoCi(), "ci.yml")["smoke-generate"], "smoke-generate");
  const matrix = asRecord(asRecord(smoke.strategy, "strategy").matrix, "matrix");
  const rows = (matrix.include as Record<string, unknown>[]) ?? [];
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`ci.yml: smoke-generate has no '${name}' matrix row`);
  return row;
}

/** A row's `modules` value (a YAML list serialized as a string). */
function smokeRowModules(row: Record<string, unknown>): string[] {
  return (parseYaml(String(row.modules)) as unknown[]).map(String);
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const moduleRules: Rule[] = [
  {
    // The module roster's independently-authored sites, compared against
    // the manifests (loadManifests walks MODULE_ORDER, so the hand-ordered
    // list and the manifest set share one spine; the loader already fails
    // on a listed module without a folder). copier.yml's choices,
    // KNOWN_MODULES, and the doc rosters are generated FROM the manifests
    // and are generate:check's job, not this rule's.
    name: "module-list",
    run: () => {
      const mismatches: Mismatch[] = [];
      const reference = loadManifests().map((m) => m.module);

      // The filesystem side of MODULE_ORDER: the loader catches a listed
      // module without a templates/ folder, this catches a folder no
      // manifest claims.
      const dirs = readdirSync(join(REPO_ROOT, "templates")).filter(
        (name) => name !== "base" && lstatSync(join(REPO_ROOT, "templates", name)).isDirectory(),
      );
      mismatches.push(...setMismatch("templates/ module directories", reference, dirs));

      const everyModules = smokeRowModules(smokeMatrixRow("everything"));
      mismatches.push(
        ...setMismatch("ci.yml smoke-generate 'everything' row", reference, everyModules),
      );

      // The smoke-gating expectation table's own module tuple, and the
      // modules its rows actually condition on (a module no row gates
      // would render ungated for every matrix row).
      const gatingFile = "tests/ci/smoke_gating/expectations.ts";
      mismatches.push(
        ...setMismatch(`${gatingFile} MODULES`, reference, [...SMOKE_GATING_MODULES]),
      );
      for (const module of reference) {
        if (!GATED_MODULES.has(module as (typeof SMOKE_GATING_MODULES)[number])) {
          mismatches.push({
            file: gatingFile,
            expected: `an expectation row whose condition names '${module}'`,
            got: "none",
          });
        }
      }
      return mismatches;
    },
  },
  {
    // ci.yml's dogfood-oracle smoke row and .repo-platform-answers.yml are
    // two independently-authored statements of this repository's own module
    // selection and visibility. The oracle step byte-compares real copier
    // output rendered from the ROW against copies generated from the
    // ANSWERS, so a drifted row would make it test the wrong render (the
    // oracle script re-checks the recorded answers at run time; this rule
    // catches the drift before CI spends a render on it).
    name: "dogfood-oracle-row",
    run: () => {
      const mismatches: Mismatch[] = [];
      const answers = parseAnswers(read(ANSWERS_FILE), ANSWERS_FILE);
      const row = smokeMatrixRow("dogfood-oracle");
      mismatches.push(
        ...setMismatch(
          "ci.yml smoke-generate 'dogfood-oracle' row modules",
          [...answers.modules],
          smokeRowModules(row),
        ),
      );
      if (String(row.private) !== String(answers.private)) {
        mismatches.push({
          file: "ci.yml smoke-generate 'dogfood-oracle' row",
          expected: `private: "${answers.private}" (${ANSWERS_FILE})`,
          got: `private: "${String(row.private)}"`,
        });
      }
      return mismatches;
    },
  },
  {
    // reusable-pages.yml's hand-written token grammar against the manifests'
    // pages declarations. copier.yml's pages_setup validator carries the
    // same token set but is generated from the manifests (generate:check),
    // so the workflow's case arm is the one independently-authored copy.
    name: "pages-grammar",
    run: () => {
      const reference = loadManifests()
        .filter((m) => m.pages !== undefined)
        .map((m) => m.module)
        .concat("none");
      const pages = read(".github/workflows/reusable-pages.yml");
      // Anchor on the token-validation case block: the workflow has other
      // case statements whose arms fit the same shape.
      const tokenCase = mustMatch(
        pages,
        /case "\$tool" in([\s\S]*?)esac/,
        "reusable-pages.yml",
        "token case block",
      )[1];
      const arm = mustMatch(
        tokenCase,
        /^\s*((?:[a-z]+\|)+[a-z]+)\) ;;$/m,
        "reusable-pages.yml",
        "setup case arm",
      )[1];
      return setMismatch(
        ".github/workflows/reusable-pages.yml setup tokens",
        reference,
        arm.split("|"),
      );
    },
  },
];

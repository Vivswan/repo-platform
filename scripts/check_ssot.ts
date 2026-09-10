#!/usr/bin/env bun

// Single-source-of-truth drift checker: facts this repo intentionally states
// in more than one INDEPENDENTLY-authored place (hand-written module-roster
// sites, dogfooded template counterparts, settings/label rosters, doc-quoted
// constants) are compared here so drift fails CI instead of rotting silently.
// Copies GENERATED from the module manifests are NOT compared: `bun run
// generate:check` and `dogfood:check` prove the generators ran, and checking
// generator output against generator input would pass vacuously.
//
// The rules are a flat named list assembled from scripts/check/ssot/. Every
// grep-shaped extraction goes through mustMatch(), so a rule whose anchor
// text disappears fails loudly instead of vacuously; structure read from
// TypeScript SOURCES comes off the AST via scripts/lib/ts_extract.ts under
// the same contract, so a comment, string, or template decoy can neither
// satisfy an anchor nor hide the real declaration. Template (.jinja) inputs
// are compared modulo jinja via normalizeJinja() (scripts/lib/jinja_subset.ts,
// shared with render_dogfood.ts); intentional divergences live in
// RECORDED_DIVERGENCES with a reason.
//
// Usage: bun scripts/check_ssot.ts   # prints "rule: file -> expected X, got Y"
//                                    # lines and exits 1 on any mismatch

import { allGreenRules } from "./check/ssot/all_green.ts";
import { type Mismatch, RECORDED_DIVERGENCES, usedDivergences } from "./check/ssot/comparison.ts";
import { deliveryPinRules } from "./check/ssot/delivery_pins.ts";
import { harnessImportRules } from "./check/ssot/harness_imports.ts";
import { labelPreflightRules } from "./check/ssot/label_preflight.ts";
import { labelRules } from "./check/ssot/labels.ts";
import { literalAnchorRules } from "./check/ssot/literal_anchors.ts";
import { migrationLadderRules } from "./check/ssot/migration_ladder.ts";
import { moduleRules } from "./check/ssot/modules.ts";
import { pagesCallerRules } from "./check/ssot/pages_callers.ts";
import { postGreenRules } from "./check/ssot/post_green.ts";
import { prTitleRules } from "./check/ssot/pr_title.ts";
import { processDisciplineRules } from "./check/ssot/process_discipline.ts";
import { RULE_ROSTER, type Rule, ruleRosterMismatches } from "./check/ssot/rule_roster.ts";
import { settingsWorkflowRules } from "./check/ssot/settings_workflow.ts";
import { stickyCommentRules } from "./check/ssot/sticky_comments.ts";
import { toolchainRules } from "./check/ssot/toolchain.ts";
import { twinCopyRules } from "./check/ssot/twin_copies.ts";

/** Every rule, one group module at a time; ruleRosterMismatches audits
 *  the assembled list against RULE_ROSTER before the loop runs. */
const rules: Rule[] = [
  ...moduleRules,
  ...toolchainRules,
  ...deliveryPinRules,
  ...stickyCommentRules,
  ...migrationLadderRules,
  ...allGreenRules,
  ...twinCopyRules,
  ...settingsWorkflowRules,
  ...labelRules,
  ...prTitleRules,
  ...literalAnchorRules,
  ...postGreenRules,
  ...pagesCallerRules,
  ...labelPreflightRules,
  ...processDisciplineRules,
  ...harnessImportRules,
];

function main(): number {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    console.error(`error: unrecognized argument(s): ${args.join(" ")}`);
    return 2;
  }
  let failures = 0;
  // The roster audit runs before the loop it vouches for: a rules array
  // that lost or doubled an entry must scream regardless of what the
  // surviving rules report.
  for (const mismatch of ruleRosterMismatches(
    RULE_ROSTER,
    rules.map((rule) => rule.name),
  )) {
    console.error(
      `rule-roster: ${mismatch.file} -> expected ${mismatch.expected}, got ${mismatch.got}`,
    );
    failures++;
  }
  for (const rule of rules) {
    let mismatches: Mismatch[];
    try {
      mismatches = rule.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mismatches = [{ file: "(rule aborted)", expected: "a readable anchor", got: message }];
    }
    for (const mismatch of mismatches) {
      console.error(
        `${rule.name}: ${mismatch.file} -> expected ${mismatch.expected}, got ${mismatch.got}`,
      );
      failures++;
    }
  }
  for (const [index, entry] of RECORDED_DIVERGENCES.entries()) {
    if (!usedDivergences.has(index)) {
      console.error(
        `recorded-divergences: ${entry.file} -> expected pattern ${entry.skip} to match a line, got nothing (stale entry - remove it)`,
      );
      failures++;
    }
  }
  if (failures > 0) {
    console.error(`ssot: ${failures} mismatch(es) across ${rules.length} rules`);
    return 1;
  }
  console.log(`ssot: all ${rules.length} rules green`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

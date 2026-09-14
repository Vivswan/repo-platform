#!/usr/bin/env bun

// Facts this repo states in more than one INDEPENDENTLY-authored place are compared here so drift fails CI instead of rotting silently.
//
// Every rule's extraction fails loudly when its anchor disappears, never vacuously:
//   grep-shaped text    -> mustMatch() (scripts/check/ssot/comparison.ts)
//   TypeScript sources  -> the AST via scripts/lib/ts_extract.ts, so a comment, string, or template decoy
//                          can neither satisfy an anchor nor hide the declaration
//
// Usage: bun scripts/check_ssot.ts   # prints "rule: file -> expected X, got Y" lines and exits 1 on any mismatch

import type { Mismatch } from "./check/ssot/comparison.ts";
import { RULE_ROSTER, type Rule, ruleRosterMismatches } from "./check/ssot/rule_roster.ts";
import { settingsWorkflowRules } from "./check/ssot/settings_workflow.ts";

const rules: Rule[] = [...settingsWorkflowRules];

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

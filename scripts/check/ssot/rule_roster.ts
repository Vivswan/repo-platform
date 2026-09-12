// The Rule shape and the checker's own authored roster of rule names,
// audited against the live rules before any of them runs (check_ssot.ts).

import type { Mismatch } from "./comparison.ts";

export interface Rule {
  /** Typed as the roster union, so an unrostered name is a tsc error
   *  before it is a runtime mismatch (an unrepresentable invalid state
   *  for typechecked edits); ruleRosterMismatches still owns dropped and
   *  duplicated rules at run time. */
  name: (typeof RULE_ROSTER)[number];
  run: () => Mismatch[];
}

/** The run loop counts whatever the rules array holds, so a rule silently dropped or registered twice would stay green with nothing
 *  to notice it; this roster is compared against the live rules in both directions (ruleRosterMismatches).
 *  Adding a rule means adding its name here; deleting one means removing its entry in the same change. */
export const RULE_ROSTER = [
  "bun-dirs",
  "bun-types-pin",
  "toolchain-version-files",
  "dependabot-action-dirs",
  "actions-bun-guard",
  "local-bun-runtime",
  "action-pins",
  "fleet-refs-ride-build",
  "delivery-pin-stems",
  "sticky-pr-comments",
  "held-run-notice",
  "local-gates",
  "all-green-roster",
  "skeleton-gate",
  "all-green-judge-substitutions",
  "fleet-ci-roster",
  "fleet-ci-plan-unconditional",
  "fleet-nightly-roster",
  "fleet-caller-ceilings",
  "all-green-name",
  "skill-ownership-tables",
  "settings-starter",
  "step-output-gates",
  "settings-apply-input",
  "settings-lane-newest-wins",
  "labels",
  "release-guard-labels",
  "dependabot-label-tuples",
  "tracking-label-regex",
  "pr-title-workflow",
  "pins-and-identities",
  "docs-constants",
  "owner-slug",
  "platform-name-once",
  "release-gate-predicates",
  "release-cut-wiring",
  "auto-assign-codeowners-parity",
  "settings-green-gate",
  "fleet-writers-ride-post-green",
  "spawn-sync-hang-bound",
  "no-tests-under-actions",
  "stream-write-sync",
  "ci-harness-imports",
  "operator-verdict-only",
  "site-config-parity",
  "root-twin-parity",
] as const;

/** Not a rule itself: it runs unconditionally in main(), before the loop it audits,
 *  so it cannot drop out of the rules array alongside what it guards. */
export function ruleRosterMismatches(
  roster: readonly string[],
  names: readonly string[],
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const flagDuplicate = (list: readonly string[], site: string) => {
    const duplicate = list.find((name, index) => list.indexOf(name) !== index);
    if (duplicate !== undefined) {
      mismatches.push({
        file: site,
        expected: "each rule name listed once",
        got: `'${duplicate}' appears more than once`,
      });
    }
  };
  flagDuplicate(roster, "scripts/check/ssot/rule_roster.ts RULE_ROSTER");
  flagDuplicate(names, "scripts/check_ssot.ts rules");
  const expected = new Set(roster);
  for (const name of names) {
    if (!expected.has(name)) {
      mismatches.push({
        file: "scripts/check_ssot.ts rules",
        expected: `rule '${name}' in RULE_ROSTER (adding a rule is a roster edit too)`,
        got: "not in the roster - add its name there, deliberately",
      });
    }
  }
  const present = new Set(names);
  for (const name of roster) {
    if (!present.has(name)) {
      mismatches.push({
        file: "scripts/check/ssot/rule_roster.ts RULE_ROSTER",
        expected: `a rule named '${name}'`,
        got: "no such rule - a dropped rule is a silently retired gate; remove the entry in the same change, deliberately",
      });
    }
  }
  return mismatches;
}

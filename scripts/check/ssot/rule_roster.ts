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

/** Every rule this checker runs, by name - the checker's own authored
 *  roster, mirroring ALL_GREEN_ROSTER one level down: the run loop counts
 *  whatever the rules array happens to hold, so a rule silently dropped
 *  (a bad merge, a refactor that loses an entry) or registered twice
 *  would stay green with nothing to notice it. main() compares this list
 *  against the live rules in both directions (ruleRosterMismatches), so
 *  adding a rule means adding its name here, and deleting one means
 *  removing its entry in the same change, deliberately. */
export const RULE_ROSTER = [
  "module-list",
  "files-modules",
  "dogfood-oracle-row",
  "bun-dirs",
  "action-pins",
  "sticky-pr-comments",
  "fleet-refs-ride-build",
  "migration-ladder",
  "migrations-self-contained",
  "no-retired-shapes",
  "bun-types-pin",
  "toolchain-version-files",
  "files-pins",
  "files-pages",
  "files-defaults",
  "local-gates",
  "dogfood-parity",
  "gitattributes-region",
  "dependabot-actions-block",
  "dependabot-action-dirs",
  "typography-allow",
  "symlink-trio",
  "settings-starter",
  "labels",
  "issue-labels",
  "release-guard-labels",
  "all-green-roster",
  "all-green-judge-substitutions",
  "fleet-ci-roster",
  "fleet-nightly-roster",
  "fleet-caller-ceilings",
  "all-green-name",
  "pr-title-workflow",
  "dependabot-label-tuples",
  "settings-read-pin",
  "settings-hide-details",
  "settings-apply-skip-gate",
  "step-output-gates",
  "pins-and-identities",
  "tracking-label-regex",
  "pages-grammar",
  "docs-constants",
  "agents-recipe",
  "owner-slug",
  "release-gate-predicates",
  "auto-assign-codeowners-parity",
  "actions-bun-guard",
  "stamp-hook-path",
  "settings-apply-merged-input",
  "settings-green-gate",
  "fleet-writers-ride-post-green",
  "settings-hidden-step-notices",
  "settings-label-preflight",
  "spawn-sync-hang-bound",
  "temp-dirs-through-helper",
  "no-tests-under-actions",
  "stream-write-sync",
  "local-bun-runtime",
  "skill-ownership-tables",
  "ci-harness-imports",
  "operator-verdict-only",
  "pages-callers-parity",
] as const;

/** Set-plus-uniqueness comparison between the authored roster and the live
 *  rules' names, in both directions: a live rule missing from the roster is
 *  a gate the roster never vouched for, a roster entry with no live rule is
 *  a DROPPED rule (the silent case the roster exists for, since the run loop
 *  only counts what survived), and a duplicate on either side is a double-run
 *  rule or a double-vouched entry. Not a rule itself: it runs unconditionally
 *  in main(), before the loop it audits, so it cannot drop out of the rules
 *  array alongside what it guards. */
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

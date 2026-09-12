// Rules over the label rosters: the managed labels' sites, the release
// guard's literals, dependabot's tuples, and the hand-copied label regex.

import { FLEET_SYNC_LABELS } from "../../../.github/scripts/fleet/fleet_sync_marker.ts";
import { loadLayer } from "../../../.github/scripts/sync/writer/settings_layers.ts";
import { constRegexSource, constStringValue } from "../../lib/ts_extract.ts";
import { type Mismatch, mustMatch } from "./comparison.ts";
import { managedLabelRoster, modules, read, trackingStreams } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** This repository's overlay: the one place the fleet-sync labels are declared, since only its pull requests carry them. */
export const FLEET_SYNC_OVERLAY = ".github/settings.local.yml";

/** The fleet-sync labels the leg reads (`known`) against the overlay's `labels` list, both ways: a label the leg knows but the
 *  overlay lacks is never on a pull request, and a fleet-sync label the overlay declares but the leg does not know is refused red
 *  on every merge that wears it. Names fold case like the leg and GitHub do. A declared label needs its color and description,
 *  or the apply cannot create it. */
export function fleetSyncLabelMismatches(known: readonly string[], declared: unknown): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const labels = Array.isArray(declared) ? declared : [];
  const byName = new Map<string, Record<string, unknown>>();
  for (const label of labels) {
    if (typeof label === "object" && label !== null && typeof label.name === "string") {
      byName.set(label.name.toLowerCase(), label);
    }
  }
  const folded = known.map((name) => name.toLowerCase());
  for (const name of known) {
    const label = byName.get(name.toLowerCase());
    if (label === undefined) {
      mismatches.push({
        file: FLEET_SYNC_OVERLAY,
        expected: `label '${name}' (fleet_sync_marker.ts FLEET_SYNC_LABELS)`,
        got: "missing - no pull request can wear a label the repository does not declare",
      });
      continue;
    }
    for (const field of ["color", "description"]) {
      if (typeof label[field] !== "string" || label[field] === "") {
        mismatches.push({
          file: `${FLEET_SYNC_OVERLAY} label '${label.name}'`,
          expected: `a non-empty ${field}`,
          got: "missing",
        });
      }
    }
  }
  for (const [name, label] of byName) {
    if (name.startsWith("fleet-sync:") && !folded.includes(name)) {
      mismatches.push({
        file: `${FLEET_SYNC_OVERLAY} label '${label.name}'`,
        expected: `a scope fleet_sync_marker.ts FLEET_SYNC_LABELS knows (${known.join(", ")})`,
        got: "a fleet-sync label the leg refuses on every merge that wears it",
      });
    }
  }
  return mismatches;
}

/** The registration grammar's LABEL_RE is the home; these are its hand-copied twins, each read off its AST as an exported const. */
export const LABEL_RE_HOME = "actions/plan/registration.ts";
export const LABEL_RE_COPIES: readonly { file: string; name: string }[] = [
  { file: "actions/release-health/release-health.ts", name: "LABEL_RE" },
];

/** Each copy in LABEL_RE_COPIES whose pattern body differs from `labelRe`
 *  (the registration grammar's), sources read through `readSource`. */
export function labelRegexCopyMismatches(
  labelRe: string,
  readSource: (rel: string) => string,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const copy of LABEL_RE_COPIES) {
    const got = constRegexSource(readSource(copy.file), copy.name, {
      where: copy.file,
      what: `the ${copy.name} label regex`,
      exported: true,
    });
    if (got !== labelRe) {
      mismatches.push({
        file: `${copy.file} ${copy.name}`,
        expected: `${labelRe} (${LABEL_RE_HOME} LABEL_RE)`,
        got,
      });
    }
  }
  return mismatches;
}

/** release-health's gate labels, read off the action so the roster cannot drift from what the gate queries. */
const RELEASE_GATE_LABELS = ["BLOCKER_LABEL", "OVERRIDE_LABEL"] as const;

/** The two starter workflows carrying a tracking stream's create tuple. */
export const FUZZ_STARTER = "files/fuzzer/.github/workflows/nightly-fuzz.yml";
export const NIGHTLY_STARTER = "files/nightly/.github/workflows/nightly.yml";
/** The shared deploy carrying the site stream's create tuple. */
export const REUSABLE_SITE = ".github/workflows/reusable-site.yml";
const TRACKING_CARRIERS = [
  { module: "fuzzer", carrier: FUZZ_STARTER },
  { module: "nightly", carrier: NIGHTLY_STARTER },
  { module: "site", carrier: REUSABLE_SITE },
] as const;

export const labelRules: Rule[] = [
  {
    name: "fleet-sync-labels",
    run: () =>
      fleetSyncLabelMismatches([...FLEET_SYNC_LABELS.keys()], loadLayer(FLEET_SYNC_OVERLAY).labels),
  },
  {
    name: "labels",
    run: () => {
      const mismatches: Mismatch[] = [];
      // The settings layers are the label roster's single home; this
      // regression tripwire keeps the hand-maintained tuples from quietly
      // losing a member the fleet's tools recreate (dependabot, the
      // release machinery) - losing one restarts the nightly
      // delete/recreate loop the layers exist to kill.
      const rosterNames = new Set(managedLabelRoster().map((label) => label.name));
      const required = [
        "dependencies",
        "github_actions",
        "javascript",
        "bug",
        "enhancement",
        "fix-lint",
        "settings-as-code-report",
        "autorelease: pending",
        "autorelease: tagged",
        ...RELEASE_GATE_LABELS.map((name) =>
          constStringValue(read("actions/release-health/release-health.ts"), name, {
            where: "release-health.ts",
            what: "the release gate label",
            exported: true,
          }),
        ),
      ];
      for (const name of required) {
        if (!rosterNames.has(name)) {
          mismatches.push({
            file: "files/settings/baseline.yml (or a module's settings.yml layer)",
            expected: `label '${name}' in the managed roster`,
            got: "missing",
          });
        }
      }

      // Tracking-label streams: files.yml's tracking_label block is the single source of each stream's create
      // tuple, and each carrier (the two starters, the shared site deploy) passes the tuple to the fuzz-issue action.
      const streams = trackingStreams();
      for (const { module, carrier } of TRACKING_CARRIERS) {
        const tracking = streams.find((m) => m.module === module);
        if (!tracking) throw new Error(`files.yml modules.${module} lost tracking_label`);
        const text = read(carrier);
        const color = mustMatch(text, /label-color: "([^"]+)"/, carrier, "label-color input")[1];
        const description = mustMatch(
          text,
          /label-description: (.+)/,
          carrier,
          "label-description input",
        )[1];
        if (color !== tracking.color || description !== tracking.description) {
          mismatches.push({
            file: `${carrier} label tuple`,
            expected: `${tracking.color} / ${tracking.description} (files.yml modules.${module}.tracking_label)`,
            got: `${color} / ${description}`,
          });
        }
      }

      // The fleet-wide security stream is fleet data, not a module answer:
      // its tuple lives in the settings baseline (so every repository
      // carries the label), fleet-nightly's scan job files under it, and the
      // plan job appends it to the tracking labels release-health blocks on.
      const securityLabel = constStringValue(read("actions/plan/plan.ts"), "SECURITY_LABEL", {
        where: "plan.ts",
        what: "the fleet security label",
        exported: true,
      });
      const baselineTuple = managedLabelRoster().find((label) => label.name === securityLabel);
      if (baselineTuple === undefined) {
        mismatches.push({
          file: "files/settings/baseline.yml",
          expected: `label '${securityLabel}' (actions/plan/plan.ts SECURITY_LABEL)`,
          got: "missing - every repository must carry the label the nightly scan files under",
        });
      }
      const fleetNightly = read(".github/workflows/fleet-nightly.yml");
      const nightly = mustMatch(
        fleetNightly,
        /^ {2}trivy-nightly:\n((?:(?!\n {2}[a-z-]+:\n)[\s\S])*)/m,
        "fleet-nightly.yml",
        "the trivy-nightly job",
      )[1];
      const labels = [...nightly.matchAll(/^ {10}label: (.+)$/gm)].map((match) => match[1]);
      if (labels.length !== 2 || labels.some((label) => label !== securityLabel)) {
        mismatches.push({
          file: ".github/workflows/fleet-nightly.yml trivy-nightly label inputs",
          expected: `'${securityLabel}' on both the report and the resolve step (actions/plan/plan.ts SECURITY_LABEL)`,
          got: labels.join(", ") || "no label input",
        });
      }
      const nightlyColor = mustMatch(
        nightly,
        /label-color: "([^"]+)"/,
        "fleet-nightly.yml trivy-nightly",
        "label-color input",
      )[1];
      const nightlyDescription = mustMatch(
        nightly,
        /label-description: (.+)/,
        "fleet-nightly.yml trivy-nightly",
        "label-description input",
      )[1];
      if (
        baselineTuple !== undefined &&
        (nightlyColor !== baselineTuple.color || nightlyDescription !== baselineTuple.description)
      ) {
        mismatches.push({
          file: ".github/workflows/fleet-nightly.yml trivy-nightly label overrides",
          expected: `${baselineTuple.color} / ${baselineTuple.description} (files/settings/baseline.yml '${securityLabel}')`,
          got: `${nightlyColor} / ${nightlyDescription}`,
        });
      }
      return mismatches;
    },
  },
  {
    // The stale-pending guard in the release-please workflow queries and
    // names the autorelease labels as string literals. gh pr list exits 0
    // and empty for a label that does not exist, so a literal that drifts
    // from the managed roster degrades the guard to a permanent silent
    // no-op - anchor the literals to the release-please module's settings
    // layer here instead.
    name: "release-guard-labels",
    run: () => {
      const mismatches: Mismatch[] = [];
      const layer = "files/release-please/settings.yml";
      const releaseLabels = (loadLayer(layer).labels ?? []) as {
        name: string;
      }[];
      if (releaseLabels.length === 0) {
        throw new Error(`${layer} declares no labels - anchor lost`);
      }
      const roster = new Set(releaseLabels.map((label) => label.name));
      const rel = ".github/workflows/fleet-release.yml";
      const text = read(rel);
      const queried = mustMatch(
        text,
        /gh pr list --state merged --label '([^']+)'/,
        rel,
        "guard label query",
      )[1];
      const worn = mustMatch(text, /have worn '([^']+)'/, rel, "guard error's pending label")[1];
      const target = mustMatch(
        text,
        /move the label to '([^']+)'/,
        rel,
        "guard error's tagged label",
      )[1];
      for (const name of [queried, worn, target]) {
        if (!roster.has(name)) {
          mismatches.push({
            file: rel,
            expected: `label '${name}' declared in ${layer}`,
            got: "not in the module's roster",
          });
        }
      }
      if (worn !== queried) {
        mismatches.push({
          file: rel,
          expected: `guard error names the queried label '${queried}'`,
          got: `'${worn}'`,
        });
      }
      // The prescribed fix must point at the tagged label specifically -
      // roster membership alone would accept any declared label.
      if (target !== "autorelease: tagged") {
        mismatches.push({
          file: rel,
          expected: "guard error prescribes moving to 'autorelease: tagged'",
          got: `'${target}'`,
        });
      }
      return mismatches;
    },
  },
  {
    name: "dependabot-label-tuples",
    run: () => {
      // A toolchain module's dependabot label has two homes: files.yml's
      // `dependabot_label` tuple (which the docs quote) and the module's
      // own settings layer (which drives the label roster the apply syncs).
      // If they drift, dependabot recreates a label the settings apply then
      // deletes - the nightly delete/recreate loop this whole roster exists
      // to kill.
      const mismatches: Mismatch[] = [];
      for (const module of modules()) {
        const tuple = module.dependabot_label;
        if (tuple === undefined) continue;
        const rel = `files/${module.name}/settings.yml`;
        const declared = (loadLayer(rel).labels ?? []) as {
          name: string;
          color: string;
          description: string;
        }[];
        const entry = declared.find((label) => label.name === tuple.name);
        if (entry === undefined) {
          mismatches.push({
            file: rel,
            expected: `a label '${tuple.name}' (files.yml modules.${module.name}.dependabot_label)`,
            got: declared.map((label) => label.name).join(", ") || "no labels",
          });
          continue;
        }
        if (entry.color !== tuple.color) {
          mismatches.push({
            file: `${rel} label '${tuple.name}' color`,
            expected: `${tuple.color} (files.yml modules.${module.name}.dependabot_label.color)`,
            got: entry.color,
          });
        }
      }
      return mismatches;
    },
  },
  {
    // Every hand-copied label regex (LABEL_RE_COPIES) must state exactly
    // the shape the registration grammar enforces: release-health reads
    // the labels the plan admitted, so it must read them the same way.
    name: "tracking-label-regex",
    run: () => {
      const labelRe = constRegexSource(read(LABEL_RE_HOME), "LABEL_RE", {
        where: LABEL_RE_HOME,
        what: "LABEL_RE",
        exported: true,
      });
      return labelRegexCopyMismatches(labelRe, read);
    },
  },
];

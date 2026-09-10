#!/usr/bin/env bun
// The sync-side referenced-labels warning (docs/settings.md, "Label
// preflight"): every label the target's issue forms and workflows reference
// must exist in the settings LAYER STACK's roster under its POST-APPLY name,
// because the apply's reconciliation deletes undeclared labels and renames
// `new_name` sources (label_references.ts owns the extraction rule and its
// limits; settings_layers.ts owns the stack and its labels-only fold). A missing label writes a PR-body section that FORCES manual
// review. WARN, never fail: a repo's own quirk must not block its sync PR,
// and the apply side (label_preflight.ts) carries the fail-closed guard.
//
// Runs after the preserve steps, so the tree it reads is the delivered
// content the invariant is about. Not applicable (empty report) when no
// apply would reconcile labels: no .repo-platform.yml, no settings.yml, or
// no labels key in the merged document. A computation failure writes a
// COULD-NOT-VERIFY section instead - still forcing review, still exit 0:
// skipping silently would fail open, hard-failing would block delivery.
// The report may quote target content; it ships in the PR body to the
// target itself, so the LOG lines stay value-free for a hidden target.
// Usage: bun referenced_labels.ts [--root target] [--report FILE]
//   [--hide-details true|false]. --report defaults to RUNNER_TEMP/
//   <REFERENCED_LABELS_NAME>, the section_files.ts constant open_pr.ts reads.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadManifests } from "../../../scripts/lib/module_manifests.ts";
import {
  collectReferences,
  type LabelReference,
  missingFromRoster,
  referenceFilesFromDir,
} from "../fleet/label_references.ts";
import { factsFromTargetDir } from "../fleet/settings_facts.ts";
import { layerLabelNames, layerStack, loadLayer } from "../fleet/settings_layers.ts";
import { parseFlags } from "../shared/flags.ts";
import { requireEnv, warning } from "../shared/gha.ts";
import { REFERENCED_LABELS_NAME } from "./section_files.ts";

/** The listed references are bounded so the section can never starve
 *  open_pr.ts's aggregate PR-body budget; the rest is counted, not shown. */
const LIST_CAP_BYTES = 6000;

/** The PR-body section for referenced-but-undeclared labels, or "" when
 *  every reference is covered. */
export function missingLabelsSection(missing: LabelReference[]): string {
  if (missing.length === 0) return "";
  const lines: string[] = [];
  let bytes = 0;
  let shown = 0;
  for (const reference of missing) {
    const line = `> - ${JSON.stringify(reference.label)}: referenced by ${reference.files
      .map((file) => `\`${file}\``)
      .join(", ")}`;
    bytes += Buffer.byteLength(line, "utf-8");
    if (bytes > LIST_CAP_BYTES) break;
    lines.push(line);
    shown += 1;
  }
  if (shown < missing.length) {
    lines.push(`> - (list truncated: ${missing.length - shown} more label(s))`);
  }
  return [
    "> [!WARNING]",
    "> REFERENCED LABELS MISSING FROM THE SETTINGS ROSTER: this",
    "> repository's issue forms or workflows reference label(s) the merged",
    "> settings document does not declare under their final names. The",
    "> settings apply DELETES undeclared labels (and a `new_name` rename",
    "> removes the old name the same way), so each reference below is",
    "> broken already or breaks on the next apply (which refuses to remove",
    "> a still-referenced label and fails instead). Declare each label in",
    "> `.github/settings.yml` (or a fleet/module layer), or remove the",
    "> reference, then re-run the sync for a clean PR.",
    ">",
    ...lines,
    "",
  ].join("\n");
}

/** The fallback section when the roster could not be computed: the check
 *  ran but cannot answer, so a human must - fail open is how the two
 *  incidents happened, and a hard fail would block the delivery the
 *  reviewer needs to fix the cause. */
export function checkFailedSection(reason: string): string {
  return [
    "> [!WARNING]",
    "> REFERENCED-LABEL CHECK COULD NOT RUN: the merged settings label",
    "> roster could not be computed for this tree, so labels referenced by",
    "> issue forms and workflows were not checked against it. Verify",
    "> manually that every referenced label is declared before merging.",
    ">",
    `> ${JSON.stringify(reason)}`,
    "",
  ].join("\n");
}

/** The whole check against `root`'s working tree: writes `report` (the
 *  PR-body section, or "" when nothing needs review) and prints the
 *  hide-details-aware status line. */
function writeReferencedLabelsReport(root: string, report: string, hideDetails: boolean): void {
  let note = "";
  let log = "";
  try {
    const manifests = loadManifests();
    const facts = factsFromTargetDir(root, manifests);
    const settingsPath = join(root, ".github/settings.yml");
    if (facts === null) {
      log = "not applicable (no .repo-platform.yml, so no apply reconciles labels)";
    } else if (!existsSync(settingsPath)) {
      log = "not applicable (no settings.yml to merge, so no apply reconciles labels)";
    } else {
      const roster = layerLabelNames(
        layerStack(facts, manifests, settingsPath).map((layer) =>
          layer.kind === "file" ? loadLayer(layer.path) : { labels: layer.labels },
        ),
      );
      if (roster === null) {
        log = "not applicable (no layer leaves a labels key for the apply to reconcile)";
      } else {
        const references = collectReferences(referenceFilesFromDir(root));
        const missing = missingFromRoster(references, roster);
        note = missingLabelsSection(missing);
        log =
          missing.length === 0
            ? `every referenced label is declared (${references.length} referenced, ` +
              `${roster.length} in the post-apply roster)`
            : hideDetails
              ? `${missing.length} referenced label(s) missing from the merged roster ` +
                "(names hidden: private repository; listed in the PR body) - manual review forced"
              : `referenced label(s) missing from the merged roster: ${missing
                  .map((reference) => JSON.stringify(reference.label))
                  .join(", ")} - listed in the PR body, manual review forced`;
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    note = checkFailedSection(reason);
    log = hideDetails
      ? "the referenced-label check could not run (detail hidden: private repository; " +
        "in the PR body) - manual review forced"
      : `the referenced-label check could not run (${reason}) - the PR body says so, ` +
        "manual review forced";
  }

  writeFileSync(report, note, "utf-8");
  if (note === "") console.log(`referenced labels: ${log}`);
  else warning(`referenced labels: ${log}`);
}

function main(argv: string[]): number {
  const flags = parseFlags(argv, [] as const, ["--root", "--report", "--hide-details"] as const);
  writeReferencedLabelsReport(
    flags["--root"] ?? "target",
    flags["--report"] ?? join(requireEnv("RUNNER_TEMP"), REFERENCED_LABELS_NAME),
    flags["--hide-details"] === "true",
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

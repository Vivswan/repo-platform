import { describe, expect, test } from "bun:test";
import type { Mismatch } from "../../../scripts/check/ssot/comparison.ts";
import {
  FLEET_SYNC_OVERLAY,
  fleetSyncLabelMismatches,
  LABEL_RE_COPIES,
  LABEL_RE_HOME,
  labelRegexCopyMismatches,
} from "../../../scripts/check/ssot/labels.ts";

describe("fleetSyncLabelMismatches", () => {
  const KNOWN = ["fleet-sync:all", "fleet-sync:public"];
  const label = (name: string, color = "0052cc", description = "Sync from this merge") => ({
    name,
    color,
    description,
  });

  test.each<{ reason: string; declared: unknown; expected: Mismatch[] }>([
    {
      reason: "both labels declared whole, beside another of the repository's own (the control)",
      declared: [label("fleet-sync:public"), label("fleet-sync:all"), label("triage")],
      expected: [],
    },
    {
      reason: "names fold case, as the leg and GitHub fold them",
      declared: [label("Fleet-Sync:Public"), label("FLEET-SYNC:ALL")],
      expected: [],
    },
    {
      reason: "a label the leg knows is missing from the overlay",
      declared: [label("fleet-sync:public")],
      expected: [
        {
          file: FLEET_SYNC_OVERLAY,
          expected: "label 'fleet-sync:all' (fleet_sync_marker.ts FLEET_SYNC_LABELS)",
          got: "missing - no pull request can wear a label the repository does not declare",
        },
      ],
    },
    {
      reason: "a declared label without its color and description cannot be created by the apply",
      declared: [label("fleet-sync:all"), { name: "fleet-sync:public", color: "" }],
      expected: [
        {
          file: `${FLEET_SYNC_OVERLAY} label 'fleet-sync:public'`,
          expected: "a non-empty color",
          got: "missing",
        },
        {
          file: `${FLEET_SYNC_OVERLAY} label 'fleet-sync:public'`,
          expected: "a non-empty description",
          got: "missing",
        },
      ],
    },
    {
      reason: "a fleet-sync label the leg does not know would be refused on every merge wearing it",
      declared: [label("fleet-sync:all"), label("fleet-sync:public"), label("Fleet-Sync:private")],
      expected: [
        {
          file: `${FLEET_SYNC_OVERLAY} label 'Fleet-Sync:private'`,
          expected:
            "a scope fleet_sync_marker.ts FLEET_SYNC_LABELS knows (fleet-sync:all, fleet-sync:public)",
          got: "a fleet-sync label the leg refuses on every merge that wears it",
        },
      ],
    },
    {
      reason: "an overlay with no labels list lacks both",
      declared: undefined,
      expected: [
        {
          file: FLEET_SYNC_OVERLAY,
          expected: "label 'fleet-sync:all' (fleet_sync_marker.ts FLEET_SYNC_LABELS)",
          got: "missing - no pull request can wear a label the repository does not declare",
        },
        {
          file: FLEET_SYNC_OVERLAY,
          expected: "label 'fleet-sync:public' (fleet_sync_marker.ts FLEET_SYNC_LABELS)",
          got: "missing - no pull request can wear a label the repository does not declare",
        },
      ],
    },
  ])("$reason", ({ declared, expected }) => {
    expect(fleetSyncLabelMismatches(KNOWN, declared)).toEqual(expected);
  });
});

describe("labelRegexCopyMismatches", () => {
  const LABEL_RE = "^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}$";
  const source = (copy: (typeof LABEL_RE_COPIES)[number], pattern: string) =>
    `export const ${copy.name} = /${pattern}/;\n`;
  const reader = (drifted?: string) => (rel: string) => {
    const copy = LABEL_RE_COPIES.find((entry) => entry.file === rel);
    if (copy === undefined) throw new Error(`unexpected read ${rel}`);
    return source(copy, rel === drifted ? "^[a-z]+$" : LABEL_RE);
  };

  test("every copy spelling the home's pattern yields nothing (the control)", () => {
    expect(labelRegexCopyMismatches(LABEL_RE, reader())).toEqual([]);
  });

  test.each(LABEL_RE_COPIES.map((copy) => ({ copy })))(
    "a drifted $copy.file names that copy alone",
    ({ copy }) => {
      expect(labelRegexCopyMismatches(LABEL_RE, reader(copy.file))).toEqual([
        {
          file: `${copy.file} ${copy.name}`,
          expected: `${LABEL_RE} (${LABEL_RE_HOME} LABEL_RE)`,
          got: "^[a-z]+$",
        },
      ]);
    },
  );

  test("a copy that lost its declaration is a lost anchor, not a pass", () => {
    const missing = (rel: string) =>
      rel === "actions/release-health/release-health.ts"
        ? "export const OTHER = /x/;\n"
        : reader()(rel);
    expect(() => labelRegexCopyMismatches(LABEL_RE, missing)).toThrow(
      "actions/release-health/release-health.ts: anchor for the LABEL_RE label regex not found",
    );
  });
});

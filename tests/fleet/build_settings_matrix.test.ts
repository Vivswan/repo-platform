import { describe, expect, test } from "bun:test";
import {
  applyOnly,
  buildMatrix,
  selfTarget,
  type Target,
} from "../../.github/scripts/fleet/build_settings_matrix";
import type { EnrichedRow } from "../../.github/scripts/fleet/redact";

function target(repo: string, hideDetails = false): Target {
  return {
    repo,
    name: repo.split("/").pop() ?? repo,
    redact_name: false,
    hide_details: hideDetails,
    verify: "",
  };
}

function publicRow(repo: string): EnrichedRow {
  return {
    repo,
    redact_name: false,
    hide_details: false,
    display: repo,
    verify: "",
  };
}

describe("selfTarget", () => {
  test("the operator repo becomes a plain unredacted row", () => {
    expect(selfTarget("Vivswan/repo-platform")).toEqual({
      repo: "Vivswan/repo-platform",
      name: "repo-platform",
      redact_name: false,
      hide_details: false,
      verify: "",
    });
  });
});

describe("buildMatrix", () => {
  test("merges the rows and the self target sorted by repo", () => {
    expect(
      buildMatrix(
        [publicRow("Vivswan/zeta"), publicRow("Vivswan/alpha")],
        selfTarget("Vivswan/repo-platform"),
      ),
    ).toEqual([target("Vivswan/alpha"), target("Vivswan/repo-platform"), target("Vivswan/zeta")]);
  });

  test("the self target wins when its slug also appears as a row", () => {
    expect(
      buildMatrix([publicRow("Vivswan/repo-platform")], selfTarget("Vivswan/repo-platform")),
    ).toEqual([target("Vivswan/repo-platform")]);
  });

  test("a duplicated slug yields one entry, folding case like GitHub", () => {
    expect(buildMatrix([publicRow("Vivswan/alpha"), publicRow("VIVSWAN/Alpha")], null)).toEqual([
      target("Vivswan/alpha"),
    ]);
  });

  test("a redacted row emits its display, never the slug", () => {
    // Target keeps EnrichedRow's discriminated union instead of flattening
    // it into three independent fields, so `redact_name: true,
    // hide_details: false` - the combination the selector's schema exists
    // to prevent (a repo whose NAME is hidden but whose label and ruleset
    // names print to the public log) - is unrepresentable here too; tsc
    // checks the construction sites, and this pins the redacted arm's
    // runtime output whole.
    const row: EnrichedRow = {
      repo: "Vivswan/hidden-server",
      redact_name: true,
      hide_details: true,
      display: "h**-s**r",
      verify: "deadbeef",
    };
    const matrix = buildMatrix([row], null);
    expect(matrix).toEqual([
      {
        repo: "h**-s**r",
        name: "h**-s**r",
        redact_name: true,
        hide_details: true,
        verify: "deadbeef",
      },
    ]);
    expect(JSON.stringify(matrix)).not.toContain("hidden-server");
  });

  test("a self-disclosed private row keeps its committed name", () => {
    const row: EnrichedRow = {
      repo: "Vivswan/committed-private",
      redact_name: false,
      hide_details: true,
      display: "Vivswan/committed-private",
      verify: "",
    };
    // The NAME is disclosed but the content is not: hide_details must
    // survive the matrix, or the pre-action render and merge steps print
    // this repo's own label and ruleset names into a public log.
    expect(buildMatrix([row], null)).toEqual([target("Vivswan/committed-private", true)]);
  });

  test("no targets is an empty matrix, not an error", () => {
    expect(buildMatrix([], null)).toEqual([]);
  });
});

describe("applyOnly", () => {
  const self = selfTarget("Vivswan/repo-platform");
  const rows: EnrichedRow[] = [
    {
      repo: "Vivswan/beta",
      redact_name: false,
      hide_details: false,
      display: "Vivswan/beta",
      verify: "",
    },
    {
      repo: "Vivswan/gamma",
      redact_name: true,
      hide_details: true,
      display: "g**a",
      verify: "v",
    },
  ];

  test.each([
    {
      reason: "the self slug, case-folded, keeps only self",
      only: "vivswan/REPO-PLATFORM",
      expected: { rows: [], self },
    },
    {
      reason: "a row's real slug, case-folded, keeps that row and drops self",
      only: "vivswan/GAMMA",
      expected: { rows: [rows[1]], self: null },
    },
    {
      reason: "an unknown slug scopes everything to empty",
      only: "Vivswan/nope",
      expected: { rows: [], self: null },
    },
  ])("applyOnly: $reason", ({ only, expected }) => {
    expect(applyOnly(rows, self, only)).toEqual(expected);
  });
});

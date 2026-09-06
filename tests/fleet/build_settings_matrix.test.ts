import { describe, expect, test } from "bun:test";
import {
  applyOnly,
  buildMatrix,
  selfTarget,
  type Target,
} from "../../.github/scripts/fleet/build_settings_matrix";
import type { EnrichedRow } from "../../.github/scripts/fleet/redact";

function target(repo: string): Target {
  return { repo, name: repo.split("/").pop() ?? repo, private: false, verify: "" };
}

function publicRow(repo: string): EnrichedRow {
  return { repo, private: false, display: repo, verify: "" };
}

describe("selfTarget", () => {
  test("the operator repo becomes a plain public row", () => {
    expect(selfTarget("Vivswan/repo-platform")).toEqual({
      repo: "Vivswan/repo-platform",
      name: "repo-platform",
      private: false,
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

  test("a private row emits its display in both name slots, never the slug", () => {
    // Target keeps EnrichedRow's discriminated union instead of flattening
    // it into independent fields, so a tagless private row - the shape the
    // selector's schema exists to prevent - is unrepresentable here too;
    // tsc checks the construction sites, and this pins the private arm's
    // runtime output whole.
    const row: EnrichedRow = {
      repo: "Vivswan/hidden-server",
      private: true,
      display: "h**-s**r",
      verify: "deadbeef",
    };
    const matrix = buildMatrix([row], null);
    expect(matrix).toEqual([
      { repo: "h**-s**r", name: "h**-s**r", private: true, verify: "deadbeef" },
    ]);
    expect(JSON.stringify(matrix)).not.toContain("hidden-server");
  });

  test("no targets is an empty matrix, not an error", () => {
    expect(buildMatrix([], null)).toEqual([]);
  });
});

describe("applyOnly", () => {
  const self = selfTarget("Vivswan/repo-platform");
  const rows: EnrichedRow[] = [
    { repo: "Vivswan/beta", private: false, display: "Vivswan/beta", verify: "" },
    { repo: "Vivswan/gamma", private: true, display: "g**a", verify: "v" },
  ];

  test.each<{ reason: string; only: string; expected: ReturnType<typeof applyOnly> }>([
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
    {
      reason: "a comma list keeps every listed target, self included, trimmed and case-folded",
      only: "vivswan/GAMMA, Vivswan/repo-platform ,Vivswan/nope",
      expected: { rows: [rows[1]], self },
    },
  ])("applyOnly: $reason", ({ only, expected }) => {
    expect(applyOnly(rows, self, only)).toEqual(expected);
  });
});

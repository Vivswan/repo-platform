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

  test("the redaction union rides through: redacted always means hidden details", () => {
    // Target used to flatten EnrichedRow's discriminated union into three
    // independent fields, re-admitting `redact_name: true, hide_details:
    // false` - the combination the selector's schema exists to prevent
    // (a repo whose NAME is hidden but whose label and ruleset names
    // print to the public log). The union now carries through at the
    // type level (tsc checks the construction sites); this pins the
    // runtime outputs, which were already sound - no behavior change.
    const rows: EnrichedRow[] = [
      publicRow("Vivswan/open"),
      {
        repo: "Vivswan/hidden-server",
        redact_name: true,
        hide_details: true,
        display: "h**-s**r",
        verify: "deadbeef",
      },
      {
        repo: "Vivswan/committed-private",
        redact_name: false,
        hide_details: true,
        display: "Vivswan/committed-private",
        verify: "",
      },
    ];
    for (const entry of buildMatrix(rows, selfTarget("Vivswan/repo-platform"))) {
      if (entry.redact_name) expect(entry.hide_details).toBe(true);
    }
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

  test("keeps only the requested self target", () => {
    const scoped = applyOnly(rows, self, "vivswan/REPO-PLATFORM");
    expect(scoped.self).toEqual(self);
    expect(scoped.rows).toHaveLength(0);
  });

  test("matches rows case-insensitively on the real slug", () => {
    const scoped = applyOnly(rows, self, "vivswan/GAMMA");
    expect(scoped.self).toBeNull();
    expect(scoped.rows.map((r) => r.repo)).toEqual(["Vivswan/gamma"]);
  });

  test("an unknown repo scopes everything to empty", () => {
    const scoped = applyOnly(rows, self, "Vivswan/nope");
    expect(scoped.self).toBeNull();
    expect(scoped.rows).toHaveLength(0);
  });
});

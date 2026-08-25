// Unit tests for the fleet rehearsal driver: repos.yml enumeration with
// exclude handling, the fail-closed private-skip decision (the rehearsal
// function must never run for a private or visibility-unknown repo), the
// failure-continues-loop contract, and the summary formatting for every
// status shape. All dependencies are injected; nothing here touches the
// network.

import { describe, expect, test } from "bun:test";
import { loadRegistry, type Registry } from "../../.github/scripts/fleet/repos_registry.ts";
import {
  NotManagedError,
  RecoveryNeededError,
  RehearsalError,
  type RehearsalOutcome,
} from "../../.github/scripts/sync/rehearse.ts";
import {
  enumerateFleet,
  type FleetRow,
  failureRow,
  outcomeRow,
  rehearseFleet,
  statusTally,
  summaryLine,
  summaryTable,
} from "../../.github/scripts/sync/rehearse_fleet.ts";

function outcome(overrides: Partial<RehearsalOutcome> = {}): RehearsalOutcome {
  return {
    changed: true,
    conflicts: [],
    malformed: [],
    retired: 0,
    manifest: "stamped",
    validationOk: true,
    workspace: null,
    ...overrides,
  };
}

function registryOf(text: string): Registry {
  const { registry, errors } = loadRegistry(text);
  if (registry === null) throw new Error(errors.join("; "));
  return registry;
}

describe("enumerateFleet", () => {
  const registry = registryOf(
    [
      "managed:",
      '  - "*"',
      "  - Other/extra",
      "exclude:",
      "  - Vivswan/paused",
      "defaults:",
      "  channel: staging",
    ].join("\n"),
  );

  test("unions the wildcard discovery with explicit entries and drops the exclude list", () => {
    const fleet = enumerateFleet(registry, [
      { repo: "Vivswan/app", private: false },
      { repo: "Vivswan/secret", private: true },
      { repo: "Vivswan/paused", private: false },
    ]);
    expect(fleet.slugs).toEqual(["Other/extra", "Vivswan/app", "Vivswan/secret"]);
    expect(fleet.excluded).toBe(1);
  });

  test("exclusion matches ignoring case, like GitHub repo identity", () => {
    const fleet = enumerateFleet(registry, [{ repo: "vivswan/PAUSED", private: false }]);
    expect(fleet.slugs).toEqual(["Other/extra"]);
  });

  test("visibility is keyed by lowercased slug and only covers the discovery slice", () => {
    const fleet = enumerateFleet(registry, [
      { repo: "Vivswan/app", private: false },
      { repo: "Vivswan/secret", private: true },
    ]);
    expect(fleet.visibility.get("vivswan/app")).toBe(false);
    expect(fleet.visibility.get("vivswan/secret")).toBe(true);
    expect(fleet.visibility.has("other/extra")).toBe(false);
  });

  test("a wildcard registry without a discovery listing throws instead of guessing", () => {
    expect(() => enumerateFleet(registry, null)).toThrow(/--discovered/);
  });
});

describe("rehearseFleet private skip", () => {
  test("private and visibility-unknown repos are skipped before the rehearsal function runs", () => {
    const rehearsed: string[] = [];
    const lines: string[] = [];
    const rows = rehearseFleet(["o/public", "o/secret", "o/unknown"], {
      isPrivate: (slug) => (slug === "o/public" ? false : slug === "o/secret" ? true : null),
      rehearse: (slug) => {
        rehearsed.push(slug);
        return outcome();
      },
      log: (line) => lines.push(line),
    });
    expect(rehearsed).toEqual(["o/public"]);
    expect(lines[1]).toBe("o/secret  skipped (private)");
    expect(rows[1]).toEqual({ repo: "o/secret", status: "skipped (private)", detail: "" });
    // Fail-closed: an unknown visibility skips too, printing the same bare
    // line; the reason surfaces only in the table row.
    expect(lines[2]).toBe("o/unknown  skipped (private)");
    expect(rows[2].status).toBe("skipped (private)");
    expect(rows[2].detail).toBe("visibility lookup failed; treated as private");
  });
});

describe("rehearseFleet failure handling", () => {
  test("a throwing rehearsal becomes a row and the loop continues", () => {
    const lines: string[] = [];
    const rows = rehearseFleet(["o/a", "o/b", "o/c"], {
      isPrivate: () => false,
      rehearse: (slug) => {
        if (slug === "o/a") {
          throw new RehearsalError("git clone failed (exit 128): repository not found\nnoise");
        }
        if (slug === "o/b") {
          throw new RecoveryNeededError("o/b's recorded _commit 'abc' does not resolve");
        }
        return outcome();
      },
      log: (line) => lines.push(line),
    });
    expect(rows.map((row) => row.status)).toEqual(["REHEARSAL FAILED", "recovery needed", "clean"]);
    // One-line reason: only the first line of a multi-line message.
    expect(rows[0].detail).toBe("git clone failed (exit 128): repository not found");
    expect(lines[0]).toBe(
      "o/a  REHEARSAL FAILED: git clone failed (exit 128): repository not found",
    );
  });

  test("a non-Error throw still becomes a failure row", () => {
    expect(failureRow("o/r", "boom")).toEqual({
      repo: "o/r",
      status: "REHEARSAL FAILED",
      detail: "boom",
    });
  });

  test("a not-adopted repo files as a skip, matching production's selector", () => {
    expect(failureRow("o/r", new NotManagedError("o/r is not managed by repo-platform"))).toEqual({
      repo: "o/r",
      status: "skipped (not adopted)",
      detail: "o/r is not managed by repo-platform",
    });
  });
});

describe("outcomeRow", () => {
  test("a clean, unchanged rehearsal", () => {
    expect(outcomeRow("o/r", outcome({ changed: false }))).toEqual({
      repo: "o/r",
      status: "clean",
      detail: "no changes; retired 0; manifest stamped ok; validation ok",
    });
  });

  test("conflicted files carry their dropped-hunk counts and malformed files their state", () => {
    const row = outcomeRow(
      "o/r",
      outcome({
        conflicts: [{ file: "README.md", hunks: 2 }],
        malformed: ["a.txt"],
        retired: 3,
        validationOk: false,
        manifest: "missing",
      }),
    );
    expect(row.status).toBe("2 conflict(s)");
    expect(row.detail).toBe(
      "README.md (2 hunk(s) dropped); a.txt (malformed markers, left unresolved); " +
        "retired 3; manifest missing; validation FAILED",
    );
  });
});

describe("summary formatting", () => {
  const rows: FleetRow[] = [
    { repo: "o/app", status: "clean", detail: "retired 0; manifest stamped ok; validation ok" },
    { repo: "o/secret", status: "skipped (private)", detail: "" },
    { repo: "o/broken", status: "REHEARSAL FAILED", detail: "git clone failed (exit 128)" },
  ];

  test("summaryLine shapes per status", () => {
    expect(summaryLine(rows[0])).toBe(
      "o/app  clean - retired 0; manifest stamped ok; validation ok",
    );
    expect(summaryLine(rows[1])).toBe("o/secret  skipped (private)");
    expect(summaryLine(rows[2])).toBe("o/broken  REHEARSAL FAILED: git clone failed (exit 128)");
  });

  test("a private skip prints the bare line even when the row carries a lookup-failure reason", () => {
    expect(
      summaryLine({
        repo: "o/x",
        status: "skipped (private)",
        detail: "visibility lookup failed; treated as private",
      }),
    ).toBe("o/x  skipped (private)");
  });

  test("statusTally buckets per-file conflict statuses together", () => {
    expect(
      statusTally([
        ...rows,
        { repo: "o/c1", status: "2 conflict(s)", detail: "" },
        { repo: "o/c2", status: "1 conflict(s)", detail: "" },
      ]),
    ).toBe("1 clean, 1 skipped (private), 1 REHEARSAL FAILED, 2 with conflicts");
  });

  test("summaryTable aligns the repo and status columns under a header", () => {
    expect(summaryTable(rows).split("\n")).toEqual([
      "repo     | status            | detail",
      "o/app    | clean             | retired 0; manifest stamped ok; validation ok",
      "o/secret | skipped (private) |",
      "o/broken | REHEARSAL FAILED  | git clone failed (exit 128)",
    ]);
  });
});

// Unit tests for the fleet rehearsal driver: repos.yml enumeration with
// exclude handling, the fail-closed private-skip decision (the rehearsal
// function must never run for a private or visibility-unknown repo), the
// failure-continues-loop contract, the summary formatting for every
// status shape, and the --gate severity model (what fails CI, what only
// warns). All dependencies are injected; nothing here touches the
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
  gateAnnotations,
  outcomeRow,
  phaseOf,
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
    validationErrors: [],
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
    ["managed:", '  - "*"', "  - Other/extra", "exclude:", "  - Vivswan/paused"].join("\n"),
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
    const probed: string[] = [];
    const lines: string[] = [];
    const rows = rehearseFleet(["o/public", "o/secret", "o/unknown"], {
      isPrivate: (slug) => (slug === "o/public" ? false : slug === "o/secret" ? true : null),
      enrollment: (slug) => {
        probed.push(slug);
        return "enrolled";
      },
      rehearse: (slug) => {
        rehearsed.push(slug);
        return outcome();
      },
      log: (line) => lines.push(line),
    });
    expect(rehearsed).toEqual(["o/public"]);
    // The enrollment probe carries the fleet token at a repo, so the
    // fail-closed private gate must precede it too.
    expect(probed).toEqual(["o/public"]);
    expect(lines[1]).toBe("o/secret  skipped (private)");
    expect(rows[1]).toEqual({
      repo: "o/secret",
      status: "skipped (private)",
      detail: "",
      severity: "ok",
    });
    // Fail-closed: an unknown visibility skips too, printing the same bare
    // line; the reason surfaces only in the table row - and it is an
    // ERROR under the gate, because a selected repo went unrehearsed.
    expect(lines[2]).toBe("o/unknown  skipped (private)");
    expect(rows[2].status).toBe("skipped (private)");
    expect(rows[2].detail).toBe("visibility lookup failed; treated as private, NOT rehearsed");
    expect(rows[2].severity).toBe("error");
  });

  test("a repo the fleet token is not enrolled in skips exactly like production", () => {
    const rehearsed: string[] = [];
    const rows = rehearseFleet(["o/unenrolled", "o/unknown-grant"], {
      isPrivate: () => false,
      enrollment: (slug) => (slug === "o/unenrolled" ? "not-enrolled" : "unknown"),
      rehearse: (slug) => {
        rehearsed.push(slug);
        return outcome();
      },
      log: () => {},
    });
    expect(rows[0]).toEqual({
      repo: "o/unenrolled",
      status: "skipped (not enrolled)",
      detail: "the fleet token has no write grant here; production never syncs it",
      severity: "ok",
    });
    // An unanswerable probe proceeds: the rehearsal itself speaks.
    expect(rehearsed).toEqual(["o/unknown-grant"]);
  });
});

describe("rehearseFleet failure handling", () => {
  test("a throwing rehearsal becomes a row and the loop continues", () => {
    const lines: string[] = [];
    const rows = rehearseFleet(["o/a", "o/b", "o/c"], {
      isPrivate: () => false,
      enrollment: () => "enrolled",
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
      severity: "error",
    });
  });

  test("a known leg script's failure names its pipeline phase", () => {
    const row = failureRow(
      "o/r",
      new RehearsalError("resolve_copier_conflicts.ts failed (exit 1): boom"),
    );
    expect(row.detail).toBe("[phase resolve] resolve_copier_conflicts.ts failed (exit 1): boom");
    expect(row.severity).toBe("error");
  });

  test("a not-adopted repo files as a skip, matching production's selector", () => {
    expect(failureRow("o/r", new NotManagedError("o/r is not managed by repo-platform"))).toEqual({
      repo: "o/r",
      status: "skipped (not adopted)",
      detail: "o/r is not managed by repo-platform",
      severity: "ok",
    });
  });
});

describe("phaseOf", () => {
  test("maps every leg script of the sync pipeline", () => {
    expect(phaseOf("branch_tree.ts failed (exit 1)")).toBe("compose");
    expect(phaseOf("apply_update.ts failed (exit 1): copier exploded")).toBe("render");
    expect(phaseOf("clean_renders.ts failed (exit 1)")).toBe("render");
    expect(phaseOf("preserve_local_content.ts failed (exit 1)")).toBe("splice");
    expect(phaseOf("preserve_repo_owned.ts failed (exit 1)")).toBe("splice");
    expect(phaseOf("resolve_copier_conflicts.ts failed (exit 1)")).toBe("resolve");
    expect(phaseOf("retired_cleanup.ts failed (exit 1)")).toBe("retire");
    expect(phaseOf("stamp_manifest.ts failed (exit 1)")).toBe("stamp");
  });

  test("non-script failures stay unlabeled - clone and fetch reasons already read clearly", () => {
    expect(phaseOf("git clone failed (exit 128): repository not found")).toBeNull();
    expect(phaseOf("some_unknown_thing.ts failed (exit 1)")).toBeNull();
    expect(phaseOf("")).toBeNull();
  });
});

describe("outcomeRow", () => {
  test("a clean, unchanged rehearsal", () => {
    expect(outcomeRow("o/r", outcome({ changed: false }))).toEqual({
      repo: "o/r",
      status: "clean",
      detail: "no changes; retired 0; manifest stamped ok; validation ok",
      severity: "ok",
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
        "retired 3; manifest missing; [phase validate] validation FAILED",
    );
    expect(row.severity).toBe("error");
  });

  test("a failed validation names the failing files' diagnostics", () => {
    const row = outcomeRow(
      "o/r",
      outcome({
        validationOk: false,
        validationErrors: [".github/workflows/ci.yml: gate drift", "... and 2 more"],
      }),
    );
    expect(row.detail).toBe(
      "retired 0; manifest stamped ok; [phase validate] validation FAILED: " +
        ".github/workflows/ci.yml: gate drift | ... and 2 more",
    );
    expect(row.severity).toBe("error");
  });

  test("auto-resolved conflicts alone stay ok severity - production ships them for PR review", () => {
    const row = outcomeRow("o/r", outcome({ conflicts: [{ file: "README.md", hunks: 1 }] }));
    expect(row.status).toBe("1 conflict(s)");
    expect(row.severity).toBe("ok");
  });
});

describe("gateAnnotations", () => {
  test("error rows fail the gate, recovery warnings only annotate, everything else is silent", () => {
    const rows: FleetRow[] = [
      { repo: "o/clean", status: "clean", detail: "validation ok", severity: "ok" },
      { repo: "o/hidden", status: "skipped (private)", detail: "", severity: "ok" },
      {
        repo: "o/stale",
        status: "recovery needed",
        detail: "o/stale's recorded _commit 'abc' does not resolve",
        severity: "warning",
      },
      {
        repo: "o/broken",
        status: "REHEARSAL FAILED",
        detail: "[phase render] apply_update.ts failed (exit 1): copier exploded",
        severity: "error",
      },
    ];
    expect(gateAnnotations(rows)).toEqual({
      errors: [
        "o/broken: REHEARSAL FAILED - [phase render] apply_update.ts failed (exit 1): copier exploded",
      ],
      warnings: ["o/stale: recovery needed - o/stale's recorded _commit 'abc' does not resolve"],
    });
  });
});

describe("summary formatting", () => {
  const rows: FleetRow[] = [
    {
      repo: "o/app",
      status: "clean",
      detail: "retired 0; manifest stamped ok; validation ok",
      severity: "ok",
    },
    { repo: "o/secret", status: "skipped (private)", detail: "", severity: "ok" },
    {
      repo: "o/broken",
      status: "REHEARSAL FAILED",
      detail: "git clone failed (exit 128)",
      severity: "error",
    },
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
        severity: "ok",
      }),
    ).toBe("o/x  skipped (private)");
  });

  test("statusTally buckets per-file conflict statuses together", () => {
    expect(
      statusTally([
        ...rows,
        { repo: "o/c1", status: "2 conflict(s)", detail: "", severity: "ok" },
        { repo: "o/c2", status: "1 conflict(s)", detail: "", severity: "ok" },
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

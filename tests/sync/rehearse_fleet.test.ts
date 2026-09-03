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
  laneOutcome,
  outcomeRow,
  phaseOf,
  privateDisplayNames,
  rehearseFleet,
  runPool,
  statusTally,
  summaryLine,
  summaryTable,
} from "../../.github/scripts/sync/rehearse_fleet.ts";
import { SHRANK_PHRASE } from "../../.github/scripts/sync/tail_tripwire.ts";

function outcome(overrides: Partial<RehearsalOutcome> = {}): RehearsalOutcome {
  return {
    changed: true,
    conflicts: [],
    malformed: [],
    retired: 0,
    manifest: "stamped",
    validationOk: true,
    validationErrors: [],
    tripwireReport: "",
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
    // Visibility is keyed by lowercased slug and covers the discovery
    // slice only: the explicit Other/extra entry has no key.
    expect(fleet).toEqual({
      slugs: ["Other/extra", "Vivswan/app", "Vivswan/secret"],
      visibility: new Map([
        ["vivswan/app", false],
        ["vivswan/secret", true],
        ["vivswan/paused", false],
      ]),
      excluded: 1,
    });
  });

  test("exclusion matches ignoring case, like GitHub repo identity", () => {
    expect(enumerateFleet(registry, [{ repo: "vivswan/PAUSED", private: false }])).toEqual({
      slugs: ["Other/extra"],
      visibility: new Map([["vivswan/paused", false]]),
      excluded: 1,
    });
  });

  test("a wildcard registry without a discovery listing throws instead of guessing", () => {
    expect(() => enumerateFleet(registry, null)).toThrow(/--discovered/);
  });
});

describe("privateDisplayNames", () => {
  // This repo's Actions logs are public: a wildcard-discovered private
  // slug must never print raw under --gate, on ANY output path.
  const discovered = [
    { repo: "Vivswan/hidden-server", private: true },
    { repo: "Vivswan/committed-private", private: true },
    { repo: "Vivswan/app", private: false },
  ];
  const committed = new Set(["vivswan/committed-private"]);

  test("gate mode hints a wildcard-discovered private slug on every output path", async () => {
    const display = privateDisplayNames(true, discovered, committed);
    const deps = {
      display,
      enrollment: () => "enrolled" as const,
      rehearse: async () => outcome(),
      concurrency: 2,
      log: () => {},
    };
    const rows = await rehearseFleet(["Vivswan/hidden-server"], { ...deps, isPrivate: () => true });
    expect(rows[0].repo).toBe("h**-s**r");
    expect(summaryLine(rows[0])).toBe("h**-s**r  skipped (private)");
    expect(summaryTable(rows)).not.toContain("hidden-server");
    // The lookup-failure shape is error severity, so it reaches the gate
    // annotations - the hint must hold there too.
    const failed = await rehearseFleet(["Vivswan/hidden-server"], {
      ...deps,
      isPrivate: () => null,
    });
    const annotations = gateAnnotations(failed);
    expect(annotations.errors[0]).toContain("h**-s**r");
    expect(JSON.stringify(annotations)).not.toContain("hidden-server");
  });

  test.each([
    {
      reason: "a wildcard-discovered private slug is hinted under the gate",
      gate: true,
      slug: "Vivswan/hidden-server",
      expected: "h**-s**r",
    },
    {
      reason: "a committed registry entry keeps its raw name (hinting a public name is theater)",
      gate: true,
      slug: "Vivswan/committed-private",
      expected: "Vivswan/committed-private",
    },
    {
      reason: "the local CLI (no --gate) prints raw slugs to the operator's terminal",
      gate: false,
      slug: "Vivswan/hidden-server",
      expected: "Vivswan/hidden-server",
    },
    {
      reason: "a public repo prints raw even in gate mode - its name is public",
      gate: true,
      slug: "Vivswan/app",
      expected: "Vivswan/app",
    },
  ])("$reason", ({ gate, slug, expected }) => {
    expect(privateDisplayNames(gate, discovered, committed)(slug)).toBe(expected);
  });
});

describe("rehearseFleet private skip", () => {
  test("private and visibility-unknown repos are skipped before the rehearsal function runs", async () => {
    const rehearsed: string[] = [];
    const probed: string[] = [];
    const lines: string[] = [];
    const rows = await rehearseFleet(["o/public", "o/secret", "o/unknown"], {
      isPrivate: (slug) => (slug === "o/public" ? false : slug === "o/secret" ? true : null),
      display: (slug) => slug,
      enrollment: (slug) => {
        probed.push(slug);
        return "enrolled";
      },
      rehearse: async (slug) => {
        rehearsed.push(slug);
        return outcome();
      },
      concurrency: 1,
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

  test("a repo the fleet token is not enrolled in skips exactly like production", async () => {
    const rehearsed: string[] = [];
    const rows = await rehearseFleet(["o/unenrolled", "o/unknown-grant"], {
      isPrivate: () => false,
      display: (slug) => slug,
      enrollment: (slug) => (slug === "o/unenrolled" ? "not-enrolled" : "unknown"),
      rehearse: async (slug) => {
        rehearsed.push(slug);
        return outcome();
      },
      concurrency: 2,
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

describe("laneOutcome", () => {
  test("an outcome envelope returns the outcome", () => {
    const envelope = JSON.stringify({ kind: "outcome", outcome: outcome() });
    expect(laneOutcome(envelope, "o/r")).toEqual(outcome());
  });

  test("a malformed envelope THROWS (the lane's failure row), never exits the run", () => {
    // The original bug: parseJsonWith exits the whole process here, so one
    // truncated lane verdict aborted every remaining lane and the summary.
    expect(() => laneOutcome("not json {", "o/r")).toThrow("not valid JSON");
    expect(() => laneOutcome('{"kind": "nonsense"}', "o/r")).toThrow("unexpected shape");
  });

  test("typed skips re-throw their typed errors, keeping failureRow's one mapping", () => {
    expect(() => laneOutcome(JSON.stringify({ kind: "not-managed", reason: "r" }), "o/r")).toThrow(
      NotManagedError,
    );
    expect(() =>
      laneOutcome(JSON.stringify({ kind: "recovery-needed", reason: "r" }), "o/r"),
    ).toThrow(RecoveryNeededError);
    expect(() => laneOutcome(JSON.stringify({ kind: "failed", reason: "boom" }), "o/r")).toThrow(
      "boom",
    );
  });
});

describe("rehearseFleet failure handling", () => {
  test("a throwing rehearsal becomes a row and the loop continues", async () => {
    const lines: string[] = [];
    const rows = await rehearseFleet(["o/a", "o/b", "o/c"], {
      isPrivate: () => false,
      display: (slug) => slug,
      enrollment: () => "enrolled",
      rehearse: async (slug) => {
        if (slug === "o/a") {
          throw new RehearsalError("git clone failed (exit 128): repository not found\nnoise");
        }
        if (slug === "o/b") {
          throw new RecoveryNeededError("o/b's recorded _commit 'abc' does not resolve");
        }
        return outcome();
      },
      concurrency: 3,
      log: (line) => lines.push(line),
    });
    expect(rows.map((row) => row.status)).toEqual(["REHEARSAL FAILED", "recovery needed", "clean"]);
    // One-line reason: only the first line of a multi-line message.
    expect(rows[0].detail).toBe("git clone failed (exit 128): repository not found");
    expect(lines[0]).toBe(
      "o/a  REHEARSAL FAILED: git clone failed (exit 128): repository not found",
    );
  });

  test("a throwing visibility lookup becomes a lane-local failed row, siblings survive", async () => {
    // The isolation the loop promises must cover EVERY per-repo dep, not
    // just rehearse: a throw from isPrivate (or the enrollment probe's
    // curl) used to escape the worker, reject runPool's Promise.all, and
    // destroy the whole report. Now it is this lane's failed row, and the
    // report continues. isPrivate threw before visibility was known, so
    // the row carries the display name (redacted for a hidden repo),
    // never the raw slug.
    const rows = await rehearseFleet(["o/a", "o/b"], {
      isPrivate: (slug) => {
        if (slug === "o/a") throw new Error("visibility probe curl not found");
        return false;
      },
      display: (slug) => (slug === "o/a" ? "h**-s**t" : slug),
      enrollment: () => "enrolled",
      rehearse: async () => outcome(),
      concurrency: 2,
      log: () => {},
    });
    expect(rows).toEqual([
      {
        repo: "h**-s**t",
        status: "REHEARSAL FAILED",
        detail: "visibility probe curl not found",
        severity: "error",
      },
      {
        repo: "o/b",
        status: "clean",
        detail: "retired 0; manifest stamped ok; validation ok",
        severity: "ok",
      },
    ]);
  });

  test("a throwing enrollment probe becomes a lane-local failed row, not an abort", async () => {
    const rows = await rehearseFleet(["o/a", "o/b"], {
      isPrivate: () => false,
      display: (slug) => slug,
      enrollment: (slug) => {
        if (slug === "o/b") throw new Error("gh auth token subprocess failed");
        return "enrolled";
      },
      rehearse: async () => outcome(),
      concurrency: 2,
      log: () => {},
    });
    expect(rows).toEqual([
      {
        repo: "o/a",
        status: "clean",
        detail: "retired 0; manifest stamped ok; validation ok",
        severity: "ok",
      },
      {
        repo: "o/b",
        status: "REHEARSAL FAILED",
        detail: "gh auth token subprocess failed",
        severity: "error",
      },
    ]);
  });
});

describe("failureRow", () => {
  test.each([
    {
      reason: "a non-Error throw still becomes a failure row",
      err: "boom",
      expected: { repo: "o/r", status: "REHEARSAL FAILED", detail: "boom", severity: "error" },
    },
    {
      reason: "a known leg script's failure names its pipeline phase",
      err: new RehearsalError("resolve_copier_conflicts.ts failed (exit 1): boom"),
      expected: {
        repo: "o/r",
        status: "REHEARSAL FAILED",
        detail: "[phase resolve] resolve_copier_conflicts.ts failed (exit 1): boom",
        severity: "error",
      },
    },
    {
      reason: "a not-adopted repo files as a skip, matching production's selector",
      err: new NotManagedError("o/r is not managed by repo-platform"),
      expected: {
        repo: "o/r",
        status: "skipped (not adopted)",
        detail: "o/r is not managed by repo-platform",
        severity: "ok",
      },
    },
    {
      reason: "an unresolvable recorded _commit is a warning-severity recovery row",
      err: new RecoveryNeededError("o/r's recorded _commit 'abc' does not resolve"),
      expected: {
        repo: "o/r",
        status: "recovery needed",
        detail: "o/r's recorded _commit 'abc' does not resolve",
        severity: "warning",
      },
    },
  ])("$reason", ({ err, expected }) => {
    expect(failureRow("o/r", err)).toEqual(expected);
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
    expect(phaseOf("tail_tripwire.ts failed (exit 1)")).toBe("tripwire");
  });

  test("non-script failures stay unlabeled - clone and fetch reasons already read clearly", () => {
    expect(phaseOf("git clone failed (exit 128): repository not found")).toBeNull();
    expect(phaseOf("some_unknown_thing.ts failed (exit 1)")).toBeNull();
    expect(phaseOf("")).toBeNull();
  });
});

describe("rehearseFleet concurrency", () => {
  test("in-flight rehearsals never exceed the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const slugs = Array.from({ length: 9 }, (_, i) => `o/repo-${i}`);
    await rehearseFleet(slugs, {
      isPrivate: () => false,
      display: (slug) => slug,
      enrollment: () => "enrolled",
      rehearse: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(5);
        inFlight--;
        return outcome();
      },
      concurrency: 3,
      log: () => {},
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("rows and summary lines stay in roster order however the lanes finish", async () => {
    // Later roster entries finish FIRST (reversed delays): the rows array
    // and the logged lines must still follow the roster.
    const slugs = ["o/a", "o/b", "o/c", "o/d"];
    const lines: string[] = [];
    const rows = await rehearseFleet(slugs, {
      isPrivate: () => false,
      display: (slug) => slug,
      enrollment: () => "enrolled",
      rehearse: async (slug) => {
        await Bun.sleep((3 - slugs.indexOf(slug)) * 10);
        return outcome({ retired: slugs.indexOf(slug) });
      },
      concurrency: 4,
      log: (line) => lines.push(line),
    });
    expect(rows.map((row) => row.repo)).toEqual(slugs);
    expect(rows.map((row) => row.detail)).toEqual([
      "retired 0; manifest stamped ok; validation ok",
      "retired 1; manifest stamped ok; validation ok",
      "retired 2; manifest stamped ok; validation ok",
      "retired 3; manifest stamped ok; validation ok",
    ]);
    expect(lines.map((line) => line.split("  ")[0])).toEqual(slugs);
  });

  test("one repo's rejection never suppresses another's row", async () => {
    const rows = await rehearseFleet(["o/fails", "o/works"], {
      isPrivate: () => false,
      display: (slug) => slug,
      enrollment: () => "enrolled",
      rehearse: async (slug) => {
        if (slug === "o/fails") throw new RehearsalError("apply_update.ts failed (exit 1)");
        await Bun.sleep(5);
        return outcome();
      },
      concurrency: 2,
      log: () => {},
    });
    expect(rows).toEqual([
      {
        repo: "o/fails",
        status: "REHEARSAL FAILED",
        detail: "[phase render] apply_update.ts failed (exit 1)",
        severity: "error",
      },
      {
        repo: "o/works",
        status: "clean",
        detail: "retired 0; manifest stamped ok; validation ok",
        severity: "ok",
      },
    ]);
  });
});

describe("runPool", () => {
  test("results land by item index, not completion order", async () => {
    const results = await runPool([30, 10, 20], 3, async (delay, index) => {
      await Bun.sleep(delay);
      return index * 10;
    });
    expect(results).toEqual([0, 10, 20]);
  });

  test("a zero-or-negative limit still runs one lane", async () => {
    const results = await runPool([1, 2], 0, async (item) => item * 2);
    expect(results).toEqual([2, 4]);
  });
});

describe("outcomeRow", () => {
  test.each<{ reason: string; overrides: Partial<RehearsalOutcome>; expected: FleetRow }>([
    {
      reason: "a clean, unchanged rehearsal",
      overrides: { changed: false },
      expected: {
        repo: "o/r",
        status: "clean",
        detail: "no changes; retired 0; manifest stamped ok; validation ok",
        severity: "ok",
      },
    },
    {
      reason: "a tripped tail tripwire is an error row (the script exits 0 by design)",
      overrides: { tripwireReport: `> [!WARNING]\n- \`AGENTS.md\`: 1 ${SHRANK_PHRASE}\n` },
      expected: {
        repo: "o/r",
        status: "TRIPPED",
        detail:
          "retired 0; manifest stamped ok; [phase tripwire] tail tripwire TRIPPED " +
          "(repository-owned lines would be lost); validation ok",
        severity: "error",
      },
    },
    {
      // Unverifiable findings prove nothing was lost - the row must say
      // integrity is unproven, not that lines vanished. Severity stays
      // error either way (manual attention).
      reason: "an unverifiable-only report never asserts confirmed loss",
      overrides: {
        tripwireReport:
          "> [!WARNING]\n- `AGENTS.md`: the previous commit has no usable ownership manifest - review this file's full diff against the previous commit before merging.\n",
      },
      expected: {
        repo: "o/r",
        status: "TRIPPED",
        detail:
          "retired 0; manifest stamped ok; [phase tripwire] tail tripwire TRIPPED " +
          "(integrity unproven - manifest unusable; nothing proven lost); validation ok",
        severity: "error",
      },
    },
    {
      reason: "conflicted files carry their dropped-hunk counts and malformed files their state",
      overrides: {
        conflicts: [{ file: "README.md", hunks: 2 }],
        malformed: ["a.txt"],
        retired: 3,
        validationOk: false,
        manifest: "missing",
      },
      expected: {
        repo: "o/r",
        status: "2 conflict(s)",
        detail:
          "README.md (2 hunk(s) dropped); a.txt (malformed markers, left unresolved); " +
          "retired 3; manifest missing; [phase validate] validation FAILED",
        severity: "error",
      },
    },
    {
      reason: "a failed validation names the failing files' diagnostics",
      overrides: {
        validationOk: false,
        validationErrors: [".github/workflows/ci.yml: gate drift", "... and 2 more"],
      },
      expected: {
        repo: "o/r",
        status: "clean",
        detail:
          "retired 0; manifest stamped ok; [phase validate] validation FAILED: " +
          ".github/workflows/ci.yml: gate drift | ... and 2 more",
        severity: "error",
      },
    },
    {
      reason:
        "auto-resolved conflicts alone stay ok severity - production ships them for PR review",
      overrides: { conflicts: [{ file: "README.md", hunks: 1 }] },
      expected: {
        repo: "o/r",
        status: "1 conflict(s)",
        detail: "README.md (1 hunk(s) dropped); retired 0; manifest stamped ok; validation ok",
        severity: "ok",
      },
    },
  ])("$reason", ({ overrides, expected }) => {
    expect(outcomeRow("o/r", outcome(overrides))).toEqual(expected);
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

  test.each<{ reason: string; row: FleetRow; expected: string }>([
    {
      reason: "a clean row carries its detail after a dash",
      row: rows[0],
      expected: "o/app  clean - retired 0; manifest stamped ok; validation ok",
    },
    {
      reason: "a private skip is the bare required line",
      row: rows[1],
      expected: "o/secret  skipped (private)",
    },
    {
      reason: "a failure carries its reason after a colon",
      row: rows[2],
      expected: "o/broken  REHEARSAL FAILED: git clone failed (exit 128)",
    },
    {
      reason:
        "a private skip prints the bare line even when the row carries a lookup-failure reason",
      row: {
        repo: "o/x",
        status: "skipped (private)",
        detail: "visibility lookup failed; treated as private",
        severity: "ok",
      },
      expected: "o/x  skipped (private)",
    },
  ])("summaryLine: $reason", ({ row, expected }) => {
    expect(summaryLine(row)).toBe(expected);
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

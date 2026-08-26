#!/usr/bin/env bun
// Fleet-wide sync rehearsal: a read-only dry run of the template sync
// across every managed repo. Enumerates the fleet from repos.yml (the
// exclude list is respected; the "*" wildcard uses the same owner-scoped
// discovery the sync's plan job runs), then rehearses each PUBLIC repo
// the fleet token is enrolled in (production's push-probe skip is
// mirrored, so a repo the sync would never touch cannot red the gate)
// with rehearse.ts's core - quiet, workspace removed after each repo.
//
// PRIVATE REPOS ARE NEVER TOUCHED: visibility is established BEFORE any
// git command aims at the repo (the discovery listing carries it; explicit
// managed entries outside that slice get one gh api read), and anything
// but a definitive `private: false` - including a failed lookup - counts
// as private (fail-closed, the same rule discovery.ts pins). A private
// repo prints "<repo>  skipped (private)" and is neither cloned nor
// fetched. Public repos inherit rehearse.ts's read-only guarantees: the
// clone's origin URLs go unroutable before any leg runs, and nothing
// opens PRs or writes to any remote.
//
// One summary line prints per repo as it completes, then a final
// repo | status | detail table. Repos that have not adopted the template
// report as "skipped (not adopted)" (production's selector skips them the
// same way); an unresolvable recorded _commit reports as "recovery
// needed". A repo whose rehearsal throws otherwise prints
// "REHEARSAL FAILED: <reason>" - the reason names the failing pipeline
// phase when a known leg script threw - and the loop CONTINUES; per-repo
// failure is information, never an abort. EXIT CODE: 0 whenever the loop
// completed, regardless of per-repo outcomes - this is a report, not a
// gate; nonzero is reserved for enumeration failures (no trustworthy
// fleet list means nothing ran).
//
// --gate (CI's rehearse-fleet job) turns the report into a gate: every
// error-severity row (a failed rehearsal, a tree that failed validation)
// becomes an ::error:: annotation naming the repo, the phase, and the
// files, and the run exits 1. Recovery-needed rows only ::warning:: -
// they are fleet-repo state an operator heals with recover=recopy, not
// something a repo-platform PR causes or can fix, so they must not hold
// unrelated merges hostage.
//
// Usage:
//   bun .github/scripts/sync/rehearse_fleet.ts [--gate]

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { pushProbeStatus } from "../fleet/push_probe.ts";
import { assignHints } from "../fleet/redact.ts";
import { loadRegistry, type Registry, selectRepos } from "../fleet/repos_registry.ts";
import { error, warning } from "../shared/gha.ts";
import { parseJsonWith } from "../shared/json.ts";
import { capture } from "../shared/proc.ts";
import {
  NETWORK_TIMEOUT_MS,
  NotManagedError,
  RecoveryNeededError,
  type RehearsalOutcome,
  rehearseRepo,
} from "./rehearse.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** How a row counts under --gate: "error" fails the gate, "warning"
 * annotates without failing, "ok" is silent (clean rows, both skip
 * shapes, and auto-resolved conflicts - production delivers those through
 * a reviewable PR, so they are report material, not a regression). */
export type RowSeverity = "ok" | "warning" | "error";

export interface FleetRow {
  repo: string;
  status: string;
  detail: string;
  severity: RowSeverity;
}

export interface FleetEnumeration {
  /** Selected slugs, sorted (wildcard x discovered, union explicit
   * managed entries, minus exclude - selectRepos's contract). */
  slugs: string[];
  /** Lowercased slug -> private flag, from the discovery listing. */
  visibility: Map<string, boolean>;
  /** repos.yml exclude entries (already removed from slugs). */
  excluded: number;
}

/** Resolve repos.yml against the discovery listing (null when managed has
 * no wildcard and none is needed). Throws on an invalid registry or
 * selection: without a trustworthy fleet list nothing may run. */
export function enumerateFleet(
  registry: Registry,
  discovered: { repo: string; private: boolean }[] | null,
): FleetEnumeration {
  const { selection, errors } = selectRepos(registry, {
    discovered: discovered === null ? null : discovered.map((row) => row.repo),
  });
  if (errors.length > 0) throw new Error(errors.join("; "));
  return {
    slugs: selection.map((row) => row.repo),
    visibility: new Map((discovered ?? []).map((row) => [row.repo.toLowerCase(), row.private])),
    excluded: registry.exclude.length,
  };
}

const PRIVATE_SKIP = "skipped (private)";

/** Display names for the report's private rows. This repo's Actions logs
 * are PUBLIC, so under --gate a wildcard-DISCOVERED private slug renders
 * as its redact.ts hint - the same partial pseudonymization the sync's
 * own logs use. Two deliberate exemptions, from redact.ts's design: a
 * name committed in repos.yml (managed/exclude entries) is public by
 * definition, so hinting it would be theater; and the local CLI (no
 * --gate) prints raw to the operator's own terminal. Public repos always
 * print raw - their names are public. */
export function privateDisplayNames(
  gate: boolean,
  discovered: { repo: string; private: boolean }[] | null,
  committed: Set<string>,
): (slug: string) => string {
  if (!gate || discovered === null) return (slug) => slug;
  const hidden = discovered
    .filter((row) => row.private && !committed.has(row.repo.toLowerCase()))
    .map((row) => row.repo);
  const hints = new Map([...assignHints(hidden)].map(([slug, hint]) => [slug.toLowerCase(), hint]));
  return (slug) => hints.get(slug.toLowerCase()) ?? slug;
}

// Pipeline phase per leg script, so a failure reason names WHERE the sync
// broke without a live run. Keyed on the script basename rehearse.ts's
// failure messages lead with; both the current rehearsal legs and the
// production workflow's leg names are listed so the map survives the two
// converging.
const PHASE_BY_SCRIPT = new Map<string, string>([
  ["branch_tree.ts", "compose"],
  ["modules.ts", "select"],
  ["apply_update.ts", "render"],
  ["clean_renders.ts", "render"],
  ["preserve_local_content.ts", "splice"],
  ["preserve_repo_owned.ts", "splice"],
  ["resolve_copier_conflicts.ts", "resolve"],
  ["retired_cleanup.ts", "retire"],
  ["stamp_manifest.ts", "stamp"],
  ["tail_tripwire.ts", "tripwire"],
  ["manifest_license_check.ts", "stamp"],
  ["validate_generated_files.ts", "validate"],
]);

/** The pipeline phase a one-line failure reason names, or null when the
 * failing command is not a known leg script (clone and fetch failures
 * already read clearly). */
export function phaseOf(reason: string): string | null {
  const script = /^(\S+\.ts) /.exec(reason);
  if (script === null) return null;
  return PHASE_BY_SCRIPT.get(script[1]) ?? null;
}

/** The row for a completed rehearsal: conflict-affected files (dropped-
 * hunk counts included) drive the status; retired count, manifest stamp
 * state, and the validation verdict - with the failing files' diagnostics
 * when it failed - ride in the detail. */
export function outcomeRow(slug: string, outcome: RehearsalOutcome): FleetRow {
  const parts: string[] = [];
  if (!outcome.changed) parts.push("no changes");
  for (const { file, hunks } of outcome.conflicts) parts.push(`${file} (${hunks} hunk(s) dropped)`);
  for (const file of outcome.malformed) parts.push(`${file} (malformed markers, left unresolved)`);
  parts.push(`retired ${outcome.retired}`);
  parts.push(`manifest ${outcome.manifest === "stamped" ? "stamped ok" : outcome.manifest}`);
  // The tripwire exits 0 on findings by design (warn-only in the sync,
  // where the PR body carries the report); here a non-empty report IS a
  // regression a repo-platform PR is about to cause - error severity.
  const tripped = outcome.tripwireReport !== "";
  if (tripped) {
    parts.push("[phase tripwire] tail tripwire TRIPPED (repository-owned lines would be lost)");
  }
  if (outcome.validationOk) {
    parts.push("validation ok");
  } else {
    const diagnostics = outcome.validationErrors.join(" | ");
    parts.push(`[phase validate] validation FAILED${diagnostics === "" ? "" : `: ${diagnostics}`}`);
  }
  const affected = outcome.conflicts.length + outcome.malformed.length;
  return {
    repo: slug,
    status: tripped ? "TRIPPED" : affected === 0 ? "clean" : `${affected} conflict(s)`,
    detail: parts.join("; "),
    severity: outcome.validationOk && !tripped ? "ok" : "error",
  };
}

/** The row for a rehearsal that threw: non-adoption and the unresolvable
 * recorded _commit get their own statuses, everything else is a one-line
 * failure naming the pipeline phase when a known leg script threw. */
export function failureRow(slug: string, err: unknown): FleetRow {
  const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0];
  if (err instanceof NotManagedError) {
    return { repo: slug, status: "skipped (not adopted)", detail: reason, severity: "ok" };
  }
  if (err instanceof RecoveryNeededError) {
    return { repo: slug, status: "recovery needed", detail: reason, severity: "warning" };
  }
  const phase = phaseOf(reason);
  return {
    repo: slug,
    status: "REHEARSAL FAILED",
    detail: phase === null ? reason : `[phase ${phase}] ${reason}`,
    severity: "error",
  };
}

export function summaryLine(row: FleetRow): string {
  // The private skip prints the bare required line; a lookup-failure
  // reason stays in the table.
  if (row.status === PRIVATE_SKIP) return `${row.repo}  ${PRIVATE_SKIP}`;
  if (row.status === "REHEARSAL FAILED") return `${row.repo}  REHEARSAL FAILED: ${row.detail}`;
  return `${row.repo}  ${row.status}${row.detail === "" ? "" : ` - ${row.detail}`}`;
}

export function summaryTable(rows: FleetRow[]): string {
  const all: { repo: string; status: string; detail: string }[] = [
    { repo: "repo", status: "status", detail: "detail" },
    ...rows,
  ];
  const repoWidth = Math.max(...all.map((row) => row.repo.length));
  const statusWidth = Math.max(...all.map((row) => row.status.length));
  return all
    .map((row) =>
      `${row.repo.padEnd(repoWidth)} | ${row.status.padEnd(statusWidth)} | ${row.detail}`.trimEnd(),
    )
    .join("\n");
}

/** Per-status counts for the closing line, per-file conflict statuses
 * collapsed into one "conflicts" bucket. */
export function statusTally(rows: FleetRow[]): string {
  const tally = new Map<string, number>();
  for (const row of rows) {
    const key = row.status.endsWith("conflict(s)") ? "with conflicts" : row.status;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally].map(([status, count]) => `${count} ${status}`).join(", ");
}

export interface FleetDeps {
  /** false = definitively public; true = private; null = lookup failed
   * (treated as private, fail-closed - and as an error under --gate: a
   * selected repo went unrehearsed for an unknown reason). */
  isPrivate: (slug: string) => boolean | null;
  /** The display name a PRIVATE row prints (privateDisplayNames above);
   * public rows always print the raw slug - their names are public. */
  display: (slug: string) => string;
  /** Production's enrollment signal (the fleet token's actual write
   * grant, select_sync_repos.ts's push probe): "not-enrolled" repos are
   * skipped like production skips them, "unknown" (no token, transport
   * failure) proceeds and lets the rehearsal itself speak. */
  enrollment: (slug: string) => "enrolled" | "not-enrolled" | "unknown";
  rehearse: (slug: string) => RehearsalOutcome;
  log: (line: string) => void;
}

/** The report loop. The private check gates EVERY repo before the
 * enrollment probe and deps.rehearse (the only code path that clones)
 * can run, and a throwing rehearsal becomes a row, never an abort.
 * Private rows carry deps.display's name, so every output path
 * (summary lines, the table, gate annotations) inherits the redaction. */
export function rehearseFleet(slugs: string[], deps: FleetDeps): FleetRow[] {
  const rows: FleetRow[] = [];
  for (const slug of slugs) {
    const isPrivate = deps.isPrivate(slug);
    let row: FleetRow;
    if (isPrivate !== false) {
      row = {
        repo: deps.display(slug),
        status: PRIVATE_SKIP,
        detail:
          isPrivate === null ? "visibility lookup failed; treated as private, NOT rehearsed" : "",
        severity: isPrivate === null ? "error" : "ok",
      };
    } else if (deps.enrollment(slug) === "not-enrolled") {
      row = {
        repo: slug,
        status: "skipped (not enrolled)",
        detail: "the fleet token has no write grant here; production never syncs it",
        severity: "ok",
      };
    } else {
      try {
        row = outcomeRow(slug, deps.rehearse(slug));
      } catch (err) {
        row = failureRow(slug, err);
      }
    }
    rows.push(row);
    deps.log(summaryLine(row));
  }
  return rows;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

// Production's own discovery step, run as a subprocess so the fleet
// listing gets the same hard deadline as every other network call:
// discover_repos.ts resolves the owner scope itself (the authenticated gh
// user) and writes RUNNER_TEMP/discovered.json {repo, private} rows.
const discoveredRows = z.array(z.object({ repo: z.string(), private: z.boolean() }));

function discoverFleet(): { repo: string; private: boolean }[] {
  const temp = mkdtempSync(join(tmpdir(), "rehearse-fleet-discovery-"));
  const discovery = capture(["bun", ".github/scripts/fleet/discover_repos.ts"], {
    cwd: REPO_ROOT,
    env: { RUNNER_TEMP: temp },
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  // The temp dir is removed BEFORE any failure path: fail() and
  // parseJsonWith exit the process outright, which would skip a finally.
  let listing: string | null = null;
  try {
    if (discovery.exitCode === 0) listing = readFileSync(join(temp, "discovered.json"), "utf-8");
  } catch {
    listing = null;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  if (listing === null) {
    process.stderr.write(discovery.stderr);
    fail(
      discovery.timedOut === true
        ? `fleet discovery timed out after ${NETWORK_TIMEOUT_MS}ms (stalled network?)`
        : "fleet discovery failed (is gh authenticated?)",
    );
  }
  return parseJsonWith(discoveredRows, listing, "rehearse_fleet: discovered.json");
}

// Visibility for a slug the discovery slice does not cover (an explicit
// managed entry outside the owner scope): one direct read, fail-closed -
// only a clean `false` counts as public.
function lookupPrivate(slug: string): boolean | null {
  const probe = capture(["gh", "api", `repos/${slug}`, "--jq", ".private"], {
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (probe.exitCode !== 0) return null;
  const value = probe.stdout.trim();
  if (value === "false") return false;
  if (value === "true") return true;
  return null;
}

// Production's enrollment signal, so the fleet gate never reds a repo the
// sync would skip: select_sync_repos.ts skips repos the fleet token
// cannot push to (401/403/404 from the read-only push probe). The probe
// needs the raw token; `gh auth token` resolves it for env-provided (CI's
// PAT) and keyring logins alike. Without one, and on any non-permission
// answer, the rehearsal proceeds and speaks for itself.
function makeEnrollment(): (slug: string) => "enrolled" | "not-enrolled" | "unknown" {
  const token = capture(["gh", "auth", "token"], { timeoutMs: NETWORK_TIMEOUT_MS });
  if (token.exitCode !== 0) return () => "unknown";
  const pat = token.stdout.trim();
  return (slug) => {
    const code = pushProbeStatus(slug, pat);
    if (code === 200) return "enrolled";
    if (code === 401 || code === 403 || code === 404) return "not-enrolled";
    return "unknown";
  };
}

/** The gate's annotation lines for a finished report: one entry per
 * error-severity row (fails the gate) and per warning-severity row
 * (annotates only), each naming the repo and its full detail. */
export function gateAnnotations(rows: FleetRow[]): {
  errors: string[];
  warnings: string[];
} {
  const annotate = (row: FleetRow): string => `${row.repo}: ${row.status} - ${row.detail}`;
  return {
    errors: rows.filter((row) => row.severity === "error").map(annotate),
    warnings: rows.filter((row) => row.severity === "warning").map(annotate),
  };
}

function main(): number {
  const args = process.argv.slice(2);
  const gate = args[0] === "--gate";
  if (args.length > (gate ? 1 : 0)) {
    fail("usage: bun .github/scripts/sync/rehearse_fleet.ts [--gate]");
  }
  if (Bun.which("gh") === null) {
    fail("gh is not on PATH; fleet discovery and the visibility checks need it");
  }
  if (Bun.which("copier") === null) {
    fail("copier is not on PATH (pipx install copier); the rehearsal runs real copier updates");
  }

  const { registry, errors } = loadRegistry(readFileSync(join(REPO_ROOT, "repos.yml"), "utf-8"));
  if (registry === null) fail(`repos.yml: ${errors.join("; ")}`);
  const discovered = registry.managed.wildcard ? discoverFleet() : null;
  let fleet: FleetEnumeration;
  try {
    fleet = enumerateFleet(registry, discovered);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(
    `rehearsing ${fleet.slugs.length} repo(s); ${fleet.excluded} excluded by repos.yml\n`,
  );

  const committed = new Set(
    [...registry.managed.repos, ...registry.exclude].map((slug) => slug.toLowerCase()),
  );
  const rows = rehearseFleet(fleet.slugs, {
    isPrivate: (slug) => fleet.visibility.get(slug.toLowerCase()) ?? lookupPrivate(slug),
    display: privateDisplayNames(gate, discovered, committed),
    enrollment: makeEnrollment(),
    rehearse: (slug) => rehearseRepo(slug, { verbose: false, keepWorkspace: false }),
    log: console.log,
  });

  console.log("\n=== fleet summary ===");
  console.log(summaryTable(rows));
  console.log(`\n${rows.length} repo(s): ${statusTally(rows)}`);
  if (!gate) return 0;
  const annotations = gateAnnotations(rows);
  for (const line of annotations.warnings) warning(`rehearse-fleet: ${line}`);
  for (const line of annotations.errors) error(`rehearse-fleet: ${line}`);
  if (annotations.errors.length > 0) {
    error(
      `rehearse-fleet gate: ${annotations.errors.length} of ${rows.length} repo(s) failed the dry-run sync (details above name the repo, phase, and files). Reproduce one locally with: bun .github/scripts/sync/rehearse.ts <owner>/<repo>`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

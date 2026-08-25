#!/usr/bin/env bun
// Fleet-wide sync rehearsal: a read-only dry run of the template sync
// across every managed repo. Enumerates the fleet from repos.yml (the
// exclude list is respected; the "*" wildcard uses the same owner-scoped
// discovery the sync's plan job runs), then rehearses each PUBLIC repo
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
// "REHEARSAL FAILED: <reason>" and the loop CONTINUES - per-repo failure
// is information, never an abort. EXIT CODE: 0 whenever the loop
// completed, regardless of per-repo outcomes - this is a report, not a
// gate; nonzero is reserved for enumeration failures (no trustworthy
// fleet list means nothing ran).
//
// Usage:
//   bun .github/scripts/sync/rehearse_fleet.ts

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { loadRegistry, type Registry, selectRepos } from "../fleet/repos_registry.ts";
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

export interface FleetRow {
  repo: string;
  status: string;
  detail: string;
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

/** The row for a completed rehearsal: conflict-affected files (dropped-
 * hunk counts included) drive the status; retired count, manifest stamp
 * state, and the validation verdict ride in the detail. */
export function outcomeRow(slug: string, outcome: RehearsalOutcome): FleetRow {
  const parts: string[] = [];
  if (!outcome.changed) parts.push("no changes");
  for (const { file, hunks } of outcome.conflicts) parts.push(`${file} (${hunks} hunk(s) dropped)`);
  for (const file of outcome.malformed) parts.push(`${file} (malformed markers, left unresolved)`);
  parts.push(`retired ${outcome.retired}`);
  parts.push(`manifest ${outcome.manifest === "stamped" ? "stamped ok" : outcome.manifest}`);
  parts.push(`validation ${outcome.validationOk ? "ok" : "FAILED"}`);
  const affected = outcome.conflicts.length + outcome.malformed.length;
  return {
    repo: slug,
    status: affected === 0 ? "clean" : `${affected} conflict(s)`,
    detail: parts.join("; "),
  };
}

/** The row for a rehearsal that threw: non-adoption and the unresolvable
 * recorded _commit get their own statuses, everything else is a one-line
 * failure. */
export function failureRow(slug: string, err: unknown): FleetRow {
  const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0];
  if (err instanceof NotManagedError) {
    return { repo: slug, status: "skipped (not adopted)", detail: reason };
  }
  if (err instanceof RecoveryNeededError) {
    return { repo: slug, status: "recovery needed", detail: reason };
  }
  return { repo: slug, status: "REHEARSAL FAILED", detail: reason };
}

export function summaryLine(row: FleetRow): string {
  // The private skip prints the bare required line; a lookup-failure
  // reason stays in the table.
  if (row.status === PRIVATE_SKIP) return `${row.repo}  ${PRIVATE_SKIP}`;
  if (row.status === "REHEARSAL FAILED") return `${row.repo}  REHEARSAL FAILED: ${row.detail}`;
  return `${row.repo}  ${row.status}${row.detail === "" ? "" : ` - ${row.detail}`}`;
}

export function summaryTable(rows: FleetRow[]): string {
  const all = [{ repo: "repo", status: "status", detail: "detail" }, ...rows];
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
   * (treated as private, fail-closed). */
  isPrivate: (slug: string) => boolean | null;
  rehearse: (slug: string) => RehearsalOutcome;
  log: (line: string) => void;
}

/** The report loop. The private check gates EVERY repo before
 * deps.rehearse (the only code path that clones) can run, and a throwing
 * rehearsal becomes a row, never an abort. */
export function rehearseFleet(slugs: string[], deps: FleetDeps): FleetRow[] {
  const rows: FleetRow[] = [];
  for (const slug of slugs) {
    const isPrivate = deps.isPrivate(slug);
    let row: FleetRow;
    if (isPrivate !== false) {
      row = {
        repo: slug,
        status: PRIVATE_SKIP,
        detail: isPrivate === null ? "visibility lookup failed; treated as private" : "",
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

function main(): number {
  if (process.argv.length > 2) {
    fail("usage: bun .github/scripts/sync/rehearse_fleet.ts (no arguments)");
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

  const rows = rehearseFleet(fleet.slugs, {
    isPrivate: (slug) => fleet.visibility.get(slug.toLowerCase()) ?? lookupPrivate(slug),
    rehearse: (slug) => rehearseRepo(slug, { verbose: false, keepWorkspace: false }),
    log: console.log,
  });

  console.log("\n=== fleet summary ===");
  console.log(summaryTable(rows));
  console.log(`\n${rows.length} repo(s): ${statusTally(rows)}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

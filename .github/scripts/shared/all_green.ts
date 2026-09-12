// The one green-commit predicate every consumer shares (docs/all-green.md, "Consuming the gate").

import { z } from "zod";
import { parseJsonWith } from "./json.ts";
import { lastLine } from "./lines.ts";
import { capture, type RunResult } from "./proc.ts";

/** The gate check's name - the same context branch protection requires
 * (files/settings/override.yml) and the ci.yml all-green job's own
 * check run carries (a job's check run is named by its job id). */
export const CHECK_NAME = "all-green";

/** A third-party app's look-alike check never vouches: only checks the github-actions app created
 * count. */
const CHECK_APP = "github-actions";

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      app: z.object({ slug: z.string() }).nullable(),
    }),
  ),
});

/** Injectable gh runner so tests never touch the network. */
export type GhRunner = (command: string[]) => RunResult;

/** capture()'s default hang bound is five minutes; a probe of the remote (this gate read, the tag mover's ls-remote) that
 * slow is a stalled connection, and every caller waits on it. */
export const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? "15000");

const boundedCapture: GhRunner = (command) => capture(command, { timeoutMs: PROBE_TIMEOUT_MS });

/** Injectable so tests never sleep. The default deadline covers a re-run's gate job finishing
 * moments behind a self-woken caller's first read. */
export interface VerdictWait {
  deadlineMs?: number;
  sleepMs?: number;
  sleep?: (ms: number) => void;
}

/** A malformed override (NaN, Infinity, a negative) must never remove the poll's termination. */
function boundedMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const DEFAULT_WAIT_MS = boundedMs(process.env.ALL_GREEN_WAIT_MS, 120_000);
const DEFAULT_SLEEP_MS = 10_000;

/** Kept beside the reason strings it matches so a reworded reason and its retryability cannot drift
 *  apart; require_green_commit.ts's outer wait consumes it. A failed probe counts as pending: an API
 *  blip deserves the caller's deadline, not an instant refusal. */
export function verdictPending(reason: string): boolean {
  return (
    reason.includes("verdict is still '") ||
    reason.includes("no all-green verdict check exists") ||
    reason.includes("check runs failed")
  );
}

/** Any completed success vouches: every verdict at one sha judged the same tree, so a later failure
 * there is environment drift. A completed failure never returns early: a re-judged sha's fresh
 * verdict can land moments after its stale one was read. */
export function allGreenFailure(
  repository: string,
  sha: string,
  gh: GhRunner = boundedCapture,
  wait: VerdictWait = {},
): string | null {
  const deadlineMs = wait.deadlineMs ?? DEFAULT_WAIT_MS;
  const sleepMs = wait.sleepMs ?? DEFAULT_SLEEP_MS;
  const sleep = wait.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const started = Date.now();
  for (;;) {
    const probe = gh([
      "gh",
      "api",
      `repos/${repository}/commits/${sha}/check-runs?check_name=${CHECK_NAME}&filter=latest&per_page=100`,
    ]);
    if (probe.exitCode !== 0) {
      const detail = lastLine(probe.stderr + probe.stdout);
      const reason = detail === "" ? `exit ${probe.exitCode}` : detail;
      return (
        `reading its ${CHECK_NAME} check runs failed (${reason}) - ` +
        "an API failure, not proof the commit is red, but the gate fails closed"
      );
    }
    const checks = parseJsonWith(
      checkRunsSchema,
      probe.stdout,
      "all_green: check runs response",
    ).check_runs.filter((check) => check.name === CHECK_NAME && check.app?.slug === CHECK_APP);
    if (checks.some((check) => check.status === "completed" && check.conclusion === "success")) {
      return null;
    }
    const remaining = deadlineMs - (Date.now() - started);
    if (remaining <= 0) {
      const completed = checks.find((check) => check.status === "completed");
      if (completed !== undefined) {
        return `its ${CHECK_NAME} verdict concluded '${completed.conclusion}'`;
      }
      return checks.length === 0
        ? `no ${CHECK_NAME} verdict check exists there (waited ${Math.round(deadlineMs / 1000)}s)` +
            " - CI has not vouched for the commit; re-run the sha's CI run (the all-green job posts the check) if one should exist"
        : `its ${CHECK_NAME} verdict is still '${checks[0].status}' after ${Math.round(deadlineMs / 1000)}s`;
    }
    sleep(Math.min(sleepMs, remaining));
  }
}

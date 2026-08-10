/**
 * Gate a release on the repository's health. Runs at two points, selected by
 * MODE:
 * - pull-request: on a release-please PR's CI; the PR's own labels supply
 *   the override.
 * - release: on the main-push release path just before release-please cuts a
 *   release. Only a commit that is the merge of a release-please PR is
 *   gated; every other main push exits 0 untouched (release-please runs on
 *   every push but only cuts a release from a release-PR merge, so gating
 *   ordinary pushes would paint all of main red while one issue is open).
 *
 * Three gates, all evaluated even when the override label is present so the
 * report is complete: an open fuzz tracking issue (FUZZ_LABEL, optional), an
 * open blocker issue (BLOCKER_LABEL), and open Dependabot alerts at or above
 * SECURITY_SEVERITY. Failures without the override label on the release PR
 * are ::error + exit 1; with it they become ::warning + a loud ::notice and
 * exit 0.
 *
 * Configuration from the environment (set by action.yml): MODE, FUZZ_LABEL,
 * BLOCKER_LABEL, OVERRIDE_LABEL, SECURITY_SEVERITY. Context: GH_TOKEN (gh
 * auth), GITHUB_REPOSITORY, GITHUB_SHA (release mode), GITHUB_EVENT_PATH
 * (pull-request mode).
 */

import { existsSync, readFileSync } from "node:fs";

/** Runs a `gh` subcommand and returns stdout; throws on a non-zero exit. */
export type GhRunner = (args: string[]) => Promise<string>;

/** Run gh and return stdout; throws with gh's stderr on a non-zero exit. */
const gh: GhRunner = async (args) => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
  return stdout;
};

/** Same label shape the fuzz-issue action enforces: safe as a gh flag value
 * (no leading dash), within GitHub's 50-character label limit. */
export const LABEL_RE = /^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}$/;

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type SecurityThreshold = Severity | "off";

/** Mode-specific context, parsed up front so each mode's requirements
 * (event payload vs commit sha) cannot be missing later. */
export type ModeContext =
  | { mode: "pull-request"; eventPath: string }
  | { mode: "release"; sha: string };

export interface Config {
  context: ModeContext;
  repo: string;
  /** Undefined disables the fuzz gate. */
  fuzzLabel: string | undefined;
  blockerLabel: string;
  overrideLabel: string;
  security: SecurityThreshold;
}

function parseLabel(name: string, value: string): string {
  if (!LABEL_RE.test(value)) {
    throw new Error(
      `${name} must be a plain label (letters, digits, ._:- and spaces; no leading dash), got '${value}'`,
    );
  }
  return value;
}

/** Parse the environment into a Config, or throw naming the first problem. */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new Error("GITHUB_REPOSITORY is required");
  }

  const mode = env.MODE ?? "";
  let context: ModeContext;
  if (mode === "pull-request") {
    if (!env.GITHUB_EVENT_PATH) {
      throw new Error("GITHUB_EVENT_PATH is required in pull-request mode");
    }
    context = { mode, eventPath: env.GITHUB_EVENT_PATH };
  } else if (mode === "release") {
    if (!env.GITHUB_SHA) {
      throw new Error("GITHUB_SHA is required in release mode");
    }
    context = { mode, sha: env.GITHUB_SHA };
  } else {
    throw new Error(`unknown MODE '${mode}' (expected pull-request or release)`);
  }

  const security = env.SECURITY_SEVERITY || "high";
  if (security !== "off" && !SEVERITIES.includes(security as Severity)) {
    throw new Error(
      `SECURITY_SEVERITY must be one of off|${SEVERITIES.join("|")}, got '${security}'`,
    );
  }

  return {
    context,
    repo,
    fuzzLabel: env.FUZZ_LABEL ? parseLabel("FUZZ_LABEL", env.FUZZ_LABEL) : undefined,
    blockerLabel: parseLabel("BLOCKER_LABEL", env.BLOCKER_LABEL || "release-blocker"),
    overrideLabel: parseLabel("OVERRIDE_LABEL", env.OVERRIDE_LABEL || "release-override"),
    security: security as SecurityThreshold,
  };
}

/** The severities that meet or exceed the threshold, mildest first. */
export function severitiesAtOrAbove(threshold: Severity): Severity[] {
  return SEVERITIES.slice(SEVERITIES.indexOf(threshold));
}

/** GitHub deduplicates labels case-insensitively; compare the same way. */
function hasLabel(labels: string[], wanted: string): boolean {
  return labels.some((label) => label.toLowerCase() === wanted.toLowerCase());
}

export type Override = { active: true; prNumber: number } | { active: false; reason: string };

interface PrPayload {
  number?: number;
  labels?: Array<{ name: string }>;
}

/**
 * Pull-request mode: the override label read from the PR named by the event
 * payload. The labels come from a live `gh pr view`, never the payload's
 * label snapshot: the override flow is applying the label AFTER a failing
 * run and re-running, and a removed label must stop counting, so a stale
 * snapshot is wrong in both directions. A failed lookup propagates - a gate
 * that cannot determine override state must not pass one (fail closed).
 */
export async function overrideFromPullRequest(
  run: GhRunner,
  repo: string,
  eventPath: string,
  overrideLabel: string,
): Promise<Override> {
  if (!existsSync(eventPath)) {
    return { active: false, reason: `no event payload at ${eventPath}` };
  }
  const payload = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: PrPayload };
  const pr = payload.pull_request;
  if (!pr?.number) {
    return { active: false, reason: "event payload carries no pull_request" };
  }
  const json = await run(["pr", "view", String(pr.number), "--repo", repo, "--json", "labels"]);
  const labels = ((JSON.parse(json) as PrPayload).labels ?? []).map((label) => label.name);
  if (hasLabel(labels, overrideLabel)) {
    return { active: true, prNumber: pr.number };
  }
  return { active: false, reason: `no '${overrideLabel}' label on PR #${pr.number}` };
}

export interface ReleasePr {
  number: number;
  labels: string[];
}

export interface ReleaseLookup {
  /** The merged release-please PR, or undefined when the commit is not a
   * release-PR merge. */
  pr: ReleasePr | undefined;
  /** Unmerged release-please PRs associated with the commit; reported in
   * the trivial-pass notice, never gated on. */
  unmerged: number[];
}

/**
 * The release-please PR whose MERGE produced the commit. The gate applies
 * only to an actual release-PR merge, so a candidate counts solely with
 * merged_at set: an open release-please PR that happens to be associated
 * with a pushed commit is not a merge and yields the trivial pass. More
 * than one merged candidate is unresolvable ambiguity and fails closed
 * rather than gating on an arbitrary PR's labels.
 */
export async function findReleasePr(
  run: GhRunner,
  repo: string,
  sha: string,
): Promise<ReleaseLookup> {
  const json = await run(["api", `repos/${repo}/commits/${sha}/pulls`]);
  const prs = JSON.parse(json) as Array<{
    number: number;
    head?: { ref?: string };
    labels?: Array<{ name: string }>;
    merged_at?: string | null;
  }>;
  const candidates = prs.filter((entry) => entry.head?.ref?.startsWith("release-please--"));
  const merged = candidates.filter((entry) => entry.merged_at);
  if (merged.length > 1) {
    const numbers = merged.map((entry) => `#${entry.number}`).join(", ");
    throw new Error(
      `cannot pick the release PR for ${sha}: ${merged.length} merged release-please PRs are associated (${numbers})`,
    );
  }
  const pr = merged[0];
  return {
    pr: pr
      ? { number: pr.number, labels: (pr.labels ?? []).map((label) => label.name) }
      : undefined,
    unmerged: candidates.filter((entry) => !entry.merged_at).map((entry) => entry.number),
  };
}

export type GateOutcome =
  | { gate: string; status: "pass"; summary: string }
  | { gate: string; status: "fail"; problem: string; advice: string }
  | { gate: string; status: "skip"; reason: string };

/** gh issue list returns at most this many entries; a count that hits it is
 * reported as "at least" so the message never understates the backlog. */
const ISSUE_LIMIT = 100;

/** A gate that fails while any open issue carries the label. */
export async function issueGate(
  run: GhRunner,
  repo: string,
  gate: string,
  label: string,
  advice: string,
): Promise<GateOutcome> {
  // Fleet gate jobs run this action without a checkout, so gh has no
  // repository to infer from a working tree; every invocation names it.
  const json = await run([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    label,
    "--state",
    "open",
    "--limit",
    String(ISSUE_LIMIT),
    "--json",
    "number",
  ]);
  const issues = JSON.parse(json) as Array<{ number: number }>;
  if (issues.length === 0) {
    return { gate, status: "pass", summary: `no open '${label}' issues` };
  }
  const count = issues.length >= ISSUE_LIMIT ? `at least ${issues.length}` : `${issues.length}`;
  const list = issues.map((issue) => `#${issue.number}`).join(", ");
  return {
    gate,
    status: "fail",
    problem: `${count} open '${label}' issue(s): ${list}`,
    advice,
  };
}

/** A gate that fails while any Dependabot alert at or above the threshold is
 * open. */
export async function securityGate(
  run: GhRunner,
  repo: string,
  threshold: Severity,
  advice: string,
): Promise<GateOutcome> {
  const gate = "security";
  const severities = severitiesAtOrAbove(threshold).join(",");
  let json: string;
  try {
    json = await run([
      "api",
      `repos/${repo}/dependabot/alerts?state=open&severity=${severities}&per_page=100`,
    ]);
  } catch (error) {
    // The workflow GITHUB_TOKEN can read this endpoint only when the caller
    // grants `vulnerability-alerts: read` (the dedicated permissions key;
    // security-events covers code scanning, not Dependabot). A missing grant
    // and a repo with Dependabot alerts disabled both answer HTTP 403, and a
    // host without the feature 404s - none of those may block a fleet repo.
    const message = error instanceof Error ? error.message : String(error);
    if (/HTTP 40[34]|dependabot alerts are (?:disabled|not available)/i.test(message)) {
      return { gate, status: "skip", reason: message };
    }
    throw error;
  }
  const alerts = JSON.parse(json) as Array<{ number: number }>;
  if (alerts.length === 0) {
    return { gate, status: "pass", summary: `no open Dependabot alerts at or above ${threshold}` };
  }
  const list = alerts.map((alert) => `#${alert.number}`).join(", ");
  return {
    gate,
    status: "fail",
    problem: `${alerts.length} open Dependabot alert(s) at or above ${threshold}: ${list}`,
    advice,
  };
}

/** Run the gates and emit workflow commands via `out`; returns the exit code. */
export async function runHealthCheck(
  cfg: Config,
  run: GhRunner,
  out: (line: string) => void,
): Promise<number> {
  let override: Override;
  if (cfg.context.mode === "release") {
    const { pr, unmerged } = await findReleasePr(run, cfg.repo, cfg.context.sha);
    if (pr === undefined) {
      const open =
        unmerged.length > 0
          ? ` (open release PR(s) associated: ${unmerged.map((n) => `#${n}`).join(", ")})`
          : "";
      out(
        `::notice::release health: ${cfg.context.sha} is not a release-PR merge; nothing to gate${open}`,
      );
      return 0;
    }
    override = hasLabel(pr.labels, cfg.overrideLabel)
      ? { active: true, prNumber: pr.number }
      : { active: false, reason: `no '${cfg.overrideLabel}' label on release PR #${pr.number}` };
  } else {
    override = await overrideFromPullRequest(
      run,
      cfg.repo,
      cfg.context.eventPath,
      cfg.overrideLabel,
    );
  }

  const overrideHint = `or apply the '${cfg.overrideLabel}' label to the release PR and re-run this check`;
  const outcomes: GateOutcome[] = [];
  if (cfg.fuzzLabel !== undefined) {
    outcomes.push(
      await issueGate(
        run,
        cfg.repo,
        "fuzz",
        cfg.fuzzLabel,
        `fix the crashes (the next green nightly closes the tracking issue automatically), ${overrideHint}`,
      ),
    );
  }
  outcomes.push(
    await issueGate(
      run,
      cfg.repo,
      "blocker",
      cfg.blockerLabel,
      `close the blocker issue(s), ${overrideHint}`,
    ),
  );
  if (cfg.security !== "off") {
    outcomes.push(
      await securityGate(
        run,
        cfg.repo,
        cfg.security,
        `fix or dismiss the alert(s) under the repository's Security tab, ${overrideHint}`,
      ),
    );
  }

  for (const outcome of outcomes) {
    if (outcome.status === "skip") {
      out(`::notice::${outcome.gate} gate skipped: ${outcome.reason}`);
    }
  }

  const failures = outcomes.filter((outcome) => outcome.status === "fail");
  if (failures.length === 0) {
    const parts = outcomes
      .map((o) => (o.status === "pass" ? `${o.gate}: ${o.summary}` : `${o.gate}: skipped`))
      .join("; ");
    out(`release health: all gates passed (${parts})`);
    return 0;
  }

  if (override.active) {
    for (const failure of failures) {
      out(`::warning::${failure.gate} gate failed: ${failure.problem}`);
    }
    const names = failures.map((failure) => failure.gate).join(", ");
    out(
      `::notice::OVERRIDE: the '${cfg.overrideLabel}' label on release PR #${override.prNumber} bypassed ${failures.length} failing gate(s) (${names}); this release ships despite them`,
    );
    return 0;
  }

  for (const failure of failures) {
    out(`::error::${failure.gate} gate failed: ${failure.problem}. To release: ${failure.advice}`);
  }
  return 1;
}

async function main(): Promise<number> {
  let cfg: Config;
  try {
    cfg = parseConfig(process.env);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return runHealthCheck(cfg, gh, console.log);
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

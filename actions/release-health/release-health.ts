/**
 * In release mode only a release-please PR's merge commit is gated; every other main push exits 0, because gating
 * ordinary pushes would paint all of main red while one issue is open. fleet-release.yml lets release-please tag only
 * on a "true" `release-cut` output, so an ordinary-push run cannot release a merge its gate never judged.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

/** Runs a `gh` subcommand and returns stdout; throws on a non-zero exit. */
export type GhRunner = (args: string[]) => Promise<string>;

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

/** A hand copy of the registration grammar's LABEL_RE (actions/plan/registration.ts), pinned by the tracking-label-regex ssot rule:
 * safe as a gh flag value (no leading dash), within GitHub's 50-character label limit. */
export const LABEL_RE = /^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}$/;

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One value across the fleet; files/release-please/settings.yml declares the two labels (the labels ssot rule pins it). */
export const BLOCKER_LABEL = "release-blocker";
export const OVERRIDE_LABEL = "release-override";
export const SECURITY_THRESHOLD: Severity = "high";

/** Mode-specific context, parsed up front so each mode's requirements
 * (event payload vs commit sha) cannot be missing later. */
export type ModeContext =
  | { mode: "pull-request"; eventPath: string }
  | { mode: "release"; sha: string };

export interface Config {
  context: ModeContext;
  repo: string;
  /** Tracking-issue stream labels; empty disables the tracking gates. */
  trackingLabels: string[];
}

function parseLabel(name: string, value: string): string {
  if (!LABEL_RE.test(value)) {
    throw new Error(
      `${name} must be a plain label (letters, digits, ._:- and spaces; no leading dash), got '${value}'`,
    );
  }
  return value;
}

/** A label cannot contain a comma: the registration's labels share LABEL_RE's shape.
 *  GitHub deduplicates label names case-insensitively, so the list does too. */
export function parseTrackingLabels(env: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const token of (env.TRACKING_LABELS ?? "").split(",")) {
    const label = token.trim();
    if (label === "") continue;
    parseLabel("TRACKING_LABELS", label);
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

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

  return { context, repo, trackingLabels: parseTrackingLabels(env) };
}

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
 * The labels come from a live `gh pr view`, never the payload's label snapshot: the override flow is applying the label
 * AFTER a failing run and re-running, and a removed label must stop counting, so a stale snapshot is wrong in both
 * directions. A failed lookup propagates: a gate that cannot determine override state must not pass one (fail closed).
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
 * A candidate counts solely with merged_at set: an open release-please PR that happens to be associated with a pushed
 * commit is not a merge and yields the trivial pass. More than one merged candidate is unresolvable ambiguity and fails
 * closed rather than gating on an arbitrary PR's labels.
 */
export async function findReleasePr(
  run: GhRunner,
  repo: string,
  sha: string,
): Promise<ReleaseLookup> {
  // The listing also carries open PRs whose branch contains the commit, so
  // on a busy repo the merged release PR can sit past the default first
  // page; paginate rather than silently ungating the release. --slurp pins
  // the multi-page output to one array-of-pages document regardless of gh
  // version or endpoint shape (needs gh >= 2.51; hosted runners ship
  // current gh).
  const json = await run([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/commits/${sha}/pulls?per_page=100`,
  ]);
  const pages = JSON.parse(json) as Array<
    Array<{
      number: number;
      head?: { ref?: string };
      labels?: Array<{ name: string }>;
      merged_at?: string | null;
    }>
  >;
  const prs = pages.flat();
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
  | { gate: string; status: "fail"; problem: string; advice: string };

/** gh issue list returns at most this many entries; a count that hits it is
 * reported as "at least" so the message never understates the backlog. */
const ISSUE_LIMIT = 100;

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
    // An unreadable endpoint is a broken gate, not a pass. The configuration remedy rides only on the statuses configuration
    // causes; GitHub answers a primary rate limit with 403 too, told apart by its wording.
    //   HTTP 403 (grant missing, alerts disabled), HTTP 404  -> cause and remedy
    //   HTTP 403 "rate limit", HTTP 429, HTTP 5xx            -> cause alone
    const message = error instanceof Error ? error.message : String(error);
    const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
    const configuration = (status === "403" || status === "404") && !/rate limit/i.test(message);
    const remedy = configuration
      ? "; the gate needs vulnerability-alerts: read and Dependabot alerts enabled on the repository"
      : "";
    throw new Error(`security gate could not read the Dependabot alerts (${message})${remedy}`);
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

export async function runHealthCheck(
  cfg: Config,
  run: GhRunner,
  out: (line: string) => void,
  setOutput: (name: string, value: string) => void,
): Promise<number> {
  let override: Override;
  if (cfg.context.mode === "release") {
    const { pr, unmerged } = await findReleasePr(run, cfg.repo, cfg.context.sha);
    setOutput("release-cut", pr === undefined ? "false" : "true");
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
    override = hasLabel(pr.labels, OVERRIDE_LABEL)
      ? { active: true, prNumber: pr.number }
      : { active: false, reason: `no '${OVERRIDE_LABEL}' label on release PR #${pr.number}` };
  } else {
    override = await overrideFromPullRequest(run, cfg.repo, cfg.context.eventPath, OVERRIDE_LABEL);
  }

  const overrideHint = `or apply the '${OVERRIDE_LABEL}' label to the release PR and re-run this check`;
  // Every gate runs even under the override, so the report is complete.
  const outcomes: GateOutcome[] = [];
  for (const label of cfg.trackingLabels) {
    outcomes.push(
      await issueGate(
        run,
        cfg.repo,
        `tracking:${label}`,
        label,
        `fix the failures behind it (the stream's next green nightly run closes the tracking issue automatically), ${overrideHint}`,
      ),
    );
  }
  outcomes.push(
    await issueGate(
      run,
      cfg.repo,
      "blocker",
      BLOCKER_LABEL,
      `close the blocker issue(s), ${overrideHint}`,
    ),
  );
  outcomes.push(
    await securityGate(
      run,
      cfg.repo,
      SECURITY_THRESHOLD,
      `fix or dismiss the alert(s) under the repository's Security tab, ${overrideHint}`,
    ),
  );

  const failures = outcomes.filter((outcome) => outcome.status === "fail");
  if (failures.length === 0) {
    const parts = outcomes
      .flatMap((o) => (o.status === "pass" ? [`${o.gate}: ${o.summary}`] : []))
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
      `::notice::OVERRIDE: the '${OVERRIDE_LABEL}' label on release PR #${override.prNumber} bypassed ${failures.length} failing gate(s) (${names}); this release ships despite them`,
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
  // A lost output would read as "not a release cut" and silently skip every tag.
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    throw new Error("GITHUB_OUTPUT is required");
  }
  return runHealthCheck(cfg, gh, console.log, (name, value) =>
    appendFileSync(outputFile, `${name}=${value}\n`),
  );
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    // ::error:: so an unexpected failure (a rate-limited gate, a broken gh)
    // is annotated on the run like every deliberate gate failure.
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

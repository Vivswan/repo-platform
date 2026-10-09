/**
 * In release mode only a release-please PR's merge commit is gated; every other main push exits 0, because gating
 * ordinary pushes would paint all of main red while one issue is open. fleet-release.yml lets release-please tag only
 * on a "true" `release-cut` output, so an ordinary-push run cannot release a merge its gate never judged. On that
 * ordinary push `head-current` says whether the branch still stands at the judged commit, so a run whose commit is no
 * longer the head leaves the release-PR refresh to the newer run instead of racing it.
 *
 * After-propose mode runs once release-please proposed: its propose phase aborts GREEN ("untagged, merged release PRs
 * outstanding") while a merged release PR still wears the pending label, so the guard runs after it, once
 * release-please's own recovery phase has had its turn, and fails naming the parked PRs.
 *
 * After-refresh mode runs on the release PR's own CI once release-please's propose ran against a head behind main
 * (fleet.yml's release-pr job). The verdict is the head, read against the main this run checked out:
 *
 *   main moved since the checkout        -> red: that commit's own run refreshes the PR (fleet-release.yml's head-current)
 *   head moved                           -> green, naming the new head
 *   head unmoved, a merged PR pending    -> red: release-please proposed nothing
 *   head unmoved, the PR body unchanged  -> the commits the PR lacks add no changelog line, so GitHub's update-branch
 *                                           merges main and the head is read again; still unmoved is red
 *
 * A changed body is always release-please's rebuild: a merge there would leave the changelog without those commits.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { LABEL_RE } from "../shared/label.ts";
import { baseTip } from "./freshness.ts";

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

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One value across the fleet; files/release-please/settings.yml declares the two labels (tests/files/label_names.test.ts). */
export const BLOCKER_LABEL = "release-blocker";
export const OVERRIDE_LABEL = "release-override";
export const SECURITY_THRESHOLD: Severity = "high";

/** release-please's own labels on a merged release PR: pending until the cut tags it (tests/files/label_names.test.ts). */
export const PENDING_LABEL = "autorelease: pending";
export const TAGGED_LABEL = "autorelease: tagged";
/** A label this young is a cut still in flight, not a parked release. */
const PENDING_GRACE_MINUTES = 30;

/** Mode-specific context, parsed up front so each mode's requirements
 * (event payload vs commit sha) cannot be missing later. */
export type ModeContext =
  | { mode: "pull-request"; eventPath: string }
  | { mode: "release"; sha: string; ref: string }
  | { mode: "after-propose" }
  | { mode: "after-refresh"; eventPath: string };

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
  if (mode === "pull-request" || mode === "after-refresh") {
    if (!env.GITHUB_EVENT_PATH) {
      throw new Error(`GITHUB_EVENT_PATH is required in ${mode} mode`);
    }
    context = { mode, eventPath: env.GITHUB_EVENT_PATH };
  } else if (mode === "release") {
    if (!env.GITHUB_SHA) {
      throw new Error("GITHUB_SHA is required in release mode");
    }
    if (!env.GITHUB_REF_NAME) {
      throw new Error("GITHUB_REF_NAME is required in release mode");
    }
    context = { mode, sha: env.GITHUB_SHA, ref: env.GITHUB_REF_NAME };
  } else if (mode === "after-propose") {
    context = { mode };
  } else {
    throw new Error(
      `unknown MODE '${mode}' (expected pull-request, release, after-propose, or after-refresh)`,
    );
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

/** The branch head through the API, not an anonymous ls-remote, so private repositories work. */
export async function branchHead(run: GhRunner, repo: string, ref: string): Promise<string> {
  const json = await run(["api", `repos/${repo}/git/ref/heads/${ref}`]);
  const sha = (JSON.parse(json) as { object?: { sha?: string } }).object?.sha;
  if (!sha) {
    throw new Error(`repos/${repo}/git/ref/heads/${ref} carries no object sha`);
  }
  return sha;
}

/** The merged release PRs still labelled pending, as `gh pr list --state merged` answers them. */
export async function mergedPendingPrs(
  run: GhRunner,
  repo: string,
): Promise<Array<{ number: number; mergedAt: string }>> {
  const json = await run([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--label",
    PENDING_LABEL,
    "--limit",
    String(ISSUE_LIMIT),
    "--json",
    "number,mergedAt",
  ]);
  return JSON.parse(json) as Array<{ number: number; mergedAt: string }>;
}

/** gh's mergedAt is an ISO instant; one it cannot read is a broken listing, never a fresh merge. */
export async function stalePendingGuard(
  run: GhRunner,
  repo: string,
  now: Date,
  out: (line: string) => void,
): Promise<number> {
  const merged = await mergedPendingPrs(run, repo);
  // gh's mergedAt carries whole seconds, so the cutoff does too: a merge exactly 30 minutes old is not yet stale.
  const cutoff = Math.floor(now.getTime() / 1000) * 1000 - PENDING_GRACE_MINUTES * 60_000;
  const stale = merged.filter((pr) => {
    const mergedAt = Date.parse(pr.mergedAt);
    if (Number.isNaN(mergedAt)) {
      throw new Error(`PR #${pr.number} carries an unreadable mergedAt '${pr.mergedAt}'`);
    }
    return mergedAt < cutoff;
  });
  if (stale.length === 0) {
    out(`no merged release PR has worn '${PENDING_LABEL}' past ${PENDING_GRACE_MINUTES} minutes`);
    return 0;
  }
  const list = stale.map((pr) => `#${pr.number}`).join(", ");
  out(
    `::error::merged release PR(s) ${list} have worn '${PENDING_LABEL}' for over ${PENDING_GRACE_MINUTES} minutes, ` +
      "so release-please refuses to propose any new release ('untagged, merged release PRs outstanding'). " +
      "Re-run the CI run of that merge commit (only the run that judged the merge tags it), " +
      `or finish or abandon the release by hand and then move the label to '${TAGGED_LABEL}'.`,
  );
  return 1;
}

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
  // fleet-release.yml runs this action without a checkout, so gh has no
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
    // GitHub answers a primary rate limit with HTTP 403 as well, so the configuration remedy is withheld on rate-limit wording.
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

/** GitHub answers update-branch with 202 and merges afterwards, so the head is re-read this many times, this far apart. */
export const UPDATE_BRANCH_POLLS = 30;
export const UPDATE_BRANCH_POLL_MS = 2_000;

export interface JudgedPullRequest {
  number: number;
  /** The head the run was started for, before release-please's propose. */
  headSha: string;
  base: string;
}

/** The payload is the one source of the judged head: a run cannot read it from the API after propose moved the branch. */
export function judgedPullRequest(eventPath: string): JudgedPullRequest {
  const payload = JSON.parse(readFileSync(eventPath, "utf8")) as {
    pull_request?: { number?: number; head?: { sha?: string }; base?: { ref?: string } };
  };
  const pr = payload.pull_request;
  if (!pr?.number || !pr.head?.sha || !pr.base?.ref) {
    throw new Error(
      `${eventPath} carries no pull_request with a number, a head sha, and a base ref`,
    );
  }
  return { number: pr.number, headSha: pr.head.sha, base: pr.base.ref };
}

export async function pullRequestHead(
  run: GhRunner,
  repo: string,
  number: number,
): Promise<string> {
  const json = await run(["api", `repos/${repo}/pulls/${number}`]);
  const sha = (JSON.parse(json) as { head?: { sha?: string } }).head?.sha;
  if (!sha) {
    throw new Error(`repos/${repo}/pulls/${number} carries no head sha`);
  }
  return sha;
}

/**
 * The precondition `expected_head_sha` is the judged head, so a branch another run moved meanwhile is refused (422) and
 * never merged twice; the refusal propagates like any failed gh call, and the head is read again only after the PUT.
 * `checkoutTip` is the base as this run's full-history checkout fetched it, before release-please ran. A base that has
 * moved past it may carry a commit the refresh never saw (this run cannot tell), so no head is reported refreshed over
 * it (the same guard as fleet-release.yml's head-current), and that commit's own run refreshes the PR.
 */
export async function refreshVerdict(
  run: GhRunner,
  repo: string,
  eventPath: string,
  out: (line: string) => void,
  sleep: (ms: number) => Promise<void>,
  checkoutTip: (base: string) => string,
): Promise<number> {
  const { number, headSha: judged, base } = judgedPullRequest(eventPath);
  const tip = checkoutTip(base);
  const baseMoved = async (): Promise<boolean> => {
    const head = await branchHead(run, repo, base);
    if (head === tip) return false;
    out(
      `::error::${base} moved to ${head.slice(0, 7)} since this run checked it out at ${tip.slice(0, 7)}; this run cannot tell whether the refresh saw that commit, and its own green run refreshes the release PR`,
    );
    return true;
  };
  const refreshed = async (head: string): Promise<number> => {
    if (await baseMoved()) return 1;
    out(`::notice::release PR #${number} refreshed to ${head}; approve its run from the merge box`);
    return 0;
  };
  const afterPropose = await pullRequestHead(run, repo, number);
  if (afterPropose !== judged) {
    return refreshed(afterPropose);
  }
  // release-please proposes nothing at all while a merged release PR wears the pending label, so an unmoved head then
  // says nothing about the body; merging main would go green with a changelog missing what landed since.
  const pending = await mergedPendingPrs(run, repo);
  if (pending.length > 0) {
    const list = pending.map((pr) => `#${pr.number}`).join(", ");
    out(
      `::error::Release PR is behind ${base}, and release-please proposes nothing while merged release PR(s) ${list} wear '${PENDING_LABEL}'. Re-run this job once the cut has relabelled them '${TAGGED_LABEL}'.`,
    );
    return 1;
  }
  if (await baseMoved()) return 1;
  out(
    `release-please left PR #${number} at ${judged.slice(0, 7)}: its body is unchanged, so the commits it lacks add no changelog line and merging ${base} loses none; asking GitHub to update the branch`,
  );
  await run([
    "api",
    `repos/${repo}/pulls/${number}/update-branch`,
    "--method",
    "PUT",
    "-f",
    `expected_head_sha=${judged}`,
  ]);
  for (let poll = 0; poll < UPDATE_BRANCH_POLLS; poll++) {
    await sleep(UPDATE_BRANCH_POLL_MS);
    const head = await pullRequestHead(run, repo, number);
    if (head !== judged) {
      return refreshed(head);
    }
  }
  const waited = (UPDATE_BRANCH_POLLS * UPDATE_BRANCH_POLL_MS) / 1000;
  out(
    `::error::Release PR is behind ${base} and GitHub's branch update has not moved it within ${waited} s; its version and changelog would miss commits already on ${base}. Do not merge; release-please refreshes the PR after the next green run on ${base}.`,
  );
  return 1;
}

export async function runHealthCheck(
  cfg: Config,
  run: GhRunner,
  out: (line: string) => void,
  setOutput: (name: string, value: string) => void,
  now: Date = new Date(),
  sleep: (ms: number) => Promise<void> = Bun.sleep,
  checkoutTip: (base: string) => string = baseTip,
): Promise<number> {
  if (cfg.context.mode === "after-propose") {
    return stalePendingGuard(run, cfg.repo, now, out);
  }
  if (cfg.context.mode === "after-refresh") {
    return refreshVerdict(run, cfg.repo, cfg.context.eventPath, out, sleep, checkoutTip);
  }
  let override: Override;
  if (cfg.context.mode === "release") {
    const { sha, ref } = cfg.context;
    const { pr, unmerged } = await findReleasePr(run, cfg.repo, sha);
    setOutput("release-cut", pr === undefined ? "false" : "true");
    if (pr === undefined) {
      const open =
        unmerged.length > 0
          ? ` (open release PR(s) associated: ${unmerged.map((n) => `#${n}`).join(", ")})`
          : "";
      out(`::notice::release health: ${sha} is not a release-PR merge; nothing to gate${open}`);
      const head = await branchHead(run, cfg.repo, ref);
      setOutput("head-current", head === sha ? "true" : "false");
      if (head !== sha) {
        out(
          `::notice::${ref} moved to ${head.slice(0, 7)} since ${sha.slice(0, 7)} was judged; the newer run refreshes the release PR`,
        );
      }
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

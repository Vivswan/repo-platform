#!/usr/bin/env bun
// The delivery step of the managed sync-branch.yml, run from the platform checkout at `stable` inside the labeled pull
// request's own repository (docs/platform/sync/operator.md, "Syncing a branch by label"). The log is the repository's own, so nothing here
// is redacted; the pull request's one sticky comment is the record a human reads.
//
// The label comes off before anything is judged, so adding it again is always a new run. A hold is refused before the
// tree is compared: a held link leaves no diff. The repository token cannot create or update a file under
// .github/workflows, so a diff touching one is refused whole and the comment names the operator's branch dispatch.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubClient, unansweredReason } from "../../../actions/github-client/github.ts";
import { PLATFORM_NAME, PLATFORM_SLUG, SYNC_LABEL } from "../../../actions/shared/platform.ts";
import { fail, requireEnv } from "../shared/gha.ts";
import { SYNC_IDENTITY } from "../shared/git_identity.ts";
import { parseJsonWith } from "../shared/json.ts";
import { codeSpan, fenced } from "../shared/markdown_code.ts";
import { capture, mustCapture } from "../shared/proc.ts";
import { issueComment, stickyComment } from "../shared/sticky_comment.ts";
import {
  boundedReport,
  DELIVERY_CALL_BOUND_MS,
  prTitle,
  SUMMARY_FILE,
  SYNC_LOG,
  stageWritten,
  tail,
} from "./deliver.ts";
import { readMigrated } from "./migrate.ts";
import { syncReport } from "./writer/report.ts";

/** The first line of the sticky comment; the finder matches it, so it never changes shape. */
const COMMENT_MARKER = `<!-- ${PLATFORM_NAME} sync-branch -->`;

/** A repository-token push cannot carry a change under it; such a sync is reported in the comment instead. */
const WORKFLOWS_DIR = ".github/workflows/";

type Outcome =
  | { kind: "failed"; what: "a migration rung" | "the writer"; log: string }
  | { kind: "held"; report: string }
  | { kind: "workflow files"; paths: string[]; report: string }
  | { kind: "unchanged"; tipIsOurs: boolean }
  | { kind: "push rejected"; log: string }
  | { kind: "pushed"; commit: string; report: string };

/** GitHub holds the pull_request run a repository-token push creates for approval; the autofix action's notice says the same. */
const APPROVAL_LINE =
  "GitHub holds the new head's pull_request run for approval, so its checks stay unreported until you approve the run from the merge box or push a commit of your own.";

/** The unchanged tip may be the operator's branch dispatch's commit, whose fleet-token push created an ordinary run. */
const RELABEL_APPROVAL_LINE =
  "If a label run pushed this tip, GitHub holds its pull_request run for approval; approve it from the merge box or push a commit of your own.";

function commentBody(
  outcome: Outcome,
  input: { build: string; branch: string; runUrl: string },
): string {
  const build = `Build \`${input.build}\``;
  const branch = `\`${input.branch}\``;
  const run = `([run](${input.runUrl}))`;
  const report = (text: string) => ["", boundedReport(text).replace(/\n$/, "")];
  const quoted = (text: string) => ["", ...fenced(text.replace(/\n$/, ""), "text")];
  const lines = (() => {
    switch (outcome.kind) {
      case "failed":
        return [`${build} NOT pushed: ${outcome.what} failed ${run}.`, ...quoted(outcome.log)];
      case "held":
        return [
          `${build} NOT pushed: the writer holds ${branch} for review, see the Review section ${run}.`,
          ...report(outcome.report),
        ];
      case "workflow files":
        return [
          `${build} NOT pushed: the sync changes ${outcome.paths.map(codeSpan).join(", ")}, and the repository token cannot create or update a workflow file ${run}.`,
          `The owner's dispatch of sync-repos.yml in ${PLATFORM_SLUG} with \`repo=<owner>/<name>\` and \`branch=${input.branch}\` pushes the same commit with the fleet token.`,
          ...report(outcome.report),
        ];
      case "unchanged":
        return [
          `${build}: ${branch} already matches it, nothing pushed ${run}.`,
          ...(outcome.tipIsOurs ? [RELABEL_APPROVAL_LINE] : []),
        ];
      case "push rejected":
        return [
          `${build} NOT pushed: the push onto ${branch} was refused ${run}. A commit that reached the branch meanwhile is the usual cause; add the \`${SYNC_LABEL}\` label again once the branch is where you want it.`,
          ...quoted(outcome.log),
        ];
      case "pushed":
        return [
          `${build} pushed onto ${branch} as ${outcome.commit} ${run}.`,
          APPROVAL_LINE,
          ...report(outcome.report),
        ];
    }
  })();
  return [COMMENT_MARKER, ...lines, ""].join("\n");
}

class BranchDelivery {
  /** The run's scratch directory, holding the writer's summary and log. */
  readonly runnerTemp = requireEnv("RUNNER_TEMP");

  /** The repository the pull request and its branch belong to. */
  readonly repository = requireEnv("GITHUB_REPOSITORY");

  /** The pull request whose branch is synced, and which gets the comment. */
  readonly prNumber = requireEnv("PR_NUMBER");

  /** The pull request's head branch, the one synced onto. */
  readonly branch = requireEnv("BRANCH");

  /** This run's page, linked from the comment. */
  readonly runUrl = requireEnv("RUN_URL");

  /** The platform commit the build checkout is at. */
  readonly build = mustCapture(["git", "-C", "build", "rev-parse", "HEAD"]);

  /** The API under the repository token, so comments and label removals appear as the bot login. */
  readonly github = new GitHubClient();

  /** The pull request as an issue: its labels and comments live there. */
  readonly issue = `repos/${this.repository}/issues/${this.prNumber}`;

  /** A git argv against the target clone. */
  git(...args: string[]): string[] {
    return ["git", "-C", "target", ...args];
  }

  /** One bounded call; its stderr is echoed to the job log once it returns. */
  run(argv: string[]): { ok: boolean; stdout: string; stderr: string } {
    const result = capture(argv, { timeoutMs: DELIVERY_CALL_BOUND_MS });
    if (result.stderr !== "") console.error(result.stderr.replace(/\n$/, ""));
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
  }

  /** A nonzero exit fails the job with `reason`; the stdout otherwise. */
  must(argv: string[], reason: string): string {
    const call = this.run(argv);
    if (!call.ok) fail(reason);
    return call.stdout;
  }

  /** A label already off counts as removed: a human took it off and put it back while an earlier run was still on its way here. */
  async removeLabel(): Promise<void> {
    const removed = await this.github.remove(
      `${this.issue}/labels/${encodeURIComponent(SYNC_LABEL)}`,
    );
    if (removed.kind === "ok") return;

    fail(`removing the ${SYNC_LABEL} label failed (${unansweredReason(removed)})`);
  }

  /** One comment per pull request: the earlier one is replaced in place. */
  async comment(outcome: Outcome): Promise<void> {
    const body = commentBody(outcome, {
      build: this.build,
      branch: this.branch,
      runUrl: this.runUrl,
    });
    const comments = `${this.issue}/comments`;
    const listed = await this.github.paginate(comments, issueComment);
    if (listed.kind !== "ok") {
      fail(`listing the pull request's comments failed (${unansweredReason(listed)})`);
    }

    const earlier = stickyComment(listed.value, COMMENT_MARKER);
    const posted =
      earlier === null
        ? await this.github.send("POST", comments, { body })
        : await this.github.send(
            "PATCH",
            `repos/${this.repository}/issues/comments/${earlier.id}`,
            { body },
          );
    if (posted.kind !== "ok") {
      fail(`posting the pull request comment failed (${unansweredReason(posted)})`);
    }
  }

  /** The branch sync end to end; every outcome ends as the one comment on the pull request. */
  async deliver(): Promise<void> {
    await this.removeLabel();
    const migrate = requireEnv("MIGRATE_OUTCOME");
    const writer = requireEnv("WRITER_OUTCOME");
    if (migrate !== "success" || writer !== "success") {
      const what = migrate === "success" ? "the writer" : "a migration rung";
      await this.comment({ kind: "failed", what, log: tail(join(this.runnerTemp, SYNC_LOG)) });
      fail(`${what} failed; its log is in the pull request comment`);
    }
    const summary = parseJsonWith(
      syncReport,
      readFileSync(join(this.runnerTemp, SUMMARY_FILE), "utf-8"),
      SUMMARY_FILE,
    );
    const report = readFileSync(join(this.runnerTemp, SYNC_LOG), "utf-8");
    if (summary.hold) {
      await this.comment({ kind: "held", report });
      fail(summary.holdReasons.map((reason) => `the writer holds the branch: ${reason}`));
    }

    for (const argv of [
      this.git("config", "user.name", SYNC_IDENTITY.name),
      this.git("config", "user.email", SYNC_IDENTITY.email),
    ]) {
      this.must(argv, `${argv.slice(3).join(" ")} failed in the branch checkout`);
    }
    const changed = stageWritten(
      summary,
      readMigrated(this.runnerTemp),
      (...args) => this.git(...args),
      (argv, reason) => this.must(argv, reason),
    );
    const workflows = changed.filter((path) => path.startsWith(WORKFLOWS_DIR));
    if (workflows.length > 0) {
      await this.comment({ kind: "workflow files", paths: workflows, report });
      fail(
        `the sync changes ${workflows.join(", ")}: the repository token cannot create or update a workflow file`,
      );
    }
    if (changed.length === 0) {
      // A relabel queued behind the run that pushed lands here on that run's commit: its approval instruction stays.
      const author = this.must(
        this.git("log", "-1", "--format=%an"),
        "reading the tip's author failed",
      ).trim();
      await this.comment({ kind: "unchanged", tipIsOurs: author === SYNC_IDENTITY.name });
      console.log(`the branch already matches build ${this.build}; nothing to push`);
      return;
    }

    // The lease is the commit checked out, so a commit pushed to the branch meanwhile refuses the push instead of being overwritten.
    const tip = this.must(
      this.git("rev-parse", "HEAD"),
      "reading the checkout's commit failed",
    ).trim();
    this.must(this.git("commit", "-q", "-m", prTitle(this.build)), "committing the sync failed");
    const pushed = this.run(
      this.git(
        "push",
        "--quiet",
        `--force-with-lease=${this.branch}:${tip}`,
        "origin",
        `HEAD:refs/heads/${this.branch}`,
      ),
    );
    if (!pushed.ok) {
      await this.comment({ kind: "push rejected", log: pushed.stderr });
      fail(`pushing ${this.branch} was refused; git's message is in the pull request comment`);
    }
    const commit = this.must(
      this.git("rev-parse", "HEAD"),
      "reading the pushed commit failed",
    ).trim();
    await this.comment({ kind: "pushed", commit, report });
    console.log(`build ${this.build} pushed onto ${this.branch} as ${commit}`);
  }
}

if (import.meta.main) await new BranchDelivery().deliver();

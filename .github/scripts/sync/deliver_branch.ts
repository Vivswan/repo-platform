#!/usr/bin/env bun
// The delivery step of the managed sync-branch.yml, run from the platform checkout at `stable` inside the labeled pull
// request's own repository (docs/sync.md, "Syncing a branch by label"). The log is the repository's own, so nothing here
// is redacted; the pull request's one sticky comment is the record a human reads.
//
//   label off first          -> adding it again is a new run whatever happens below
//   writer or rung failed    -> the log tail in the comment, red
//   the writer holds         -> the report in the comment, red, nothing pushed: a hold is a human's call, and this
//                               branch is a human's (judged before the tree is compared: a held link leaves no diff)
//   a workflow file changed  -> red, nothing pushed: the repository token cannot create or update a file under
//                               .github/workflows, so the comment names the operator's branch dispatch instead
//   tree already matches     -> the comment says so, green, nothing pushed (still asking for the empty commit when the
//                               tip is this bot's: a relabel queued behind the run that pushed lands here)
//   pushed                   -> the report in the comment, which asks for an empty commit: a push with the repository
//                               token fires no pull_request run, and a dispatched ci.yml run would judge less than one

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_NAME, PLATFORM_SLUG, SYNC_LABEL } from "../../../actions/shared/platform.ts";
import { fail, requireEnv } from "../shared/gha.ts";
import { SYNC_IDENTITY } from "../shared/git_identity.ts";
import { capture, mustCapture } from "../shared/proc.ts";
import {
  boundedReport,
  DELIVERY_CALL_BOUND_MS,
  fenceFor,
  prTitle,
  SUMMARY_FILE,
  SYNC_LOG,
  tail,
} from "./deliver.ts";

/** The first line of the sticky comment; the finder matches it, so it never changes shape. */
const COMMENT_MARKER = `<!-- ${PLATFORM_NAME} sync-branch -->`;

/** The login the repository token comments under. */
const COMMENT_LOGIN = "github-actions[bot]";

const WORKFLOWS_DIR = ".github/workflows/";

type Outcome =
  | { kind: "failed"; what: "a migration rung" | "the writer"; log: string }
  | { kind: "held"; report: string }
  | { kind: "workflow files"; paths: string[]; report: string }
  | { kind: "unchanged"; tipIsOurs: boolean }
  | { kind: "push rejected"; log: string }
  | { kind: "pushed"; commit: string; report: string };

const EMPTY_COMMIT_LINE =
  'The checks do not run on a commit pushed with the repository token: push an empty commit (`git commit --allow-empty -m "chore: run the checks"`) to run them on the new head.';

function commentBody(
  outcome: Outcome,
  input: { build: string; branch: string; runUrl: string },
): string {
  const build = `Build \`${input.build}\``;
  const branch = `\`${input.branch}\``;
  const run = `([run](${input.runUrl}))`;
  const report = (text: string) => ["", boundedReport(text).replace(/\n$/, "")];
  const fenced = (text: string) => {
    const fence = fenceFor(text);
    return ["", `${fence}text`, text.replace(/\n$/, ""), fence];
  };
  const lines = (() => {
    switch (outcome.kind) {
      case "failed":
        return [`${build} NOT pushed: ${outcome.what} failed ${run}.`, ...fenced(outcome.log)];
      case "held":
        return [
          `${build} NOT pushed: the writer holds ${branch} for review, see the Review section ${run}.`,
          ...report(outcome.report),
        ];
      case "workflow files":
        return [
          `${build} NOT pushed: the sync changes ${outcome.paths.map((path) => `\`${path}\``).join(", ")}, and the repository token cannot create or update a workflow file ${run}.`,
          `The owner's dispatch of sync-repos.yml in ${PLATFORM_SLUG} with \`repo=<owner>/<name>\` and \`branch=${input.branch}\` pushes the same commit with the fleet token.`,
          ...report(outcome.report),
        ];
      case "unchanged":
        return [
          `${build}: ${branch} already matches it, nothing pushed ${run}.`,
          ...(outcome.tipIsOurs ? [EMPTY_COMMIT_LINE] : []),
        ];
      case "push rejected":
        return [
          `${build} NOT pushed: the push onto ${branch} was refused ${run}. A commit that reached the branch meanwhile is the usual cause; add the \`${SYNC_LABEL}\` label again once the branch is where you want it.`,
          ...fenced(outcome.log),
        ];
      case "pushed":
        return [
          `${build} pushed onto ${branch} as ${outcome.commit} ${run}.`,
          EMPTY_COMMIT_LINE,
          ...report(outcome.report),
        ];
    }
  })();
  return [COMMENT_MARKER, ...lines, ""].join("\n");
}

class BranchDelivery {
  readonly runnerTemp = requireEnv("RUNNER_TEMP");
  readonly repository = requireEnv("GITHUB_REPOSITORY");
  readonly prNumber = requireEnv("PR_NUMBER");
  readonly branch = requireEnv("BRANCH");
  readonly runUrl = requireEnv("RUN_URL");
  readonly build = mustCapture(["git", "-C", "build", "rev-parse", "HEAD"]);

  git(...args: string[]): string[] {
    return ["git", "-C", "target", ...args];
  }

  api(...args: string[]): string[] {
    return ["gh", "api", ...args];
  }

  run(
    argv: string[],
    env?: Record<string, string>,
  ): { ok: boolean; stdout: string; stderr: string } {
    const result = capture(argv, {
      timeoutMs: DELIVERY_CALL_BOUND_MS,
      ...(env === undefined ? {} : { env }),
    });
    if (result.stderr !== "") console.error(result.stderr.replace(/\n$/, ""));
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
  }

  must(argv: string[], reason: string): string {
    const call = this.run(argv);
    if (!call.ok) fail(reason);
    return call.stdout;
  }

  /** A 404 is the label already off: a human took it off and put it back while an earlier run was still on its way here. */
  removeLabel(): void {
    const removed = this.run(
      this.api(
        "--method",
        "DELETE",
        "--silent",
        `repos/${this.repository}/issues/${this.prNumber}/labels/${encodeURIComponent(SYNC_LABEL)}`,
      ),
    );
    if (!removed.ok && !/HTTP 404/.test(removed.stderr))
      fail(`removing the ${SYNC_LABEL} label failed`);
  }

  /** One comment per pull request: the marker under this bot's login finds the earlier one, which is replaced (a human
   *  can start a comment with the marker; the login is the token's own). */
  comment(outcome: Outcome): void {
    const bodyFile = join(this.runnerTemp, "sync-branch-comment.md");
    writeFileSync(
      bodyFile,
      commentBody(outcome, { build: this.build, branch: this.branch, runUrl: this.runUrl }),
    );
    // The jq filter reads the marker and the login from env: a literal in the filter would need jq quoting of its own.
    const found = this.run(
      this.api(
        `repos/${this.repository}/issues/${this.prNumber}/comments`,
        "--paginate",
        "--jq",
        ".[] | select(.user.login == env.LOGIN and (.body | startswith(env.MARKER))) | .id",
      ),
      { MARKER: COMMENT_MARKER, LOGIN: COMMENT_LOGIN },
    );
    if (!found.ok) fail("listing the pull request's comments failed");
    const id = found.stdout.trim().split("\n")[0] ?? "";
    this.must(
      id === ""
        ? this.api(
            "--method",
            "POST",
            "--silent",
            `repos/${this.repository}/issues/${this.prNumber}/comments`,
            "-F",
            `body=@${bodyFile}`,
          )
        : this.api(
            "--method",
            "PATCH",
            "--silent",
            `repos/${this.repository}/issues/comments/${id}`,
            "-F",
            `body=@${bodyFile}`,
          ),
      "posting the pull request comment failed",
    );
  }

  deliver(): void {
    this.removeLabel();
    const migrate = requireEnv("MIGRATE_OUTCOME");
    const writer = requireEnv("WRITER_OUTCOME");
    if (migrate !== "success" || writer !== "success") {
      const what = migrate === "success" ? "the writer" : "a migration rung";
      this.comment({ kind: "failed", what, log: tail(join(this.runnerTemp, SYNC_LOG)) });
      fail(`${what} failed; its log is in the pull request comment`);
    }
    const summary = JSON.parse(readFileSync(join(this.runnerTemp, SUMMARY_FILE), "utf-8")) as {
      hold: boolean;
      holdReasons: string[];
    };
    const report = readFileSync(join(this.runnerTemp, SYNC_LOG), "utf-8");
    if (summary.hold) {
      this.comment({ kind: "held", report });
      fail(summary.holdReasons.map((reason) => `the writer holds the branch: ${reason}`));
    }

    for (const argv of [
      this.git("config", "user.name", SYNC_IDENTITY.name),
      this.git("config", "user.email", SYNC_IDENTITY.email),
      this.git("add", "--all"),
    ]) {
      this.must(argv, `${argv.slice(3).join(" ")} failed in the branch checkout`);
    }
    // NUL-delimited so no path is quoted, renames off so a retired path is listed as its own deletion.
    const changed = this.must(
      this.git("diff", "--cached", "--name-only", "-z", "--no-renames"),
      "reading the staged paths failed",
    )
      .split("\0")
      .filter((path) => path !== "");
    const workflows = changed.filter((path) => path.startsWith(WORKFLOWS_DIR));
    if (workflows.length > 0) {
      this.comment({ kind: "workflow files", paths: workflows, report });
      fail(
        `the sync changes ${workflows.join(", ")}: the repository token cannot create or update a workflow file`,
      );
    }
    if (changed.length === 0) {
      const author = this.must(
        this.git("log", "-1", "--format=%an"),
        "reading the tip's author failed",
      ).trim();
      this.comment({ kind: "unchanged", tipIsOurs: author === SYNC_IDENTITY.name });
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
      this.comment({ kind: "push rejected", log: pushed.stderr });
      fail(`pushing ${this.branch} was refused; git's message is in the pull request comment`);
    }
    const commit = this.must(
      this.git("rev-parse", "HEAD"),
      "reading the pushed commit failed",
    ).trim();
    this.comment({ kind: "pushed", commit, report });
    console.log(`build ${this.build} pushed onto ${this.branch} as ${commit}`);
  }
}

if (import.meta.main) new BranchDelivery().deliver();

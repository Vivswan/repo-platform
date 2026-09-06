// End-to-end sentinel on commit_push.ts's credential redaction: git's OWN
// error text quotes the credentialed push URL back (the 401/403 shape),
// and redactCommand only covers our argv lines - so the script must pass
// every re-emission of git's output (stderr, stdout, the hidden capture
// files) through redactText. A stub git on PATH forces the credentialed
// error shapes; the assertions are on the script's whole public output.

import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capture } from "../../.github/scripts/shared/proc.ts";
import { tempDirs } from "../shared/temp_dir";

const fixtures = tempDirs();

const REPO_ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(REPO_ROOT, ".github/scripts/sync/commit_push.ts");
const SENTINEL = "ghp_SENTINEL";
const GIT_ERROR = `fatal: unable to access 'https://x-access-token:${SENTINEL}@github.com/o/r.git/': The requested URL returned error: 403`;

// Case order matters: the push argv also contains the URL, so ls-remote
// must match first. STUB_MODE=lease-fail fails the lease probe; push-fail
// serves the lease and fails the push itself; stale-push-fail fails the
// push with stale-lease evidence flanked by 403-shaped progress bytes;
// protect-push-fail fails it quoting a file whose NAME says "stale info";
// workflow-refused fails it with GitHub's Workflows-scope refusal.
const STUB_GIT = `#!/bin/sh
case "$*" in
  *ls-remote*)
    if [ "$STUB_MODE" = "lease-fail" ]; then
      echo "${GIT_ERROR}" >&2
      exit 128
    fi
    printf '0123456789012345678901234567890123456789\\trefs/heads/automation/repo-platform\\n'
    exit 0 ;;
  *" push "*)
    if [ "$STUB_MODE" = "stale-push-fail" ]; then
      echo "remote: Resolving deltas: 100% (403/403), done." >&2
      echo " ! [rejected]        automation/repo-platform -> automation/repo-platform (stale info)" >&2
      exit 1
    fi
    if [ "$STUB_MODE" = "protect-push-fail" ]; then
      echo 'remote: error: GH013: Repository rule violations found for "(stale info).txt".' >&2
      exit 1
    fi
    if [ "$STUB_MODE" = "workflow-refused" ]; then
      echo "refusing to allow a Personal Access Token to create or update workflow files without workflows permission" >&2
      exit 1
    fi
    if [ "$STUB_MODE" = "push-ok" ]; then exit 0; fi
    echo "${GIT_ERROR}" >&2
    echo "remote: see https://x-access-token:${SENTINEL}@github.com/o/r.git"
    exit 1 ;;
  *" checkout "*|*" rm "*|*" reset "*)
    # A tree rewrite after a refused push would be a partial-delivery
    # fallback, which no longer exists; make one observable.
    echo "TREE-REWRITE $*" >> "$STUB_STATE.calls"
    exit 0 ;;
  *) exit 0 ;;
esac
`;

let scratch: string;
let stubBin: string;

beforeAll(() => {
  scratch = fixtures.dir("commit-push-");
  stubBin = join(scratch, "bin");
  mkdirSync(stubBin);
  mkdirSync(join(scratch, "work", "target"), { recursive: true });
  writeFileSync(join(stubBin, "git"), STUB_GIT);
  chmodSync(join(stubBin, "git"), 0o755);
});

function runCommitPush(
  mode: string,
  hideDetails: string,
  temp: Record<string, string> = {},
  work: string = join(scratch, "work"),
) {
  const runnerTemp = fixtures.dir("rt-");
  writeFileSync(join(runnerTemp, "gh-output.txt"), "");
  for (const [name, content] of Object.entries(temp)) {
    writeFileSync(join(runnerTemp, name), content);
  }
  const result = capture([process.execPath, SCRIPT], {
    cwd: work,
    env: {
      PATH: `${stubBin}:${process.env.PATH}`,
      STUB_MODE: mode,
      STUB_STATE: join(runnerTemp, "push-state"),
      TARGET: "o/r",
      TARGET_DISPLAY: hideDetails === "true" ? "repo #1" : "",
      BRANCH: "automation/repo-platform",
      DISPLAY: "v1 (abcdef012345)",
      PAT: SENTINEL,
      HIDE_DETAILS: hideDetails,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: join(runnerTemp, "gh-output.txt"),
    },
    timeoutMs: 30_000,
  });
  return { ...result, runnerTemp };
}

// One spawn per (STUB_MODE, HIDE_DETAILS) input, each pinning that run's
// whole public outcome: both streams, the ::error shape line, and the
// hidden-failure manifest (present with a redacted capture for a hidden
// target; absent for a public one, whose log already carries the redacted
// output - a stray manifest would have the deliver step re-post it).
describe("commit_push failure paths: redaction, diagnostics, hidden-failure manifest", () => {
  test("a public target's failing lease probe re-emits git's error redacted and points at the log", () => {
    const result = runCommitPush("lease-fail", "false");
    expect(result.exitCode).toBe(128);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    expect(result.stderr).toContain("unable to access 'https://***@github.com/o/r.git/'");
    // Public target: the ::error names the shape and points at the log.
    expect(result.stdout).toContain("::error::reading the branch lease");
    expect(result.stdout).toContain("exit 128");
    expect(result.stdout).toContain("git's output is in the log above");
    expect(existsSync(join(result.runnerTemp, "hidden-failures.tsv"))).toBe(false);
  });

  test("a hidden target's failing lease probe emits no git output and lands redacted in the failure-issue manifest", () => {
    const result = runCommitPush("lease-fail", "true");
    expect(result.exitCode).toBe(128);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    expect(result.stderr).not.toContain("o/r");
    expect(result.stdout).toContain("(ls-remote output hidden: private repository)");
    // The public pointer replaces the false "see the log above": the log
    // says only "output hidden", the issue carries the detail - and the
    // promise is scoped to what the capture holds (the error stream).
    expect(result.stdout).toContain(
      "the redacted error output is delivered to the target's failure-report issue",
    );
    const manifest = readFileSync(join(result.runnerTemp, "hidden-failures.tsv"), "utf-8");
    const [label, rc, capturePath] = manifest.trimEnd().split("\t");
    expect([label, rc]).toEqual(["branch lease", "128"]);
    const captured = readFileSync(capturePath, "utf-8");
    expect(captured).not.toContain(SENTINEL);
    expect(captured).toContain("unable to access 'https://***@github.com/o/r.git/'");
  });

  test("a public target's failing push redacts both re-emitted streams and names the failure shape", () => {
    // The capture-file leg of the redaction property is asserted on the
    // hidden push failure below - the file only exists on that path.
    const result = runCommitPush("push-fail", "false");
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    expect(result.stderr).toContain("unable to access 'https://***@github.com/o/r.git/'");
    expect(result.stdout).toContain("https://***@github.com/o/r.git");
    // The stub's git error carries a 403, so the shape line may OFFER the
    // authorization lead - but keyed on evidence, alongside the exit code,
    // instead of asserting one cause.
    expect(result.stdout).toContain("::error::pushing to o/r#automation/repo-platform failed");
    expect(result.stdout).toContain("exit 1");
    expect(result.stdout).toContain("authorization-shaped");
    expect(result.stdout).not.toContain("see the log above");
    expect(existsSync(join(result.runnerTemp, "hidden-failures.tsv"))).toBe(false);
  });

  test("a hidden target's failing push keeps its slug off both streams and lands redacted in the failure-issue manifest", () => {
    const result = runCommitPush("push-fail", "true");
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    // Redaction alone would keep the slug (o/r survives redactText); the
    // hidden path must withhold git's output on BOTH streams entirely.
    expect(result.stdout + result.stderr).not.toContain("o/r");
    expect(result.stdout).toContain("(push output hidden: private repository)");
    expect(result.stdout).toContain("delivered to the target's failure-report issue");
    const manifest = readFileSync(join(result.runnerTemp, "hidden-failures.tsv"), "utf-8");
    const [label, rc, capturePath] = manifest.trimEnd().split("\t");
    expect([label, rc]).toEqual(["branch push", "1"]);
    const captured = readFileSync(capturePath, "utf-8");
    expect(captured).not.toContain(SENTINEL);
    expect(captured).toContain("unable to access 'https://***@github.com/o/r.git/'");
  });
});

describe("commit_push failure diagnostics", () => {
  test("stale-lease evidence outranks 403-shaped bytes in ordinary git output", () => {
    // The stub's stale failure carries "(403/403)" progress bytes, which
    // the authorization pattern's bare-number alternative matches (403
    // flanked by non-digits) - the exact stale-lease needle must win. The
    // public push-fail case above is the control: a real 403 error with no
    // stale evidence still gets the authorization lead.
    const result = runCommitPush("stale-push-fail", "false");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("the lease was stale");
    expect(result.stdout).not.toContain("authorization-shaped");
  });

  test("a quoted filename saying '(stale info)' does not mislabel the failure", () => {
    // The needle requires git's structured rejection line ("[rejected]
    // ... (stale info)"); a push-protection rejection quoting a file
    // literally named "(stale info).txt" - parens and all - must not read
    // as a stale lease.
    const result = runCommitPush("protect-push-fail", "false");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("exit 1");
    expect(result.stdout).not.toContain("the lease was stale");
    expect(result.stdout).not.toContain("authorization-shaped");
  });
});

describe("commit_push refuses a partial delivery", () => {
  const REFUSED =
    "exit 1; GitHub refused a workflow-file change - the REPO_PLATFORM_TOKEN must grant " +
    "Workflows read/write on the target (README.md)";
  // A workflow-file change pushed with a token lacking Workflows write: GitHub refuses the
  // push and the step goes red naming the target and the scope. The tree still holds the change,
  // no tree-rewriting git call runs, no output is written. Each row pins the whole outcome.
  test.each<{
    hideDetails: string;
    publicLines: string[];
    stderrCarriesRefusal: boolean;
    hiddenManifest: string[] | null;
  }>([
    {
      hideDetails: "false",
      publicLines: [
        `::error::pushing to o/r#automation/repo-platform failed (${REFUSED}). git's output is in the log above.`,
      ],
      stderrCarriesRefusal: true,
      hiddenManifest: null,
    },
    {
      hideDetails: "true",
      publicLines: [
        "(push output hidden: private repository)",
        `::error::pushing to repo #1#automation/repo-platform failed (${REFUSED}). git's output is hidden ` +
          "from this log (private repository); the redacted error output is delivered to the " +
          "target's failure-report issue (docs/private-repos.md).",
      ],
      stderrCarriesRefusal: false,
      hiddenManifest: ["branch push", "1"],
    },
  ])(
    "a refused workflow-file push is a red step with the tree untouched (hide details: $hideDetails)",
    ({ hideDetails, publicLines, stderrCarriesRefusal, hiddenManifest }) => {
      const work = fixtures.dir("work-");
      const workflow = join(work, "target", ".github/workflows/new.yml");
      mkdirSync(dirname(workflow), { recursive: true });
      writeFileSync(workflow, "name: new\n");
      const result = runCommitPush("workflow-refused", hideDetails, {}, work);
      const manifestPath = join(result.runnerTemp, "hidden-failures.tsv");
      expect({
        exitCode: result.exitCode,
        workflowStillInTree: readFileSync(workflow, "utf-8"),
        treeRewrites: existsSync(join(result.runnerTemp, "push-state.calls")),
        outputs: readFileSync(join(result.runnerTemp, "gh-output.txt"), "utf-8"),
        publicLines: result.stdout.split("\n").filter((line) => line !== ""),
        stderrCarriesRefusal: result.stderr.includes("create or update workflow files"),
        hiddenManifest: existsSync(manifestPath)
          ? readFileSync(manifestPath, "utf-8").trimEnd().split("\t").slice(0, 2)
          : null,
      }).toEqual({
        exitCode: 1,
        workflowStillInTree: "name: new\n",
        treeRewrites: false,
        outputs: "",
        publicLines,
        stderrCarriesRefusal,
        hiddenManifest,
      });
    },
  );

  test("control: an accepted push reports pushed=true and touches nothing else", () => {
    const work = fixtures.dir("work-");
    mkdirSync(join(work, "target"), { recursive: true });
    const result = runCommitPush("push-ok", "false", {}, work);
    expect({
      exitCode: result.exitCode,
      outputs: readFileSync(join(result.runnerTemp, "gh-output.txt"), "utf-8"),
      notices: result.stdout.split("\n").filter((line) => line.startsWith("::")),
      treeRewrites: existsSync(join(result.runnerTemp, "push-state.calls")),
    }).toEqual({ exitCode: 0, outputs: "pushed=true\n", notices: [], treeRewrites: false });
  });
});

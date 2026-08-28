// End-to-end sentinel on commit_push.ts's credential redaction: git's OWN
// error text quotes the credentialed push URL back (the 401/403 shape),
// and redactCommand only covers our argv lines - so the script must pass
// every re-emission of git's output (stderr, stdout, the hidden capture
// files) through redactText. A stub git on PATH forces the credentialed
// error shapes; the assertions are on the script's whole public output.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../../.github/scripts/shared/proc.ts";
import {
  ALL_GREEN_BOOTSTRAP_NAME,
  REFERENCED_LABELS_NAME,
} from "../../.github/scripts/sync/section_files.ts";

const SCRIPT = join(import.meta.dir, "../../.github/scripts/sync/commit_push.ts");
const SENTINEL = "ghp_SENTINEL";
const GIT_ERROR = `fatal: unable to access 'https://x-access-token:${SENTINEL}@github.com/o/r.git/': The requested URL returned error: 403`;

// Case order matters: the push argv also contains the URL, so ls-remote
// must match first. STUB_MODE=lease-fail fails the lease probe; push-fail
// serves the lease and fails the push itself; stale-push-fail fails the
// push with stale-lease evidence flanked by 403-shaped progress bytes;
// protect-push-fail fails it quoting a file whose NAME says "stale info".
// The withhold-* modes drive the Workflows-scope fallback end to end: the
// FIRST push fails with the workflow-permission shape (STUB_STATE marks
// it spent), the diff calls report the named workflow file as the
// withheld change, and the retry push succeeds.
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
    case "$STUB_MODE" in
      withhold-*)
        if [ -f "$STUB_STATE" ]; then exit 0; fi
        : > "$STUB_STATE"
        echo "refusing to allow a Personal Access Token to create or update workflow files without workflows permission" >&2
        exit 1 ;;
    esac
    echo "${GIT_ERROR}" >&2
    echo "remote: see https://x-access-token:${SENTINEL}@github.com/o/r.git"
    exit 1 ;;
  *"--diff-filter=A"*)
    # The added-files query: nothing was ADDED in these fixtures - the
    # withheld file pre-exists, so reporting it here would have the
    # restore path rmSync the very file the checkout case just restored.
    exit 0 ;;
  *"diff --name-only"*)
    if [ "$STUB_MODE" = "withhold-allgreen" ]; then echo ".github/workflows/all-green.yml"; fi
    if [ "$STUB_MODE" = "withhold-other" ]; then echo ".github/workflows/ci.yml"; fi
    if [ "$STUB_MODE" = "withhold-restore" ]; then echo ".github/workflows/ci.yml"; fi
    exit 0 ;;
  *" checkout "*)
    # The withhold-restore mode makes the workflow-dir restore OBSERVABLE:
    # the restored ci.yml references a different label than the pre-restore
    # copy, so a consumer reading the tree too early is caught.
    if [ "$STUB_MODE" = "withhold-restore" ]; then
      mkdir -p target/.github/workflows
      printf 'jobs:\\n  close:\\n    steps:\\n      - with:\\n          stale-issue-label: restored-label\\n' > target/.github/workflows/ci.yml
    fi
    exit 0 ;;
  *"diff --quiet"*)
    exit 1 ;;
  *) exit 0 ;;
esac
`;

let scratch: string;
let stubBin: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "commit-push-"));
  stubBin = join(scratch, "bin");
  mkdirSync(stubBin);
  mkdirSync(join(scratch, "work", "target"), { recursive: true });
  writeFileSync(join(stubBin, "git"), STUB_GIT);
  chmodSync(join(stubBin, "git"), 0o755);
});

function runCommitPush(mode: string, hideDetails: string, temp: Record<string, string> = {}) {
  const runnerTemp = mkdtempSync(join(scratch, "rt-"));
  writeFileSync(join(runnerTemp, "gh-output.txt"), "");
  for (const [name, content] of Object.entries(temp)) {
    writeFileSync(join(runnerTemp, name), content);
  }
  const result = capture([process.execPath, SCRIPT], {
    cwd: join(scratch, "work"),
    env: {
      PATH: `${stubBin}:${process.env.PATH}`,
      STUB_MODE: mode,
      STUB_STATE: join(runnerTemp, "push-state"),
      TARGET: "o/r",
      TARGET_DISPLAY: hideDetails === "true" ? "repo #1" : "",
      BRANCH: "automation/repo-platform",
      DISPLAY: "v1 (abcdef012345)",
      BASE_BRANCH: "main",
      PAT: SENTINEL,
      HIDE_DETAILS: hideDetails,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: join(runnerTemp, "gh-output.txt"),
    },
    timeoutMs: 30_000,
  });
  return { ...result, runnerTemp };
}

describe("commit_push credential redaction", () => {
  test("a failing lease probe re-emits git's error redacted", () => {
    const result = runCommitPush("lease-fail", "false");
    expect(result.exitCode).toBe(128);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    expect(result.stderr).toContain("unable to access 'https://***@github.com/o/r.git/'");
    // Public target: the ::error names the shape and points at the log.
    expect(result.stdout).toContain("::error::reading the branch lease");
    expect(result.stdout).toContain("exit 128");
    expect(result.stdout).toContain("git's output is in the log above");
  });

  test("a hidden target's failing lease probe emits no git output at all", () => {
    const result = runCommitPush("lease-fail", "true");
    expect(result.exitCode).toBe(128);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    expect(result.stderr).not.toContain("o/r");
    expect(result.stdout).toContain("(ls-remote output hidden: private repository)");
  });

  test("a failing push redacts both re-emitted streams", () => {
    // The capture-file leg of the redaction property is asserted on the
    // hidden push failure below - the file only exists on that path.
    const result = runCommitPush("push-fail", "false");
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    expect(result.stderr).toContain("unable to access 'https://***@github.com/o/r.git/'");
    expect(result.stdout).toContain("https://***@github.com/o/r.git");
  });

  test("a hidden target's failing push keeps its slug off both streams", () => {
    const result = runCommitPush("push-fail", "true");
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    // Redaction alone would keep the slug (o/r survives redactText); the
    // hidden path must withhold git's output on BOTH streams entirely.
    expect(result.stdout + result.stderr).not.toContain("o/r");
    expect(result.stdout).toContain("(push output hidden: private repository)");
  });
});

describe("commit_push failure diagnostics", () => {
  test("the push ::error names the failure shape instead of asserting one cause", () => {
    // The stub's git error carries a 403, so the shape line may OFFER the
    // authorization lead - but keyed on evidence, alongside the exit code.
    const result = runCommitPush("push-fail", "false");
    expect(result.stdout).toContain("::error::pushing to o/r#automation/repo-platform failed");
    expect(result.stdout).toContain("exit 1");
    expect(result.stdout).toContain("authorization-shaped");
    expect(result.stdout).not.toContain("see the log above");
  });

  test("stale-lease evidence outranks 403-shaped bytes in ordinary git output", () => {
    // The stub's stale failure carries "(403/403)" progress bytes, which
    // the authorization pattern's bare-number alternative matches (403
    // flanked by non-digits) - the exact stale-lease needle must win. The
    // push-fail case above is the control: a real 403 error with no stale
    // evidence still gets the authorization lead.
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

  test("a hidden target's lease failure lands redacted in the failure-issue manifest", () => {
    const result = runCommitPush("lease-fail", "true");
    const manifest = readFileSync(join(result.runnerTemp, "hidden-failures.tsv"), "utf-8");
    const [label, rc, capturePath] = manifest.trimEnd().split("\t");
    expect(label).toBe("branch lease");
    expect(rc).toBe("128");
    const captured = readFileSync(capturePath, "utf-8");
    expect(captured).not.toContain(SENTINEL);
    expect(captured).toContain("unable to access 'https://***@github.com/o/r.git/'");
    // The public pointer replaces the false "see the log above": the log
    // says only "output hidden", the issue carries the detail - and the
    // promise is scoped to what the capture holds (the error stream).
    expect(result.stdout).toContain(
      "the redacted error output is delivered to the target's failure-report issue",
    );
  });

  test("a hidden target's push failure lands redacted in the failure-issue manifest", () => {
    const result = runCommitPush("push-fail", "true");
    const manifest = readFileSync(join(result.runnerTemp, "hidden-failures.tsv"), "utf-8");
    const [label, rc, capturePath] = manifest.trimEnd().split("\t");
    expect(label).toBe("branch push");
    expect(rc).toBe("1");
    const captured = readFileSync(capturePath, "utf-8");
    expect(captured).not.toContain(SENTINEL);
    expect(captured).toContain("unable to access 'https://***@github.com/o/r.git/'");
    expect(result.stdout).toContain("delivered to the target's failure-report issue");
  });

  test("a public target's failures write no failure-issue manifest", () => {
    // The channel is the hidden targets' compensation; a public log
    // already carries the redacted output, and a stray manifest would
    // have the deliver step re-post it.
    for (const mode of ["lease-fail", "push-fail"]) {
      const result = runCommitPush(mode, "false");
      expect(existsSync(join(result.runnerTemp, "hidden-failures.tsv"))).toBe(false);
    }
  });
});

describe("commit_push Workflows-scope withhold reconciliation", () => {
  const NOTE = "> [!IMPORTANT]\n> FIRST VERDICT DELIVERY: merge once with admin bypass.\n";

  test("withholding all-green.yml clears the bootstrap note (the PR no longer introduces it)", () => {
    const result = runCommitPush("withhold-allgreen", "false", {
      [ALL_GREEN_BOOTSTRAP_NAME]: NOTE,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(result.runnerTemp, "withheld-workflows.txt"), "utf-8")).toContain(
      ".github/workflows/all-green.yml",
    );
    expect(readFileSync(join(result.runnerTemp, ALL_GREEN_BOOTSTRAP_NAME), "utf-8")).toBe("");
    expect(result.stdout).toContain("workflow-file changes were withheld");
  });

  test("withholding a different workflow leaves the bootstrap note intact", () => {
    const result = runCommitPush("withhold-other", "false", {
      [ALL_GREEN_BOOTSTRAP_NAME]: NOTE,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(result.runnerTemp, "withheld-workflows.txt"), "utf-8")).toContain(
      ".github/workflows/ci.yml",
    );
    expect(readFileSync(join(result.runnerTemp, ALL_GREEN_BOOTSTRAP_NAME), "utf-8")).toBe(NOTE);
  });

  test("the withhold overwrites a stale referenced-labels report (the recompute runs post-restore)", () => {
    // The workflow's check step ran BEFORE the restore rewrote
    // .github/workflows, so its report may claim label references the
    // pushed tree no longer carries. This fixture opts out of
    // settings-sync (the shared scratch target is not a full checkout),
    // so it pins that the recompute RUNS and overwrites - the stale note
    // is replaced with that tree's honest verdict (empty: not
    // applicable). The ordering pin is the next test.
    const staleNote = '> [!WARNING]\n> REFERENCED LABELS: "answered" is missing\n';
    writeFileSync(join(scratch, "work", "target", ".repo-platform.yml"), "modules: []\n");
    writeFileSync(join(scratch, "work", "target", ".copier-answers.yml"), "private: false\n");
    const result = runCommitPush("withhold-other", "false", {
      [REFERENCED_LABELS_NAME]: staleNote,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(result.runnerTemp, REFERENCED_LABELS_NAME), "utf-8")).toBe("");
    expect(result.stdout).toContain("referenced labels: not applicable");
  });

  test("the recompute reads the RESTORED workflow content, never the pre-restore tree", () => {
    // Full settings-sync fixture, with a workflow whose label reference
    // the stub git's checkout REWRITES (pre-restore-label ->
    // restored-label). The recomputed report must name the restored
    // reference; the pre-restore one surviving would mean the recompute
    // ran before the restore and the PR body describes a tree that was
    // never pushed.
    const targetDir = join(scratch, "work", "target");
    mkdirSync(join(targetDir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(targetDir, ".repo-platform.yml"), "modules:\n  - settings-sync\n");
    writeFileSync(join(targetDir, ".copier-answers.yml"), "private: false\n");
    writeFileSync(join(targetDir, ".github", "settings.yml"), "repository:\n  private: false\n");
    writeFileSync(
      join(targetDir, ".github", "workflows", "ci.yml"),
      "jobs:\n  close:\n    steps:\n      - with:\n          stale-issue-label: pre-restore-label\n",
    );
    const result = runCommitPush("withhold-restore", "false");
    expect(result.exitCode).toBe(0);
    const report = readFileSync(join(result.runnerTemp, REFERENCED_LABELS_NAME), "utf-8");
    expect(report).toContain('"restored-label"');
    expect(report).not.toContain("pre-restore-label");
  });
});

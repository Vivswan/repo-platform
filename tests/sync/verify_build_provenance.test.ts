// Provenance verification (verify_build_provenance.ts): the sync-side
// guard that the template tip is the build-branches workflow's own output
// before it is templated into managed repos. The vouching TRUTH TABLE is
// unit-tested in tests/shared/run_vouches.test.ts; this suite proves the
// SCRIPT wires the pieces - the on-main check, the rollback walk, the run
// vouch, and the publish-step proof - and rejects each forgery shape.
//
// git and gh are PATH stubs: git answers merge-base/rev-parse from
// injected ancestry and resolvability sets and serves the tip's history
// and message from files; gh serves the run and jobs JSON. No bun stub -
// the script itself runs under real bun, and the ACCEPT case is asserted
// by the flow reaching the tree rebuild (`git worktree add`), which only
// happens once every provenance check has passed.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/sync/verify_build_provenance.ts");

const MAIN = "refs/remotes/origin/main";
const SOURCE = "a".repeat(40); // the tip's stamped source
const RUNHEAD = "b".repeat(40); // the build run's head (a later main commit)
const OLDER = "c".repeat(40); // an earlier source, for the rollback walk
const OFFMAIN = "d".repeat(40); // a commit not on main history

// git stub: records calls; answers `merge-base --is-ancestor A B` from
// IS_ANCESTOR (space-separated "A:B" pairs), `rev-parse --verify --quiet
// X^{commit}` from RESOLVABLE, `log [-1] --format=%B TIP` from the history
// or tip files, and `worktree`/anything else exit 0.
const gitStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "git"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ "\${1:-}" = "merge-base" ]; then
  a="\${@: -2:1}"; b="\${@: -1}"
  case " \${IS_ANCESTOR:-} " in *" $a:$b "*) exit 0 ;; *) exit 1 ;; esac
fi
if [ "\${1:-}" = "rev-parse" ]; then
  x="\${@: -1}"; x="\${x%'^{commit}'}"
  case " \${RESOLVABLE:-} " in *" $x "*) printf '%s\\n' "$x"; exit 0 ;; *) exit 1 ;; esac
fi
if [ "\${1:-}" = "log" ]; then
  case " $* " in *" -1 "*) cat "$GIT_TIP_FILE" ;; *) cat "$GIT_HISTORY_FILE" ;; esac
  exit 0
fi
exit 0
`;
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "gh"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
case "\${@: -1}" in
  */jobs) cat "$GH_JOBS_FILE" ;;
  *) cat "$GH_RUN_FILE" ;;
esac
`;

interface Options {
  sourceSha?: string;
  isAncestor?: string[];
  resolvable?: string[];
  history?: string;
  tip?: string;
  run?: unknown;
  jobs?: unknown;
}

const STAMP = (source: string, runId = "5") =>
  `build: template\n\nsource: https://github.com/Vivswan/repo-platform/commit/${source}\nrun: https://github.com/Vivswan/repo-platform/actions/runs/${runId}\n`;
const PUBLISHED_JOBS = {
  jobs: [{ steps: [{ name: "Build and publish", conclusion: "success" }] }],
};
const VOUCHING_RUN = {
  path: ".github/workflows/build-branches.yml",
  status: "completed",
  conclusion: "success",
  head_sha: RUNHEAD,
};

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "provenance-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const file = (name: string, value: string) => {
    const path = join(root, name);
    writeFileSync(path, value);
    return path;
  };
  const source = opts.sourceSha ?? SOURCE;
  const calls = join(root, "calls.log");
  const proc = Bun.spawnSync(["bun", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TIP_SHA: "f".repeat(40),
      SOURCE_SHA: source,
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      RUNNER_TEMP: root,
      CALLS_LOG: calls,
      IS_ANCESTOR: (
        opts.isAncestor ?? [`${SOURCE}:${MAIN}`, `${RUNHEAD}:${MAIN}`, `${SOURCE}:${RUNHEAD}`]
      ).join(" "),
      RESOLVABLE: (opts.resolvable ?? [SOURCE, RUNHEAD]).join(" "),
      GIT_HISTORY_FILE: file("history.txt", opts.history ?? STAMP(source)),
      GIT_TIP_FILE: file("tip.txt", opts.tip ?? STAMP(source)),
      GH_RUN_FILE: file("run.json", JSON.stringify(opts.run ?? VOUCHING_RUN)),
      GH_JOBS_FILE: file("jobs.json", JSON.stringify(opts.jobs ?? PUBLISHED_JOBS)),
    },
  });
  const raw = existsSync(calls) ? readFileSync(calls, "utf-8") : "";
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    calls: raw
      .split("\x1e")
      .filter(Boolean)
      .map((record) => record.split("\x1f")),
  };
}

describe("verify_build_provenance.ts", () => {
  test("accepts source A / run-head B with A an on-main ancestor of B - reaches the tree rebuild", () => {
    // The workflow_run publisher shape: the run carries main's later tip B,
    // the stamped source A is an earlier main commit B descends from. This
    // must pass every provenance check and REACH the deterministic tree
    // rebuild (git worktree add), the last line of defense. The rebuild
    // itself needs a real checkout, so it fails under the git stub - but
    // reaching it proves the vouch + step checks all passed.
    const r = run();
    const reachedRebuild = r.calls.some((args) => args[1] === "worktree" && args[2] === "add");
    expect(reachedRebuild).toBe(true);
  });

  test("rejects a source that is not on main history", () => {
    const r = run({
      sourceSha: OFFMAIN,
      isAncestor: [`${RUNHEAD}:${MAIN}`],
      resolvable: [OFFMAIN, RUNHEAD],
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("is not on main's history");
  });

  test("rejects a run head that does not contain the source (does not vouch)", () => {
    // The run ran at OLDER, an EARLIER commit that does not contain SOURCE,
    // so it cannot vouch - runVouchesForSource's ancestor arm fails.
    const r = run({
      isAncestor: [`${SOURCE}:${MAIN}`, `${OLDER}:${MAIN}`],
      resolvable: [SOURCE, OLDER],
      run: { ...VOUCHING_RUN, head_sha: OLDER },
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("does not vouch for it");
  });

  test("rejects a run whose publish STEP was skipped (red main's no-op run)", () => {
    // conclusion=success but the 'Build and publish' step skipped: on a red
    // main every step skips via CI_GREEN while the run still concludes
    // success. This is the check that pays for the vouch rule's loosening.
    const r = run({
      jobs: { jobs: [{ steps: [{ name: "Build and publish", conclusion: "skipped" }] }] },
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain(`never ran its 'Build and publish' step`);
  });

  test("rejects a tip whose ancestry stamped a NEWER source (rollback replay)", () => {
    // The tip stamps OLDER, but its history already stamped SOURCE, a newer
    // on-main source it descends from - a replayed old build. The rollback
    // walk caps freshness at the newest source already in the branch.
    const r = run({
      sourceSha: OLDER,
      isAncestor: [`${OLDER}:${MAIN}`, `${SOURCE}:${MAIN}`, `${OLDER}:${SOURCE}`],
      resolvable: [OLDER, SOURCE],
      history: `${STAMP(OLDER)}\n${STAMP(SOURCE)}`,
      tip: STAMP(OLDER),
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("replays an older build");
  });
});

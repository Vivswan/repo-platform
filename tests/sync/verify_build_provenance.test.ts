import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const script = join(import.meta.dir, "../../.github/scripts/sync/verify_build_provenance.ts");

const MAIN = "refs/remotes/origin/main";
const SOURCE = "a".repeat(40);
const OLDER = "c".repeat(40);
const OFFMAIN = "d".repeat(40);

const gitStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "git"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ "\${1:-}" = "\${GIT_ERRORS_ON:-}" ]; then echo 'fatal: stubbed' >&2; exit 128; fi
if [ "\${1:-}" = "merge-base" ]; then
  a="\${@: -2:1}"; b="\${@: -1}"
  case " \${IS_ANCESTOR:-} " in *" $a:$b "*) exit 0 ;; *) exit 1 ;; esac
fi
if [ "\${1:-}" = "rev-parse" ]; then
  x="\${@: -1}"; x="\${x%'^{commit}'}"
  case " \${RESOLVABLE:-} " in *" $x "*) printf '%s\\n' "$x"; exit 0 ;; *) exit 1 ;; esac
fi
if [ "\${1:-}" = "log" ]; then
  cat "$GIT_HISTORY_FILE"
  exit 0
fi
exit 0
`;

interface Options {
  sourceSha?: string;
  isAncestor?: string[];
  resolvable?: string[];
  history?: string;
  env?: Record<string, string>;
}

const STAMP = (source: string, runId = "5") =>
  `build: template\n\nsource: https://github.com/Vivswan/repo-platform/commit/${source}\nrun: https://github.com/Vivswan/repo-platform/actions/runs/${runId}\n`;

function run(opts: Options = {}) {
  const root = temp.dir("provenance-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
  const source = opts.sourceSha ?? SOURCE;
  const historyFile = join(root, "history.txt");
  writeFileSync(historyFile, opts.history ?? STAMP(source));
  const calls = join(root, "calls.log");
  const proc = boundedSpawnSync(["bun", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TIP_SHA: "f".repeat(40),
      SOURCE_SHA: source,
      RUNNER_TEMP: root,
      CALLS_LOG: calls,
      IS_ANCESTOR: (opts.isAncestor ?? [`${SOURCE}:${MAIN}`]).join(" "),
      RESOLVABLE: (opts.resolvable ?? [SOURCE]).join(" "),
      GIT_HISTORY_FILE: historyFile,
      ...opts.env,
    },
  });
  const raw = existsSync(calls) ? readFileSync(calls, "utf-8") : "";
  return {
    exitCode: proc.exitCode,
    output: proc.stdout + proc.stderr,
    calls: raw
      .split("\x1e")
      .filter(Boolean)
      .map((record) => record.split("\x1f")),
  };
}

describe("verify_build_provenance.ts", () => {
  test("accepts a resolvable on-main stamp with no newer stamped ancestor - reaches the tree rebuild", () => {
    // Reaching `git worktree add` is the accept proof: the rebuild itself needs a real
    // checkout, which the git stub cannot give, so the exit code is not asserted.
    const r = run();
    const reachedRebuild = r.calls.some((args) => args[1] === "worktree" && args[2] === "add");
    expect(reachedRebuild).toBe(true);
    expect(r.calls.every((args) => args[0] === "git")).toBe(true);
  });

  test("rejects a source that is not on main history", () => {
    const r = run({
      sourceSha: OFFMAIN,
      isAncestor: [],
      resolvable: [OFFMAIN],
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("is not on main's history");
  });

  test("rejects an unreachable stamped source, hinting BOTH remedies: dispatch and admin reset", () => {
    // The battery is the one owner of reachability (shared/stamp_checks.ts): a direct invocation with a garbage
    // SOURCE_SHA must not slip through to the rebuild, whose failure mode (a thrown worktree error) reads like an
    // infra problem instead of a verdict.
    const r = run({ resolvable: [] });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("is unreachable");
    // A dispatch is a no-op against a hand-pushed tip whose tree already matches main's
    // composition under a healthy stamp (publish.ts stages nothing and its skip guard reads
    // the stamp as fine), so the hint must also name the remedy that always works.
    //   broken stamp or drifted tree       -> dispatch post-green.yml
    //   tip publish.ts would skip          -> admin reset of refs/heads/build, or the next tree-moving landing
    expect(r.output).toContain("dispatch post-green.yml with sha=");
    expect(r.output).toContain("(the tip's stamped MAIN source");
    expect(r.output).toContain("to rebuild it from main");
    expect(r.output).toContain("reset refs/heads/build");
    expect(r.output).toContain("moves the composed tree");
  });

  test("rejects a tip whose ancestry stamped a NEWER source (rollback replay)", () => {
    const r = run({
      sourceSha: OLDER,
      isAncestor: [`${OLDER}:${MAIN}`, `${SOURCE}:${MAIN}`, `${OLDER}:${SOURCE}`],
      resolvable: [OLDER, SOURCE],
      history: `${STAMP(OLDER)}\n${STAMP(SOURCE)}`,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("replays an older build");
  });

  test.each(["merge-base", "rev-parse"])(
    "a git %s that errors fails the sync closed with git's own words - never a verdict, never the rebuild",
    (question) => {
      // Read as a "no", an errored look during the rollback walk would skip a newer ancestral stamp and pass a replayed old
      // build to the tree proof, which a replay PASSES (its tree rebuilds cleanly from its old source).
      const r = run({ env: { GIT_ERRORS_ON: question } });
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain(
        `git ${question} could not answer (exit 128); refusing to guess: fatal: stubbed`,
      );
      expect(r.output).not.toContain("is not on main's history");
      expect(r.output).not.toContain("is unreachable");
      expect(r.calls.some((args) => args[1] === "worktree" && args[2] === "add")).toBe(false);
    },
  );
});

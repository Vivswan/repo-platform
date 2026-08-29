// Provenance verification (verify_build_provenance.ts): the sync-side
// guard that the build tip is the build-branches workflow's own output
// before it is templated into managed repos. The stamp-health battery
// (checks 1+2) is unit-tested in tests/shared/stamp_checks.test.ts; this
// suite proves the SCRIPT wires it - the on-main check and the rollback
// walk reject, and only a tip that passes both reaches the tree rebuild,
// the content anchor.
//
// git is a PATH stub: it answers merge-base/rev-parse from injected
// ancestry and resolvability sets and serves the tip's history from a
// file. No gh stub - the retired run-proof leg was the script's only API
// consumer, and its absence is asserted below. No bun stub either: the
// script itself runs under real bun, and the ACCEPT case is asserted by
// the flow reaching the tree rebuild (`git worktree add`), which only
// happens once the stamp checks have passed.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/sync/verify_build_provenance.ts");

const MAIN = "refs/remotes/origin/main";
const SOURCE = "a".repeat(40); // the tip's stamped source
const OLDER = "c".repeat(40); // an earlier source, for the rollback walk
const OFFMAIN = "d".repeat(40); // a commit not on main history

// git stub: records calls; answers `merge-base --is-ancestor A B` from
// IS_ANCESTOR (space-separated "A:B" pairs), `rev-parse --verify --quiet
// X^{commit}` from RESOLVABLE, `log --format=%B TIP` from the history
// file, and `worktree`/anything else exit 0.
const gitStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "git"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ "\${1:-}" = "merge-base" ]; then
  if [ -n "\${GIT_MERGE_BASE_ERR:-}" ]; then exit 2; fi
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
  const root = mkdtempSync(join(tmpdir(), "provenance-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
  const source = opts.sourceSha ?? SOURCE;
  const historyFile = join(root, "history.txt");
  writeFileSync(historyFile, opts.history ?? STAMP(source));
  const calls = join(root, "calls.log");
  const proc = Bun.spawnSync(["bun", script], {
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
    output: proc.stdout.toString() + proc.stderr.toString(),
    calls: raw
      .split("\x1e")
      .filter(Boolean)
      .map((record) => record.split("\x1f")),
  };
}

describe("verify_build_provenance.ts", () => {
  test("accepts a resolvable on-main stamp with no newer stamped ancestor - reaches the tree rebuild", () => {
    // This must pass the whole stamp battery and REACH the deterministic
    // tree rebuild (git worktree add), the content anchor and last line
    // of defense. The rebuild itself needs a real checkout, so it fails
    // under the git stub - but reaching it proves the stamp checks all
    // passed, and no gh call ever happens (the retired run-proof leg was
    // the script's only API read).
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

  test("rejects an unreachable stamped source", () => {
    // resolve_refs.ts pre-checks reachability, but the battery re-answers
    // it here at the single owner (shared/stamp_checks.ts) - a direct
    // invocation with a garbage SOURCE_SHA must not slip through to the
    // rebuild, whose failure mode (a thrown worktree error) reads like an
    // infra problem instead of a verdict.
    const r = run({ resolvable: [] });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("is unreachable");
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
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("replays an older build");
  });

  test("an errored ancestry answer fails the sync closed - never a verdict, never the rebuild", () => {
    // merge-base exit 2 is "could not look", not "not an ancestor":
    // read as a verdict it would let the rollback walk skip a newer
    // ancestral stamp and pass a replayed old build to the tree proof -
    // which a replay PASSES, since its tree rebuilds cleanly from its
    // old source. The gate must refuse to guess and stop before the
    // rebuild.
    const r = run({ env: { GIT_MERGE_BASE_ERR: "1" } });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("could not answer");
    expect(r.calls.some((args) => args[1] === "worktree" && args[2] === "add")).toBe(false);
  });

  test("the rejection hint names BOTH remedies: the dispatch and the admin reset", () => {
    // A dispatch heals a broken stamp or a drifted tree, but not a
    // hand-pushed tip whose tree already matches main's composition under
    // a healthy stamp: publish.ts stages nothing and its skip guard reads
    // the stamp as fine, so the dispatch is a no-op against that tip. The
    // hint must name the remedy that always works too - an admin reset of
    // refs/heads/build (or the next tree-moving landing).
    const r = run({ resolvable: [] });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("dispatch Build Branches to rebuild it from main");
    expect(r.output).toContain("reset refs/heads/build");
    expect(r.output).toContain("moves the composed tree");
  });
});

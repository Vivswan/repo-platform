// HEAD-content probe shared by the sync scripts that must distinguish "the
// path is genuinely absent at HEAD" from "the repository is broken":
// `git ls-tree HEAD -- rel` exits 0 with empty output for an absent path,
// 0 with output for a present one, and nonzero only on real failure -
// which throws, because reading damage as "absent" would silently skip a
// carry or a tripwire check (cat-file -e cannot make that distinction: it
// exits 128 for a missing path and for fatal errors alike).

/** A VALUE-FREE failure for a HEAD probe: the git subcommand and its exit
 *  code only - never the path, the repository root, or git's stderr, each
 *  of which can name private-repo content. Defense in depth behind the
 *  callers' run_hidden.ts wrapping: the message stays safe even if a future
 *  caller logs it unwrapped. Same discipline as shared/json.ts; the withheld
 *  git detail is reproduced locally (docs/private-repos.md). */
import { capture, DEFAULT_HANG_BOUND_MS, timeoutExitCode } from "./proc.ts";

function headProbeFailed(subcommand: "ls-tree" | "show", exitCode: number | null): Error {
  return new Error(
    `git ${subcommand} against HEAD failed (exit ${exitCode ?? "unknown"}); the path, ` +
      "repository root, and git stderr are withheld to keep private-repo content out of the " +
      "log - reproduce the sync locally to see them (docs/private-repos.md)",
  );
}

/** The file's bytes at `root`'s HEAD, or null when the path is genuinely
 * absent there. Raw bytes so each caller picks the honest decode (latin1
 * for byte-owned file content, utf-8 for the manifest).
 * --literal-pathspecs: a tracked file NAMED like pathspec magic
 * (":(top)a.txt" - the validators bar traversal, not leading colons)
 * would otherwise silently resolve to a different path. */
export function headBytes(root: string, rel: string): Buffer | null {
  const probe = capture(["git", "--literal-pathspecs", "-C", root, "ls-tree", "HEAD", "--", rel]);
  if (probe.exitCode !== 0) {
    throw headProbeFailed("ls-tree", probe.exitCode);
  }
  if (probe.stdout.trim() === "") return null;
  // Raw Bun.spawnSync, not capture(): the contract above is RAW BYTES, and
  // capture's string result is a utf-8 decode that folds non-utf-8 file
  // content onto U+FFFD. The hang bound still applies, carried inline with
  // proc.ts's own constant and timeout-is-failure mapping.
  const proc = Bun.spawnSync(["git", "--literal-pathspecs", "-C", root, "show", `HEAD:${rel}`], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: DEFAULT_HANG_BOUND_MS,
    killSignal: "SIGKILL",
  });
  if (proc.exitedDueToTimeout === true) {
    throw headProbeFailed("show", timeoutExitCode(proc));
  }
  if (proc.exitCode !== 0) {
    throw headProbeFailed("show", proc.exitCode);
  }
  return Buffer.from(proc.stdout);
}

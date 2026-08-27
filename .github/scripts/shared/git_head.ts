// HEAD-content probe shared by the sync scripts that must distinguish "the
// path is genuinely absent at HEAD" from "the repository is broken":
// `git ls-tree HEAD -- rel` exits 0 with empty output for an absent path,
// 0 with output for a present one, and nonzero only on real failure -
// which throws, because reading damage as "absent" would silently skip a
// carry or a tripwire check (cat-file -e cannot make that distinction: it
// exits 128 for a missing path and for fatal errors alike).

/** The file's bytes at `root`'s HEAD, or null when the path is genuinely
 * absent there. Raw bytes so each caller picks the honest decode (latin1
 * for byte-owned file content, utf-8 for the manifest).
 * --literal-pathspecs: a tracked file NAMED like pathspec magic
 * (":(top)a.txt" - the validators bar traversal, not leading colons)
 * would otherwise silently resolve to a different path. */
export function headBytes(root: string, rel: string): Buffer | null {
  const probe = Bun.spawnSync(
    ["git", "--literal-pathspecs", "-C", root, "ls-tree", "HEAD", "--", rel],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (probe.exitCode !== 0) {
    throw new Error(
      `git ls-tree HEAD -- ${rel} failed in ${root}: ${probe.stderr.toString().trim()}`,
    );
  }
  if (probe.stdout.toString().trim() === "") return null;
  const proc = Bun.spawnSync(["git", "--literal-pathspecs", "-C", root, "show", `HEAD:${rel}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git show HEAD:${rel} failed in ${root}: ${proc.stderr.toString().trim()}`);
  }
  return Buffer.from(proc.stdout);
}

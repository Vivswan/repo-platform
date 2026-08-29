// The ONE staging form for a composed build tree, shared by every site
// that turns the composed tree into git content: the two PRODUCERS
// (build-branches/build_pending.ts parks the pending tree,
// build-branches/publish.ts commits the branch tip) and the VERIFIER
// (shared/rebuild_tree.ts hashes a scratch rebuild for the sync's
// provenance tree proof and its freshness slow path). Producer and
// verifier must stage IDENTICALLY - the same function of the composed
// tree's bytes - or their tree hashes skew, and a skew reads as a false
// tamper accusation in the provenance proof and a permanent "not fresh"
// in the freshness slow path.
//
// Why the hermetic form, at every site:
//   - `--force` stages ignored files no matter where the ignore comes
//     from: a .gitignore INSIDE the composed tree (measured to silently
//     drop staged siblings - the one vector an excludesFile override
//     does not cover), a machine-global core.excludesFile or its XDG
//     fallback ~/.config/git/ignore (which applies even with the key
//     unset), an init.templateDir-planted info/exclude, and - the
//     producer-only axis - the repo-platform checkout's own
//     .git/info/exclude and repo-level config, which the producers'
//     /tmp worktrees inherit while the verifier's fresh scratch repo
//     sees neither.
//   - `core.attributesFile=/dev/null` closes the blob-content axis: a
//     global `* text` filter rewrites line endings at add time, which
//     --force does not touch. templateDir HOOKS are a non-issue: no
//     hook fires on init, add, or write-tree.
//
// Safe for the producers to adopt: `add -A --force` differs from plain
// `add -A` only when an ignore rule would exclude something, and the
// attributesFile override changes staged BLOBS only where a
// machine-global attributes file would have rewritten them at add time
// - absent on fresh CI runners, and neutralizing it is the point (the
// verifier neutralizes it too, so a runner that ever grew one would
// skew a plain-staging producer against the verifier). For every
// composed tree shipped today - nothing ignored, no attribute source -
// both forms stage identical content, so publish.ts's staged-diff
// decisions (skip guard, stamp recovery lane) are unchanged
// (tests/shared/stage_tree.test.ts proves the equivalence with a
// control arm). The one axis NO flag can close is
// $GIT_DIR/info/attributes (git reads it regardless of
// core.attributesFile): no site plants one - fresh checkouts and
// scratch repos carry none - so it stays a documented residual, not a
// covered vector.
//
// Exported as ARGV, not a running function: the three sites run
// subprocesses through different wrappers (proc.ts's `must`,
// rebuild_tree.ts's deadline-bearing `step`) with their own stdio and
// deadline policies - this module owns only WHAT is run.

/** The hermetic staging argv for the composed tree at `treeDir`. */
export function stageComposedTreeArgv(treeDir: string): string[] {
  return ["git", "-C", treeDir, "-c", "core.attributesFile=/dev/null", "add", "-A", "--force"];
}

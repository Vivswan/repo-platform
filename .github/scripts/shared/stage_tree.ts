// The ONE staging argv for a composed build tree, shared by the producer
// (build-branches/publish.ts) and the verifier (shared/rebuild_tree.ts):
// the two must stage IDENTICALLY, or their tree hashes skew and the
// provenance proof reads a false tamper (docs/build-provenance.md,
// "Hermetic staging": the vectors each flag closes and the residual no
// flag can).
//
// Safe for the producer: `add -A --force` differs from plain `add -A` only
// where an ignore rule would exclude something, and the attributesFile
// and autocrlf overrides change staged blobs only where a machine-global
// setting would have rewritten them at add time - so for every tree
// shipped today both forms stage identical content and publish.ts's
// staged-diff decisions are unchanged (tests/shared/stage_tree.test.ts
// proves it with a control arm).
//
// Exported as ARGV, not a running function: the sites run subprocesses
// through different wrappers with their own stdio and deadline policies;
// this module owns only WHAT is run.

/** The hermetic staging argv for the composed tree at `treeDir`. */
export function stageComposedTreeArgv(treeDir: string): string[] {
  return [
    "git",
    "-C",
    treeDir,
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.autocrlf=false",
    "add",
    "-A",
    "--force",
  ];
}

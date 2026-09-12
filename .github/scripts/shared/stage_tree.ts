// The producer (build-branches/publish.ts) and the verifier (shared/rebuild_tree.ts) must stage IDENTICALLY, or their tree hashes
// skew and the provenance proof reads a false tamper (docs/build-provenance.md, "Hermetic staging", lists what each flag closes).
// Argv rather than a running function: the two sites spawn through wrappers with their own stdio and deadline policies.

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

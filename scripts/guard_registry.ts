// The guard registry: every guard against an ENVIRONMENTAL hazard
// (hostile git config, leaked env vars, hung children) that a hermetic
// test suite cannot reach by accident, bound to the hostile-fixture test
// that forces its failure branch. Such a guard can be born decorative -
// deleting it changes nothing - unless the attack it stops was STAGED
// once; this registry makes "was the attack ever staged?" a CI question.
//
// Two consumers, two proof strengths:
//   - scripts/check_guard_binding.ts (per commit, in `bun run check`)
//     proves BINDING: the snippet is in the guard file, the forcing test
//     is in the test file. Deleting a guard, renaming its test, or
//     deleting the test is an immediate red naming the entry.
//   - .github/scripts/audit-guards/arm_audit.ts (weekly) proves ARMING:
//     in a scratch clone it applies each entry's mutation, requires the
//     forcing test RED, restores, and requires it GREEN - a guard whose
//     unarming no test notices is decorative and fails the audit.
//
// AUTHORING RULE: a new environmental-hazard guard lands WITH its
// registry entry and its forcing test in the same commit. There is no
// auto-detection of unregistered guards - an honest scanner for "code
// that only matters under a hostile environment" does not exist - so the
// registry grows by authorship, and review holds the line.
//
// The snippet doubles as the mutation target on purpose: one field is
// both the binding anchor and what the audit replaces, so the two layers
// can never verify different bytes.

export interface GuardEntry {
  /** Stable name, printed in every layer's diagnostics. */
  id: string;
  /** The environmental attack the guard stops, one line. */
  hazard: string;
  /** Repo-relative file carrying the guard. */
  guardFile: string;
  /** The guard's exact bytes in guardFile (exactly once): the binding
   *  anchor AND the text the arming audit replaces. */
  snippet: string;
  /** What the audit replaces the snippet with to unarm the guard; must
   *  keep the file runnable, or the red run proves a syntax error
   *  instead of the guard. */
  mutated: string;
  /** Repo-relative test file the arming audit runs. */
  testFile: string;
  /** The exact test name (verbatim, double-quoted in testFile) that must
   *  go red under the mutation. */
  testName: string;
}

export const GUARD_REGISTRY: readonly GuardEntry[] = [
  {
    id: "stage-tree-attributes-file",
    hazard:
      "a machine-global gitattributes filter (`* text`) rewrites blobs at add time, skewing the producers' staged trees against the verifier's scratch rebuild",
    guardFile: ".github/scripts/shared/stage_tree.ts",
    snippet: '"-c",\n    "core.attributesFile=/dev/null",',
    mutated: "",
    testFile: "tests/shared/stage_tree.test.ts",
    testName:
      "the attributesFile override is ARMED: a global attributes rewrite cannot touch the helper's staged bytes",
  },
  {
    id: "stage-tree-autocrlf",
    hazard:
      "a machine-global core.autocrlf rewrites CRLF at add time through config alone (no attributes file anywhere), the same producer/verifier skew from the other config home",
    guardFile: ".github/scripts/shared/stage_tree.ts",
    snippet: '"-c",\n    "core.autocrlf=false",',
    mutated: "",
    testFile: "tests/shared/stage_tree.test.ts",
    testName:
      "the autocrlf override is ARMED: a machine-global core.autocrlf cannot touch the helper's staged bytes",
  },
  {
    id: "stage-tree-force",
    hazard:
      "an ignore rule from any home (an in-tree .gitignore, a global excludesFile, an inherited info/exclude) silently drops staged siblings from the composed tree",
    guardFile: ".github/scripts/shared/stage_tree.ts",
    snippet: '"--force",',
    mutated: "",
    testFile: "tests/shared/stage_tree.test.ts",
    testName:
      "producer and verifier hash a hostile tree identically, and the hidden files are IN it",
  },
  {
    id: "bounded-spawn-timeout",
    hazard:
      "a wedged child hangs the whole test run: bun-test's per-test timeout cannot interrupt a synchronous spawn, and a piped spawnSync without a timeout waits for pipe EOF, not child exit",
    guardFile: "tests/shared/bounded_spawn.ts",
    snippet: "timeout: timeoutMs,",
    mutated: "",
    testFile: "tests/shared/bounded_spawn.test.ts",
    testName: "FORCED RED: a hung child hits the bound and reads as failed-to-look",
  },
  {
    id: "proc-spawn-env-live-base",
    hazard:
      "bun's default child environment is a process-start snapshot, so env pins or scrubs applied before a spawn are silently inert in the child",
    guardFile: ".github/scripts/shared/proc.ts",
    snippet: "{ ...process.env, ...(env ?? {}) }",
    mutated: "{ ...(env ?? {}) }",
    testFile: "tests/shared/proc.test.ts",
    testName: "a key added to process.env after start reaches capture's child",
  },
  // The binding check is itself a guard; unarming its vanished-snippet
  // branch would let any registered guard be deleted silently.
  {
    id: "guard-binding-vanished-snippet-branch",
    hazard:
      "the harness rots from within: with the vanished-snippet branch unarmed, deleting a registered guard passes the binding check green",
    guardFile: "scripts/check_guard_binding.ts",
    snippet: "if (snippetCount !== 1) {",
    mutated: "if (false) {",
    testFile: "tests/scripts/check_guard_binding.test.ts",
    testName: "an entry whose snippet vanished from its guard file is reported",
  },
];

/** Occurrences of `token` in `text` (exact bytes, no regex). */
export function countOccurrences(text: string, token: string): number {
  if (token === "") throw new Error("countOccurrences: an empty token matches everywhere");
  return text.split(token).length - 1;
}

/** `content` with the entry's mutation applied. Throws unless the
 *  snippet appears exactly once - anything else would make the mutation
 *  ambiguous, and the binding check fails those entries before the audit
 *  ever runs. */
export function applyMutation(content: string, entry: GuardEntry): string {
  const occurrences = countOccurrences(content, entry.snippet);
  if (occurrences !== 1) {
    throw new Error(
      `${entry.id}: snippet appears ${occurrences} times in ${entry.guardFile}; the mutation needs exactly one target`,
    );
  }
  return content.replace(entry.snippet, entry.mutated);
}

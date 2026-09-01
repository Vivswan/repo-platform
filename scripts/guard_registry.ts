// The guard registry: every guard against an ENVIRONMENTAL hazard
// (hostile git config, leaked env vars, hung children) that a hermetic
// test suite cannot reach by accident, bound to the hostile-fixture test
// that forces its failure branch - plus the all-green action's judgment
// guards (fail-closed refusals), whose forcing cases live in the bash
// harness verify_allgreen_judgment.sh and bind here through the bun
// wrapper tests/ci/allgreen_guard_arming.test.ts (the arming audit runs
// bun test files, so a bash-harness guard needs a named bun test that
// goes red when the harness does). Such a guard can be born decorative -
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
  // The deletion tripwire is a guard too: the binding check validates
  // the entries PRESENT both ways but is structurally blind to ABSENT
  // ones - a rebase's conflict resolution once dropped 5 of main's
  // entries with every gate green, caught only by a manual count.
  {
    id: "guard-registry-deletion-tripwire",
    hazard:
      "a merge-conflict resolution silently drops registry entries: the binding check proves every PRESENT entry resolves both ways but never asks what main had, so guards vanish wholesale with every gate green",
    guardFile: "scripts/check_guard_binding.ts",
    snippet: "if (!liveIds.has(baseId) && !retiredIds.has(baseId)) {",
    mutated: "if (false) {",
    testFile: "tests/scripts/check_guard_binding.test.ts",
    testName: "a merge-base registry id missing at HEAD without a RETIRED_GUARDS entry is reported",
  },
  // The all-green action's judgment guards (actions/all-green/action.yml's
  // judge block). Their scenario-level forcing cases are
  // verify_allgreen_judgment.sh's; the wrapper test file
  // (tests/ci/allgreen_guard_arming.test.ts) runs that harness once and
  // fails the named test on any harness red, so each mutation below
  // reddens exactly the scenario its guard exists for and the wrapper
  // carries the verdict to the audit's junit reader.
  {
    id: "allgreen-all-skipped-refusal",
    hazard:
      "a run where every needed job skipped minted as green: nothing succeeded, so the gate would vouch for a run that verified nothing",
    guardFile: "actions/all-green/action.yml",
    snippet: 'if [ "$succeeded" -eq 0 ]; then',
    mutated: "if false; then",
    testFile: "tests/ci/allgreen_guard_arming.test.ts",
    testName: "the all-skipped refusal is ARMED: a run where nothing succeeded vouches for nothing",
  },
  {
    id: "allgreen-empty-needs-refusal",
    hazard:
      "an EMPTY needs context read as green: a refactor that empties the all-green job's needs list would leave a required check that gates nothing (the named refusal is what keeps the failure diagnosable as that, not as an incidental all-skipped)",
    guardFile: "actions/all-green/action.yml",
    snippet: 'if [ "$total" -eq 0 ]; then',
    mutated: "if false; then",
    testFile: "tests/ci/allgreen_guard_arming.test.ts",
    testName:
      "the empty-needs refusal is ARMED: a needs list emptied by refactor never reads green",
  },
  {
    id: "walk-commit-bound",
    hazard:
      "a long-red main turns the scheduled heal's green-commit walk into an unbounded probe loop, and a green commit arbitrarily far behind the tip is applied as if it were current state",
    guardFile: ".github/scripts/fleet/newest_green_commit.ts",
    snippet: "if (behind > maxCommits) {",
    mutated: "if (false) {",
    testFile: "tests/fleet/newest_green_commit.test.ts",
    testName: "a green commit beyond the walk's commit bound is NOT vouched - the heal refuses",
  },
  {
    id: "walk-age-bound",
    hazard:
      "a main red for weeks lets the scheduled heal quietly roll the fleet's settings back to a weeks-old green commit instead of halting where a human must look",
    guardFile: ".github/scripts/fleet/newest_green_commit.ts",
    snippet: "if (!(ageMs >= -DAY_MS && ageMs <= maxAgeMs)) {",
    mutated: "if (false) {",
    testFile: "tests/fleet/newest_green_commit.test.ts",
    testName: "a green commit older than the walk's age bound is NOT vouched - the heal refuses",
  },
  {
    id: "walk-vouches-candidates",
    hazard:
      "an unprobed fallback commit reaches the fleet-wide settings writer: without the per-candidate all-green vouch the walk returns the first ancestor regardless of its CI verdict",
    guardFile: ".github/scripts/fleet/newest_green_commit.ts",
    snippet: "allGreenFailure(repository, candidate.sha, gh, { deadlineMs: 0 })",
    mutated: "null",
    testFile: "tests/fleet/newest_green_commit.test.ts",
    testName:
      "a red ancestor is never chosen: the walk vouches each candidate and picks the green one behind it",
  },
  // The heal's sha plumbing (settings-repos.yml): four links between the
  // green gate's resolved commit and the checkouts that must consume it.
  // Probe C staged the attack: deleting the apply checkout's ref was
  // invisible to every local gate - actions/checkout treats a missing or
  // empty ref as the trigger ref, so the run stays green while the
  // fallback path silently applies unvouched tip state. The forcing
  // tests run the settings-heal-sha-plumbing ssot rule's structural
  // judgment (settingsHealShaPlumbingMismatches) on the REAL workflow.
  {
    id: "settings-gate-sha-output",
    hazard:
      "the select job's sha output deleted: steps.gate's resolved commit never reaches the apply job, whose checkout ref reads empty and silently reverts to the trigger ref",
    guardFile: ".github/workflows/settings-repos.yml",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal workflow line under pin
    snippet: "      sha: ${{ steps.gate.outputs.sha }}",
    mutated: "",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName: "the gate sha output is ARMED: the select job republishes the gate's resolved sha",
  },
  {
    id: "settings-fallback-checkout-condition",
    hazard:
      "the fallback re-checkout's condition rewired to never fire: the scheduled heal's select job keeps reading the RED tip's scripts and registry while the apply job reads the green commit - the unvouched hybrid no CI run ever saw",
    guardFile: ".github/workflows/settings-repos.yml",
    snippet:
      "      - name: Check out the resolved green commit\n        if: steps.gate.outputs.fallback == 'true'",
    mutated: "      - name: Check out the resolved green commit\n        if: false",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName:
      "the fallback checkout condition is ARMED: all three fallback steps gate on the resolved sha",
  },
  {
    id: "settings-fallback-checkout-ref",
    hazard:
      "the fallback re-checkout's ref deleted: actions/checkout lands on the trigger ref again, so the fallback run's selection scripts and registry come from the red tip while claiming the green commit",
    guardFile: ".github/workflows/settings-repos.yml",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal workflow line under pin
    snippet: "          ref: ${{ steps.gate.outputs.sha }}",
    mutated: "",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName:
      "the fallback checkout ref is ARMED: the re-checkout lands on the gate's resolved sha",
  },
  {
    id: "settings-apply-checkout-pinned",
    hazard:
      "the apply job's checkout ref deleted (probe C, verbatim): the fleet-wide writer's layer files come from the trigger ref instead of the gate's vouched commit, green on every local gate",
    guardFile: ".github/workflows/settings-repos.yml",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal workflow line under pin
    snippet: "          ref: ${{ needs.select.outputs.sha }}",
    mutated: "",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName:
      "the apply checkout pin is ARMED: the apply job checks out the select job's vouched sha",
  },
  {
    id: "split-entries-unknown-grammar-refusal",
    hazard:
      "a target checkout's manifest declares a grammar the GRAMMAR table has no row for; without the refusal the typed parser dispatch is fed a null key and the carry's failure mode stops being the deliberate refuses-to-guess error",
    guardFile: ".github/scripts/sync/preserve_local_content.ts",
    snippet: "if (grammar === null) {",
    mutated: "if (false) {",
    testFile: "tests/sync/preserve_local_content.test.ts",
    testName: "throws on an unknown grammar instead of degrading",
  },
  // The commit-msg gate (scripts/check_commit_subject.ts, dispatched by
  // .husky/commit-msg): the pre-commit gates run before the message
  // exists, so a subject CI's commit-names job refuses - the comma-scope
  // class, `docs(all-green,build-provenance): ...` - reached main and
  // went red there on 2026-08-30. Two entries because either half can
  // rot alone: the refusal branch inside the script, and the husky
  // dispatch line that makes the script fire at commit time.
  {
    id: "commit-subject-refusal",
    hazard:
      "a subject CI's commit-names job will refuse (a comma in the scope, a bad type) sails through every local gate - pre-commit runs before the message exists, so the class reddens main on every occurrence",
    guardFile: "scripts/check_commit_subject.ts",
    snippet: "if (!candidates.some(acceptable)) {",
    mutated: "if (false) {",
    testFile: "tests/scripts/check_commit_subject.test.ts",
    testName: "a comma-scoped subject is REFUSED by the commit-msg gate, naming the subject",
  },
  {
    id: "commit-subject-hook-wiring",
    hazard:
      "the gate script exists but nothing runs it at commit time: the husky dispatch line deleted or stubbed leaves every subject unjudged while the script and its own tests stay green",
    guardFile: ".husky/commit-msg",
    snippet: 'bun scripts/check_commit_subject.ts "$1"',
    mutated: ': "$1"',
    testFile: "tests/scripts/check_commit_subject.test.ts",
    testName:
      "the .husky/commit-msg wiring dispatches to the gate - a refused subject blocks the commit",
  },
  // The fleet release leg (the release-please module's job spliced into
  // the managed ci.yml): each pin below can rot alone, and every one
  // fails open at run time - a weakened gate releases off red or unjudged
  // commits with GitHub reporting nothing wrong. The forcing tests run the
  // fleet-ci-render-roster ssot judgment on the REAL template sources.
  {
    id: "fleet-release-verdict-gate",
    hazard:
      "the gate clause deleted from the release leg's if: GitHub still implies success() on the needs edge, but the remaining event clauses alone would release on a PR/dispatch/schedule shape the moment someone widens them - the spelled-out result clause is the belt the pinned block keeps honest",
    guardFile: "templates/release-please/fragments/all-green-release.jinja",
    snippet: "      needs.all-green.result == 'success' &&",
    mutated: "",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName: "the release leg's gate is ARMED: only a green all-green on a main push releases",
  },
  {
    id: "fleet-release-judged-sha-pass",
    hazard:
      "the sha input deleted from the release leg's call: release.yml falls back to its own github.sha - equal today because the leg runs in the judged commit's own run, but the EXPLICIT pass is what keeps a future caller from silently handing the pipeline a different commit",
    guardFile: "templates/release-please/fragments/all-green-release.jinja",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal fragment line under pin
    snippet: "      sha: {% raw %}${{ github.sha }}{% endraw %}",
    mutated: "",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName: "the judged-sha pass is ARMED: the leg hands the judged commit to release.yml",
  },
  {
    id: "fleet-release-judged-sha-read",
    hazard:
      "release.yml's head gate rewired off the input: the sha input is the explicit judged-commit hand-off (inputs.sha, github.sha as the same-run fallback), and a gate reading anything else would silently release whatever a future caller's context holds",
    guardFile: "templates/release-please/.github/workflows/release.yml.jinja",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template line under pin
    snippet: "          JUDGED: {% raw %}${{ inputs.sha || github.sha }}{% endraw %}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the unarmed shape the audit stages
    mutated: "          JUDGED: {% raw %}${{ github.sha }}{% endraw %}",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName: "the judged-sha read is ARMED: release.yml's head gate compares the judged commit",
  },
  // The meta-check gate's shape at both sources: each pin fails OPEN at
  // run time (GitHub reports nothing wrong - the gate just stops seeing a
  // caller, or skips itself on the first failure it exists to catch). The
  // forcing tests run the fleet-ci-render-roster and all-green-roster
  // ssot judgments on the REAL sources.
  {
    id: "fleet-gate-needs-roster",
    hazard:
      "a caller job dropped from the rendered all-green job's needs: the gate goes green on the remaining caller while every job of the dropped call stops gating, fleet-wide",
    guardFile: "templates/base/.github/workflows/ci.yml.jinja",
    snippet: "    needs: [checks, ci]",
    mutated: "    needs: [checks]",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName: "the fleet gate's needs edge is ARMED: all-green needs both caller jobs",
  },
  {
    id: "fleet-gate-always",
    hazard:
      "if: always() deleted from the rendered all-green job: a failed caller then SKIPS the gate instead of failing it, and a skipped required check leaves the merge box waiting - or, with GitHub's implied success(), green paths only",
    guardFile: "templates/base/.github/workflows/ci.yml.jinja",
    snippet: "    if: always()",
    mutated: "",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName: "the fleet gate's always() is ARMED: a failed caller cannot skip the gate",
  },
  {
    id: "repo-gate-needs-roster",
    hazard:
      "a gating job dropped from repo-platform's own all-green needs list: the job keeps running but stops gating merges, with every remaining gate green",
    guardFile: ".github/workflows/ci.yml",
    snippet: "      - rehearse-fleet",
    mutated: "",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName: "the repo gate's needs roster is ARMED: every ALL_GREEN_ROSTER job is needed",
  },
  // The pr-title module's natively-required check (the pr-title-workflow
  // ssot rule): each pin fails OPEN at run time - GitHub reports nothing
  // wrong, the merge box just waits forever or accepts a look-alike.
  {
    id: "pr-title-synchronize-trigger",
    hazard:
      "the trigger types list losing synchronize: a required check must exist at the PR's NEWEST head commit, so every push after open would leave the merge box waiting on a pr-title check nothing creates",
    guardFile: "templates/pr-title/.github/workflows/pr-title.yml.jinja",
    snippet: "    types: [opened, edited, reopened, synchronize]",
    mutated: "    types: [opened, edited]",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName: "the pr-title trigger shape is ARMED: a types list without synchronize is refused",
  },
  {
    id: "pr-title-required-check-pin",
    hazard:
      "the required check's integration_id pin deleted from the baseline's pr-title ruleset: any app or plain commit status named pr-title would satisfy the ruleset context by name",
    guardFile: ".github/settings-baseline.yml",
    snippet: "            - context: pr-title\n              integration_id: 15368",
    mutated: "            - context: pr-title",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName:
      "the pr-title required-check pin is ARMED: only the Actions app's job check satisfies the context",
  },
  {
    id: "pr-title-module-activation",
    hazard:
      "the module layer's enforcement flip rewired to disabled (or lost): every pr-title-selecting repo silently stops requiring the check while the workflow keeps running - the merge gate evaporates with everything green",
    guardFile: "templates/pr-title/settings.yml",
    snippet: "    enforcement: active",
    mutated: "    enforcement: disabled",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName:
      "the pr-title module activation is ARMED: the module layer flips the baseline's disabled ruleset active",
  },
  {
    id: "docs-site-caller-theme-refusal",
    hazard:
      "a fleet repo ships docs/.vitepress expecting it to style its site: the central build root ignores caller theme files by construction, so without the refusal the deploy stays green while silently discarding what the repo authored - the central-theme invariant rots into a lie",
    guardFile: "actions/pages-site/build.ts",
    snippet: 'if (existsSync(join(docsTree, ".vitepress"))) {',
    mutated: "if (false) {",
    testFile: "actions/pages-site/pages-site.test.ts",
    testName: "a caller-shipped .vitepress is REFUSED: the theme comes only from repo-platform",
  },
  {
    id: "docs-site-strict-links-wiring",
    hazard:
      "the deploy's dead-link strictness rewired to always-lenient: every tier then builds with dead internal links ignored, so current docs rot ships on a green run and the PR check's promise (a dead link fails before merge, or at worst at deploy) quietly dies",
    guardFile: "actions/pages-site/build.ts",
    snippet: 'return tier.ref === "HEAD";',
    mutated: "return false;",
    testFile: "actions/pages-site/pages-site.test.ts",
    testName: "the dead-link strictness wiring is ARMED: HEAD tiers build strict, tags lenient",
  },
  {
    id: "pages-legacy-tag-skip-narrow",
    hazard:
      "the structural probe rewired to skip every tag: versioned tiers and their versions.json entries silently vanish from the deployed site on a green run, and the loud failure a broken-but-declared build owes the operator never fires because nothing builds at all",
    guardFile: "actions/pages-site/lib.ts",
    snippet: 'return typeof pkg.scripts[script] === "string";',
    mutated: "return false;",
    testFile: "actions/pages-site/pages-site.test.ts",
    testName: "the legacy-tag skip is NARROW: a tag declaring the build script is never skipped",
  },
  // The composite actions' pinned-bun setup (the actions-bun-guard rule's
  // canonical block). The attack was staged live, not hypothetically: the
  // 1.4.0 bump rewrote the action lockfiles to lockfileVersion 2, and
  // every consumer whose own pin resolved an older bun (cloud-speech at
  // 1.3.9 first) died at the actions' install step - with the parse error
  // swallowed by --silent and zero signal in repo-platform's CI, which
  // pins 1.4.0 itself. The forcing test runs the rule's judgment on the
  // REAL action manifests, so unpinning any one of them goes red.
  {
    id: "actions-bun-pin",
    hazard:
      "a composite action's bun floats on the CONSUMER repository's version resolution (a bare setup-bun reads the caller checkout's version files): a repo-platform bun bump that rewrites the action lockfiles then breaks arbitrary consumers' CI with no signal in repo-platform's own",
    guardFile: "actions/check-typography/action.yml",
    snippet:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal action lines under pin
      "      continue-on-error: true\n      uses: oven-sh/setup-bun@v2\n      with:\n        bun-version-file: ${{ github.action_path }}/.bun-version",
    mutated: "      continue-on-error: true\n      uses: oven-sh/setup-bun@v2",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName:
      "the composite actions' bun pin is ARMED: every bun-touching action.yml carries the pinned setup block",
  },
];

/** A guard retired ON PURPOSE: its id moved here from GUARD_REGISTRY
 *  when the guard left with its machinery (the sanctioned removal case).
 *  The deletion tripwire in scripts/check_guard_binding.ts compares
 *  HEAD's ids against the registry file at the merge-base with
 *  origin/main and goes red on any id that is neither live nor listed
 *  here - so a merge-conflict resolution can never drop entries
 *  silently, while a deliberate retirement stays a one-line move.
 *  Records are permanent: deleting one re-trips the wire, because the
 *  merge-base extraction reads retired ids too. */
export interface RetiredGuard {
  /** The retired entry's id, verbatim. */
  id: string;
  /** Why the guard left, one line (usually: retired with its machinery). */
  reason: string;
}

export const RETIRED_GUARDS: readonly RetiredGuard[] = [];

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

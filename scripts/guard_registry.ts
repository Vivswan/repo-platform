// The guard registry: every guard against an ENVIRONMENTAL hazard
// (hostile git config, leaked env vars, hung children) that a hermetic
// test suite cannot reach by accident, bound to the hostile-fixture test
// that forces its failure branch - plus the verdict engine's event-shape
// guards (stand-down branches, refusal paths, pending-not-green), whose
// forcing cases live in the bash harness verify_verdict_judgment.sh and
// bind here through the bun wrapper tests/ci/verdict_guard_arming.test.ts
// (the arming audit runs bun test files, so a bash-harness guard needs a
// named bun test that goes red when the harness does). Such a guard can
// be born decorative - deleting it changes nothing - unless the attack
// it stops was STAGED once; this registry makes "was the attack ever
// staged?" a CI question.
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
  // The verdict engine's event-shape guards (reusable-all-green.yml's
  // judge block). Their scenario-level forcing cases are
  // verify_verdict_judgment.sh's; the wrapper test file runs that
  // harness once and fails the named test on any harness red, so each
  // mutation below reddens exactly the scenario its guard exists for
  // and the wrapper carries the verdict to the audit's junit reader.
  {
    id: "verdict-pending-not-green",
    hazard:
      "an incomplete expected set (the owed Copilot review, a pending conditional) minted as a completed green check instead of a visible in_progress hold - the merge box would open while members are outstanding",
    guardFile: ".github/workflows/reusable-all-green.yml",
    snippet: "status=in_progress",
    mutated: "conclusion=success",
    testFile: "tests/ci/verdict_guard_arming.test.ts",
    testName:
      "the pending path is ARMED: an incomplete expected set posts in_progress, never a green conclusion",
  },
  {
    id: "verdict-author-unknown-armed",
    hazard:
      "a wake with no PR author in reach (every wake but pull_request_review) disarming the copilot expectation - unknown must never disarm, or any CI completion at a human PR's head waves the review off",
    guardFile: ".github/workflows/reusable-all-green.yml",
    snippet: "bot=0",
    mutated: "bot=1",
    testFile: "tests/ci/verdict_guard_arming.test.ts",
    testName:
      "the author stand-down is ARMED: an unknown PR author keeps the copilot expectation armed",
  },
  {
    id: "verdict-fork-review-stand-down",
    hazard:
      "a fork-headed pull_request_review wake carries a read-only token: without the quiet stand-down, every outside-contributor review spawns a judgment whose check-run POST is refused - a red All Green run per review",
    guardFile: ".github/workflows/reusable-all-green.yml",
    snippet: 'if [ -n "$REVIEW_SHA" ] && [ "$REVIEW_HEAD_REPO" != "$GITHUB_REPOSITORY" ]; then',
    mutated: "if false; then",
    testFile: "tests/ci/verdict_guard_arming.test.ts",
    testName: "the fork stand-down is ARMED: a fork-headed review wake judges nothing",
  },
  {
    id: "verdict-review-newest-pr-run",
    hazard:
      "a review wake judging the wrong run at the head: a same-sha push or dispatch run flips RUN_EVENT to CI-only semantics (no copilot, no conditionals owed), and a stale completed run behind a running retrigger mints green over an unknown outcome",
    guardFile: ".github/workflows/reusable-all-green.yml",
    snippet:
      'run="$(jq \'[.[] | select(.event == "pull_request" or .event == "pull_request_target")] | max_by(.id) // empty\' <<<"$runs_at_head")"',
    mutated: 'run="$(jq \'.[0] // empty\' <<<"$runs_at_head")"',
    testFile: "tests/ci/verdict_guard_arming.test.ts",
    testName:
      "the review-wake run selection is ARMED: only the newest pull_request-event run is judged",
  },
  // The author env WIRING, distinct from the run-block guards above: the
  // bash harness injects PR_AUTHOR_* itself and tests only the extracted
  // run block, so the workflow-level env mapping needed its own pin
  // (probe PB: rewiring PR_AUTHOR_LOGIN to github.actor survived every
  // other gate). The forcing tests read the REAL workflow through the
  // same ALL_GREEN_WIRING patterns the all-green-name rule runs.
  {
    id: "verdict-author-login-wiring",
    hazard:
      "PR_AUTHOR_LOGIN rewired from the pull request's author to an actor- or reviewer-shaped source: a bot-submitted review wake (Copilot's own submission) at a human PR's head then reads as bot-author, skips the copilot_state read, and can mint success over a FAILED copilot check",
    guardFile: ".github/workflows/reusable-all-green.yml",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal workflow env line under pin
    snippet:
      "PR_AUTHOR_LOGIN: ${{ github.event_name == 'pull_request_review' && github.event.pull_request.user.login || '' }}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the probe-PB mutation, verbatim
    mutated:
      "PR_AUTHOR_LOGIN: ${{ github.event_name == 'pull_request_review' && github.actor || '' }}",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName:
      "the PR author LOGIN env wiring is ARMED: only the pull request's author may feed the bot stand-down",
  },
  {
    id: "verdict-author-type-wiring",
    hazard:
      "PR_AUTHOR_TYPE rewired away from the pull request's author - the same disarm as the login half through the other field: a reviewer's Bot type stands the copilot expectation down on a human PR",
    guardFile: ".github/workflows/reusable-all-green.yml",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal workflow env line under pin
    snippet:
      "PR_AUTHOR_TYPE: ${{ github.event_name == 'pull_request_review' && github.event.pull_request.user.type || '' }}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the reviewer-identity mutation
    mutated:
      "PR_AUTHOR_TYPE: ${{ github.event_name == 'pull_request_review' && github.event.review.user.type || '' }}",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName:
      "the PR author TYPE env wiring is ARMED: only the pull request's author may feed the bot stand-down",
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
  // The fleet release leg (the release-please module's job in the managed
  // all-green.yml wrapper): each pin below can rot alone, and every one
  // fails open at run time - a weakened gate releases off red or unjudged
  // commits with GitHub reporting nothing wrong. The forcing tests run the
  // fleet-ci-render-roster ssot judgment on the REAL template sources.
  {
    id: "fleet-release-verdict-gate",
    hazard:
      "the verdict-conclusion clause deleted from the release leg's if: GitHub still implies success() on the needs edge, so the leg releases on a POSTED-RED or pending verdict whose job result was success",
    guardFile: "templates/release-please/fragments/all-green-release.jinja",
    snippet: "      needs.verdict.outputs.conclusion == 'success' &&",
    mutated: "",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName: "the release leg's verdict gate is ARMED: only a posted green verdict releases",
  },
  {
    id: "fleet-release-judged-sha-pass",
    hazard:
      "the sha input deleted from the release leg's call: release.yml falls back to github.sha, which on workflow_run events is main's CURRENT tip - a newer, possibly red commit whose own verdict is still pending",
    guardFile: "templates/release-please/fragments/all-green-release.jinja",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal fragment line under pin
    snippet: "      sha: {% raw %}${{ github.event.workflow_run.head_sha }}{% endraw %}",
    mutated: "",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName: "the judged-sha pass is ARMED: the leg hands the verdict's commit to release.yml",
  },
  {
    id: "fleet-release-judged-sha-read",
    hazard:
      "release.yml's head gate rewired off the input back to github.sha: the leg still passes the judged commit but the gate compares the tip against itself, always-true, silently releasing unjudged pushes",
    guardFile: "templates/release-please/.github/workflows/release.yml.jinja",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template line under pin
    snippet: "          JUDGED: {% raw %}${{ inputs.sha || github.sha }}{% endraw %}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the unarmed shape the audit stages
    mutated: "          JUDGED: {% raw %}${{ github.sha }}{% endraw %}",
    testFile: "tests/scripts/check_ssot.test.ts",
    testName: "the judged-sha read is ARMED: release.yml's head gate compares the judged commit",
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

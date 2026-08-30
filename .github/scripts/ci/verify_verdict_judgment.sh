#!/usr/bin/env bash
# Behavior test for the all-green verdict's judging logic, run against the
# REAL run block extracted from .github/workflows/reusable-all-green.yml -
# never a copy, so the assertions cannot drift from what ships. A stub
# `gh` on PATH serves each scenario's job listing, workflow-run listing,
# and Copilot check-run listing, and captures the check-run POST; every
# scenario then asserts the POSTed status/conclusion (and title, where the
# branch taken matters). This harness stays pure bash + jq and imports
# nothing it verifies (repo law for the ci/ harnesses); the expected-set
# semantics it pins also live as expectedSetGaps in shared/all_green.ts,
# whose bun tests pin the twin.
#
# Scenarios, chosen to fail through the same path a real disarm would:
#    1. gating success + anchor success        -> success
#    2. anchor ABSENT (caller deleted)         -> failure (required gate job)
#    3. anchor SKIPPED (caller conditioned)    -> failure (required gate job)
#    4. anchor succeeded in a PRIOR attempt    -> success (newest-per-name)
#    5. duplicate gating names in one attempt  -> failure (duplicate names),
#       even though the newest duplicate succeeded - the fail-open this pins
#    6. every gating job skipped               -> failure (vouches for nothing)
#    7. no require-job (operator mode)         -> success on gating passes
#    8. a failed gating job                    -> failure naming it
#    9. a conditional still running (PR)       -> PENDING naming it
#   10. the conditional completed success      -> success
#   11. roster names a workflow with no run    -> PENDING, never green
#   12. a conditional concluded failure        -> failure naming it
#   13. Copilot required, absent, author UNKNOWN (a workflow_run wake
#       carries no PR author) -> PENDING immediately, naming the review
#       wake and the unwedge - and the sleep stub proves no poll happens
#   14. a review wake at a green sha where Copilot's check landed ->
#       success (the event-driven replacement for the retired poll)
#   15. a review wake on a bot-AUTHORED PR, no Copilot check -> success
#       with no check-run read (the stand-down keys on the PR author)
#   16. Copilot's check concluded failure      -> failure naming it
#   17. push event owes neither conditionals nor Copilot -> success, no reads
#   18. conditional missing AND Copilot missing -> PENDING naming both
#   19. the registry maps the name to two paths -> failure (ambiguous name),
#       even though the claimant that ran succeeded
#   20. two paths under the name among the runs -> failure, same rule
#   21. workflow_dispatch with NOTHING declared  -> success (a CI-only
#       judgment is then complete; dispatch/schedule verdicts keep
#       vouching for re-runs on main) - with declarations it REFUSES (below)
#   22. wrong-app / app-less copilot look-alikes -> PENDING (the app
#       filter is load-bearing, not just its TS twin)
#   23. a review wake on a HUMAN-authored PR, no Copilot check ->
#       PENDING (a known-human author arms exactly like an unknown one)
#   24. the sole run comes from a path other than the registered owner
#       -> failure (the decoy fail-open: both cardinality checks pass)
#   25. the registry does not know the rostered name -> failure, even
#       with a same-named green run (config error or off-branch decoy)
#   26. an empty registry -> failure, same rule
#   27. the unknown rostered name with NO runs at the sha -> failure,
#       never PENDING (identity precedes the no-candidate branch)
#   28. a review wake with NO CI run at the head yet -> quiet stand-down
#       (exit 0, NO POST - the CI completion judges later, and a red run
#       per review would be pure noise)
#   29. a review wake whose PR head lives in a FORK -> quiet stand-down
#       with no reads at all (fork review wakes carry a read-only token)
#   30. a review wake with the NEWEST run still in flight next to an
#       older completed green -> quiet stand-down, never a stale green
#   31. a review wake beside a same-sha completed PUSH run holding the
#       highest id -> the PR-event run is judged (PENDING on the owed
#       review), never the push run whose semantics owe nothing
#
# Retired WITH the poll (re-judgment went event-driven; a submitted
# review is its own wake): the lands-during-the-bounded-wait and
# conditional-goes-red-during-the-wait scenarios pinned the wait loop's
# post-wait re-read, and the wait no longer exists - every wake is one
# fresh read (scenarios 14/23/28/29 pin the review wake that replaced
# it). The non-numeric and oversized copilot-wait-minutes refusal guards
# went with their input. The bot-ACTOR stand-down scenario became
# scenario 15's author form: a run actor must never disarm the gate.
# shellcheck disable=SC2016  # jq programs and assertion strings carry literals
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/reusable-all-green.yml"

TMP_ROOT="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "${TMP_ROOT%/}/verdict-judgment.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "::error::verdict-judgment check failed: $1"; exit 1; }

# --- Extract the judge step's run block, verbatim -------------------------
# The block is the workflow's single `run: |` scalar: everything after that
# line at its 10-space indent, de-indented. Extraction failing (a moved or
# renamed block) must fail the harness, not pass it vacuously.
awk '
  found && /^          / { print substr($0, 11); next }
  found && /^[[:space:]]*$/ { print ""; next }
  found { exit }
  /^        run: \|$/ { found = 1 }
' "$WORKFLOW" > "$WORK/judge.sh"
grep -qF 'set -euo pipefail' "$WORK/judge.sh" || fail "could not extract the run block from $WORKFLOW"
grep -qF 'check-runs' "$WORK/judge.sh" || fail "the extracted run block is missing the check-run POST"

# --- Class ban: command substitution only in plain assignments -------------
# A $(...) anywhere but a plain assignment can swallow its probe's failure
# under errexit: inside [ ]/[[ ]]/test/case words the substitution is
# errexit-exempt (a crashing probe reads as empty/zero and the guard falls
# OPEN), and `local x="$(probe)"` masks the status with local's own. This
# class produced two real fail-opens in the block (the conditional_gaps
# fetches, then the event-refusal guard's roster count), so the invariant
# is structural: every non-arithmetic $( must OPEN a bare assignment
# (var=, or the `if ! var=` parse-guard shape, where the status IS the
# tested thing). $((...)) arithmetic runs no command and stays legal;
# comment lines are ignored. The self-checks below are the ban's own
# controls: it must be seen catching every banned shape and passing every
# legal one, or a regex regression could blind it silently.
banned_substitutions() { # <script> -> offending "line:content" lines, if any
  # Per non-comment line: strip $(( arithmetic, count the remaining $(
  # openings (an opening at end-of-line counts - a multiline `if test "$(`
  # is the same trap). One opening is legal only when the line IS the
  # assignment (optionally the `if ! ` guard prefix) AND nothing but a
  # status consumer follows the substitution's close: after the LAST )" on
  # the line only `|| return N`, `|| exit N`, or `; then` may appear - a
  # trailing command (`x="$(probe)" printf ...`) would mask the status.
  # A line with no )" is an unclosed multiline substitution: nothing can
  # execute after it on that line, so it is legal by construction.
  awk '
    /^[[:space:]]*#/ { next }
    {
      stripped = $0
      gsub(/\$\(\(/, "", stripped)
      count = gsub(/\$\(/, "", stripped)
      if (count == 0) next
      bad = 0
      if (count > 1) bad = 1
      if ($0 !~ /^[[:space:]]*(if ! )?[A-Za-z_][A-Za-z0-9_]*="\$\(/) bad = 1
      tail = $0
      if (index(tail, ")\"") > 0) {
        while ((i = index(tail, ")\"")) > 0) tail = substr(tail, i + 2)
        if (tail !~ /^( \|\| (return|exit) [1-9][0-9]*)?(; then)?$/) bad = 1
      }
      if (bad) printf "%d:%s\n", NR, $0
    }
  ' "$1"
}
ban_expect() { # <caught|clean> <line>
  printf '%s\n' "$2" > "$WORK/ban-probe.sh"
  found="$(banned_substitutions "$WORK/ban-probe.sh")"
  case "$1" in
    caught) [ -n "$found" ] || fail "class-ban self-check: must catch: $2" ;;
    clean) [ -z "$found" ] || fail "class-ban self-check: must allow: $2" ;;
  esac
}
ban_expect caught 'if [ "$(probe)" -gt 0 ]; then'
ban_expect caught '  && [ -z "$(probe)" ] should_be_caught_mid_multiline_test'
ban_expect caught 'if test "$(probe)" = x; then'
ban_expect caught 'if test "$('
ban_expect caught 'case "$(probe)" in'
ban_expect caught 'local registry="$(probe)"'
ban_expect caught 'x="$(probe)" printf masked-status'
ban_expect caught 'x="$(ok)" && test "$(probe)" = y'
ban_expect caught 'x="$(probe)" || return 0'
ban_expect caught 'x="$(probe)" || exit 0'
ban_expect clean 'roster_size="$(jq length <<<"$x")"'
ban_expect clean 'runs_at_sha="$(probe)" || return 1'
ban_expect clean 'if ! conditionals="$(jq -ce . <<<"$y")"; then'
ban_expect clean "all_jobs=\"\$(timeout 60 gh api --paginate \\"
ban_expect clean 'dupes="$(jq -r "$gating"'"'"' | group_by([.name, .run_attempt])'
ban_expect clean 'while [ "$((SECONDS - start))" -lt "$b" ]; do'
ban_expect clean '# a comment mentioning $(...) shapes'
offenders="$(banned_substitutions "$WORK/judge.sh")"
if [ -n "$offenders" ]; then
  fail "command substitution outside a plain assignment - assign the probe to a variable first, then use the variable (a \$(...) in a test/case context is errexit-exempt and a crashing probe reads as empty/zero, failing open):
$offenders"
fi
# Third layer: no explicit status DISCARD anywhere in the block - `|| true`,
# `|| :`, or a `|| return`/`|| exit` whose code is anything but a plain
# nonzero literal (an arithmetic-wrapped zero is still zero; a bare
# `|| return` propagates and stays legal). This closes the composition
# escape where a multiline closer or a smuggled zero rides past the two
# layers above. The three layers together pin the ACCIDENTAL class and
# every explicit discard; a deliberately obfuscated swallow beyond them
# (say `|| echo`) is intent, not accident - review's domain, like any
# other malicious edit to this repo's own gate.
status_discards() { # <script> -> offending "line:content" lines, if any
  awk '
    /^[[:space:]]*#/ { next }
    {
      line = $0
      while (match(line, /\|\|[[:space:]]+[^[:space:]]+([[:space:]]+[^[:space:]]+)?/)) {
        frag = substr(line, RSTART, RLENGTH)
        line = substr(line, RSTART + RLENGTH)
        n = split(frag, w, /[[:space:]]+/)
        cmd = w[2]
        arg = (n >= 3) ? w[3] : ""
        # Shell punctuation is not part of the token: `|| true)"` inside a
        # substitution and `|| true;` are the same discard, and a legal
        # `|| exit 1)"` closing a substitution keeps its plain literal.
        sub(/[)";]+$/, "", cmd)
        sub(/[)";]+$/, "", arg)
        if (cmd == "true" || cmd == ":") { printf "%d:%s\n", NR, $0; next }
        if ((cmd == "return" || cmd == "exit") && arg != "" && arg !~ /^[1-9][0-9]*$/) {
          printf "%d:%s\n", NR, $0
          next
        }
      }
    }
  ' "$1"
}
discard_expect() { # <caught|clean> <line>
  printf '%s\n' "$2" > "$WORK/ban-probe.sh"
  found="$(status_discards "$WORK/ban-probe.sh")"
  case "$1" in
    caught) [ -n "$found" ] || fail "discard-ban self-check: must catch: $2" ;;
    clean) [ -z "$found" ] || fail "discard-ban self-check: must allow: $2" ;;
  esac
}
discard_expect caught ')" || return 0'
discard_expect caught 'x="$(probe)" || return "$((0))"'
discard_expect caught 'x="$(probe)" || exit 0'
discard_expect caught 'x="$(probe || true)"'
discard_expect caught 'probe || true;'
discard_expect caught 'probe || true'
discard_expect caught 'probe || :'
discard_expect clean 'runs_at_sha="$(probe)" || return 1'
discard_expect clean 'x="$(probe || exit 1)"'
discard_expect clean '  --jq ... | jq -s .)" || return 1'
discard_expect clean '&& { [ "$a" = "x" ] || [ "$a" = "y" ]; }'
discards="$(status_discards "$WORK/judge.sh")"
if [ -n "$discards" ]; then
  fail "explicit status discard in the judge block - a swallowed probe failure is the fail-open class this harness retires:
$discards"
fi
# Second layer, a real bash lexer for the shapes line-based scanning cannot
# see (a multiline substitution CLOSING into a trailing command, arithmetic
# smuggling a command after the close): shellcheck's optional
# check-extra-masked-returns flags any substitution whose failure a
# surrounding command would mask. Enforced wherever shellcheck exists -
# CI's runner always has it; a dev machine without it still runs the awk
# layer above. Its own negative control runs first: a checker never seen
# failing proves nothing.
if command -v shellcheck > /dev/null; then
  printf '%s\n' 'x="$(probe)" printf masked-status' > "$WORK/sc-probe.sh"
  if shellcheck --shell=bash --enable=check-extra-masked-returns "$WORK/sc-probe.sh" > /dev/null 2>&1; then
    fail "shellcheck's check-extra-masked-returns did not flag a known-masked probe - the lexer layer is blind"
  fi
  shellcheck --shell=bash --enable=check-extra-masked-returns "$WORK/judge.sh" \
    || fail "the judge block masks a command substitution's return status (shellcheck check-extra-masked-returns, above)"
else
  echo "notice: shellcheck not installed - the masked-returns lexer layer runs in CI"
fi

# --- Stub gh: serve the scenario's listings, capture the POST -------------
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'GHSTUB'
#!/usr/bin/env bash
# Stub gh for the verdict harness. Jobs listing: validates the request
# shape (the jobs endpoint with filter=all - judging fewer than all
# attempts is the fail-open the block guards against), then applies the
# caller's --jq over $JOBS_FIXTURE and, when set, $JOBS_FIXTURE2 - two
# pages, emitted the way --paginate concatenates per-page --jq output.
# Workflow runs at the sha: --jq over $RUNS_FIXTURE. The workflow
# registry: --jq over $REGISTRY_FIXTURE. Copilot check runs: --jq over
# $CHECKS_FIXTURE. The review-wake / unwedge CI-run lookup: --jq over
# $CI_RUNS_FIXTURE. The literal fixture value FAIL simulates the API
# read itself dying (exit 1, nothing served).
# Check-run POST: validates the exact endpoint, then records the full
# argv as a JSON array (boundary-preserving - summaries are multi-line).
# Any endpoint without a fixture is an unexpected read and fails the
# scenario - a scenario that must not fetch proves it by providing
# nothing to serve.
set -euo pipefail
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = "--method" ] && [ "${args[i + 1]}" = "POST" ]; then
    if [ "${args[i + 2]}" = "repos/$GITHUB_REPOSITORY/check-runs" ]; then
      jq -n '$ARGS.positional' --args -- "${args[@]}" > "$POST_CAPTURE"
      exit 0
    fi
    echo "stub gh: a POST to an unexpected endpoint: $*" >&2
    exit 64
  fi
done
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = "--jq" ]; then
    for ((j = 0; j < ${#args[@]}; j++)); do
      case "${args[j]}" in
        repos/*"/actions/workflows/ci.yml/runs?head_sha="*)
          # The review-wake / unwedge lookup: the sha's newest completed
          # CI run.
          if [ -z "${CI_RUNS_FIXTURE:-}" ]; then
            echo "stub gh: a CI-run lookup this scenario must not make: $*" >&2
            exit 64
          fi
          jq -rc "${args[i + 1]}" "$CI_RUNS_FIXTURE"
          exit 0
          ;;
        repos/*/actions/runs/*"/jobs?filter=all"*)
          jq -rc "${args[i + 1]}" "$JOBS_FIXTURE"
          if [ -n "${JOBS_FIXTURE2:-}" ]; then jq -rc "${args[i + 1]}" "$JOBS_FIXTURE2"; fi
          exit 0
          ;;
        repos/*"/actions/runs?head_sha="*)
          if [ -z "${RUNS_FIXTURE:-}" ]; then
            echo "stub gh: a workflow-run listing this scenario must not make: $*" >&2
            exit 64
          fi
          if [ "$RUNS_FIXTURE" = "FAIL" ]; then
            echo "stub gh: simulated API failure for the workflow-run listing" >&2
            exit 1
          fi
          jq -rc "${args[i + 1]}" "$RUNS_FIXTURE"
          exit 0
          ;;
        repos/*"/actions/workflows?per_page="*)
          if [ -z "${REGISTRY_FIXTURE:-}" ]; then
            echo "stub gh: a workflow-registry listing this scenario must not make: $*" >&2
            exit 64
          fi
          if [ "$REGISTRY_FIXTURE" = "FAIL" ]; then
            echo "stub gh: simulated API failure for the workflow-registry listing" >&2
            exit 1
          fi
          jq -rc "${args[i + 1]}" "$REGISTRY_FIXTURE"
          exit 0
          ;;
        repos/*/commits/*"/check-runs?check_name=copilot-pull-request-reviewer"*)
          if [ -z "${CHECKS_FIXTURE:-}" ]; then
            echo "stub gh: a check-run listing this scenario must not make: $*" >&2
            exit 64
          fi
          if [ "$CHECKS_FIXTURE" = "FAIL" ]; then
            echo "stub gh: simulated API failure for the check-run listing" >&2
            exit 1
          fi
          jq -rc "${args[i + 1]}" "$CHECKS_FIXTURE"
          exit 0
          ;;
      esac
    done
    echo "stub gh: a listing without a recognized endpoint: $*" >&2
    exit 64
  fi
done
echo "stub gh: unexpected invocation: $*" >&2
exit 64
GHSTUB
chmod +x "$WORK/bin/gh"

# The judge block bounds its gh calls with `timeout N`; the stub gh never
# hangs, and macOS dev machines lack the coreutils binary, so shim it to
# a plain exec of the wrapped command.
cat > "$WORK/bin/timeout" <<'TSTUB'
#!/usr/bin/env bash
shift
exec "$@"
TSTUB
chmod +x "$WORK/bin/timeout"

# The judge never sleeps any more: the bounded Copilot poll was retired
# for event-driven re-judgment (a submitted review is its own wake), so a
# sleep reappearing in the block is the poll growing back - fail the
# scenario outright rather than let a wait ride under the stub.
cat > "$WORK/bin/sleep" <<'SSTUB'
#!/usr/bin/env bash
echo "stub sleep: the judge block must never sleep - re-judgment is event-driven, the poll is retired" >&2
exit 64
SSTUB
chmod +x "$WORK/bin/sleep"

posted() { # <field> -> the captured POST's full value for -f "<field>=..."
  jq -r --arg want "$1" '
    . as $a
    | [range(length) | select($a[.] == "-f" and ($a[. + 1] | startswith($want + "=")))]
    | if length == 0 then "" else $a[first + 1][($want | length) + 1:] end
  ' "$POST_CAPTURE"
}

posted_summary() { # -> the captured POST's full multi-line output[summary] value
  posted 'output[summary]'
}

run_verdict() { # <jobs fixture.json> [<env overrides...>] -> runs the real block
  export JOBS_FIXTURE="$1"
  export POST_CAPTURE="$WORK/post.txt"
  export GITHUB_OUTPUT="$WORK/gh-output.txt"
  shift
  : > "$POST_CAPTURE"
  : > "$GITHUB_OUTPUT"
  PATH="$WORK/bin:$PATH" \
    GH_TOKEN=stub SHA="" REQUIRE_JOB="" RUN_ID=42 \
    HEAD_SHA=0000000000000000000000000000000000000042 RUN_EVENT=push \
    RUN_STATUS=completed RUN_PATH=.github/workflows/ci.yml \
    CONDITIONAL_WORKFLOWS='[]' REQUIRE_COPILOT=false \
    GITHUB_REPOSITORY=o/r GITHUB_SERVER_URL=https://example.invalid \
    env JOBS_FIXTURE2= RUNS_FIXTURE= REGISTRY_FIXTURE= CHECKS_FIXTURE= \
    CI_RUNS_FIXTURE= REVIEW_SHA= REVIEW_HEAD_REPO= PR_AUTHOR_LOGIN= PR_AUTHOR_TYPE= "$@" \
    bash "$WORK/judge.sh" > "$WORK/judge.log" 2>&1 \
    || fail "the judge block itself exited non-zero (see below)
$(cat "$WORK/judge.log")"
}

refused() { # <scenario> <error fragment> <env overrides...> - exit EXACTLY 1, named, NO POST
  local scenario="$1" fragment="$2"
  shift 2
  # A HEALTHY fixture sits behind the guard on purpose: were the guard
  # deleted, the block would run through and POST success - only the
  # guard itself can produce the refusal, so this cannot pass vacuously
  # (a missing fixture would exit non-1 at the jq stage and be caught by
  # the exact-status assertion).
  printf '%s' '{"jobs":[{"id":1,"name":"checks / lint","conclusion":"success","run_attempt":1}]}' \
    > "$WORK/healthy.json"
  export JOBS_FIXTURE="$WORK/healthy.json"
  export POST_CAPTURE="$WORK/post.txt"
  export GITHUB_OUTPUT="$WORK/gh-output.txt"
  : > "$POST_CAPTURE"
  : > "$GITHUB_OUTPUT"
  local status=0
  PATH="$WORK/bin:$PATH" \
    GH_TOKEN=stub SHA="" REQUIRE_JOB="" RUN_ID=42 \
    HEAD_SHA=0000000000000000000000000000000000000042 RUN_EVENT=push \
    RUN_STATUS=completed RUN_PATH=.github/workflows/ci.yml \
    CONDITIONAL_WORKFLOWS='[]' REQUIRE_COPILOT=false \
    GITHUB_REPOSITORY=o/r GITHUB_SERVER_URL=https://example.invalid \
    env JOBS_FIXTURE2= RUNS_FIXTURE= REGISTRY_FIXTURE= CHECKS_FIXTURE= \
    CI_RUNS_FIXTURE= REVIEW_SHA= REVIEW_HEAD_REPO= PR_AUTHOR_LOGIN= PR_AUTHOR_TYPE= "$@" \
    bash "$WORK/judge.sh" > "$WORK/judge.log" 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    fail "$scenario: expected the guard's exit 1 but the judge block exited $status
$(cat "$WORK/judge.log")"
  fi
  grep -qF -- "$fragment" "$WORK/judge.log" \
    || fail "$scenario: the refusal does not name its reason ('$fragment' missing from the log)"
  if [ -s "$POST_CAPTURE" ]; then
    fail "$scenario: the judge block POSTed a verdict for a run it must refuse outright"
  fi
  if [ -s "$GITHUB_OUTPUT" ]; then
    fail "$scenario: a refusal must emit no step output (the job fails; a needs-gated caller never runs)"
  fi
}

stood_down() { # <scenario> <notice fragment> <env overrides...> - exit 0, named, NO POST
  # The review wake's quiet exits: judging nothing is CORRECT when the
  # reviewed head has no completed CI run yet (that run's completion
  # judges later) or lives in a fork (a read-only token there). Same
  # healthy-fixture trick as refused(): were the stand-down guard
  # deleted, the block would run on and POST (or die at a fixture-less
  # stub read with exit 64), so this can never pass vacuously.
  local scenario="$1" fragment="$2"
  shift 2
  printf '%s' '{"jobs":[{"id":1,"name":"checks / lint","conclusion":"success","run_attempt":1}]}' \
    > "$WORK/healthy.json"
  export JOBS_FIXTURE="$WORK/healthy.json"
  export POST_CAPTURE="$WORK/post.txt"
  export GITHUB_OUTPUT="$WORK/gh-output.txt"
  : > "$POST_CAPTURE"
  : > "$GITHUB_OUTPUT"
  local status=0
  PATH="$WORK/bin:$PATH" \
    GH_TOKEN=stub SHA="" REQUIRE_JOB="" RUN_ID=42 \
    HEAD_SHA=0000000000000000000000000000000000000042 RUN_EVENT=push \
    RUN_STATUS=completed RUN_PATH=.github/workflows/ci.yml \
    CONDITIONAL_WORKFLOWS='[]' REQUIRE_COPILOT=false \
    GITHUB_REPOSITORY=o/r GITHUB_SERVER_URL=https://example.invalid \
    env JOBS_FIXTURE2= RUNS_FIXTURE= REGISTRY_FIXTURE= CHECKS_FIXTURE= \
    CI_RUNS_FIXTURE= REVIEW_SHA= REVIEW_HEAD_REPO= PR_AUTHOR_LOGIN= PR_AUTHOR_TYPE= "$@" \
    bash "$WORK/judge.sh" > "$WORK/judge.log" 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    fail "$scenario: expected the quiet stand-down's exit 0 but the judge block exited $status
$(cat "$WORK/judge.log")"
  fi
  grep -qF -- "$fragment" "$WORK/judge.log" \
    || fail "$scenario: the stand-down does not name its reason ('$fragment' missing from the log)"
  if [ -s "$POST_CAPTURE" ]; then
    fail "$scenario: the judge block POSTed a verdict on a wake that must judge nothing"
  fi
  if [ -s "$GITHUB_OUTPUT" ]; then
    fail "$scenario: a stand-down must emit no step output (nothing was judged)"
  fi
}

expect() { # <scenario> <conclusion> [<title fragment>]
  got_status="$(posted status)"
  [ "$got_status" = "completed" ] \
    || fail "$1: expected a completed verdict but the POST carries status '$got_status'"
  got="$(posted conclusion)"
  [ "$got" = "$2" ] || fail "$1: expected conclusion '$2' but the verdict POSTed '$got'"
  grep -qxF "conclusion=$2" "$GITHUB_OUTPUT" \
    || fail "$1: the conclusion step output does not mirror the POSTed conclusion '$2' (callers sequence post-green on it)"
  if [ -n "${3:-}" ]; then
    title="$(posted 'output[title]')"
    case "$title" in
      *"$3"*) ;;
      *) fail "$1: expected the title to mention '$3' but got '$title'" ;;
    esac
  fi
}

expect_pending() { # <scenario> <summary fragment> - in_progress, NO conclusion
  got_status="$(posted status)"
  [ "$got_status" = "in_progress" ] \
    || fail "$1: expected a PENDING (in_progress) verdict but the POST carries status '$got_status'"
  got="$(posted conclusion)"
  [ -z "$got" ] || fail "$1: a pending verdict must carry no conclusion, got '$got'"
  grep -qxF "conclusion=" "$GITHUB_OUTPUT" \
    || fail "$1: a pending verdict must emit an EMPTY conclusion output (a caller gating on == success must not run)"
  posted_summary | grep -qF -- "$2" \
    || fail "$1: the pending summary does not name what is missing ('$2' absent from output[summary])"
}

jobs() { printf '%s' "$1" > "$WORK/jobs.json"; echo "$WORK/jobs.json"; }
runs() { printf '%s' "$1" > "$WORK/runs.json"; echo "$WORK/runs.json"; }
registry() { printf '%s' "$1" > "$WORK/registry.json"; echo "$WORK/registry.json"; }
checks() { printf '%s' "$1" > "$2"; echo "$2"; }
ci_runs() { printf '%s' "$1" > "$WORK/ci-runs.json"; echo "$WORK/ci-runs.json"; }

# The review-wake fixtures: the reviewed head and the completed
# pull_request CI run the lookup resolves there. Order is deliberately
# oldest-first (the live API serves newest-first): an implementation
# trusting list order over max_by(.id) would pick the stale in-progress
# run and stand down, failing every judging review-wake scenario.
REVIEW_HEAD=0000000000000000000000000000000000000077
REVIEW_CI_RUN='{"workflow_runs":[
  {"id":76,"head_sha":"0000000000000000000000000000000000000077","event":"pull_request","status":"in_progress","conclusion":null},
  {"id":77,"head_sha":"0000000000000000000000000000000000000077","event":"pull_request","status":"completed","conclusion":"success"}]}'

# The single-owner registry most conditional scenarios ride on ("Ghost
# Workflow" is registered but never runs - the pending case needs a name
# the registry KNOWS, since an unknown name now fails closed outright).
EXTRA_REGISTRY='{"workflows":[
  {"name":"CI","path":".github/workflows/ci.yml"},
  {"name":"Extra Suite","path":".github/workflows/extra.yml"},
  {"name":"Ghost Workflow","path":".github/workflows/ghost.yml"}]}'

ANCHOR="ci / validate-template"

# 1. The healthy fleet run.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"checks / lint","conclusion":"success","run_attempt":1},
  {"id":2,"name":"ci / validate-template","conclusion":"success","run_attempt":1},
  {"id":3,"name":"ci / typography","conclusion":"skipped","run_attempt":1}]}')" REQUIRE_JOB="$ANCHOR"
expect "healthy run" success

# 2. The disarmed caller: the anchor job never ran.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"checks / lint","conclusion":"success","run_attempt":1}]}')" REQUIRE_JOB="$ANCHOR"
expect "deleted caller" failure "required gate job"

# 3. The conditioned caller: the anchor exists but skipped.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"checks / lint","conclusion":"success","run_attempt":1},
  {"id":2,"name":"ci / validate-template","conclusion":"skipped","run_attempt":1}]}')" REQUIRE_JOB="$ANCHOR"
expect "conditioned caller" failure "required gate job"

# 4. A partial re-run: the anchor's attempt-1 success still vouches. The
# attempts arrive across two pages, the way --paginate serves large runs.
printf '%s' '{"jobs":[
  {"id":3,"name":"checks / lint","conclusion":"success","run_attempt":2}]}' > "$WORK/jobs2.json"
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"ci / validate-template","conclusion":"success","run_attempt":1},
  {"id":2,"name":"checks / lint","conclusion":"failure","run_attempt":1}]}')" \
  REQUIRE_JOB="$ANCHOR" JOBS_FIXTURE2="$WORK/jobs2.json"
expect "prior-attempt anchor" success

# 5. Duplicate gating names inside one attempt: refused, even though the
# newest duplicate succeeded (the fail-open this branch exists to close).
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"checks / test","conclusion":"failure","run_attempt":1},
  {"id":2,"name":"checks / test","conclusion":"success","run_attempt":1},
  {"id":3,"name":"ci / validate-template","conclusion":"success","run_attempt":1}]}')" REQUIRE_JOB="$ANCHOR"
expect "duplicate names" failure "duplicate job names"

# 6. All gating jobs skipped: vouches for nothing.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"checks / lint","conclusion":"skipped","run_attempt":1}]}')"
expect "all skipped" failure "no gating job actually succeeded"

# 7. Operator mode: no anchor required, gating passes suffice.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"validate","conclusion":"success","run_attempt":1},
  {"id":2,"name":"info-release / publish","conclusion":"failure","run_attempt":1}]}')"
expect "operator mode" success

# 8. A failed gating job is named.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"checks / lint","conclusion":"failure","run_attempt":1},
  {"id":2,"name":"ci / validate-template","conclusion":"success","run_attempt":1}]}')" REQUIRE_JOB="$ANCHOR"
expect "failed gate" failure "checks / lint (failure)"

# --- the expected set beyond the CI run ------------------------------------
GREEN_JOBS='{"jobs":[
  {"id":1,"name":"checks / lint","conclusion":"success","run_attempt":1},
  {"id":2,"name":"ci / validate-template","conclusion":"success","run_attempt":1}]}'

# 9. A declared conditional workflow is still running on a PR: PENDING.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request CONDITIONAL_WORKFLOWS='["Extra Suite"]' \
  REGISTRY_FIXTURE="$(registry "$EXTRA_REGISTRY")" \
  RUNS_FIXTURE="$(runs '{"workflow_runs":[
    {"id":9,"name":"Extra Suite","path":".github/workflows/extra.yml","event":"pull_request","status":"in_progress","conclusion":null}]}')"
expect_pending "conditional still running" "Extra Suite is still in_progress"

# 10. The conditional completed successfully: green. A completed push run
# of the same name must not be what satisfies it (event-scoped), so one
# rides along red.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request CONDITIONAL_WORKFLOWS='["Extra Suite"]' \
  REGISTRY_FIXTURE="$(registry "$EXTRA_REGISTRY")" \
  RUNS_FIXTURE="$(runs '{"workflow_runs":[
    {"id":8,"name":"Extra Suite","path":".github/workflows/extra.yml","event":"push","status":"completed","conclusion":"failure"},
    {"id":9,"name":"Extra Suite","path":".github/workflows/extra.yml","event":"pull_request","status":"completed","conclusion":"success"}]}')"
expect "conditional completed" success

# 11. The roster names a workflow with no run at the sha (nonexistent or
# never fired): PENDING, never green - the fail-closed rule.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request CONDITIONAL_WORKFLOWS='["Ghost Workflow"]' \
  REGISTRY_FIXTURE="$(registry "$EXTRA_REGISTRY")" \
  RUNS_FIXTURE="$(runs '{"workflow_runs":[
    {"id":7,"name":"CI","path":".github/workflows/ci.yml","event":"pull_request","status":"completed","conclusion":"success"}]}')"
expect_pending "roster names a nonexistent workflow" "Ghost Workflow has no pull_request run at this sha"

# 12. The conditional concluded failure: the verdict is a completed failure.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request CONDITIONAL_WORKFLOWS='["Extra Suite"]' \
  REGISTRY_FIXTURE="$(registry "$EXTRA_REGISTRY")" \
  RUNS_FIXTURE="$(runs '{"workflow_runs":[
    {"id":9,"name":"Extra Suite","path":".github/workflows/extra.yml","event":"pull_request","status":"completed","conclusion":"failure"}]}')"
expect "conditional failed" failure "expected workflows did not succeed"

# 13. Copilot required and absent, author unknown (a workflow_run wake
# carries no PR author, and unknown must never disarm): PENDING
# immediately - no poll exists any more (the sleep stub would fail the
# block), and the summary names both re-judgment paths.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request REQUIRE_COPILOT=true \
  CHECKS_FIXTURE="$(checks '{"check_runs":[]}' "$WORK/checks.json")"
expect_pending "copilot absent, author unknown" "copilot-pull-request-reviewer check run has not been created"
posted_summary | grep -qF "each submitted review at this sha re-judges" \
  || fail "copilot absent, author unknown: the pending summary does not name the review wake"
posted_summary | grep -qF "dispatch the All Green workflow" \
  || fail "copilot absent, author unknown: the pending summary does not name the dispatch unwedge"

# 14. The review wake at a green sha where Copilot's check has landed:
# success - this wake is the event-driven replacement for the retired
# poll (a check run's completion fires no workflow_run event; the review
# SUBMISSION is what re-fires judgment).
run_verdict "$(jobs "$GREEN_JOBS")" \
  REVIEW_SHA="$REVIEW_HEAD" REVIEW_HEAD_REPO=o/r \
  PR_AUTHOR_LOGIN=someone PR_AUTHOR_TYPE=User REQUIRE_COPILOT=true \
  CI_RUNS_FIXTURE="$(ci_runs "$REVIEW_CI_RUN")" \
  CHECKS_FIXTURE="$(checks '{"check_runs":[
    {"name":"copilot-pull-request-reviewer","status":"completed","conclusion":"success","app":{"slug":"github-actions"}}]}' "$WORK/checks.json")"
expect "review wake with the check landed" success
got_head="$(posted head_sha)"
[ "$got_head" = "$REVIEW_HEAD" ] \
  || fail "review wake with the check landed: the verdict must attach to the looked-up run's head sha, got '$got_head'"

# 15. A review wake on a bot-AUTHORED PR stands the Copilot expectation
# down: success, and the stub proves no check-run read happened (no
# CHECKS_FIXTURE is provided - a read would exit 64 and fail the block).
# The stand-down keys on the PULL REQUEST'S AUTHOR, never any run actor.
run_verdict "$(jobs "$GREEN_JOBS")" \
  REVIEW_SHA="$REVIEW_HEAD" REVIEW_HEAD_REPO=o/r \
  PR_AUTHOR_LOGIN='dependabot[bot]' PR_AUTHOR_TYPE=Bot REQUIRE_COPILOT=true \
  CI_RUNS_FIXTURE="$(ci_runs "$REVIEW_CI_RUN")"
expect "bot-authored PR review wake skips the copilot expectation" success

# 16. Copilot's check concluded failure: a completed failure, not pending.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request REQUIRE_COPILOT=true \
  CHECKS_FIXTURE="$(checks '{"check_runs":[
    {"name":"copilot-pull-request-reviewer","status":"completed","conclusion":"failure","app":{"slug":"github-actions"}}]}' "$WORK/checks.json")"
expect "copilot concluded failure" failure "copilot-pull-request-reviewer check run concluded failure"

# 17. Push judgments owe neither conditionals nor Copilot: green with no
# workflow-run or check-run reads (the stub would fail on either).
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=push CONDITIONAL_WORKFLOWS='["Extra Suite"]' REQUIRE_COPILOT=true
expect "push event owes only CI" success

# 18. A conditional missing AND Copilot missing: PENDING naming both
# gaps in one summary - nothing masks anything.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request CONDITIONAL_WORKFLOWS='["Extra Suite"]' REQUIRE_COPILOT=true \
  REGISTRY_FIXTURE="$(registry "$EXTRA_REGISTRY")" \
  RUNS_FIXTURE="$(runs '{"workflow_runs":[]}')" \
  CHECKS_FIXTURE="$(checks '{"check_runs":[]}' "$WORK/checks.json")"
expect_pending "mixed gaps" "Extra Suite has no pull_request run at this sha"
posted_summary | grep -qF "copilot-pull-request-reviewer check run has not been created" \
  || fail "mixed gaps: the pending summary must name the Copilot gap too"

# 19. The repository's workflow registry resolves the rostered name to two
# paths: a completed failure, even though the one that ran succeeded - by
# name is the only way a roster can speak, so an ambiguous name must never
# be judged by whichever claimant happened to run.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request CONDITIONAL_WORKFLOWS='["Extra Suite"]' \
  REGISTRY_FIXTURE="$(registry '{"workflows":[
    {"name":"Extra Suite","path":".github/workflows/extra.yml"},
    {"name":"Extra Suite","path":".github/workflows/decoy.yml"}]}')" \
  RUNS_FIXTURE="$(runs '{"workflow_runs":[
    {"id":9,"name":"Extra Suite","path":".github/workflows/decoy.yml","event":"pull_request","status":"completed","conclusion":"success"}]}')"
expect "registry name collision" failure "expected workflows did not succeed"
posted_summary | grep -qF "Extra Suite is claimed by 2 workflows" \
  || fail "registry name collision: the summary does not name the colliding claimants"

# 20. Two paths under the rostered name among the sha's own runs: a
# completed failure, even with a success among them. This catches the
# BOTH-RAN shape; the sole-run decoy (only the impostor fired) is
# scenario 24's owner binding - together they close the branch-side
# collisions the default-branch registry cannot see.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request CONDITIONAL_WORKFLOWS='["Extra Suite"]' \
  REGISTRY_FIXTURE="$(registry "$EXTRA_REGISTRY")" \
  RUNS_FIXTURE="$(runs '{"workflow_runs":[
    {"id":8,"name":"Extra Suite","path":".github/workflows/extra.yml","event":"pull_request","status":"completed","conclusion":"failure"},
    {"id":9,"name":"Extra Suite","path":".github/workflows/decoy.yml","event":"pull_request","status":"completed","conclusion":"success"}]}')"
expect "run-level name collision" failure "expected workflows did not succeed"
posted_summary | grep -qF "Extra Suite is two different workflows at this sha" \
  || fail "run-level name collision: the summary does not name the collision"

# 24. The decoy hole, closed: the registry owns the name at extra.yml, but
# the ONLY run at the sha - green - comes from decoy.yml (the real
# workflow path-filtered away, a same-named decoy added). Both
# cardinality checks pass; only the owner binding can catch it.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request CONDITIONAL_WORKFLOWS='["Extra Suite"]' \
  REGISTRY_FIXTURE="$(registry "$EXTRA_REGISTRY")" \
  RUNS_FIXTURE="$(runs '{"workflow_runs":[
    {"id":9,"name":"Extra Suite","path":".github/workflows/decoy.yml","event":"pull_request","status":"completed","conclusion":"success"}]}')"
expect "sole-run path mismatch" failure "expected workflows did not succeed"
posted_summary | grep -qF "Extra Suite ran from .github/workflows/decoy.yml, not its registered workflow .github/workflows/extra.yml" \
  || fail "sole-run path mismatch: the summary does not name the owner binding"

# 25. A rostered name the registry does not know: failure (config error or
# an off-default-branch decoy - waiting heals neither), even though a
# same-named green run exists.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request CONDITIONAL_WORKFLOWS='["Extra Suite"]' \
  REGISTRY_FIXTURE="$(registry '{"workflows":[
    {"name":"CI","path":".github/workflows/ci.yml"}]}')" \
  RUNS_FIXTURE="$(runs '{"workflow_runs":[
    {"id":9,"name":"Extra Suite","path":".github/workflows/decoy.yml","event":"pull_request","status":"completed","conclusion":"success"}]}')"
expect "unknown rostered name" failure "expected workflows did not succeed"
posted_summary | grep -qF "Extra Suite is not a workflow this repository knows" \
  || fail "unknown rostered name: the summary does not name the registry miss"

# 26. An entirely empty registry: same failure, same reason - a green
# decoy run must never stand in for a workflow the repository does not
# have.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request CONDITIONAL_WORKFLOWS='["Extra Suite"]' \
  REGISTRY_FIXTURE="$(registry '{"workflows":[]}')" \
  RUNS_FIXTURE="$(runs '{"workflow_runs":[
    {"id":9,"name":"Extra Suite","path":".github/workflows/decoy.yml","event":"pull_request","status":"completed","conclusion":"success"}]}')"
expect "empty registry" failure "expected workflows did not succeed"
posted_summary | grep -qF "Extra Suite is not a workflow this repository knows" \
  || fail "empty registry: the summary does not name the registry miss"

# 27. The unknown rostered name with NO runs at the sha at all: still the
# identity failure, never PENDING. Scenarios 25/26 carry a green decoy
# run, so only this pins the ORDER - a no-candidate branch hoisted above
# the registry check would leave this verdict pending forever.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request CONDITIONAL_WORKFLOWS='["Extra Suite"]' \
  REGISTRY_FIXTURE="$(registry '{"workflows":[
    {"name":"CI","path":".github/workflows/ci.yml"}]}')" \
  RUNS_FIXTURE="$(runs '{"workflow_runs":[]}')"
expect "unknown name with no runs" failure "expected workflows did not succeed"
posted_summary | grep -qF "Extra Suite is not a workflow this repository knows" \
  || fail "unknown name with no runs: the summary does not name the registry miss"

# 21. workflow_dispatch with NOTHING declared posts like a push judgment:
# with an empty roster and no Copilot demand, a CI-only judgment is
# complete, and dispatch/schedule verdicts are what re-runs on main rely
# on today. (With anything declared the same event REFUSES - guard below.)
run_verdict "$(jobs "$GREEN_JOBS")" RUN_EVENT=workflow_dispatch
expect "dispatch with nothing declared" success

# 22. Wrong-app and app-less check runs NAMED copilot-pull-request-reviewer
# never satisfy the expectation: still PENDING. This pins the inline
# engine's app filter itself - the TS twin's look-alike test cannot see a
# deletion here.
run_verdict "$(jobs "$GREEN_JOBS")" \
  RUN_EVENT=pull_request REQUIRE_COPILOT=true \
  CHECKS_FIXTURE="$(checks '{"check_runs":[
    {"name":"copilot-pull-request-reviewer","status":"completed","conclusion":"success","app":{"slug":"evil-app"}},
    {"name":"copilot-pull-request-reviewer","status":"completed","conclusion":"success","app":null}]}' "$WORK/checks.json")"
expect_pending "copilot look-alike apps" "copilot-pull-request-reviewer check run has not been created"

# 23. A review wake on a HUMAN-authored PR whose Copilot check is absent:
# PENDING - a known-human author arms the expectation exactly like an
# unknown one, so only the bot reading (15) may disarm.
run_verdict "$(jobs "$GREEN_JOBS")" \
  REVIEW_SHA="$REVIEW_HEAD" REVIEW_HEAD_REPO=o/r \
  PR_AUTHOR_LOGIN=someone PR_AUTHOR_TYPE=User REQUIRE_COPILOT=true \
  CI_RUNS_FIXTURE="$(ci_runs "$REVIEW_CI_RUN")" \
  CHECKS_FIXTURE="$(checks '{"check_runs":[]}' "$WORK/checks.json")"
expect_pending "human-authored PR review wake" "copilot-pull-request-reviewer check run has not been created"

# 28. A review wake whose head has no CI run at all yet (a review
# usually beats CI here): a QUIET stand-down - exit 0, nothing POSTed,
# nothing output. The CI run's own completion fires the judgment that
# will see this review; a red All Green run per early review would be
# pure noise. The unwedge dispatch keeps its loud error for an empty
# lookup (the guard below), so the two exits cannot be merged. Residual,
# recorded: on a bot-authored PR this discard means a review submitted
# BEFORE CI completes never disarms the expectation - the later CI wake
# carries no author - so the heal is one more review (or the Copilot
# re-request) after CI completes.
stood_down "review wake before any CI run" "no pull_request CI run exists at" \
  REVIEW_SHA="$REVIEW_HEAD" REVIEW_HEAD_REPO=o/r \
  PR_AUTHOR_LOGIN=someone PR_AUTHOR_TYPE=User REQUIRE_COPILOT=true \
  CI_RUNS_FIXTURE="$(ci_runs '{"workflow_runs":[]}')"

# 29. A review wake whose PR head lives in a FORK: a quiet stand-down
# with NO reads at all (no CI_RUNS_FIXTURE is provided - a lookup would
# exit 64 and fail the block). Fork review wakes carry a read-only
# token, so the check-run POST could never land; the sha's CI-completion
# wakes run with full permissions and still judge it.
stood_down "fork-headed review wake" "fork wakes carry a read-only token" \
  REVIEW_SHA="$REVIEW_HEAD" REVIEW_HEAD_REPO=fork-owner/other-repo \
  PR_AUTHOR_LOGIN=someone PR_AUTHOR_TYPE=User REQUIRE_COPILOT=true

# 30. A review wake where the NEWEST run (highest id) is still in flight
# next to an OLDER completed green run: stand down, never judge the
# stale run - a retriggered head's fresh outcome is unknown, and green
# minted from the superseded run would ride the merge box until the new
# completion replaced it. The completed run comes FIRST in the fixture,
# so an implementation trusting list order (or newest-completed) judges
# it and fails here; only max_by(.id) stands down.
stood_down "review wake with a stale green behind a running retrigger" "still 'in_progress'" \
  REVIEW_SHA="$REVIEW_HEAD" REVIEW_HEAD_REPO=o/r \
  PR_AUTHOR_LOGIN=someone PR_AUTHOR_TYPE=User REQUIRE_COPILOT=true \
  CI_RUNS_FIXTURE="$(ci_runs '{"workflow_runs":[
    {"id":77,"head_sha":"0000000000000000000000000000000000000077","event":"pull_request","status":"completed","conclusion":"success"},
    {"id":78,"head_sha":"0000000000000000000000000000000000000077","event":"pull_request","status":"in_progress","conclusion":null}]}')"

# 31. A review wake where a completed PUSH run holds the highest id next
# to the completed PR run: the PR-EVENT run must be judged - selecting
# the newest run of ANY event would flip RUN_EVENT to push, which owes
# neither conditionals nor Copilot, and mint green over the owed review.
# The correct judgment here is PENDING (copilot required and absent).
run_verdict "$(jobs "$GREEN_JOBS")" \
  REVIEW_SHA="$REVIEW_HEAD" REVIEW_HEAD_REPO=o/r \
  PR_AUTHOR_LOGIN=someone PR_AUTHOR_TYPE=User REQUIRE_COPILOT=true \
  CI_RUNS_FIXTURE="$(ci_runs '{"workflow_runs":[
    {"id":77,"head_sha":"0000000000000000000000000000000000000077","event":"pull_request","status":"completed","conclusion":"success"},
    {"id":99,"head_sha":"0000000000000000000000000000000000000077","event":"push","status":"completed","conclusion":"success"}]}')" \
  CHECKS_FIXTURE="$(checks '{"check_runs":[]}' "$WORK/checks.json")"
expect_pending "review wake beside a same-sha push run" "copilot-pull-request-reviewer check run has not been created"

# The pre-judgment guards refuse outright (exit 1, no POST): a look-alike
# workflow merely NAMED "CI", an uncompleted run, a trigger carrying
# neither a workflow_run event, a review head, nor a dispatch sha, a
# conditional-workflows value that is not a JSON list of strings, an
# unwedge dispatch naming a sha with no completed CI run (the review
# wake's quiet exit must never swallow an operator's explicit ask), a
# dispatch or schedule judgment while an expected set is declared (such
# events can neither carry nor stand down PR-scoped members - the refusal
# is JOB-red with no check posted, so no legitimate verdict is shadowed),
# and a dead registry read (command substitution strips errexit inside
# conditional_gaps, so its by-hand propagation is what keeps a dead API
# from being judged as an empty list - this scenario is that guard's
# negative control).
refused "look-alike workflow" "refusing to judge a look-alike" RUN_PATH=.github/workflows/look-alike.yml
refused "uncompleted run" "only completed runs are judged" RUN_STATUS=in_progress
refused "no event and no sha" "nothing to judge" RUN_ID=
refused "malformed roster" "must be a JSON list of workflow display names" CONDITIONAL_WORKFLOWS='not-json'
refused "unwedge dispatch at a run-less sha" "no completed CI run exists at" \
  SHA=0000000000000000000000000000000000000099 \
  CI_RUNS_FIXTURE="$(ci_runs '{"workflow_runs":[]}')"
refused "dispatch with a roster" "cannot judge the declared expected set" \
  RUN_EVENT=workflow_dispatch CONDITIONAL_WORKFLOWS='["Extra Suite"]'
refused "schedule requiring copilot" "cannot judge the declared expected set" \
  RUN_EVENT=schedule REQUIRE_COPILOT=true
refused "dead registry read" "simulated API failure for the workflow-registry listing" \
  RUN_EVENT=pull_request CONDITIONAL_WORKFLOWS='["Extra Suite"]' \
  RUNS_FIXTURE="$(runs '{"workflow_runs":[
    {"id":9,"name":"Extra Suite","path":".github/workflows/extra.yml","event":"pull_request","status":"completed","conclusion":"success"}]}')" \
  REGISTRY_FIXTURE=FAIL

echo "verdict judgment OK: all 28 verdict scenarios POSTed the expected status/conclusion, all three review-wake stand-downs stayed quiet, and all 8 guard scenarios refused, through the real run block"

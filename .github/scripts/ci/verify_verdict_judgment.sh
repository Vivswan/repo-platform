#!/usr/bin/env bash
# Behavior test for the all-green verdict's judging logic, run against the
# REAL run block extracted from .github/workflows/reusable-all-green.yml -
# never a copy, so the assertions cannot drift from what ships. A stub
# `gh` on PATH serves each scenario's job listing and captures the
# check-run POST; every scenario then asserts the POSTed conclusion (and
# title, where the branch taken matters). This harness stays pure bash +
# jq and imports nothing it verifies (repo law for the ci/ harnesses).
#
# Scenarios, chosen to fail through the same path a real disarm would:
#   1. gating success + anchor success        -> success
#   2. anchor ABSENT (caller deleted)         -> failure (required gate job)
#   3. anchor SKIPPED (caller conditioned)    -> failure (required gate job)
#   4. anchor succeeded in a PRIOR attempt    -> success (newest-per-name)
#   5. duplicate gating names in one attempt  -> failure (duplicate names),
#      even though the newest duplicate succeeded - the fail-open this pins
#   6. every gating job skipped               -> failure (vouches for nothing)
#   7. no require-job (operator mode)         -> success on gating passes
#   8. a failed gating job                    -> failure naming it
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

# --- Stub gh: serve the scenario's jobs, capture the POST -----------------
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'GHSTUB'
#!/usr/bin/env bash
# Stub gh for the verdict harness. Jobs listing: validates the request
# shape (the jobs endpoint with filter=all - judging fewer than all
# attempts is the fail-open the block guards against), then applies the
# caller's --jq over $JOBS_FIXTURE and, when set, $JOBS_FIXTURE2 - two
# pages, emitted the way --paginate concatenates per-page --jq output.
# Check-run POST: records the -f fields.
set -euo pipefail
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = "--method" ] && [ "${args[i + 1]}" = "POST" ]; then
    printf '%s\n' "${args[@]}" > "$POST_CAPTURE"
    exit 0
  fi
done
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = "--jq" ]; then
    for ((j = 0; j < ${#args[@]}; j++)); do
      case "${args[j]}" in
        repos/*/actions/runs/*"/jobs?filter=all"*)
          jq -c "${args[i + 1]}" "$JOBS_FIXTURE"
          if [ -n "${JOBS_FIXTURE2:-}" ]; then jq -c "${args[i + 1]}" "$JOBS_FIXTURE2"; fi
          exit 0
          ;;
      esac
    done
    echo "stub gh: a jobs listing without the filter=all jobs endpoint: $*" >&2
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

posted() { # <field> -> the captured POST's value for -f "<field>=..."
  awk -v want="$1" '
    prev == "-f" && index($0, want "=") == 1 { print substr($0, length(want) + 2); exit }
    { prev = $0 }
  ' "$POST_CAPTURE"
}

run_verdict() { # <fixture.json> <require-job> [<fixture page 2>] -> runs the real block
  export JOBS_FIXTURE="$1"
  export JOBS_FIXTURE2="${3:-}"
  export POST_CAPTURE="$WORK/post.txt"
  : > "$POST_CAPTURE"
  PATH="$WORK/bin:$PATH" \
    GH_TOKEN=stub SHA="" REQUIRE_JOB="$2" RUN_ID=42 \
    HEAD_SHA=0000000000000000000000000000000000000042 RUN_EVENT=push \
    RUN_STATUS=completed RUN_PATH=.github/workflows/ci.yml \
    GITHUB_REPOSITORY=o/r GITHUB_SERVER_URL=https://example.invalid \
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
  export JOBS_FIXTURE2=""
  export POST_CAPTURE="$WORK/post.txt"
  : > "$POST_CAPTURE"
  local status=0
  PATH="$WORK/bin:$PATH" \
    GH_TOKEN=stub SHA="" REQUIRE_JOB="" RUN_ID=42 \
    HEAD_SHA=0000000000000000000000000000000000000042 RUN_EVENT=push \
    RUN_STATUS=completed RUN_PATH=.github/workflows/ci.yml \
    GITHUB_REPOSITORY=o/r GITHUB_SERVER_URL=https://example.invalid \
    env "$@" bash "$WORK/judge.sh" > "$WORK/judge.log" 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    fail "$scenario: expected the guard's exit 1 but the judge block exited $status
$(cat "$WORK/judge.log")"
  fi
  grep -qF -- "$fragment" "$WORK/judge.log" \
    || fail "$scenario: the refusal does not name its reason ('$fragment' missing from the log)"
  if [ -s "$POST_CAPTURE" ]; then
    fail "$scenario: the judge block POSTed a verdict for a run it must refuse outright"
  fi
}

expect() { # <scenario> <conclusion> [<title fragment>]
  got="$(posted conclusion)"
  [ "$got" = "$2" ] || fail "$1: expected conclusion '$2' but the verdict POSTed '$got'"
  if [ -n "${3:-}" ]; then
    title="$(posted 'output[title]')"
    case "$title" in
      *"$3"*) ;;
      *) fail "$1: expected the title to mention '$3' but got '$title'" ;;
    esac
  fi
}

jobs() { printf '%s' "$1" > "$WORK/jobs.json"; echo "$WORK/jobs.json"; }

ANCHOR="ci / validate-template"

# 1. The healthy fleet run.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"checks / lint","conclusion":"success","run_attempt":1},
  {"id":2,"name":"ci / validate-template","conclusion":"success","run_attempt":1},
  {"id":3,"name":"ci / typography","conclusion":"skipped","run_attempt":1}]}')" "$ANCHOR"
expect "healthy run" success

# 2. The disarmed caller: the anchor job never ran.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"checks / lint","conclusion":"success","run_attempt":1}]}')" "$ANCHOR"
expect "deleted caller" failure "required gate job"

# 3. The conditioned caller: the anchor exists but skipped.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"checks / lint","conclusion":"success","run_attempt":1},
  {"id":2,"name":"ci / validate-template","conclusion":"skipped","run_attempt":1}]}')" "$ANCHOR"
expect "conditioned caller" failure "required gate job"

# 4. A partial re-run: the anchor's attempt-1 success still vouches. The
# attempts arrive across two pages, the way --paginate serves large runs.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"ci / validate-template","conclusion":"success","run_attempt":1},
  {"id":2,"name":"checks / lint","conclusion":"failure","run_attempt":1}]}')" "$ANCHOR" \
  "$(printf '%s' '{"jobs":[
  {"id":3,"name":"checks / lint","conclusion":"success","run_attempt":2}]}' > "$WORK/jobs2.json" && echo "$WORK/jobs2.json")"
expect "prior-attempt anchor" success

# 5. Duplicate gating names inside one attempt: refused, even though the
# newest duplicate succeeded (the fail-open this branch exists to close).
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"checks / test","conclusion":"failure","run_attempt":1},
  {"id":2,"name":"checks / test","conclusion":"success","run_attempt":1},
  {"id":3,"name":"ci / validate-template","conclusion":"success","run_attempt":1}]}')" "$ANCHOR"
expect "duplicate names" failure "duplicate job names"

# 6. All gating jobs skipped: vouches for nothing.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"checks / lint","conclusion":"skipped","run_attempt":1}]}')" ""
expect "all skipped" failure "no gating job actually succeeded"

# 7. Operator mode: no anchor required, gating passes suffice.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"validate","conclusion":"success","run_attempt":1},
  {"id":2,"name":"info-release / publish","conclusion":"failure","run_attempt":1}]}')" ""
expect "operator mode" success

# 8. A failed gating job is named.
run_verdict "$(jobs '{"jobs":[
  {"id":1,"name":"checks / lint","conclusion":"failure","run_attempt":1},
  {"id":2,"name":"ci / validate-template","conclusion":"success","run_attempt":1}]}')" "$ANCHOR"
expect "failed gate" failure "checks / lint (failure)"

# 9-11. The pre-judgment guards refuse outright (exit 1, no POST): a
# look-alike workflow merely NAMED "CI", an uncompleted run, and a trigger
# carrying neither a workflow_run event nor a dispatch sha.
refused "look-alike workflow" "refusing to judge a look-alike" RUN_PATH=.github/workflows/look-alike.yml
refused "uncompleted run" "only completed runs are judged" RUN_STATUS=in_progress
refused "no event and no sha" "nothing to judge" RUN_ID=

echo "verdict judgment OK: all 8 verdict scenarios POSTed the expected conclusion and all 3 guard scenarios refused, through the real run block"

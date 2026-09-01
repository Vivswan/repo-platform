#!/usr/bin/env bash
# Behavior test for the all-green gate's judgment, run against the REAL
# run block extracted from actions/all-green/action.yml - never a copy,
# so the assertions cannot drift from what ships. The block judges the
# calling job's needs context (toJSON(needs)) and exits nonzero on any
# non-green shape; each scenario feeds one NEEDS payload and asserts the
# exit code (and the named branch, where it matters). This harness stays
# pure bash + jq and imports nothing it verifies (repo law for the ci/
# harnesses).
#
# Scenarios, chosen to fail through the same path a real disarm would:
#    1. every needed job succeeded              -> pass
#    2. success next to skipped (a conditioned
#       gate standing down)                     -> pass
#    3. one failed gating job                   -> fail, naming it
#    4. a cancelled job                         -> fail (only success and
#       skipped are green shapes)
#    5. EVERY job skipped                       -> fail (vouches for nothing)
#    6. an empty needs context                  -> fail (no gate at all -
#       a needs list emptied by refactor must never read as green)
#    7. a null result (an unknown future shape) -> fail closed
#    8. malformed input (not JSON / not object) -> fail closed
#
# shellcheck disable=SC2016  # jq programs and assertion strings carry literals
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ACTION="$REPO_ROOT/actions/all-green/action.yml"

TMP_ROOT="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "${TMP_ROOT%/}/allgreen-judgment.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "::error::allgreen-judgment check failed: $1"; exit 1; }

# --- Extract the judge step's run block, verbatim -------------------------
# The block is the action's single `run: |` scalar: everything after that
# line at its 8-space indent, de-indented. Extraction failing (a moved or
# renamed block) must fail the harness, not pass it vacuously.
awk '
  found && /^        / { print substr($0, 9); next }
  found && /^[[:space:]]*$/ { print ""; next }
  found { exit }
  /^      run: \|$/ { found = 1 }
' "$ACTION" > "$WORK/judge.sh"
grep -qF 'set -euo pipefail' "$WORK/judge.sh" || fail "could not extract the run block from $ACTION"
grep -qF 'succeeded' "$WORK/judge.sh" || fail "the extracted run block is missing the success census"

# --- Class ban: command substitution only in plain assignments -------------
# A $(...) anywhere but a plain assignment can swallow its probe's failure
# under errexit: inside [ ]/[[ ]]/test/case words the substitution is
# errexit-exempt (a crashing probe reads as empty/zero and the guard falls
# OPEN). This class produced real fail-opens in the retired verdict
# engine, so the invariant is structural: every non-arithmetic $( must
# OPEN a bare assignment (var=, or the `if ! var=` parse-guard shape,
# where the status IS the tested thing). $((...)) arithmetic runs no
# command and stays legal; comment lines are ignored. The self-checks
# below are the ban's own controls: it must be seen catching every banned
# shape and passing every legal one, or a regex regression could blind it
# silently.
banned_substitutions() { # <script> -> offending "line:content" lines, if any
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
ban_expect caught 'if test "$(probe)" = x; then'
ban_expect caught 'x="$(probe)" trailing_command'
ban_expect clean 'count="$(jq length <<<"$x")"'
ban_expect clean 'if ! parsed="$(jq -ce . <<<"$x")"; then'
offenders="$(banned_substitutions "$WORK/judge.sh")"
if [ -n "$offenders" ]; then
  fail "command substitution outside a plain assignment (errexit-exempt there, so a crashed probe reads as empty and the guard falls open): $offenders"
fi

# --- The scenario runner ----------------------------------------------------
# Runs the extracted block with a NEEDS payload; asserts exit code and,
# when given, a substring of the output (the branch taken must be the
# branch under test, not an incidental crash).
run_case() { # <name> <expected-exit|nonzero> <needs-json> [expected-substring]
  local name="$1" expected="$2" needs="$3" expect_text="${4:-}"
  local status=0
  NEEDS="$needs" bash "$WORK/judge.sh" > "$WORK/out.txt" 2>&1 || status=$?
  if [ "$expected" = "nonzero" ]; then
    if [ "$status" -eq 0 ]; then
      echo "--- output for $name:"
      cat "$WORK/out.txt"
      fail "$name: expected a nonzero exit, got 0"
    fi
  elif [ "$status" -ne "$expected" ]; then
    echo "--- output for $name:"
    cat "$WORK/out.txt"
    fail "$name: expected exit $expected, got $status"
  fi
  if [ -n "$expect_text" ] && ! grep -qF -- "$expect_text" "$WORK/out.txt"; then
    echo "--- output for $name:"
    cat "$WORK/out.txt"
    fail "$name: output does not carry '$expect_text'"
  fi
  echo "ok: $name"
}

result() { jq -n --arg r "$1" '{result: $r, outputs: {}}'; }
needs_of() { # <job=result>... -> the needs context JSON
  local json="{}" pair
  for pair in "$@"; do
    json="$(jq --arg k "${pair%%=*}" --argjson v "$(result "${pair#*=}")" '. + {($k): $v}' <<<"$json")"
  done
  printf '%s' "$json"
}

# 1: every needed job succeeded.
run_case "all success" 0 "$(needs_of checks=success ci=success)" "2 of 2 gating jobs succeeded"

# 2: skipped stands down NEXT TO a success.
run_case "success + skipped" 0 "$(needs_of checks=success ci=skipped)" "1 of 2"

# 3: one failure fails, naming the job.
run_case "one failure" 1 "$(needs_of checks=success ci=failure)" "ci (failure)"

# 4: cancelled is not a green shape.
run_case "cancelled" 1 "$(needs_of checks=success ci=cancelled)" "ci (cancelled)"

# 5: all skipped vouches for nothing.
run_case "all skipped" 1 "$(needs_of checks=skipped ci=skipped)" "no gating job actually succeeded"

# 6: an empty needs context is no gate at all.
run_case "empty needs" 1 "{}" "needs nothing"

# 7: a null result (unknown future shape) fails closed.
run_case "null result" 1 '{"ci": {"result": null, "outputs": {}}}' "ci (null)"

# 8: malformed input fails closed (jq crashes under set -e, whatever its
# exit code - only never-zero matters here). The job-shaped ARRAY is the
# sharp case: to_entries walks arrays too (index-keyed), so without the
# explicit object check it would read as one green job.
run_case "malformed input" nonzero "not json"
run_case "non-object input" nonzero '["success"]'
run_case "job-shaped array input" nonzero '[{"result": "success", "outputs": {}}]'

echo "allgreen-judgment: all scenarios passed"

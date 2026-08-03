#!/usr/bin/env bash
# Failure-report issue on the target repo: a hide-details target's issues
# are as private as the repo, so the full run_hidden.sh captures are safe
# there when no sync PR exists to carry them. Invoked by
# reusable-template-sync.yml's tail steps.
#
# deliver (failed run): replace the issue body with every recorded hidden
# failure (hidden-failures.tsv from run_hidden.sh) and (re)open it.
# Skipped when PR_URL is set - the only hidden-wrapped failures that let
# the run reach PR creation are validation ones, and open_pr.sh already
# routed those into the PR body. resolve (fully successful run): close
# the issue if one is open; none existing is a no-op.
#
# The issue is found by exact title among issues created by the token's
# user, never by a marker label: the settings apply deletes undeclared
# labels, so a label would enter a delete/recreate loop. Both modes are
# best-effort - an API failure emits ONE ::warning and exits 0. The
# warning follows the reference implementation's rule: it names the HTTP
# status and generic advice only - never the slug, the request path, or
# the API's message, all of which would leak into this public log (the
# issue URL contains the slug, so it stays unprinted too).
#
# Usage: failure_issue.sh deliver|resolve
# Env: TARGET, GH_TOKEN, RUN_URL, RUNNER_TEMP, GITHUB_REPOSITORY;
# PR_URL (deliver only, may be empty).
set -euo pipefail

mode="${1:-}"
if [ "$mode" != "deliver" ] && [ "$mode" != "resolve" ]; then
  echo "::error::failure_issue.sh: expected mode 'deliver' or 'resolve'"
  exit 2
fi
: "${TARGET:?}" "${RUN_URL:?}" "${RUNNER_TEMP:?}" "${GITHUB_REPOSITORY:?}"

export ISSUE_TITLE="[automated] repo-platform sync: private failure report"
errlog="$RUNNER_TEMP/failure-issue.err"
: >"$errlog"

# One warning, public-safe: gh's stderr (captured, never printed) embeds
# the request path and API message, so only the bare HTTP status is
# lifted out of it. A permission-shaped status gets the grant advice; no
# status at all means the request died before an HTTP response.
warn_and_exit() {
  local status advice
  status="$(grep -oE 'HTTP [0-9]{3}' "$errlog" | tail -n 1 || true)"
  case "$status" in
  "HTTP 401" | "HTTP 403" | "HTTP 404")
    advice="Check that the REPO_PLATFORM_TOKEN grants Issues read/write on the target repository."
    ;;
  "")
    status="no HTTP response arrived"
    advice="Re-run the sync if it persists."
    ;;
  *)
    advice="Re-run the sync if it persists."
    ;;
  esac
  echo "::warning::$1 (${status}). ${advice} $2"
  exit 0
}
deliver_lead="sync failure diagnostics could not be delivered to the target repository's failure-report issue"
deliver_tail="This run's captured output dies with the runner; reproduce the failure locally per docs/private-repos.md."
resolve_lead="the target repository's failure-report issue could not be resolved after this healthy run"
resolve_tail="If one is open, close it manually."

# Prints "<number> <state>" for the reused issue, or nothing when none
# exists. Filtering to the token user's own issues keeps a title squatted
# by someone else from hijacking the delivery; creation order makes the
# oldest issue win deterministically should a duplicate ever appear.
find_issue() {
  local login
  login="$(gh api user --jq .login 2>>"$errlog")" || return 1
  gh api "repos/${TARGET}/issues" --method GET --paginate --slurp \
    -f state=all -f creator="$login" -f sort=created -f direction=asc \
    -F per_page=100 \
    --jq '[.[][] | select(has("pull_request") | not)
      | select(.title == env.ISSUE_TITLE)] | first
      | if . == null then "" else "\(.number) \(.state)" end' \
    2>>"$errlog"
}

body="$RUNNER_TEMP/failure-issue-body.md"

if [ "$mode" = "deliver" ]; then
  if [ -n "${PR_URL:-}" ]; then
    echo "the sync PR carries this failure's hidden diagnostics; no issue delivery needed"
    exit 0
  fi
  manifest="$RUNNER_TEMP/hidden-failures.tsv"
  if [ ! -s "$manifest" ]; then
    echo "no hidden step failed; the public log already carries this failure's diagnosis"
    exit 0
  fi

  # The fence must outrun the longest backtick run in each SHIPPED
  # excerpt, or a captured line could terminate its own code block early
  # (a run split by the truncation cut only gets shorter, so scanning
  # the excerpt is sufficient). Runs past 100 backticks are collapsed to
  # exactly 100 on write, which caps the fence at 101 and keeps the body
  # bounded under GitHub's 64 KiB limit; grep -a keeps a NUL byte in the
  # capture from flipping the scan to binary mode and hiding the runs.
  bt100="$(printf '%*s' 100 '' | tr ' ' '\140')"
  collapse_runs() {
    sed -E 's/`{100,}/'"$bt100"'/g'
  }
  fence_len=4
  while IFS=$'\t' read -r _ _ capture; do
    [ -f "$capture" ] || continue
    run="$(head -c 20000 "$capture" | (grep -a -oE '`+' || true) |
      awk '{ if (length > m) m = length } END { print m + 0 }')"
    if [ "$run" -gt 100 ]; then
      run=100
    fi
    if [ "$((run + 1))" -gt "$fence_len" ]; then
      fence_len=$((run + 1))
    fi
  done <"$manifest"
  fence="$(printf '%*s' "$fence_len" '' | tr ' ' '\140')"

  {
    echo "The push sync from \`${GITHUB_REPOSITORY}\` failed for this repository, and no sync PR exists to carry the hidden diagnostics, so the captured output lands here instead (this repo's issues are as private as the repo)."
    echo
    echo "Run: ${RUN_URL}"
    while IFS=$'\t' read -r label rc capture; do
      echo
      echo "## ${label}: exit ${rc}"
      echo
      echo "${fence}text"
      if [ -f "$capture" ]; then
        # GitHub caps issue bodies at 64 KiB; keep each capture bounded
        # like open_pr.sh's PR-body excerpt.
        head -c 20000 "$capture" | collapse_runs
        echo
        if [ "$(wc -c <"$capture")" -gt 20000 ]; then
          echo "(truncated at 20000 bytes; reproduce locally for the rest)"
        fi
      fi
      echo "$fence"
    done <"$manifest"
    echo
    echo "This issue is reused by every sync run: each delivery replaces the body (earlier reports stay in the edit history), open means the sync needs attention, and the next fully healthy run closes it. Local reproduction: https://github.com/${GITHUB_REPOSITORY}/blob/main/docs/private-repos.md"
  } >"$body"

  found="$(find_issue)" || warn_and_exit "$deliver_lead" "$deliver_tail"
  if [ -z "$found" ]; then
    gh api "repos/${TARGET}/issues" --method POST --silent \
      -f title="$ISSUE_TITLE" -F body=@"$body" \
      >>"$errlog" 2>&1 || warn_and_exit "$deliver_lead" "$deliver_tail"
  else
    gh api "repos/${TARGET}/issues/${found%% *}" --method PATCH --silent \
      -f state=open -F body=@"$body" \
      >>"$errlog" 2>&1 || warn_and_exit "$deliver_lead" "$deliver_tail"
  fi
  echo "hidden failure diagnostics delivered to the target's failure-report issue (URL withheld: private repository)"
  exit 0
fi

found="$(find_issue)" || warn_and_exit "$resolve_lead" "$resolve_tail"
if [ -z "$found" ] || [ "${found#* }" != "open" ]; then
  exit 0
fi
printf '%s\n' "Healthy: the push sync from \`${GITHUB_REPOSITORY}\` completed cleanly as of ${RUN_URL}. The last failure report is in this issue's edit history." >"$body"
gh api "repos/${TARGET}/issues/${found%% *}" --method PATCH --silent \
  -f state=closed -F body=@"$body" \
  >>"$errlog" 2>&1 || warn_and_exit "$resolve_lead" "$resolve_tail"
echo "failure-report issue closed: the sync is healthy again"

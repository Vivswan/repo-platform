#!/usr/bin/env bash
# Safe-output boundary for steps that process a hide-details target's
# checkout. Tools reading that tree (copier, the template validator, the
# retired-file cleanup) print target paths, file content, and parser
# diagnostics that a public log must not carry for a private repository -
# and their failure paths print the most. Wrapping the command captures
# everything and publishes only a generic outcome; the captured output
# stays in RUNNER_TEMP for same-run consumers (never uploaded). A failure
# is also recorded in RUNNER_TEMP/hidden-failures.tsv (label, exit code,
# capture path) so the detail reaches the operator privately: in the sync
# PR body when one exists (open_pr.sh), else delivered to the target's
# failure-report issue (failure_issue.sh, docs/private-repos.md).
#
# Usage: HIDE_DETAILS=true|false run_hidden.sh <label> -- <cmd> [args...]
# Passthrough (exec) when HIDE_DETAILS is not "true".
set -euo pipefail

label="${1:-}"
[ "${2:-}" = "--" ] || {
  echo "::error::run_hidden.sh: expected '--' after the label"
  exit 2
}
shift 2

if [ "${HIDE_DETAILS:-false}" != "true" ]; then
  exec "$@"
fi

slug="$(printf '%s' "$label" | tr -c 'A-Za-z0-9' '-' | tr -s '-')"
slug="${slug#-}"
capture="$RUNNER_TEMP/hidden-${slug%-}.log"
rc=0
"$@" >"$capture" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  echo "${label}: ok (output hidden: private repository)"
else
  printf '%s\t%s\t%s\n' "$label" "$rc" "$capture" >>"$RUNNER_TEMP/hidden-failures.tsv"
  echo "::error::${label}: failed with exit ${rc} (output hidden: private repository). The captured output is delivered privately - in the sync PR body when one exists, else in the target's failure-report issue (docs/private-repos.md)."
fi
exit "$rc"

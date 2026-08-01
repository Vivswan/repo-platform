#!/usr/bin/env bash
# Selects the target's modules for the update (modules.ts filtered
# against the template ref) into $RUNNER_TEMP/modules.json - a file, not
# a step output, because the module list is a target-derived fact and
# step outputs ride into later steps' env-group prints. Hide-details
# targets get counts, not names; modules.ts's failure detail (unknown
# module names, YAML parse text) is captured and withheld for them.
#
# Env: TARGET_DISPLAY, HIDE_DETAILS, RUNNER_TEMP.
set -euo pipefail

if ! modules="$(bun .github/scripts/sync/modules.ts \
  --repo-file target/.repo-platform.yml \
  --template-copier "$RUNNER_TEMP/copier-new.yml" \
  --retired-summary "$RUNNER_TEMP/retired-modules.txt" \
  2>"$RUNNER_TEMP/modules.err")"; then
  if [ "${HIDE_DETAILS:-false}" = "true" ]; then
    echo "::error::module selection for ${TARGET_DISPLAY} failed (detail hidden: private repository). Reproduce the sync locally - see docs/private-repos.md."
  else
    cat "$RUNNER_TEMP/modules.err" >&2
  fi
  exit 1
fi
printf '%s' "$modules" >"$RUNNER_TEMP/modules.json"
if [ "${HIDE_DETAILS:-false}" = "true" ]; then
  echo "selected modules: $(jq 'length' <<<"$modules") (names hidden: private repository)"
  if [ -s "$RUNNER_TEMP/retired-modules.txt" ]; then
    echo "::notice::${TARGET_DISPLAY}: $(wc -l <"$RUNNER_TEMP/retired-modules.txt" | tr -d ' ') retired module(s) dropped from the selection; their files leave the render with this update."
  fi
else
  echo "selected modules: ${modules}"
  if [ -s "$RUNNER_TEMP/retired-modules.txt" ]; then
    while IFS= read -r name; do
      echo "::notice::${TARGET_DISPLAY}: retired module '${name}' dropped from the selection; its files leave the render with this update."
    done <"$RUNNER_TEMP/retired-modules.txt"
  fi
fi

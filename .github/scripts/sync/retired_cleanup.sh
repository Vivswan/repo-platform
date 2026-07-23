#!/usr/bin/env bash
# Deletes files the template retired from the target's working tree.
# Invoked by reusable-template-sync.yml's "Remove files the template
# retired" step from the repo-platform checkout root; deletion candidates
# come from retired_paths.ts (see its header for the safety rules).
#
# Env: OLD_SHA, TARGET_REF, MODULES, CHANNEL, PRIVATE, DESCRIPTION,
# SRC_PATH, RUNNER_TEMP.
set -euo pipefail

# The old render uses the answers recorded BEFORE this update (HEAD still
# points at the pre-update commit); the new render applies the live
# module/channel/private/description data on top.
git -C target show HEAD:.copier-answers.yml >"$RUNNER_TEMP/answers-old.yml"
bun .github/scripts/sync/render_data.ts \
  --answers-old "$RUNNER_TEMP/answers-old.yml" \
  --out-old "$RUNNER_TEMP/data-old.yml" \
  --out-new "$RUNNER_TEMP/data-new.yml" \
  --modules "$MODULES" \
  --channel "$CHANNEL" \
  --private "$PRIVATE" \
  --description "$DESCRIPTION"

copier copy --vcs-ref "$OLD_SHA" --defaults --trust \
  --data-file "$RUNNER_TEMP/data-old.yml" "$SRC_PATH" "$RUNNER_TEMP/render-old"
copier copy --vcs-ref "$TARGET_REF" --defaults --trust \
  --data-file "$RUNNER_TEMP/data-new.yml" "$SRC_PATH" "$RUNNER_TEMP/render-new"
bun .github/scripts/sync/retired_paths.ts \
  --old-render "$RUNNER_TEMP/render-old" \
  --new-render "$RUNNER_TEMP/render-new" \
  --old-copier "$RUNNER_TEMP/copier-old.yml" \
  --new-copier "$RUNNER_TEMP/copier-new.yml" >"$RUNNER_TEMP/retired-paths.json"

: >"$RUNNER_TEMP/removed-paths.txt"
while IFS= read -r path; do
  if [ -e "target/${path}" ] || [ -L "target/${path}" ]; then
    rm -f "target/${path}"
    printf '%s\n' "$path" >>"$RUNNER_TEMP/removed-paths.txt"
    echo "removed retired file: ${path}"
  fi
done < <(jq -r '.[]' "$RUNNER_TEMP/retired-paths.json")

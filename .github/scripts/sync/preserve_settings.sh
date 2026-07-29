#!/usr/bin/env bash
# Preserves the repo-owned settings file after an update. settings.yml is
# repo-owned wherever it exists: deselecting the settings-sync module
# de-renders it, but the sync must never delete a repo's settings file -
# repo-platform's settings-repos run applies it remotely (a central
# settings/repos/<name>.yml wins over it). A recovery re-render has no
# three-way merge to protect local content, so there it is restored
# outright. Invoked by reusable-template-sync.yml's "Preserve the
# repo-owned settings file" step and by ci/upgrade_path_test.sh.
#
# Env: RECOVER; TARGET_DIR (default target); TARGET (log label, default
# TARGET_DIR).
set -euo pipefail

target_dir="${TARGET_DIR:-target}"
label="${TARGET:-$target_dir}"
if ! git -C "$target_dir" cat-file -e "HEAD:.github/settings.yml" 2>/dev/null; then
  exit 0
fi
if [ "${RECOVER:-}" = "recopy" ]; then
  git -C "$target_dir" checkout HEAD -- .github/settings.yml
  echo "::notice::${label}: .github/settings.yml is repo-owned; restored as-is after the recovery re-render."
elif [ ! -e "$target_dir/.github/settings.yml" ]; then
  git -C "$target_dir" checkout HEAD -- .github/settings.yml
  echo "::notice::${label}: .github/settings.yml left the template render but is repo-owned; kept as-is."
fi

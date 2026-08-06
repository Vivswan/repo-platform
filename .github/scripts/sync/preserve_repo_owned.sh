#!/usr/bin/env bash
# Preserves repo-owned files after an update.
#
# settings.yml is repo-owned wherever it exists: deselecting the
# settings-sync module de-renders it, but the sync must never delete a
# repo's settings file - repo-platform's settings-repos run applies it
# remotely (a central settings/repos/<name>.yml wins over it). A recovery
# re-render has no three-way merge to protect local content, so there it
# is restored outright.
#
# LICENSE leaves the render when a repo selects the custom-license module;
# copier deletes the de-rendered file when it was unmodified, which would
# leave the repo with no license at all, so it is restored from the base
# commit. Unlike settings.yml it is NOT restored on recovery: without the
# module LICENSE is fleet-managed and the recovery re-render's overwrite
# is the correct outcome; with the module the recovery re-render does not
# emit LICENSE (recopy deletes nothing), so the repo's own license
# survives untouched.
#
# A committed LICENSE deletion in a repo still on the fleet license is the
# remaining hole: copier honors the deletion (it re-applies the local
# diff), cleanup protects the path, and there is no HEAD copy to restore -
# but the fleet license is mandatory without the custom-license module, so
# it is re-seeded from the target build ref (which must be resolvable in
# the cwd's git repository).
#
# Invoked by reusable-template-sync.yml's "Preserve repo-owned files" step
# and by ci/upgrade_path_test.sh.
#
# Env: RECOVER; TARGET_DIR (default target); TARGET_REF and MODULES (for
# the fleet-license re-seed); TARGET_DISPLAY / TARGET (log label, in that
# order; defaults to TARGET_DIR).
set -euo pipefail

target_dir="${TARGET_DIR:-target}"
label="${TARGET_DISPLAY:-${TARGET:-$target_dir}}"
if git -C "$target_dir" cat-file -e "HEAD:.github/settings.yml" 2>/dev/null; then
  if [ "${RECOVER:-}" = "recopy" ]; then
    git -C "$target_dir" checkout HEAD -- .github/settings.yml
    echo "::notice::${label}: .github/settings.yml is repo-owned; restored as-is after the recovery re-render."
  elif [ ! -e "$target_dir/.github/settings.yml" ]; then
    git -C "$target_dir" checkout HEAD -- .github/settings.yml
    echo "::notice::${label}: .github/settings.yml left the template render but is repo-owned; kept as-is."
  fi
fi
if [ "${RECOVER:-}" != "recopy" ] \
  && git -C "$target_dir" cat-file -e "HEAD:LICENSE" 2>/dev/null \
  && [ ! -e "$target_dir/LICENSE" ]; then
  git -C "$target_dir" checkout HEAD -- LICENSE
  echo "::notice::${label}: LICENSE left the template render (custom-license module) but is repo-owned; kept as-is."
fi
fleet_license="template/{% if 'custom-license' not in modules %}LICENSE{% endif %}"
if [ "${RECOVER:-}" != "recopy" ] && [ ! -e "$target_dir/LICENSE" ] \
  && ! git -C "$target_dir" cat-file -e "HEAD:LICENSE" 2>/dev/null; then
  case "${MODULES:-}" in
    *custom-license*) : ;;
    *)
      if [ -n "${TARGET_REF:-}" ] && git cat-file -e "${TARGET_REF}:${fleet_license}" 2>/dev/null; then
        git show "${TARGET_REF}:${fleet_license}" > "$target_dir/LICENSE"
        echo "::notice::${label}: LICENSE was deleted but the fleet license is mandatory without the custom-license module; re-seeded from ${TARGET_REF}."
      fi
      ;;
  esac
fi

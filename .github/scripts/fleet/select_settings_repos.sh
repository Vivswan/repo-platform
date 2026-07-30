#!/usr/bin/env bash
# Discovers the in-repo settings targets: enrolled repos (the fleet token
# can push - probed, since user/repos' permissions field reflects the
# USER, not the token), adopted (.repo-platform.yml on the default
# branch), and carrying their own .github/settings.yml - no module
# required, the file is the signal. A central settings/repos/<name>.yml
# wins and drops the repo from the remote list. Invoked by
# settings-repos.yml.
#
# Env: PAT, GH_TOKEN, OWNER, RUNNER_TEMP, GITHUB_OUTPUT;
# GITHUB_STEP_SUMMARY (optional) receives a copy of every warning.
set -euo pipefail

# A drop that leaves a repo without settings management is announced: a
# workflow warning, plus a step-summary bullet (under a heading written
# once) when running in Actions. Routine skips stay at notice level and
# out of the summary.
warn() {
  echo "::warning::$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    if [ -z "${summary_headed:-}" ]; then
      echo "### Settings heal warnings" >>"$GITHUB_STEP_SUMMARY"
      summary_headed=1
    fi
    echo "- $1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# -F alone would flip gh api to POST; this is a read.
gh api user/repos --method GET --paginate --slurp -F per_page=100 |
  jq --arg owner "$OWNER" \
    'add | [.[] | select(.owner.login == $owner and (.archived | not) and .permissions.push) | .full_name]' \
    >"$RUNNER_TEMP/discovered.json"
bun .github/scripts/fleet/repos_registry.ts select \
  --discovered "$RUNNER_TEMP/discovered.json" >"$RUNNER_TEMP/selected.json"

repos=""
while IFS=$'\t' read -r repo name; do
  [ -f "settings/repos/$name.yml" ] && continue
  # Enrollment = the token's actual grant, probed via git's push-service
  # advertisement (200 only with push permission; 401/403/404 = no
  # grant). Anything else is a transient or unexpected failure and must
  # not silently drop the repo.
  probe_code="$(curl -s -o /dev/null -w '%{http_code}' \
    -u "x-access-token:${PAT}" \
    "https://github.com/${repo}.git/info/refs?service=git-receive-pack")"
  case "$probe_code" in
    200) ;;
    401 | 403 | 404)
      echo "::notice::${repo}: skipped - the fleet token has no write access (push probe HTTP ${probe_code}). Grant the REPO_PLATFORM_TOKEN access to this repository to enroll it, or add it to repos.yml's exclude list to silence this."
      continue
      ;;
    *)
      echo "::error::push-permission probe for $repo failed with HTTP ${probe_code}; not a permission answer, refusing to guess."
      exit 1
      ;;
  esac
  # Only a 404 means "not adopted"; other API failures must not silently
  # drop a repo from this run.
  if ! gh api "repos/$repo/contents/.repo-platform.yml" --silent \
    2>"$RUNNER_TEMP/probe.err"; then
    if grep -q "HTTP 404" "$RUNNER_TEMP/probe.err"; then
      echo "::notice::${repo}: skipped - no .repo-platform.yml on its default branch, so it has not adopted the template. If it carries .github/settings.yml, the central nightly heal no longer applies it. Generate it with copier (see the repo-platform README) to opt in, or add the repo to repos.yml's exclude list to silence this."
      continue
    fi
    echo "::error::adoption check failed for $repo: $(cat "$RUNNER_TEMP/probe.err")"
    exit 1
  fi
  # Same 404-vs-failure split for the settings file itself.
  if ! gh api "repos/$repo/contents/.github/settings.yml" --jq .sha \
    >/dev/null 2>"$RUNNER_TEMP/probe.err"; then
    if grep -q "HTTP 404" "$RUNNER_TEMP/probe.err"; then
      # The central file was already ruled out above, so at this point
      # nothing manages the repo's settings.
      warn "$repo is enrolled and adopted but has no settings home: no settings/repos/$name.yml here and no .github/settings.yml in the repo. Its settings are unmanaged - nothing installs or heals the main ruleset (so all-green may not be a required check) and labels are never reconciled. Pick a home per docs/settings.md."
      continue
    fi
    echo "::error::settings.yml check failed for $repo: $(cat "$RUNNER_TEMP/probe.err")"
    exit 1
  fi
  repos="$repos$repo"$'\n'
done < <(jq -r '.[] | [.repo, .name] | @tsv' "$RUNNER_TEMP/selected.json")

# repos.yml's exclude: pauses the sync AND this heal - the registry drops
# excluded repos before the loop above ever sees them. When such a repo
# still carries an in-repo settings.yml (and no central file has taken
# over), say that the heal stopped instead of going quiet. Materialized
# first so a registry failure fails the run instead of silently
# skipping every exclusion warning.
bun .github/scripts/fleet/repos_registry.ts excluded >"$RUNNER_TEMP/excluded.json"
while IFS= read -r repo; do
  name="${repo##*/}"
  [ -f "settings/repos/$name.yml" ] && continue
  if gh api "repos/$repo/contents/.github/settings.yml" --silent \
    2>"$RUNNER_TEMP/probe.err"; then
    warn "$repo is excluded in repos.yml but still carries .github/settings.yml - the exclusion also pauses the central nightly heal for that file, so its settings can drift. If the pause is deliberate, this is the reminder that healing is off; otherwise remove the exclusion, or move the settings to settings/repos/$name.yml here (central files are applied regardless of exclude)."
  elif ! grep -q "HTTP 404" "$RUNNER_TEMP/probe.err"; then
    # A 404 also covers repos the token cannot read; those skip
    # silently. Anything else: this check is purely informational, so
    # report it without killing the apply for the selected repos.
    echo "::warning::settings.yml check for excluded repo $repo failed: $(cat "$RUNNER_TEMP/probe.err") - cannot tell whether its pause left an in-repo settings file behind; continuing."
  fi
done < <(jq -r '.[]' "$RUNNER_TEMP/excluded.json")

{
  echo "repos<<REPOS_EOF"
  printf '%s' "$repos"
  echo "REPOS_EOF"
} >>"$GITHUB_OUTPUT"
echo "in-repo targets:"
printf '%s' "$repos"

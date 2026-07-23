#!/usr/bin/env bash
# Discovers the in-repo settings targets: enrolled repos (the fleet token
# can push - probed, since user/repos' permissions field reflects the
# USER, not the token), adopted (.repo-platform.yml on the default
# branch), and carrying their own .github/settings.yml - no module
# required, the file is the signal. A central settings/repos/<name>.yml
# wins and drops the repo from the remote list. Invoked by
# settings-repos.yml.
#
# Env: PAT, GH_TOKEN, OWNER, RUNNER_TEMP, GITHUB_OUTPUT.
set -euo pipefail

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
    401 | 403 | 404) continue ;;
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
      continue # not adopted
    fi
    echo "::error::adoption check failed for $repo: $(cat "$RUNNER_TEMP/probe.err")"
    exit 1
  fi
  # Same 404-vs-failure split for the settings file itself.
  if ! gh api "repos/$repo/contents/.github/settings.yml" --jq .sha \
    >/dev/null 2>"$RUNNER_TEMP/probe.err"; then
    if grep -q "HTTP 404" "$RUNNER_TEMP/probe.err"; then
      continue # no in-repo settings; central covers it or nothing does
    fi
    echo "::error::settings.yml check failed for $repo: $(cat "$RUNNER_TEMP/probe.err")"
    exit 1
  fi
  repos="$repos$repo"$'\n'
done < <(jq -r '.[] | [.repo, .name] | @tsv' "$RUNNER_TEMP/selected.json")

{
  echo "repos<<REPOS_EOF"
  printf '%s' "$repos"
  echo "REPOS_EOF"
} >>"$GITHUB_OUTPUT"
echo "in-repo targets:"
printf '%s' "$repos"

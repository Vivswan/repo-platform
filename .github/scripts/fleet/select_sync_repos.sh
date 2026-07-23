#!/usr/bin/env bash
# Selects the push-sync fan-out: applies repos.yml to the discovered
# fleet, probes the token's ACTUAL write grant per repo, and checks
# adoption. Invoked by sync-repos.yml's plan job after the discovery step
# wrote $RUNNER_TEMP/discovered.json.
#
# Env: PAT, GH_TOKEN, ONLY_REPO, RUNNER_TEMP, GITHUB_OUTPUT.
set -euo pipefail

bun .github/scripts/fleet/repos_registry.ts select \
  ${ONLY_REPO:+--repo "$ONLY_REPO"} \
  --discovered "$RUNNER_TEMP/discovered.json" >"$RUNNER_TEMP/selection.json"

repos='[]'
while IFS= read -r row; do
  slug="$(jq -r '.repo' <<<"$row")"
  # Fine-grained PATs read every public repo and user/repos reports the
  # USER's permissions, so the token's actual grant is probed via git's
  # push-service advertisement: 200 only with push permission. Read-only,
  # no side effects.
  probe_code="$(curl -s -o /dev/null -w '%{http_code}' \
    -u "x-access-token:${PAT}" \
    "https://github.com/${slug}.git/info/refs?service=git-receive-pack")"
  case "$probe_code" in
    200) ;;
    401 | 403 | 404)
      echo "::notice::${slug}: skipped - the fleet token has no write access (push probe HTTP ${probe_code}). Grant the REPO_PLATFORM_TOKEN access to this repository to enroll it, or add it to repos.yml's exclude list to silence this."
      continue
      ;;
    *)
      echo "::error::push-permission probe for ${slug} failed with HTTP ${probe_code}; not a permission answer, refusing to guess."
      exit 1
      ;;
  esac
  # Only a 404 means "not adopted"; any other API failure (auth, rate
  # limit, outage) fails the plan instead of silently skipping repos.
  if probe="$(gh api "repos/${slug}/contents/.repo-platform.yml" --silent 2>&1)"; then
    repos="$(jq -c --argjson row "$row" '. + [$row | .channel //= ""]' <<<"$repos")"
  elif grep -q "HTTP 404" <<<"$probe"; then
    echo "::notice::${slug}: skipped - no .repo-platform.yml on its default branch, so it has not adopted the template. Generate it with copier (see the repo-platform README) to opt in, or add it to repos.yml's exclude list to silence this."
  else
    echo "::error::adoption check failed for ${slug}: ${probe}"
    exit 1
  fi
done < <(jq -c '.[]' "$RUNNER_TEMP/selection.json")

echo "repos=${repos}" >>"$GITHUB_OUTPUT"
if [ "$repos" = "[]" ]; then
  echo "::notice::no adopted repos selected; nothing to sync."
else
  echo "syncing: $(jq -r 'map(.repo) | join(", ")' <<<"$repos")"
fi

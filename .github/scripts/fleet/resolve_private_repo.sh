#!/usr/bin/env bash
# Resolves a per-repo leg's target from a redacted matrix row. Public job
# names and the auto-printed workflow inputs carry only a display hint and
# an HMAC tag for redacted repos (see .github/scripts/fleet/redact.ts), so
# the leg re-discovers the fleet and picks the repository whose tag
# matches - then registers the slug with the runner's secret masker BEFORE
# any other output, so later steps' env prints, checkout logs, and API
# error bodies render it as ***.
#
# The tag key is derived from the PAT, never the raw PAT. Everything
# fails closed: an empty tag, a zero-match (repo renamed/deleted,
# grant revoked, or PAT rotated since the plan job), or an ambiguous
# match errors out naming only the hint.
#
# Env in: TARGET_INPUT (slug, or hint when REDACT_NAME=true), REDACT_NAME,
# VERIFY, PAT, GITHUB_RUN_ID, GITHUB_ENV, GITHUB_OUTPUT, RUNNER_TEMP.
# Out: TARGET + TARGET_DISPLAY via GITHUB_ENV, repo= via GITHUB_OUTPUT.
set -euo pipefail

if [ "${REDACT_NAME:-false}" != "true" ]; then
  {
    echo "TARGET=${TARGET_INPUT}"
    echo "TARGET_DISPLAY=${TARGET_INPUT}"
  } >>"$GITHUB_ENV"
  echo "repo=${TARGET_INPUT}" >>"$GITHUB_OUTPUT"
  exit 0
fi

if [ -z "${VERIFY:-}" ]; then
  echo "::error::redacted target ${TARGET_INPUT} arrived without a resolution tag - the plan job's matrix row is malformed; re-run the whole workflow."
  exit 1
fi

# An empty key would be publicly known: HMAC(key="") is computable by
# anyone, so an unset or empty PAT must fail before any derivation.
if [ -z "${PAT:-}" ]; then
  echo "::error::PAT is empty or unset - cannot derive the resolution key; check the REPO_PLATFORM_TOKEN wiring."
  exit 1
fi

# Same key derivation as redact.ts verifyTag; the lockstep test in
# redact.test.ts and a check_ssot rule keep the two sides identical.
# python3 reads the PAT from the environment, so the secret never rides
# any process argv; the tag HMAC below receives only the derived key.
key_hex="$(python3 -c 'import hashlib, hmac, os
print(hmac.new(os.environb[b"PAT"], b"repo-platform-redact-key-v1", hashlib.sha256).hexdigest())')"

tag_for() {
  printf '%s\0%s' "$GITHUB_RUN_ID" "$(tr '[:upper:]' '[:lower:]' <<<"$1")" |
    openssl dgst -sha256 -mac HMAC -macopt "hexkey:${key_hex}" -hex |
    awk '{print $NF}' | cut -c1-32
}

# Every writable repo, regardless of owner: repos.yml accepts explicit
# entries under other owners, so the search must not assume the fleet
# owner. The payload stays in a file - never echoed.
gh api user/repos --method GET --paginate --slurp -F per_page=100 |
  jq '[add[] | select((.archived | not) and .permissions.push) | .full_name]' \
    >"$RUNNER_TEMP/resolve-candidates.json"

resolved=""
matches=0
while IFS= read -r slug; do
  if [ "$(tag_for "$slug")" = "$VERIFY" ]; then
    resolved="$slug"
    matches=$((matches + 1))
  fi
done < <(jq -r '.[]' "$RUNNER_TEMP/resolve-candidates.json")

if [ "$matches" -eq 0 ]; then
  echo "::error::cannot resolve the plan-time target (${TARGET_INPUT}): it was renamed or deleted, the token's grant was revoked, or the REPO_PLATFORM_TOKEN was rotated after the plan job ran. Re-run the whole workflow, not just this job."
  exit 1
fi
if [ "$matches" -gt 1 ]; then
  echo "::error::the resolution tag for ${TARGET_INPUT} matched ${matches} repositories - refusing to guess; re-run the whole workflow."
  exit 1
fi

# Mask before any output that could carry the slug. The runner's masker is
# case-sensitive and substring-based, so register the canonical and
# lowercase slug forms, and the bare name when it is long enough that
# masking it cannot garble the whole log (a 3-char name like "api" appears
# in too many innocent strings; the hide-details discipline covers its
# diagnostics instead).
echo "::add-mask::${resolved}"
lower="$(tr '[:upper:]' '[:lower:]' <<<"$resolved")"
if [ "$lower" != "$resolved" ]; then
  echo "::add-mask::${lower}"
fi
name="${resolved##*/}"
if [ "${#name}" -ge 4 ]; then
  echo "::add-mask::${name}"
  lower_name="$(tr '[:upper:]' '[:lower:]' <<<"$name")"
  if [ "$lower_name" != "$name" ]; then
    echo "::add-mask::${lower_name}"
  fi
fi

{
  echo "TARGET=${resolved}"
  echo "TARGET_DISPLAY=${TARGET_INPUT}"
} >>"$GITHUB_ENV"
echo "repo=${resolved}" >>"$GITHUB_OUTPUT"
echo "resolved the redacted target ${TARGET_INPUT}"

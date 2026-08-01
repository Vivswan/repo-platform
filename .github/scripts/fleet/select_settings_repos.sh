#!/usr/bin/env bash
# Discovers the settings targets and builds the per-repo apply matrix
# for settings-repos.yml. In-repo targets are enrolled repos (the fleet
# token can push - probed, since user/repos' permissions field reflects
# the USER, not the token), adopted (.repo-platform.yml on the default
# branch), and carrying their own .github/settings.yml - no module
# required, the file is the signal. A central settings/repos/<name>.yml
# wins and drops the repo from the remote list; the matrix carries both
# homes, one entry per repo (build_settings_matrix.ts).
#
# One repo's flaky probe must never block the heal for the rest of the
# fleet: every probe is retried, and a repo whose probes still return no
# answer is skipped with a warning - the nightly cron retries it. exit 1
# stays reserved for failures that invalidate the whole selection
# (unreadable registry, discovery, or exclusion list).
#
# This job's log, step summary, and matrix are publicly readable, so
# private repos appear only by their redaction display (redact.ts):
# probes print the display, captured error text is scrubbed of the slug,
# and a redacted matrix row carries the hint plus an HMAC tag instead of
# the slug. No ::add-mask:: here - the runner drops a job output holding
# a masked substring, which would kill the matrix. Central-file repos and
# repos.yml-excluded repos keep their committed (self-disclosed) names.
#
# Env: PAT, GH_TOKEN, GITHUB_RUN_ID, OWNER, RUNNER_TEMP, GITHUB_OUTPUT;
# GITHUB_STEP_SUMMARY (optional) receives a copy of every warning.
set -euo pipefail

# A drop that leaves a repo without settings management is announced: a
# workflow warning, plus a step-summary bullet (under a heading written
# once) when running in Actions. Routine skips stay at notice level and
# out of the summary. Callers pass already-safe strings: the summary is
# not covered by the runner's masker, so redaction happens before here.
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

# Each probe answers one question about one repo, probing $1 (the slug)
# and printing $2 (the display). Return codes: 0 = the repo passes, 10 =
# a definitive negative (the probe already explained it), 1 = no answer
# this attempt (transient or unexpected failure; $probe_error carries the
# detail for the retry loop).
probe_error=""

# Enrollment = the token's actual grant, probed via git's push-service
# advertisement (200 only with push permission; 401/403/404 = no grant).
probe_push() {
  local code
  # A curl transport failure (DNS, TLS, timeout) reports code 000 and is
  # retried like any other non-answer.
  code="$(curl -s -o /dev/null -w '%{http_code}' \
    -u "x-access-token:${PAT}" \
    "https://github.com/${1}.git/info/refs?service=git-receive-pack")" || true
  case "$code" in
    200) return 0 ;;
    401 | 403 | 404)
      echo "::notice::${2}: skipped - the fleet token has no write access (push probe HTTP ${code}). Grant the REPO_PLATFORM_TOKEN access to this repository to enroll it, or add it to repos.yml's exclude list to silence this."
      return 10
      ;;
    *)
      probe_error="HTTP ${code:-000}"
      return 1
      ;;
  esac
}

# Only a 404 means "not adopted"; any other API failure is a non-answer.
probe_adoption() {
  if gh api "repos/$1/contents/.repo-platform.yml" --silent \
    2>"$RUNNER_TEMP/probe.err"; then
    return 0
  fi
  if grep -q "HTTP 404" "$RUNNER_TEMP/probe.err"; then
    echo "::notice::${2}: skipped - no .repo-platform.yml on its default branch, so it has not adopted the template. If it carries .github/settings.yml, the central nightly heal no longer applies it. Generate it with copier (see the repo-platform README) to opt in, or add the repo to repos.yml's exclude list to silence this."
    return 10
  fi
  probe_error="$(cat "$RUNNER_TEMP/probe.err")"
  return 1
}

# Same 404-vs-failure split for the settings file itself. $3 names the
# central file the warning may reference - the literal placeholder form
# for a redacted repo, whose bare name must not appear here.
probe_settings() {
  if gh api "repos/$1/contents/.github/settings.yml" --jq .sha \
    >/dev/null 2>"$RUNNER_TEMP/probe.err"; then
    return 0
  fi
  if grep -q "HTTP 404" "$RUNNER_TEMP/probe.err"; then
    # The central file was already ruled out above, so at this point
    # nothing manages the repo's settings.
    warn "$2 is enrolled and adopted but has no settings home: no $3 here and no .github/settings.yml in the repo. Its settings are unmanaged - nothing installs or heals the main ruleset (so all-green may not be a required check) and labels are never reconciled. Pick a home per docs/settings.md."
    return 10
  fi
  probe_error="$(cat "$RUNNER_TEMP/probe.err")"
  return 1
}

# probe <label> <fn> <repo> <display> <central_ref>: rc 0 keeps the repo
# in the pipeline, rc 1 drops it - either a definitive negative (already
# reported by the probe) or still no answer after the retries, which
# warns loudly: a silently dropped repo would heal nothing tonight and
# nobody would know. $probe_error is scrubbed of the slug and bare name
# before printing when the two differ from the display.
attempts=3
probe() {
  local label="$1" fn="$2" repo="$3" display="$4" central_ref="$5" rc try
  for try in $(seq 1 "$attempts"); do
    rc=0
    probe_error=""
    "$fn" "$repo" "$display" "$central_ref" || rc=$?
    if [ "$rc" -eq 0 ]; then return 0; fi
    if [ "$rc" -eq 10 ]; then return 1; fi
    if [ "$display" != "$repo" ]; then
      probe_error="${probe_error//"$repo"/$display}"
      probe_error="${probe_error//"${repo##*/}"/$display}"
    fi
    if [ "$try" -lt "$attempts" ]; then
      echo "${display}: ${label} failed (attempt ${try}/${attempts}: ${probe_error}); retrying..."
      sleep 5
    fi
  done
  warn "${display}: the ${label} failed ${attempts} times (last error: ${probe_error}) - not a permission or adoption answer, so the repo is skipped this run; the nightly heal retries it. If this persists, check the repo's availability and the fleet token."
  return 1
}

# -F alone would flip gh api to POST; this is a read. Visibility rides
# along fail-closed: anything but private: false counts as private.
gh api user/repos --method GET --paginate --slurp -F per_page=100 |
  jq --arg owner "$OWNER" \
    'add | [.[] | select(.owner.login == $owner and (.archived | not) and .permissions.push) | {repo: .full_name, private: (.private != false)}]' \
    >"$RUNNER_TEMP/discovered.json"
bun .github/scripts/fleet/repos_registry.ts select \
  --discovered "$RUNNER_TEMP/discovered.json" >"$RUNNER_TEMP/selected.json"
bun .github/scripts/fleet/redact.ts enrich \
  --selection "$RUNNER_TEMP/selected.json" \
  --discovered "$RUNNER_TEMP/discovered.json" >"$RUNNER_TEMP/enriched.json"

echo '[]' >"$RUNNER_TEMP/in_repo_targets.json"
while IFS= read -r row; do
  repo="$(jq -r '.repo' <<<"$row")"
  display="$(jq -r '.display' <<<"$row")"
  name="${repo##*/}"
  central_ref="settings/repos/$name.yml"
  if [ "$(jq -r '.redact_name' <<<"$row")" = "true" ]; then
    central_ref='settings/repos/<name>.yml'
  fi
  [ -f "settings/repos/$name.yml" ] && continue
  probe "push-permission probe" probe_push "$repo" "$display" "$central_ref" || continue
  probe "adoption check" probe_adoption "$repo" "$display" "$central_ref" || continue
  probe "settings.yml check" probe_settings "$repo" "$display" "$central_ref" || continue
  jq -c --argjson row "$row" '. + [$row]' "$RUNNER_TEMP/in_repo_targets.json" \
    >"$RUNNER_TEMP/in_repo_targets.json.new"
  mv "$RUNNER_TEMP/in_repo_targets.json.new" "$RUNNER_TEMP/in_repo_targets.json"
done < <(jq -c '.rows[]' "$RUNNER_TEMP/enriched.json")

# repos.yml's exclude: pauses the sync AND this heal - the registry drops
# excluded repos before the loop above ever sees them. When such a repo
# still carries an in-repo settings.yml (and no central file has taken
# over), say that the heal stopped instead of going quiet. Materialized
# first so a registry failure fails the run instead of silently
# skipping every exclusion warning. Excluded slugs are committed in
# repos.yml - self-disclosed, so they print plainly.
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
    # report it without killing the apply for the selected repos. The
    # NAME is self-disclosed (committed in repos.yml), but an excluded
    # repo's error detail may not be - unless discovery proves the repo
    # public, only the HTTP code prints.
    detail="$(cat "$RUNNER_TEMP/probe.err")"
    if ! jq -e --arg r "$repo" \
      '.[] | select(.repo == $r and (.private == false))' \
      "$RUNNER_TEMP/discovered.json" >/dev/null; then
      code="$(grep -oE 'HTTP [0-9]+' <<<"$detail" | head -1)"
      detail="${code:-no status} (detail hidden: private repository)"
    fi
    echo "::warning::settings.yml check for excluded repo $repo failed: ${detail} - cannot tell whether its pause left an in-repo settings file behind; continuing."
  fi
done < <(jq -r '.[]' "$RUNNER_TEMP/excluded.json")

# The matrix joins the probed in-repo list with the central files; a
# builder failure (unreadable dir, a central file the per-repo scoping
# cannot represent) invalidates the whole selection and exits 1.
targets="$(bun .github/scripts/fleet/build_settings_matrix.ts \
  --owner "$OWNER" --in-repo "$RUNNER_TEMP/in_repo_targets.json")"
echo "targets=${targets}" >>"$GITHUB_OUTPUT"
echo "settings targets: $(jq -r 'if length == 0 then "(none)" else map(.repo + " [" + .home + "]") | join(", ") end' <<<"$targets")"

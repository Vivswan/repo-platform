#!/usr/bin/env bash
# Fails when the release-please PR is behind its base branch. HEAD is the
# PR head commit, checked out by ci.yml's release-freshness job.
set -euo pipefail

tip="$(git rev-parse "origin/${GITHUB_BASE_REF}")"
if git merge-base --is-ancestor "$tip" HEAD; then
  echo "release PR contains the ${GITHUB_BASE_REF} tip (${tip})"
else
  echo "::error::Release PR is behind ${GITHUB_BASE_REF} (tip ${tip}); its version and changelog would miss commits already on ${GITHUB_BASE_REF}. Do not merge; release-please refreshes the PR after the next green run on ${GITHUB_BASE_REF}."
  exit 1
fi

#!/usr/bin/env bash
# Applies the template to the target checkout: a three-way `copier update`
# normally, or a full `copier recopy` in recovery mode - for a repo whose
# recorded _commit base is unusable, there is no merge base, so the
# re-render overwrites template-managed files outright (`_skip_if_exists`
# files survive; copier deletes nothing; the PR is forced onto the
# manual-review path). Invoked by reusable-template-sync.yml's "Apply
# copier update" step.
#
# Env: TARGET_DIR (default target), TARGET_REF, MODULES, CHANNEL, PRIVATE,
# DESCRIPTION, RECOVER.
set -euo pipefail

cd "${TARGET_DIR:-target}"
if [ "$RECOVER" = "recopy" ]; then
  copier recopy --vcs-ref "$TARGET_REF" --defaults --trust --overwrite \
    -d "modules=${MODULES}" \
    -d "channel=${CHANNEL}" \
    -d "private=${PRIVATE}" \
    -d "description=${DESCRIPTION}"
else
  copier update --vcs-ref "$TARGET_REF" --defaults --trust \
    -d "modules=${MODULES}" \
    -d "channel=${CHANNEL}" \
    -d "private=${PRIVATE}" \
    -d "description=${DESCRIPTION}"
fi

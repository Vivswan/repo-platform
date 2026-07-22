#!/usr/bin/env bash
# Render a smoke-test project into /tmp/smoke for one CI matrix row: main
# carries only templates/ sources, so assemble the consumable build tree
# (what the staging/latest branches hold) and `copier copy` from it.
#
# Inputs (env): MODULES (YAML list as a string), PRIVATE, EXTRA_DATA
# (optional extra -d args).
set -euo pipefail
: "${MODULES:?}" "${PRIVATE:?}"
EXTRA_DATA="${EXTRA_DATA:-}"

python3 .github/scripts/build_branch_tree.py --dest /tmp/build-tree --channel staging
git -C /tmp/build-tree init -q -b build
git -C /tmp/build-tree add -A
git -C /tmp/build-tree -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: build"

# shellcheck disable=SC2086 # EXTRA_DATA is a list of extra -d args; values
# must stay whitespace-free (word splitting) - add a matrix field instead
# for anything that needs spaces.
copier copy /tmp/build-tree /tmp/smoke \
  --vcs-ref HEAD --defaults --trust \
  -d project_name="Smoke Test" \
  -d description="Smoke-test project" \
  -d "modules=$MODULES" \
  -d private="$PRIVATE" \
  $EXTRA_DATA

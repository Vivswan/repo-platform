#!/usr/bin/env bash
# Upgrade-path test: generate a project from the previous templates/v* build
# tag, then `copier update` it to a freshly assembled build tree - the path
# every managed repo actually takes. Both refs must live in ONE clone (copier
# re-renders the old version from _src_path), so the new tree is committed to
# a local orphan ref + tag. Exits cleanly when no templates/v* tag exists yet
# (first release).
set -euo pipefail
GITHUB_WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"

git fetch --tags --quiet origin
prev="$(git tag --list 'templates/v*' --sort=-v:refname | sed -n 1p)"
if [ -z "$prev" ]; then
  echo "No previous templates/v* build tag; skipping upgrade-path test."
  exit 0
fi
echo "Testing upgrade path ${prev} -> fresh build"
copier copy "$GITHUB_WORKSPACE" /tmp/upgrade \
  --vcs-ref "$prev" --defaults --trust \
  -d project_name="Upgrade Test" \
  -d description="Upgrade-path project" \
  -d 'modules=[agents, uv, release-please, issue-templates, pr-title, auto-assign]' \
  -d private="false"
cd /tmp/upgrade
git init -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"

# Assemble the would-be next release INTO THE WORKSPACE CLONE as an
# orphan commit + local templates/v* tag.
cd "$GITHUB_WORKSPACE"
python3 .github/scripts/build_branch_tree.py --dest /tmp/next --channel latest --version v99.99.99
git worktree add --detach /tmp/wt HEAD
git -C /tmp/wt switch --orphan ci-build
rsync -a --delete --exclude=.git /tmp/next/ /tmp/wt/
git -C /tmp/wt add -A
git -C /tmp/wt -c user.name=ci -c user.email=ci@localhost commit -q -m "build(ci): v99.99.99"
git tag templates/v99.99.99 "$(git -C /tmp/wt rev-parse HEAD)"

# NO -d flags: exactly what reusable-template-sync runs downstream.
cd /tmp/upgrade
copier update --vcs-ref templates/v99.99.99 --defaults --trust
python3 "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.py" /tmp/upgrade
# _commit must record the build tag (git describe lands exactly on it).
grep -qF "_commit: templates/v99.99.99" .copier-answers.yml
# The update must PRESERVE the repo's configuration, not reset it.
grep -qF -- "## Python " .gitignore
grep -qF -- 'package-ecosystem: "uv"' .github/dependabot.yml
grep -qF -- "language: python" .github/workflows/codeql.yml
test -f .github/workflows/pr-title.yml
test -f AGENTS.md
echo "upgrade preserved the module configuration"

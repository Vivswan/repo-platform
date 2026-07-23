#!/usr/bin/env bash
# Assert module/visibility gating on the rendered smoke-test project in
# /tmp/smoke: the right files exist for the selected modules, and the right
# fragments appear inside shared files.
#
# Inputs (env): MODULES, PRIVATE (the matrix row that produced the tree),
# EXPECT_IN_PAGES (optional per-row patterns for pages.yml), EXTRA_DATA
# (optional extra -d args the row passed to copier).
set -euo pipefail
: "${MODULES:?}" "${PRIVATE:?}"
EXPECT_IN_PAGES="${EXPECT_IN_PAGES:-}"
EXTRA_DATA="${EXTRA_DATA:-}"

wf=/tmp/smoke/.github/workflows
mods=",$(echo "$MODULES" | tr -d '[] '),"
has() { case "$mods" in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
present() { grep -qF -- "$1" "$2" || { echo "::error::gating check failed: '$1' is missing from $2, so the template did not emit it for modules=$MODULES private=$PRIVATE. Fix the gate in templates/ (or this expectation in verify_smoke_gating.sh)."; exit 1; }; }
absent() { if grep -qF -- "$1" "$2"; then echo "::error::gating check failed: '$1' appears in $2 but modules=$MODULES private=$PRIVATE should not emit it. Fix the gate in templates/ (or this expectation in verify_smoke_gating.sh)."; exit 1; fi; }

if has pr-title; then test -f "$wf/pr-title.yml"; else test ! -e "$wf/pr-title.yml"; fi
if has auto-assign; then test -f "$wf/auto-assign.yml"; else test ! -e "$wf/auto-assign.yml"; fi
if has issue-templates; then test -d /tmp/smoke/.github/ISSUE_TEMPLATE; else test ! -e /tmp/smoke/.github/ISSUE_TEMPLATE; fi
if has pages; then test -f "$wf/pages.yml"; else test ! -e "$wf/pages.yml"; fi
if has settings-sync; then
  test -f "$wf/settings-sync.yml"
  present "reusable-apply-settings.yml@main" "$wf/settings-sync.yml"
else
  test ! -e "$wf/settings-sync.yml"
fi

# auto-assign: security-events is always granted (static validation of
# the reusable call); the CodeQL-driven triggers and the code_scanning
# input follow enable_codeql (= public AND a toolchain module).
if has auto-assign; then
  present "security-events: write" "$wf/auto-assign.yml"
  if [ "$PRIVATE" != "true" ] && { has bun || has uv; }; then
    present "workflow_run:" "$wf/auto-assign.yml"
    present "code_scanning: true" "$wf/auto-assign.yml"
  else
    absent "workflow_run:" "$wf/auto-assign.yml"
    present "code_scanning: false" "$wf/auto-assign.yml"
  fi
fi

# CodeQL: public AND at least one analyzable toolchain; one job per language.
if [ "$PRIVATE" != "true" ] && { has bun || has uv; }; then
  test -f "$wf/codeql.yml"
  if has bun; then present "language: javascript-typescript" "$wf/codeql.yml"; else absent "language: javascript-typescript" "$wf/codeql.yml"; fi
  if has uv; then present "language: python" "$wf/codeql.yml"; else absent "language: python" "$wf/codeql.yml"; fi
else
  test ! -e "$wf/codeql.yml"
fi

if [ "$PRIVATE" = "true" ]; then test ! -e /tmp/smoke/SECURITY.md; else test -f /tmp/smoke/SECURITY.md; fi

# gitignore toolchain sections; the four markers are asserted by the validator.
if has bun; then present "## Node " /tmp/smoke/.gitignore; else absent "## Node " /tmp/smoke/.gitignore; fi
if has uv; then present "## Python " /tmp/smoke/.gitignore; else absent "## Python " /tmp/smoke/.gitignore; fi

# dependabot ecosystems follow the toolchain modules.
present 'package-ecosystem: "github-actions"' /tmp/smoke/.github/dependabot.yml
if has bun; then present 'package-ecosystem: "bun"' /tmp/smoke/.github/dependabot.yml; else absent 'package-ecosystem: "bun"' /tmp/smoke/.github/dependabot.yml; fi
if has uv; then present 'package-ecosystem: "uv"' /tmp/smoke/.github/dependabot.yml; else absent 'package-ecosystem: "uv"' /tmp/smoke/.github/dependabot.yml; fi

# agents module: AGENTS.md plus the three agent-file symlinks. The
# rows without it also prove conditional filenames work on symlinks.
if has agents; then
  test -f /tmp/smoke/AGENTS.md
  test -L /tmp/smoke/CLAUDE.md
  test "$(readlink /tmp/smoke/CLAUDE.md)" = "AGENTS.md"
  test -L /tmp/smoke/.github/copilot-instructions.md
  test -L /tmp/smoke/.github/agents.md
  # AGENTS.md toolchain section only when a toolchain module is selected.
  if has bun || has uv; then present "## Toolchain" /tmp/smoke/AGENTS.md; else absent "## Toolchain" /tmp/smoke/AGENTS.md; fi
else
  # `test ! -e` follows symlinks (a dangling one passes), so also
  # assert not-a-symlink for the three link paths.
  test ! -e /tmp/smoke/AGENTS.md
  test ! -e /tmp/smoke/CLAUDE.md && test ! -L /tmp/smoke/CLAUDE.md
  test ! -e /tmp/smoke/.github/agents.md && test ! -L /tmp/smoke/.github/agents.md
  test ! -e /tmp/smoke/.github/copilot-instructions.md && test ! -L /tmp/smoke/.github/copilot-instructions.md
fi

# release-please module gates the autorelease labels in settings.yml, the
# managed release-please.yml machinery, the repo-owned release.yml pipeline
# plus its thin caller job in the managed ci.yml, and the config files.
if has release-please; then present "autorelease: pending" /tmp/smoke/.github/settings.yml; else absent "autorelease: pending" /tmp/smoke/.github/settings.yml; fi
if has release-please; then
  test -f "$wf/release-please.yml"
  test -f "$wf/release.yml"
  present "uses: ./.github/workflows/release.yml" "$wf/ci.yml"
  test -f /tmp/smoke/release-please-config.json
  test -f /tmp/smoke/.release-please-manifest.json
else
  test ! -e "$wf/release-please.yml"
  test ! -e "$wf/release.yml"
  absent "uses: ./.github/workflows/release.yml" "$wf/ci.yml"
  test ! -e /tmp/smoke/release-please-config.json
  test ! -e /tmp/smoke/.release-please-manifest.json
fi

# auto-format follows the toolchain modules; its formatter steps, like the
# checks.yml example comments, are spliced from the bun/uv module fragments.
if has bun; then present "Example bun checks" "$wf/checks.yml"; else absent "Example bun checks" "$wf/checks.yml"; fi
if has uv; then present "Example uv checks" "$wf/checks.yml"; else absent "Example uv checks" "$wf/checks.yml"; fi
if has bun || has uv; then
  test -f "$wf/auto-format.yml"
  if has bun; then present "biome" "$wf/auto-format.yml"; else absent "biome" "$wf/auto-format.yml"; fi
  if has uv; then present "ruff" "$wf/auto-format.yml"; else absent "ruff" "$wf/auto-format.yml"; fi
else
  test ! -e "$wf/auto-format.yml"
fi

# copilot-setup-steps belongs to the agents module; the toolchain installs
# inside it splice from the bun/uv fragments.
if has agents; then
  test -f "$wf/copilot-setup-steps.yml"
  if has bun; then present "oven-sh/setup-bun" "$wf/copilot-setup-steps.yml"; else absent "oven-sh/setup-bun" "$wf/copilot-setup-steps.yml"; fi
  if has uv; then present "astral-sh/setup-uv" "$wf/copilot-setup-steps.yml"; else absent "astral-sh/setup-uv" "$wf/copilot-setup-steps.yml"; fi
else
  test ! -e "$wf/copilot-setup-steps.yml"
fi

# Managed ci.yml is always generated (repo checks live in the repo-owned
# checks.yml it calls); the validator asserts the all-green shape, so only
# check the wiring and the composite-action pin falling back to main here
# (scratch build tree, same as the template-sync pin below).
test -f "$wf/ci.yml"
test -f "$wf/checks.yml"
present "uses: ./.github/workflows/checks.yml" "$wf/ci.yml"
present "actions/check-typography@main" "$wf/ci.yml"

# Row-specific expectations for the rendered pages caller.
if [ -n "$EXPECT_IN_PAGES" ]; then
  while IFS= read -r pattern; do
    [ -z "$pattern" ] && continue
    present "$pattern" "$wf/pages.yml"
  done <<< "$EXPECT_IN_PAGES"
fi

test -f "$wf/template-sync.yml"
# The reusable-workflow pin must fall back to main here: the scratch
# build tree's _commit is a bare sha, not a templates/vX.Y.Z tag.
present "reusable-template-sync.yml@main" "$wf/template-sync.yml"
# Channel is recorded in the registration file (a row can override to
# staging via EXTRA_DATA; every other row takes the latest default).
case "$EXTRA_DATA" in
  *channel=staging*) present "channel: staging" /tmp/smoke/.repo-platform.yml ;;
  *) present "channel: latest" /tmp/smoke/.repo-platform.yml ;;
esac

#!/usr/bin/env bash
# Assert module/visibility gating on the rendered smoke-test project in
# /tmp/smoke: the right files exist for the selected modules, and the right
# fragments appear inside shared files.
#
# Inputs (env): MODULES, PRIVATE (the matrix row that produced the tree),
# EXPECT_IN_PAGES (optional per-row patterns for pages.yml), EXTRA_DATA
# (optional extra -d args the row passed to copier).
# shellcheck disable=SC2016  # assertion strings carry literal backticks
set -euo pipefail
: "${MODULES:?}" "${PRIVATE:?}"
EXPECT_IN_PAGES="${EXPECT_IN_PAGES:-}"
EXTRA_DATA="${EXTRA_DATA:-}"

wf=/tmp/smoke/.github/workflows
mods=",$(echo "$MODULES" | tr -d '[] '),"
has() { case "$mods" in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
# The toolchain rosters, spelled once: CodeQL-analyzable toolchains drive
# enable_codeql and the auto-format starter; rust joins only the
# any-toolchain gates (dependabot prefix, the AGENTS.md Toolchain section).
has_codeql_toolchain() { has bun || has node || has deno || has uv; }
has_any_toolchain() { has_codeql_toolchain || has rust; }
present() { grep -qF -- "$1" "$2" || { echo "::error::gating check failed: '$1' is missing from $2, so the template did not emit it for modules=$MODULES private=$PRIVATE. Fix the gate in templates/ (or this expectation in verify_smoke_gating.sh)."; exit 1; }; }
present_line() { grep -qxF -- "$1" "$2" || { echo "::error::gating check failed: no line is exactly '$1' in $2, so the template did not emit it for modules=$MODULES private=$PRIVATE. Fix the gate in templates/ (or this expectation in verify_smoke_gating.sh)."; exit 1; }; }
absent() { if grep -qF -- "$1" "$2"; then echo "::error::gating check failed: '$1' appears in $2 but modules=$MODULES private=$PRIVATE should not emit it. Fix the gate in templates/ (or this expectation in verify_smoke_gating.sh)."; exit 1; fi; }
absent_line() { if grep -qxF -- "$1" "$2"; then echo "::error::gating check failed: a line is exactly '$1' in $2 but modules=$MODULES private=$PRIVATE should not emit it. Fix the gate in templates/ (or this expectation in verify_smoke_gating.sh)."; exit 1; fi; }

# pr-title runs inside the managed ci.yml gate (no standalone workflow).
test ! -e "$wf/pr-title.yml"
if has pr-title; then
  present "pr-title:" "$wf/ci.yml"
  present "- pr-title" "$wf/ci.yml"
else
  absent "pr-title:" "$wf/ci.yml"
  absent "- pr-title" "$wf/ci.yml"
fi
if has auto-assign; then test -f "$wf/auto-assign.yml"; else test ! -e "$wf/auto-assign.yml"; fi
if has issue-templates; then test -f /tmp/smoke/.github/ISSUE_TEMPLATE/config.yml; else test ! -e /tmp/smoke/.github/ISSUE_TEMPLATE; fi
if has pages; then test -f "$wf/pages.yml"; else test ! -e "$wf/pages.yml"; fi

# fuzzer: the repo-owned nightly-fuzz starter with the fuzz-issue action in
# both modes and the dispatch replay inputs; the auto-assign dispatch step
# follows that module (scratch build tree pins the action to main, like
# check-typography below).
if has fuzzer; then
  test -f "$wf/nightly-fuzz.yml"
  present "actions/fuzz-issue@main" "$wf/nightly-fuzz.yml"
  present "mode: report" "$wf/nightly-fuzz.yml"
  present "mode: resolve" "$wf/nightly-fuzz.yml"
  present "workflow_dispatch:" "$wf/nightly-fuzz.yml"
  if has auto-assign; then
    present "auto-assign.yml" "$wf/nightly-fuzz.yml"
    present "actions: write" "$wf/nightly-fuzz.yml"
  else
    absent "auto-assign.yml" "$wf/nightly-fuzz.yml"
    absent "actions: write" "$wf/nightly-fuzz.yml"
  fi
else
  test ! -e "$wf/nightly-fuzz.yml"
fi

if has settings-sync; then
  test -f /tmp/smoke/.github/settings.yml
  test -f "$wf/settings-sync.yml"
  present "reusable-apply-settings.yml@main" "$wf/settings-sync.yml"
  # Visibility is declared even when public; the whole-line match keeps
  # the explanatory comment above the key from satisfying the check.
  present_line "  private: $PRIVATE" /tmp/smoke/.github/settings.yml
  # homepage and topics are declared even when empty (declare-and-clear);
  # no row passes either answer, so every row must render the empty form.
  # A re-gated key would vanish and its drift would go unmanaged again.
  present_line '  homepage: ""' /tmp/smoke/.github/settings.yml
  present_line '  topics: ""' /tmp/smoke/.github/settings.yml
  # The ruleset's code_scanning rule follows enable_codeql (public AND a
  # toolchain): GitHub 422s that rule on a private personal repo, so a
  # private render must never emit it.
  if [ "$PRIVATE" != "true" ] && has_codeql_toolchain; then
    present "type: code_scanning" /tmp/smoke/.github/settings.yml
  else
    absent "type: code_scanning" /tmp/smoke/.github/settings.yml
  fi
  # security_and_analysis follows visibility alone: private repos without
  # Advanced Security reject the block (422), so it must never render there.
  if [ "$PRIVATE" != "true" ]; then
    present "security_and_analysis:" /tmp/smoke/.github/settings.yml
    present "secret_scanning_push_protection:" /tmp/smoke/.github/settings.yml
  else
    absent "security_and_analysis:" /tmp/smoke/.github/settings.yml
  fi
else
  test ! -e /tmp/smoke/.github/settings.yml
  test ! -e "$wf/settings-sync.yml"
fi

# auto-assign: the issues/PR call grants only issues/PR scopes;
# security-events rides the separate alerts call, which - with its
# CodeQL-driven triggers - follows enable_codeql (= public AND a toolchain
# module) and is absent otherwise. The workflow level grants nothing, so a
# scope moving back up there fails here.
if has auto-assign; then
  absent "code_scanning:" "$wf/auto-assign.yml"
  present "reusable-auto-assign.yml" "$wf/auto-assign.yml"
  present_line "permissions: {}" "$wf/auto-assign.yml"
  if [ "$PRIVATE" != "true" ] && has_codeql_toolchain; then
    present "workflow_run:" "$wf/auto-assign.yml"
    # Alert assignment watches CI completions (the CodeQL jobs run inside
    # CI's gate; a reusable-workflow call creates no separate run to watch).
    present 'workflows: ["CI"]' "$wf/auto-assign.yml"
    present "reusable-auto-assign-alerts.yml" "$wf/auto-assign.yml"
    # Exactly once: only the alerts caller job may carry the scope.
    if [ "$(grep -cF -- "security-events: write" "$wf/auto-assign.yml")" != "1" ]; then
      echo "::error::gating check failed: 'security-events: write' must appear exactly once (on the alerts caller job) in $wf/auto-assign.yml for modules=$MODULES private=$PRIVATE. Fix the gate in templates/ (or this expectation in verify_smoke_gating.sh)."
      exit 1
    fi
  else
    absent "workflow_run:" "$wf/auto-assign.yml"
    absent "reusable-auto-assign-alerts.yml" "$wf/auto-assign.yml"
    absent "security-events: write" "$wf/auto-assign.yml"
  fi
fi

# CodeQL: public AND at least one analyzable toolchain; the per-language
# analysis jobs are spliced straight into ci.yml's gate (no standalone
# workflow), and the weekly re-scan schedule lives on ci.yml's triggers.
test ! -e "$wf/codeql.yml"
if [ "$PRIVATE" != "true" ] && has_codeql_toolchain; then
  present "reusable-codeql.yml@main" "$wf/ci.yml"
  present "schedule:" "$wf/ci.yml"
  present 'cron: "23 4 * * 1"' "$wf/ci.yml"
  # The caller jobs must grant the scan permissions (a caller job's
  # permissions are the ceiling for the called workflow).
  present "contents: read" "$wf/ci.yml"
  present "security-events: write" "$wf/ci.yml"
  present "actions: read" "$wf/ci.yml"
  if has bun || has node || has deno; then
    present "codeql-javascript:" "$wf/ci.yml"
    present "- codeql-javascript" "$wf/ci.yml"
    # bun, node, and deno all analyze as javascript-typescript; the composer
    # must group them into ONE job under co-selection. A duplicate YAML job
    # key would not fail YAML parsers, so count the exact job-key line.
    js_jobs="$(grep -cxF -- "  codeql-javascript:" "$wf/ci.yml" || true)"
    if [ "$js_jobs" -ne 1 ]; then
      echo "::error::gating check failed: expected exactly 1 line \"  codeql-javascript:\" in $wf/ci.yml but found $js_jobs for modules=$MODULES private=$PRIVATE - the shared javascript-typescript CodeQL group must emit one job, never per-module duplicates. Fix the codeql-languages generator in scripts/compose_template.ts (or this expectation in verify_smoke_gating.sh)."
      exit 1
    fi
  else
    absent "codeql-javascript" "$wf/ci.yml"
  fi
  if has uv; then
    present "codeql-python:" "$wf/ci.yml"
    present "- codeql-python" "$wf/ci.yml"
  else
    absent "codeql-python" "$wf/ci.yml"
  fi
else
  absent "codeql" "$wf/ci.yml"
  absent "schedule:" "$wf/ci.yml"
  # No gate job needs the scan permissions without CodeQL (contents: read
  # stays - it is ci.yml's workflow-level default).
  absent "security-events: write" "$wf/ci.yml"
  absent "actions: read" "$wf/ci.yml"
fi

# Base community files: the fleet LICENSE ships to every render unless the
# repo opts out via the custom-license module; the other three are
# public-only. Job and needs entry
# are asserted separately as a cheap render-time cross-check (the validator
# independently hard-errors on a present job missing from all-green's
# needs).
if has custom-license; then test ! -e /tmp/smoke/LICENSE.md; else test -f /tmp/smoke/LICENSE.md; fi
# SECURITY.md is visibility-independent (private collaborators need the
# reporting route too); the contributor-facing files stay public-only.
test -f /tmp/smoke/SECURITY.md
if [ "$PRIVATE" = "true" ]; then
  test ! -e /tmp/smoke/CONTRIBUTING.md
  test ! -e /tmp/smoke/CODE_OF_CONDUCT.md
  absent "dependency-review:" "$wf/ci.yml"
  absent "- dependency-review" "$wf/ci.yml"
else
  test -f /tmp/smoke/CONTRIBUTING.md
  test -f /tmp/smoke/CODE_OF_CONDUCT.md
  present "dependency-review:" "$wf/ci.yml"
  present "      - dependency-review" "$wf/ci.yml"
  # The wrapper pin, falling back to main on the scratch build tree; the
  # upgrade test proves the release-tag form.
  present "repo-platform/actions/dependency-review@main" "$wf/ci.yml"
fi

# Base checks: private renders merge the five tiny jobs into one
# base-checks job (a standalone job bills a rounded-up minute per run on
# private repos); public renders keep the one-job-per-check fan-out. Job
# keys and needs entries are matched as whole lines at their exact
# indentation: a bare 'typography' pattern would also hit
# 'actions/check-typography@main'.
base_check_jobs=(typography commit-names actionlint gitleaks yamllint)
if [ "$PRIVATE" = "true" ]; then
  present_line "  base-checks:" "$wf/ci.yml"
  present_line "      - base-checks" "$wf/ci.yml"
  for job in "${base_check_jobs[@]}"; do
    absent_line "  $job:" "$wf/ci.yml"
    absent_line "      - $job" "$wf/ci.yml"
  done
  # Every check's tool steps must survive the merge (check-typography is
  # asserted for both shapes below).
  present "actions/validate-commit-names@main" "$wf/ci.yml"
  present "raven-actions/actionlint" "$wf/ci.yml"
  present "gitleaks/gitleaks-action" "$wf/ci.yml"
  present "yamllint -s ." "$wf/ci.yml"
  # ...and keep their run-even-after-an-earlier-failure guard: one per
  # check step (five checks, yamllint contributing two steps).
  guard="        if: '!cancelled()'"
  guards="$(grep -cxF -- "$guard" "$wf/ci.yml" || true)"
  if [ "$guards" -ne 6 ]; then
    echo "::error::gating check failed: expected exactly 6 lines \"$guard\" in $wf/ci.yml but found $guards for modules=$MODULES private=$PRIVATE. Fix the gate in templates/ (or this expectation in verify_smoke_gating.sh)."
    exit 1
  fi
else
  # Exact lines, not a substring: the header comment describing the two
  # shapes names base-checks in every render.
  absent_line "  base-checks:" "$wf/ci.yml"
  absent_line "      - base-checks" "$wf/ci.yml"
  # The guard belongs to the merged shape alone; public fan-out jobs fail
  # independently without it.
  absent "!cancelled()" "$wf/ci.yml"
  for job in "${base_check_jobs[@]}"; do
    present_line "  $job:" "$wf/ci.yml"
    present_line "      - $job" "$wf/ci.yml"
  done
fi

# gitignore toolchain sections; the four markers are asserted by the validator.
# bun and node share upstream Node.gitignore: the shared section must appear
# under either module and exactly once under co-selection (the node fragment
# suppresses its guarded copy when bun is also selected). The count matches
# the full header line, so a reworded near-miss cannot satisfy it.
if has bun || has node; then
  node_sections="$(grep -cxF -- "## Node (github/gitignore Node.gitignore)" /tmp/smoke/.gitignore || true)"
  if [ "$node_sections" -ne 1 ]; then
    echo "::error::gating check failed: expected exactly 1 line '## Node (github/gitignore Node.gitignore)' in /tmp/smoke/.gitignore but found $node_sections for modules=$MODULES private=$PRIVATE - the shared Node.gitignore source must render once, never per-module duplicates. Fix the fragment guards emitted by scripts/build_gitignore.ts (or this expectation in verify_smoke_gating.sh)."
    exit 1
  fi
else
  absent "## Node " /tmp/smoke/.gitignore
fi
if has deno; then present_line "## Deno (github/gitignore Deno.gitignore)" /tmp/smoke/.gitignore; else absent "## Deno " /tmp/smoke/.gitignore; fi
if has uv; then present "## Python " /tmp/smoke/.gitignore; else absent "## Python " /tmp/smoke/.gitignore; fi
if has rust; then present "## Rust " /tmp/smoke/.gitignore; else absent "## Rust " /tmp/smoke/.gitignore; fi

# dependabot ecosystems follow the toolchain modules; every entry carries a
# commit-message prefix so dependabot PR titles are Conventional Commits.
present 'package-ecosystem: "github-actions"' /tmp/smoke/.github/dependabot.yml
present 'prefix: "ci"' /tmp/smoke/.github/dependabot.yml
if has bun; then present 'package-ecosystem: "bun"' /tmp/smoke/.github/dependabot.yml; else absent 'package-ecosystem: "bun"' /tmp/smoke/.github/dependabot.yml; fi
if has node; then present 'package-ecosystem: "npm"' /tmp/smoke/.github/dependabot.yml; else absent 'package-ecosystem: "npm"' /tmp/smoke/.github/dependabot.yml; fi
if has deno; then present 'package-ecosystem: "deno"' /tmp/smoke/.github/dependabot.yml; else absent 'package-ecosystem: "deno"' /tmp/smoke/.github/dependabot.yml; fi
if has uv; then present 'package-ecosystem: "uv"' /tmp/smoke/.github/dependabot.yml; else absent 'package-ecosystem: "uv"' /tmp/smoke/.github/dependabot.yml; fi
if has rust; then present 'package-ecosystem: "cargo"' /tmp/smoke/.github/dependabot.yml; else absent 'package-ecosystem: "cargo"' /tmp/smoke/.github/dependabot.yml; fi
if has_any_toolchain; then present 'prefix: "build"' /tmp/smoke/.github/dependabot.yml; else absent 'prefix: "build"' /tmp/smoke/.github/dependabot.yml; fi

# agents module: AGENTS.md plus the three agent-file symlinks. The
# rows without it also prove conditional filenames work on symlinks.
if has agents; then
  test -f /tmp/smoke/AGENTS.md
  test -L /tmp/smoke/CLAUDE.md
  test "$(readlink /tmp/smoke/CLAUDE.md)" = "AGENTS.md"
  test -L /tmp/smoke/.github/copilot-instructions.md
  test -L /tmp/smoke/.github/agents.md
  # AGENTS.md toolchain section only when a toolchain module is selected,
  # with exactly the selected toolchains' bullets inside it.
  if has_any_toolchain; then present "## Toolchain" /tmp/smoke/AGENTS.md; else absent "## Toolchain" /tmp/smoke/AGENTS.md; fi
  if has bun; then present_line '- Runtime and package manager: bun (`bun install`, `bun test`, `bun run <script>`)' /tmp/smoke/AGENTS.md; else absent "Runtime and package manager: bun" /tmp/smoke/AGENTS.md; fi
  if has node; then present_line '- Node.js with npm (`npm install`, `npm test`, `npm run <script>`)' /tmp/smoke/AGENTS.md; else absent "Node.js with npm" /tmp/smoke/AGENTS.md; fi
  if has deno; then present_line '- Deno runtime (`deno install`, `deno test`, `deno task <task>`)' /tmp/smoke/AGENTS.md; else absent "Deno runtime" /tmp/smoke/AGENTS.md; fi
  if has uv; then present_line '- Python managed with uv (`uv sync`, `uv run <command>`)' /tmp/smoke/AGENTS.md; else absent "Python managed with uv" /tmp/smoke/AGENTS.md; fi
  if has rust; then present_line '- Rust managed with cargo (`cargo build`, `cargo test`, `cargo clippy`)' /tmp/smoke/AGENTS.md; else absent "Rust managed with cargo" /tmp/smoke/AGENTS.md; fi
else
  # `test ! -e` follows symlinks (a dangling one passes), so also
  # assert not-a-symlink for the three link paths.
  test ! -e /tmp/smoke/AGENTS.md
  test ! -e /tmp/smoke/CLAUDE.md && test ! -L /tmp/smoke/CLAUDE.md
  test ! -e /tmp/smoke/.github/agents.md && test ! -L /tmp/smoke/.github/agents.md
  test ! -e /tmp/smoke/.github/copilot-instructions.md && test ! -L /tmp/smoke/.github/copilot-instructions.md
fi

# release-please module gates the autorelease labels in the settings-sync
# module's settings.yml (only rendered when that module is on) and the
# release-tags tag-immutability ruleset there (sync pins against v-tags),
# the managed release-please.yml machinery, the repo-owned release.yml
# pipeline plus its thin caller job in the managed ci.yml, and the config
# files. The fuzzer module's tracking label splices into settings.yml the
# same way.
if has settings-sync; then
  if has release-please; then present "autorelease: pending" /tmp/smoke/.github/settings.yml; else absent "autorelease: pending" /tmp/smoke/.github/settings.yml; fi
  if has release-please; then present "name: release-tags" /tmp/smoke/.github/settings.yml; else absent "name: release-tags" /tmp/smoke/.github/settings.yml; fi
  if has fuzzer; then present "Automated nightly fuzz failure" /tmp/smoke/.github/settings.yml; else absent "Automated nightly fuzz failure" /tmp/smoke/.github/settings.yml; fi
fi

# Toolchain modules gate dependabot's default per-ecosystem labels in the
# settings-sync module's settings.yml (dependabot recreates them when
# missing, so the settings apply must declare them or loop on deletion).
# github_actions is unconditional: the base dependabot.yml always carries
# the github-actions ecosystem.
if has settings-sync; then
  present_line "  - name: github_actions" /tmp/smoke/.github/settings.yml
  if has bun || has node; then present_line "  - name: javascript" /tmp/smoke/.github/settings.yml; else absent "name: javascript" /tmp/smoke/.github/settings.yml; fi
  if has deno; then present_line "  - name: deno" /tmp/smoke/.github/settings.yml; else absent "name: deno" /tmp/smoke/.github/settings.yml; fi
  if has uv; then present_line '  - name: "python:uv"' /tmp/smoke/.github/settings.yml; else absent 'name: "python:uv"' /tmp/smoke/.github/settings.yml; fi
  if has rust; then present_line "  - name: rust" /tmp/smoke/.github/settings.yml; else absent "name: rust" /tmp/smoke/.github/settings.yml; fi
fi
if has release-please; then
  test -f "$wf/release-please.yml"
  test -f "$wf/release.yml"
  present "uses: ./.github/workflows/release.yml" "$wf/ci.yml"
  # The freshness gate must render as a job AND sit in all-green's needs;
  # losing either fragment would fail open silently.
  present "release-freshness:" "$wf/ci.yml"
  present "      - release-freshness" "$wf/ci.yml"
  # The release-health gate likewise: the PR-time job in ci.yml (exact
  # indented lines - the header comments also say release-health) plus the
  # authoritative pre-flight on the release path. Modes are pinned as whole
  # lines so a flipped mode cannot pass, and the fuzz-label assert pins the
  # exact tojson-quoted default so an unquoted or empty render fails too.
  present_line "  release-health:" "$wf/ci.yml"
  present_line "      - release-health" "$wf/ci.yml"
  present "release-health@main" "$wf/ci.yml"
  present "release-health@main" "$wf/release-please.yml"
  present_line "          mode: pull-request" "$wf/ci.yml"
  present_line "          mode: release" "$wf/release-please.yml"
  if has fuzzer; then
    present_line '          fuzz-label: "fuzz-nightly"' "$wf/ci.yml"
    present_line '          fuzz-label: "fuzz-nightly"' "$wf/release-please.yml"
  else
    absent "fuzz-label:" "$wf/ci.yml"
    absent "fuzz-label:" "$wf/release-please.yml"
  fi
  test -f /tmp/smoke/release-please-config.json
  test -f /tmp/smoke/.release-please-manifest.json
  # Every render carries the full three-step draft flow: the update hook
  # between the draft and the publish, and the publish job last, each
  # needing everything before it.
  present "update-release:" "$wf/release.yml"
  present "publish-release:" "$wf/release.yml"
  present "needs: [release-please]" "$wf/release.yml"
  present "needs: [release-please, update-release]" "$wf/release.yml"
else
  test ! -e "$wf/release-please.yml"
  test ! -e "$wf/release.yml"
  absent "uses: ./.github/workflows/release.yml" "$wf/ci.yml"
  absent "release-freshness" "$wf/ci.yml"
  absent_line "  release-health:" "$wf/ci.yml"
  absent_line "      - release-health" "$wf/ci.yml"
  # fuzz-label only rides in the release-please fragments, so even a
  # fuzzer-selected render must not carry it without release-please.
  absent "fuzz-label:" "$wf/ci.yml"
  test ! -e /tmp/smoke/release-please-config.json
  test ! -e /tmp/smoke/.release-please-manifest.json
fi

# auto-format follows the toolchain modules; its formatter steps, like the
# checks.yml example comments, are spliced from the toolchain module
# fragments. Formatter markers are command-specific: a bare "biome" would
# false-positive between the bun and node steps.
if has bun; then present "Example bun checks" "$wf/checks.yml"; else absent "Example bun checks" "$wf/checks.yml"; fi
if has node; then present "Example node checks" "$wf/checks.yml"; else absent "Example node checks" "$wf/checks.yml"; fi
if has deno; then present "Example deno checks" "$wf/checks.yml"; else absent "Example deno checks" "$wf/checks.yml"; fi
if has uv; then present "Example uv checks" "$wf/checks.yml"; else absent "Example uv checks" "$wf/checks.yml"; fi
if has_codeql_toolchain; then
  test -f "$wf/auto-format.yml"
  if has bun; then present "bun x @biomejs/biome" "$wf/auto-format.yml"; else absent "bun x @biomejs/biome" "$wf/auto-format.yml"; fi
  if has node; then present "npx --yes @biomejs/biome" "$wf/auto-format.yml"; else absent "npx --yes @biomejs/biome" "$wf/auto-format.yml"; fi
  if has deno; then present "deno fmt" "$wf/auto-format.yml"; else absent "deno fmt" "$wf/auto-format.yml"; fi
  if has uv; then present "ruff" "$wf/auto-format.yml"; else absent "ruff" "$wf/auto-format.yml"; fi
else
  test ! -e "$wf/auto-format.yml"
fi

# The bun module's Dependabot lockfile fixer is managed machinery (always
# overwritten by sync, unlike the repo-owned auto-format starter above): it
# regenerates bun.lock on Dependabot PRs and pushes the fix.
if has bun; then
  test -f "$wf/dependabot-bun-lockfile.yml"
  present "bun install --lockfile-only" "$wf/dependabot-bun-lockfile.yml"
  present "github.actor == 'dependabot[bot]'" "$wf/dependabot-bun-lockfile.yml"
  present "REPO_PLATFORM_TOKEN || github.token" "$wf/dependabot-bun-lockfile.yml"
else
  test ! -e "$wf/dependabot-bun-lockfile.yml"
fi

# copilot-setup-steps belongs to the agents module; the toolchain installs
# inside it splice from the toolchain module fragments.
if has agents; then
  test -f "$wf/copilot-setup-steps.yml"
  if has bun; then present "oven-sh/setup-bun" "$wf/copilot-setup-steps.yml"; else absent "oven-sh/setup-bun" "$wf/copilot-setup-steps.yml"; fi
  if has node; then present "actions/setup-node" "$wf/copilot-setup-steps.yml"; else absent "actions/setup-node" "$wf/copilot-setup-steps.yml"; fi
  if has deno; then present "denoland/setup-deno" "$wf/copilot-setup-steps.yml"; else absent "denoland/setup-deno" "$wf/copilot-setup-steps.yml"; fi
  if has uv; then present "astral-sh/setup-uv" "$wf/copilot-setup-steps.yml"; else absent "astral-sh/setup-uv" "$wf/copilot-setup-steps.yml"; fi
else
  test ! -e "$wf/copilot-setup-steps.yml"
fi

# Managed ci.yml is always generated (repo checks live in the repo-owned
# checks.yml it calls); the validator asserts the all-green shape, so only
# check the wiring and the composite-action pin falling back to main here
# (scratch build tree: _commit is a bare sha, not a templates/vX.Y.Z tag).
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

# The per-repo sync caller is gone: template updates are pushed by
# repo-platform's sync-repos workflow, so no sync workflow may render.
test ! -e "$wf/template-sync.yml"
# Channel is recorded in copier's answers (a row can override to staging
# via EXTRA_DATA; every other row takes the latest default).
case "$EXTRA_DATA" in
  *channel=staging*) present "channel: staging" /tmp/smoke/.copier-answers.yml ;;
  *) present "channel: latest" /tmp/smoke/.copier-answers.yml ;;
esac

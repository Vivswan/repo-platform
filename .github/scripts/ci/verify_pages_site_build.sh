#!/usr/bin/env bash
# Build the pages-site action's vitepress path end to end against a scratch
# fixture repository, in the runner-shaped directory topology (workspace,
# action checkout, and RUNNER_TEMP in three separate trees). This is the
# gate for the class `bun run check` cannot see: the build works only when
# the docs tree is materialized inside the build root, because the pages'
# own SSR imports resolve by walking up from the SOURCE files - a srcDir
# outside the root never reaches the action's node_modules on real runners
# even though it can accidentally work on a laptop where the repo sits
# near the dependencies.
#
# Asserts, on the assembled artifact: the versioned tier layout, content
# isolation between tiers, the locale build with carbon's translations
# menu, the version switcher, a carbon token in the built CSS (the base
# theme actually applied, not a silent default-theme fallback), llms.txt,
# and the strict CHECK mode both passing on clean docs and failing on a
# dead link.
#
# Needs bun and git on PATH and the action's dependencies installed
# (bun install --frozen-lockfile --cwd actions/pages-site).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BUILD_TS="$REPO_ROOT/actions/pages-site/build.ts"

tmp_root="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "${tmp_root%/}/pages-site-fixture.XXXXXX")"
TEMP_REAL="$(mktemp -d "${tmp_root%/}/pages-site-temp.XXXXXX")"
ALIAS_DIR="$(mktemp -d "${tmp_root%/}/pages-site-alias.XXXXXX")"
# RUNNER_TEMP is handed over through a SYMLINK on purpose: the build must
# realpath its scratch base (macOS /tmp is such an alias), or the build
# root exists under two spellings and vitepress's path-keyed route
# resolution reports every internal link dead.
TEMP="$ALIAS_DIR/alias"
ln -s "$TEMP_REAL" "$TEMP"
WORK2="$(mktemp -d "${tmp_root%/}/pages-site-nested.XXXXXX")"
CMD_WORK="$(mktemp -d "${tmp_root%/}/pages-site-command.XXXXXX")"
CMD_ALLSKIP="$(mktemp -d "${tmp_root%/}/pages-site-allskip.XXXXXX")"
CMD_PATHBIN="$(mktemp -d "${tmp_root%/}/pages-site-pathbin.XXXXXX")"
trap 'rm -rf "$WORK" "$WORK2" "$CMD_WORK" "$CMD_ALLSKIP" "$CMD_PATHBIN" "$TEMP_REAL" "$ALIAS_DIR"' EXIT

fail() { echo "::error::pages-site build check failed: $1"; exit 1; }
present() { grep -qF -- "$1" "$2" || fail "'$1' is missing from $2"; }
absent() { if grep -qF -- "$1" "$2"; then fail "'$1' should not be in $2"; fi; }

# --- fixture: two tagged versions, a HEAD-only edit, and a zh-cn locale
# tree added after v0.1.0 (so the locale must appear in latest and v0.2.0
# but not v0.1.0 - per-version locale detection).
mkdir -p "$WORK/docs/guide"
printf '# Fixture\n\nWelcome. See the [guide](guide/) and [setup](setup).\n' > "$WORK/docs/README.md"
printf '# Setup\n\nInstall things.\n' > "$WORK/docs/setup.md"
printf '# Guide\n\nThe guide index, version one.\n' > "$WORK/docs/guide/README.md"
git -C "$WORK" init -q -b main
git -C "$WORK" -c user.name=fixture -c user.email=f@localhost add -A
git -C "$WORK" -c user.name=fixture -c user.email=f@localhost commit -qm "v1 docs"
git -C "$WORK" tag v0.1.0
mkdir -p "$WORK/docs/zh-cn"
printf '# Fixture zh\n\nlocale landing page\n' > "$WORK/docs/zh-cn/README.md"
printf 'Second version line.\n' >> "$WORK/docs/guide/README.md"
git -C "$WORK" -c user.name=fixture -c user.email=f@localhost add -A
git -C "$WORK" -c user.name=fixture -c user.email=f@localhost commit -qm "v2 docs + locale"
git -C "$WORK" tag v0.2.0
printf 'HEAD-only line.\n' >> "$WORK/docs/setup.md"
git -C "$WORK" -c user.name=fixture -c user.email=f@localhost add -A
git -C "$WORK" -c user.name=fixture -c user.email=f@localhost commit -qm "head docs"

# --- the versioned build, runner-shaped topology.
env GITHUB_WORKSPACE="$WORK" GITHUB_REPOSITORY=fixture-owner/fixture-repo \
  RUNNER_TEMP="$TEMP" SITE_TITLE="Fixture Docs" GITHUB_OUTPUT="" \
  MOUNTS='[{"path": "/", "source": "vitepress", "versioned": true}]' \
  bun "$BUILD_TS" || fail "the versioned build exited nonzero"

site="$TEMP_REAL/pages-site/_site"
test -d "$site" || fail "no assembled _site under RUNNER_TEMP"

# Tier layout: root = newest tag, latest = HEAD, one dir per tag, index.
for path in index.html latest/index.html v0.1.0/index.html v0.2.0/index.html versions.json llms.txt latest/llms.txt; do
  test -f "$site/$path" || fail "missing $path in the assembled site"
done
present '"label": "latest"' "$site/versions.json"
present '"label": "v0.2.0"' "$site/versions.json"

# Content isolation: the HEAD-only edit exists in latest alone, and the
# v0.2.0 guide line reached the root copy (root serves the newest tag).
present "HEAD-only line" "$site/latest/setup.html"
absent "HEAD-only line" "$site/setup.html"
absent "HEAD-only line" "$site/v0.2.0/setup.html"
present "Second version line" "$site/guide/index.html"
absent "Second version line" "$site/v0.1.0/guide/index.html"

# Locales: zh-cn renders where its tree exists (latest, v0.2.0), with
# carbon's translations menu in the nav; v0.1.0 predates the locale.
present "locale landing page" "$site/latest/zh-cn/index.html"
test -f "$site/v0.2.0/zh-cn/index.html" || fail "v0.2.0 lost its locale tree"
test ! -e "$site/v0.1.0/zh-cn" || fail "v0.1.0 grew a locale tree its tag never had"
present "VPNavBarTranslations" "$site/latest/index.html"

# The version switcher and the carbon skin. The token hex is stable
# because vitepress-carbon is pinned EXACT in the action's package.json -
# a carbon bump that moves its brand token should update this pin note.
present "docs-site-version-switcher" "$site/latest/index.html"
grep -qrF -- "58a6ff" "$site/latest/assets" || fail "carbon's brand token is missing from the built CSS - the base theme did not apply"

# A NESTED docs-dir (multi-segment input): tag extraction must land the
# leaf tree at the build root's fixed docs/ slot whatever its depth, for
# the tagged tier and the HEAD tier alike.
mkdir -p "$WORK2/site/manual"
printf '# Nested\n\nnested landing page\n' > "$WORK2/site/manual/README.md"
git -C "$WORK2" init -q -b main
git -C "$WORK2" -c user.name=fixture -c user.email=f@localhost add -A
git -C "$WORK2" -c user.name=fixture -c user.email=f@localhost commit -qm "nested docs"
git -C "$WORK2" tag v1.0.0
env GITHUB_WORKSPACE="$WORK2" GITHUB_REPOSITORY=fixture-owner/nested-repo \
  RUNNER_TEMP="$TEMP" DOCS_DIR=site/manual GITHUB_OUTPUT="" \
  MOUNTS='[{"path": "/", "source": "vitepress", "versioned": true}]' \
  bun "$BUILD_TS" >/dev/null || fail "the versioned build failed with a nested docs-dir (site/manual)"
present "nested landing page" "$TEMP_REAL/pages-site/_site/index.html"
present "nested landing page" "$TEMP_REAL/pages-site/_site/latest/index.html"

# CHECK mode: green on clean docs, red on a dead internal link.
env GITHUB_WORKSPACE="$WORK" GITHUB_REPOSITORY=fixture-owner/fixture-repo \
  RUNNER_TEMP="$TEMP" CHECK=true bun "$BUILD_TS" || fail "CHECK mode failed on clean docs"
printf '\nA [dead link](missing-page).\n' >> "$WORK/docs/setup.md"
if env GITHUB_WORKSPACE="$WORK" GITHUB_REPOSITORY=fixture-owner/fixture-repo \
  RUNNER_TEMP="$TEMP" CHECK=true bun "$BUILD_TS" >/dev/null 2>&1; then
  fail "CHECK mode passed docs carrying a dead internal link - the strict build is unarmed"
fi

# The DEPLOY path's strictness wiring, both arms: a dead link sealed into
# a tag builds lenient (history cannot be fixed), while the same rot on
# HEAD fails the whole deploy - hardcoding strictness either way in the
# builder turns exactly one of these two runs the wrong color.
git -C "$WORK" -c user.name=fixture -c user.email=f@localhost add -A
git -C "$WORK" -c user.name=fixture -c user.email=f@localhost commit -qm "seal a dead link into history"
git -C "$WORK" tag v0.3.0
git -C "$WORK" -c user.name=fixture -c user.email=f@localhost revert --no-edit HEAD >/dev/null
env GITHUB_WORKSPACE="$WORK" GITHUB_REPOSITORY=fixture-owner/fixture-repo \
  RUNNER_TEMP="$TEMP" SITE_TITLE="Fixture Docs" GITHUB_OUTPUT="" \
  MOUNTS='[{"path": "/", "source": "vitepress", "versioned": true}]' \
  bun "$BUILD_TS" >/dev/null || fail "the deploy refused a dead link sealed in a historical tag (tags must build lenient)"
printf '\nA [dead link](missing-page).\n' >> "$WORK/docs/setup.md"
if env GITHUB_WORKSPACE="$WORK" GITHUB_REPOSITORY=fixture-owner/fixture-repo \
  RUNNER_TEMP="$TEMP" SITE_TITLE="Fixture Docs" GITHUB_OUTPUT="" \
  MOUNTS='[{"path": "/", "source": "vitepress", "versioned": true}]' \
  bun "$BUILD_TS" >/dev/null 2>&1; then
  fail "the deploy shipped a dead link on HEAD - the strict-HEAD wiring is unarmed"
fi

# --- command mounts and legacy tags: a tag from before the build script
# existed is structurally unbuildable FOREVER, so the deploy must skip it
# with a notice (and leave it out of versions.json) instead of failing
# every run; a tag that HAS the script but whose build errors must still
# fail the deploy loudly - that distinction is the correctness line.
commit_cmd() { # repo, message
  git -C "$1" -c user.name=fixture -c user.email=f@localhost add -A
  git -C "$1" -c user.name=fixture -c user.email=f@localhost commit -qm "$2"
}
printf '{"name": "cmd-fixture", "scripts": {"test": "true"}}\n' > "$CMD_WORK/package.json"
git -C "$CMD_WORK" init -q -b main
commit_cmd "$CMD_WORK" "before the site existed"
git -C "$CMD_WORK" tag v1.0.0
printf '{"name": "cmd-fixture", "scripts": {"build:site": "mkdir -p dist && echo SCRIPT-ERA > dist/index.html"}}\n' > "$CMD_WORK/package.json"
commit_cmd "$CMD_WORK" "add the site build"
git -C "$CMD_WORK" tag v1.1.0
# A tag whose package.json is a SYMLINK: bun follows it at build time, so
# the probe must stay inconclusive and BUILD this tag, never skip it. The
# link's TARGET is a file literally named '{"scripts": {}}' - target text
# that parses as script-less JSON - so a mode-blind reader that judges the
# link text as content would falsely skip this tag.
link_target='{"scripts": {}}'
printf '{"name": "cmd-fixture", "scripts": {"build:site": "mkdir -p dist && echo LINK-ERA > dist/index.html"}}\n' > "$CMD_WORK/$link_target"
rm "$CMD_WORK/package.json"
ln -s "$link_target" "$CMD_WORK/package.json"
commit_cmd "$CMD_WORK" "symlinked package.json"
git -C "$CMD_WORK" tag v1.1.1
rm "$CMD_WORK/package.json" "$CMD_WORK/$link_target"
printf '{"name": "cmd-fixture", "scripts": {"build:site": "mkdir -p dist && echo HEAD-ERA > dist/index.html"}}\n' > "$CMD_WORK/package.json"
commit_cmd "$CMD_WORK" "head-only build output"

cmd_log="$CMD_WORK/deploy.log"
env GITHUB_WORKSPACE="$CMD_WORK" GITHUB_REPOSITORY=fixture-owner/cmd-repo \
  RUNNER_TEMP="$TEMP" GITHUB_OUTPUT="" \
  MOUNTS='[{"path": "/", "source": "command", "versioned": true}]' \
  BUILD_COMMAND='bun run build:site' \
  bun "$BUILD_TS" > "$cmd_log" 2>&1 || { cat "$cmd_log"; fail "the command-mount deploy failed on a pre-script tag it should skip"; }
site="$TEMP_REAL/pages-site/_site"
present "::notice::site version v1.0.0 skipped" "$cmd_log"
test ! -e "$site/v1.0.0" || fail "the pre-script tag v1.0.0 landed in the site instead of skipping"
present "SCRIPT-ERA" "$site/v1.1.0/index.html"
present "LINK-ERA" "$site/v1.1.1/index.html"
present "LINK-ERA" "$site/index.html"
present "HEAD-ERA" "$site/latest/index.html"
absent "HEAD-ERA" "$site/index.html"
present '"label": "v1.1.1"' "$site/versions.json"
present '"label": "v1.1.0"' "$site/versions.json"
absent '"label": "v1.0.0"' "$site/versions.json"

# A declared-but-failing build stays FATAL: seal a broken script into a
# tag (HEAD then reverts to good), and the deploy must go red on it.
printf '{"name": "cmd-fixture", "scripts": {"build:site": "exit 1"}}\n' > "$CMD_WORK/package.json"
commit_cmd "$CMD_WORK" "seal a broken build into history"
git -C "$CMD_WORK" tag v1.2.0
git -C "$CMD_WORK" -c user.name=fixture -c user.email=f@localhost revert --no-edit HEAD >/dev/null
if env GITHUB_WORKSPACE="$CMD_WORK" GITHUB_REPOSITORY=fixture-owner/cmd-repo \
  RUNNER_TEMP="$TEMP" GITHUB_OUTPUT="" \
  MOUNTS='[{"path": "/", "source": "command", "versioned": true}]' \
  BUILD_COMMAND='bun run build:site' \
  bun "$BUILD_TS" >/dev/null 2>&1; then
  fail "the deploy went green over a tag whose declared build script fails - the skip must stay structural"
fi

# Every tag pre-script: the root falls back to the redirect-to-latest
# layout instead of failing, versions.json carries latest alone.
printf '{"name": "allskip-fixture"}\n' > "$CMD_ALLSKIP/package.json"
git -C "$CMD_ALLSKIP" init -q -b main
commit_cmd "$CMD_ALLSKIP" "before the site existed"
git -C "$CMD_ALLSKIP" tag v0.9.0
printf '{"name": "allskip-fixture", "scripts": {"build:site": "mkdir -p dist && echo ALLSKIP-HEAD > dist/index.html"}}\n' > "$CMD_ALLSKIP/package.json"
commit_cmd "$CMD_ALLSKIP" "add the site build"
env GITHUB_WORKSPACE="$CMD_ALLSKIP" GITHUB_REPOSITORY=fixture-owner/allskip-repo \
  RUNNER_TEMP="$TEMP" GITHUB_OUTPUT="" \
  MOUNTS='[{"path": "/", "source": "command", "versioned": true}]' \
  BUILD_COMMAND='bun run build:site' \
  bun "$BUILD_TS" >/dev/null 2>&1 || fail "the deploy failed when every tag pre-dates the build script (root must redirect to latest)"
site="$TEMP_REAL/pages-site/_site"
present "url=./latest/" "$site/index.html"
present "ALLSKIP-HEAD" "$site/latest/index.html"
present '"label": "latest"' "$site/versions.json"
absent '"label": "v0.9.0"' "$site/versions.json"

# The HEAD calibration gate: a probeable command HEAD never declares (it
# resolves through a PATH executable here) must not arm skipping - every
# tag keeps building, scripts-less package.json and all.
mkdir -p "$CMD_PATHBIN/bin" "$CMD_PATHBIN/repo"
printf '#!/usr/bin/env bash\nmkdir -p dist && echo PATH-ERA > dist/index.html\n' > "$CMD_PATHBIN/bin/makedist"
chmod +x "$CMD_PATHBIN/bin/makedist"
printf '{"name": "pathbin-fixture", "scripts": {}}\n' > "$CMD_PATHBIN/repo/package.json"
git -C "$CMD_PATHBIN/repo" init -q -b main
commit_cmd "$CMD_PATHBIN/repo" "no script anywhere"
git -C "$CMD_PATHBIN/repo" tag v0.1.0
pathbin_log="$CMD_PATHBIN/deploy.log"
env PATH="$CMD_PATHBIN/bin:$PATH" GITHUB_WORKSPACE="$CMD_PATHBIN/repo" \
  GITHUB_REPOSITORY=fixture-owner/pathbin-repo RUNNER_TEMP="$TEMP" GITHUB_OUTPUT="" \
  MOUNTS='[{"path": "/", "source": "command", "versioned": true}]' \
  BUILD_COMMAND='bun run makedist' \
  bun "$BUILD_TS" > "$pathbin_log" 2>&1 || { cat "$pathbin_log"; fail "the PATH-resolved deploy failed - the calibration gate must keep every tag building"; }
site="$TEMP_REAL/pages-site/_site"
present "PATH-ERA" "$site/v0.1.0/index.html"
absent "::notice::site version" "$pathbin_log"

echo "pages-site build check passed: tiers, locales, switcher, carbon skin, llms.txt, strict mode both arms, legacy-tag skip both arms, calibration gate"

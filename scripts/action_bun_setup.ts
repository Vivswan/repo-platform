// The bun setup steps generate.ts renders into every bun-running action.yml.
// A relative `uses:` inside a composite action resolves against the CALLER's
// workspace, so the steps cannot live in one shared action.

/** What the BEGIN markers tell editors to edit instead of the region. */
export const BUN_SETUP_SOURCES = "scripts/action_bun_setup.ts";

/** The action-local generated .bun-version both setup steps read, never the
 *  CALLING repository's dotfile. */
export const ACTION_BUN_PIN = "${{ github.action_path }}/.bun-version";

/** The step id every later step binds its ACTION_BUN env to
 *  (`steps.action-bun.outputs.path`). */
export const RESOLVER_STEP_ID = "action-bun";

/** The actions whose setup must never end the action: the retry may fail and
 *  the resolver exports `ready`, so their own report step still runs. */
export const READY_OUTPUT_ACTIONS: ReadonlySet<string> = new Set([
  "actions/validate-template-report/action.yml",
]);

export type BunSetupVariant = "bun-setup" | "bun-setup-ready";

/** The region name an action.yml carries; the name makes the variant
 *  visible where the steps are read. */
export function bunSetupRegionName(file: string): BunSetupVariant {
  return READY_OUTPUT_ACTIONS.has(file) ? "bun-setup-ready" : "bun-setup";
}

/** The region body at `indent`, the column the action's step list sits at
 *  (generate.ts detects it, so the rendered steps join that list). */
export function bunSetupSteps(variant: BunSetupVariant, indent: number): string[] {
  const ready = variant === "bun-setup-ready";
  const retryTail = ready
    ? [
        "  # A second failure must not end the action before its report step:",
        "  # the resolver below turns the missing bun into ready=false.",
        "  continue-on-error: true",
      ]
    : [];
  const resolver = ready
    ? [
        "# A bun is ready only as an absolute path that prints the pinned",
        "# version and exits 0; later steps gate on `ready` and run `path`,",
        "# never `bun` through PATH, where a later setup-bun can put another",
        "# bun first.",
        "- name: Resolve the action's bun",
        `  id: ${RESOLVER_STEP_ID}`,
        "  shell: bash",
        "  env:",
        `    PIN_FILE: ${ACTION_BUN_PIN}`,
        "  run: |",
        '    pin="$(cat "$PIN_FILE")"',
        '    path="$(command -v bun || true)"',
        '    case "$path" in /*) ;; *) path="" ;; esac',
        '    have=""',
        '    if [ -n "$path" ]; then have="$("$path" --version 2>/dev/null)" || have=""; fi',
        '    if [ -z "$pin" ] || [ "$have" != "$pin" ]; then path=""; fi',
        '    echo "path=$path" >> "$GITHUB_OUTPUT"',
        '    echo "ready=$([ -n "$path" ] && echo true || echo false)" >> "$GITHUB_OUTPUT"',
      ]
    : [
        "# Recorded once after the setup: later steps run this path, never `bun`",
        "# through PATH, where a later setup-bun can put another bun first.",
        "- name: Resolve the action's bun",
        `  id: ${RESOLVER_STEP_ID}`,
        "  shell: bash",
        '  run: echo "path=$(command -v bun)" >> "$GITHUB_OUTPUT"',
      ];
  const lines = [
    "- name: Check for a bun matching the action's pin",
    "  id: bun",
    "  shell: bash",
    "  run: |",
    `    pin="$(cat "${ACTION_BUN_PIN}")"`,
    '    have="$(command -v bun >/dev/null && bun --version || true)"',
    '    echo "pinned=$([ "$have" = "$pin" ] && echo true || echo false)" >> "$GITHUB_OUTPUT"',
    "",
    "# Skipped only when the caller's bun already IS the pinned version",
    "# (reuse then just skips a second network fetch): the action's scripts",
    "# and lockfile run on the action-local .bun-version pin (generated",
    "# from the manifests' bun pin), never on whatever the CALLER resolves",
    "# - a caller pinning an older bun cannot parse the lockfiles",
    "# repo-platform's bun writes.",
    "- name: Set up bun",
    "  id: setup-bun",
    "  if: steps.bun.outputs.pinned != 'true'",
    "  continue-on-error: true",
    "  uses: oven-sh/setup-bun@v2",
    "  with:",
    `    bun-version-file: ${ACTION_BUN_PIN}`,
    "",
    "# One retry: the setup's network fetch is a known transient flake, and",
    "# on nightly paths a flake here turns a green night red.",
    "- name: Set up bun (retry)",
    "  id: setup-bun-retry",
    "  if: steps.setup-bun.outcome == 'failure'",
    "  uses: oven-sh/setup-bun@v2",
    "  with:",
    `    bun-version-file: ${ACTION_BUN_PIN}`,
    ...retryTail,
    "",
    ...resolver,
  ];
  const pad = " ".repeat(indent);
  return lines.map((line) => (line === "" ? "" : `${pad}${line}`));
}

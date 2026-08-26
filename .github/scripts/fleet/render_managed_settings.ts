#!/usr/bin/env bun
// The managed settings baseline, computed per repository at apply time.
// This module is the single source of the fleet's settings policy: the
// repository field block every repo shares, the full label roster a
// repo's module selection requires, and the fleet-generic rulesets. The
// settings-sync template's rendered .github/settings.yml is a repo-owned
// STARTER carrying only identity keys and local overrides; the baseline
// is never synced into client repos - settings-repos.yml (and the
// self-apply in reusable-apply-settings.yml) computes it here and
// merge_settings_layers.ts merges the repo's own file over it.
//
// Consumers beyond the apply paths: scripts/generate.ts derives the
// tracking-label validators' reserved-label roster from managedLabelNames,
// scripts/check_ssot.ts anchors its label/ruleset rules here, and the
// sync's settings_layering.ts shadow-diff renders each repo's baseline to
// name the keys its settings.yml shadows.
//
// Inputs are repo facts: the module selection (the target repo's
// .repo-platform.yml - selecting the settings-sync module there is the
// opt-in), live visibility (private repositories reject
// security_and_analysis and the code_scanning rule with a 422), and the
// tracking-label answers recorded in .copier-answers.yml (each stream
// repo picks its own label name; the color/description tuples live in
// the module manifests).
//
// CLI (the apply paths):
//   bun .github/scripts/fleet/render_managed_settings.ts --repo owner/name
//     --out managed.yml [--target-dir <checkout>]
//
// Without --target-dir the facts come from the target repository's default
// branch via gh api plus a live visibility probe (env: GH_TOKEN). The
// operator repo itself (GITHUB_REPOSITORY) is the one repo with no
// .repo-platform.yml - it is not generated from the template - so fetching
// it reads module selection and visibility from .repo-platform-answers.yml
// in the cwd instead. --target-dir reads the facts from a local checkout
// (recorded answers; no network).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { dependabotLabels } from "../../../scripts/compose_template.ts";
import { loadManifests, type ModuleManifest } from "../../../scripts/module_manifests.ts";
import { ANSWERS_FILE, parseAnswers } from "../../../scripts/render_dogfood.ts";
import { parseFlags } from "../shared/flags.ts";
import { env, fail } from "../shared/gha.ts";
import { captureNetwork } from "./discovery.ts";

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface RepoFacts {
  /** The target's module selection (its .repo-platform.yml list). */
  modules: string[];
  /** Live visibility: private repos reject the public-only blocks. */
  private: boolean;
  /** Resolved tracking-label answers, one per SELECTED stream module. */
  trackingLabels: { module: string; label: string }[];
}

/** The repository policy block every managed repo shares (previously
 *  settings/defaults.yml; identity keys - description, homepage, topics,
 *  private - stay in each repo's own settings.yml). */
export function policyBlock(): Record<string, unknown> {
  return {
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    has_discussions: false,
    default_branch: "main",
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    // The squash subject must ALWAYS be the PR title (the pr-title check
    // and release-please rely on it); GitHub only defaults to that for
    // single-commit PRs.
    squash_merge_commit_title: "PR_TITLE",
    squash_merge_commit_message: "PR_BODY",
    allow_update_branch: true,
    delete_branch_on_merge: true,
    allow_auto_merge: true,
    enable_vulnerability_alerts: true,
    enable_automated_security_fixes: true,
  };
}

/** Declared so the apply heals out-of-band disables (GitHub enables both
 *  by default on public repositories). Public only: private repositories
 *  without Advanced Security reject this block (422). */
export function securityAndAnalysis(): Record<string, unknown> {
  return {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
  };
}

/** The unconditional labels: dependabot's base pair (the base
 *  dependabot.yml always carries the github-actions ecosystem, and
 *  dependabot recreates its labels when missing, so leaving either
 *  undeclared would loop delete/recreate nightly) plus the conventional
 *  triage trio. */
export function staticLabels(): Label[] {
  return [
    { name: "dependencies", color: "0366d6", description: "Dependency updates" },
    {
      name: "github_actions",
      color: "000000",
      description: "Pull requests that update GitHub Actions code",
    },
    { name: "bug", color: "d73a4a", description: "Something isn't working" },
    { name: "enhancement", color: "a2eeef", description: "New feature or request" },
    { name: "fix-lint", color: "fbca04", description: "Lint / formatting fixes" },
  ];
}

/** The release-please module's labels: the autorelease pair release-please
 *  manages on release PRs, and release-health's gate labels (an open
 *  release-blocker issue fails the release PR and the release pipeline's
 *  pre-flight; release-override on the release PR bypasses the gates for
 *  that one release). */
export function releasePleaseLabels(): Label[] {
  return [
    {
      name: "autorelease: pending",
      color: "ededed",
      description: "release-please release PR awaiting merge/tag",
    },
    {
      name: "autorelease: tagged",
      color: "ededed",
      description: "release-please release PR has been tagged",
    },
    {
      name: "release-blocker",
      color: "B60205",
      description:
        "Blocks releases while open - release-health fails release PRs and the release pipeline",
    },
    {
      name: "release-override",
      color: "FBCA04",
      description: "On a release PR: bypass release-health gates for this release",
    },
  ];
}

/** The marker label github-settings-as-code's private reporting pins its
 *  report issue with. The central apply redacts private targets and
 *  injects the label into its managed set automatically; the settings-sync
 *  self-apply is never redacted and injects nothing - so the baseline
 *  declares it for private repos, keeping the self-apply from deleting
 *  what the next central run recreates. */
export function privateReportLabel(): Label {
  return {
    name: "settings-as-code-report",
    color: "0e2a47",
    description: "managed by settings-as-code private reporting - do not remove",
  };
}

/** Every label name this generator can emit for ANY selection, tracking
 *  labels excluded (those render from the very answers the copier
 *  validators check). scripts/generate.ts builds the reserved-label
 *  roster from this. */
export function managedLabelNames(manifests: ModuleManifest[]): string[] {
  return [
    ...staticLabels().map((label) => label.name),
    privateReportLabel().name,
    ...releasePleaseLabels().map((label) => label.name),
    ...dependabotLabels(manifests).map((label) => label.name),
  ];
}

/** The full label roster a repo's facts require. Order is stable:
 *  static, per-module dependabot labels, the private report marker, the
 *  release-please labels, tracking labels - a superset-shaped echo of the
 *  retired settings.yml.jinja render, so existing repos' shadow diffs
 *  read as byte-equal. */
export function managedLabels(facts: RepoFacts, manifests: ModuleManifest[]): Label[] {
  const labels = staticLabels();
  for (const group of dependabotLabels(manifests)) {
    if (group.modules.some((module) => facts.modules.includes(module))) {
      labels.push({ name: group.name, color: group.color, description: group.description });
    }
  }
  if (facts.private) labels.push(privateReportLabel());
  if (facts.modules.includes("release-please")) labels.push(...releasePleaseLabels());
  const byModule = new Map(manifests.map((m) => [m.module, m]));
  for (const { module, label } of facts.trackingLabels) {
    const tracking = byModule.get(module)?.tracking_label;
    if (!tracking) {
      throw new Error(
        `tracking label recorded for '${module}', but templates/${module}/module.yml ` +
          "declares no tracking_label - the facts and the manifests disagree",
      );
    }
    labels.push({ name: label, color: tracking.color, description: tracking.description });
  }
  return labels;
}

/** copier.yml's computed enable_codeql from the same inputs: a public
 *  repository with at least one selected toolchain module. */
export function enableCodeql(facts: RepoFacts, manifests: ModuleManifest[]): boolean {
  return (
    !facts.private &&
    manifests.some((m) => m.toolchain !== undefined && facts.modules.includes(m.module))
  );
}

const ADMIN_BYPASS = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
const DEFAULT_BRANCH_CONDITIONS = { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } };

/** The fleet-generic rulesets for a repo's facts. Admins (RepositoryRole
 *  id 5) are in the main ruleset's bypass list, so direct pushes to main
 *  still work; the single required status check is `all-green`, which
 *  `needs:` every gating CI job. */
export function managedRulesets(
  facts: RepoFacts,
  manifests: ModuleManifest[],
): Record<string, unknown>[] {
  const rulesets: Record<string, unknown>[] = [
    {
      name: "main",
      target: "branch",
      enforcement: "active",
      conditions: DEFAULT_BRANCH_CONDITIONS,
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "required_linear_history" },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: true,
            required_status_checks: [{ context: "all-green" }],
          },
        },
        // GitHub rejects the code_scanning rule on repos CodeQL does not
        // analyze (private personal repos, no analyzable toolchain).
        ...(enableCodeql(facts, manifests)
          ? [
              {
                type: "code_scanning",
                parameters: {
                  code_scanning_tools: [
                    {
                      tool: "CodeQL",
                      security_alerts_threshold: "high_or_higher",
                      alerts_threshold: "errors",
                    },
                  ],
                },
              },
            ]
          : []),
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: false,
            // Require an approving review from a CODEOWNER before merge.
            // Admins in bypass_actors can still merge without one.
            require_code_owner_review: true,
            require_last_push_approval: false,
            // Every PR review thread must be resolved before merge, fleet
            // wide - an unresolved comment is an unaddressed finding.
            required_review_thread_resolution: true,
            // Squash-only merges (enforced by the ruleset, not just repo
            // settings).
            allowed_merge_methods: ["squash"],
          },
        },
        // Automatically request Copilot code review on PRs to main,
        // including on each new push and on draft PRs.
        {
          type: "copilot_code_review",
          parameters: { review_on_push: true, review_draft_pull_requests: true },
        },
      ],
      bypass_actors: ADMIN_BYPASS,
    },
    // Rules with an EMPTY bypass list: nobody - owner and admins included -
    // can violate these on the default branch. A separate ruleset so the
    // main ruleset's admin bypass (which keeps direct pushes working)
    // cannot exempt anyone from these rules. The explicit empty list is
    // deliberate: an omitted key is invisible to drift detection and
    // preserved by the update, so the empty list is what lets the nightly
    // apply heal an out-of-band bypass actor.
    {
      name: "non-bypassable",
      target: "branch",
      enforcement: "active",
      conditions: DEFAULT_BRANCH_CONDITIONS,
      rules: [{ type: "deletion" }, { type: "required_linear_history" }],
      bypass_actors: [],
    },
  ];
  if (facts.modules.includes("release-please")) {
    // vX.Y.Z release tags are immutable: repo-platform's push sync pins
    // against them and release artifacts reference them. Admins bypass, so
    // deliberate tag cleanup doesn't require disabling the ruleset.
    rulesets.push({
      name: "release-tags",
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["v*"], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "update" }],
      bypass_actors: ADMIN_BYPASS,
    });
  }
  return rulesets;
}

/** The whole managed settings document for a repo's facts: the shared
 *  repository policy block (plus the public-only security_and_analysis),
 *  the module-derived label roster, and the fleet-generic rulesets.
 *  Identity keys are absent on purpose - they live in the repo's own
 *  settings.yml, which merges OVER this document. */
export function managedSettings(
  facts: RepoFacts,
  manifests: ModuleManifest[] = loadManifests(),
): Record<string, unknown> {
  return {
    repository: {
      ...policyBlock(),
      ...(facts.private ? {} : { security_and_analysis: securityAndAnalysis() }),
    },
    labels: managedLabels(facts, manifests),
    rulesets: managedRulesets(facts, manifests),
  };
}

// --- fact resolution --------------------------------------------------------

function parseMapping(text: string, where: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`${where}: YAML parse error: ${detail}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${where}: not a YAML mapping`);
  }
  return data as Record<string, unknown>;
}

/** Modules from a .repo-platform.yml text; throws on a missing or
 *  malformed top-level list (the baseline cannot be computed from a
 *  guess). */
export function modulesFrom(registrationText: string, where: string): string[] {
  const modules = parseMapping(registrationText, where).modules;
  if (!Array.isArray(modules) || !modules.every((m) => typeof m === "string")) {
    throw new Error(`${where}: no readable top-level modules list`);
  }
  return modules;
}

/** The selected stream modules' tracking-label answers from a
 *  .copier-answers.yml text. A tracking label is the module's issue-stream
 *  identity: guessing a default could pass while the repo's real label
 *  loops on delete/recreate, so an unreadable answer for a SELECTED
 *  stream module throws, never falls back. */
export function trackingLabelsFrom(
  answersText: string,
  modules: string[],
  manifests: ModuleManifest[],
  where: string,
): { module: string; label: string }[] {
  const streams = manifests.filter(
    (m) => m.tracking_label !== undefined && modules.includes(m.module),
  );
  if (streams.length === 0) return [];
  const answers = parseMapping(answersText, where);
  return streams.map((m) => {
    const tracking = m.tracking_label;
    if (tracking === undefined) throw new Error("unreachable: filtered on tracking_label");
    const value = answers[tracking.answer];
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `${where}: the ${m.module} module is selected but no ${tracking.answer} answer ` +
          "is readable - the tracking label cannot be resolved; fix the answers file",
      );
    }
    return { module: m.module, label: value };
  });
}

function fetchRepoFile(repo: string, path: string): string | null {
  const proc = captureNetwork([
    "gh",
    "api",
    `repos/${repo}/contents/${path}`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  if (proc.exitCode === 0) return proc.stdout;
  if (proc.stderr.includes("HTTP 404")) return null;
  throw new Error(`${repo}/${path}: fetch failed (${proc.stderr.trim().split("\n")[0]})`);
}

/** Live visibility, failing closed like every other probe: only an
 *  explicit "false" proves the repo public. A probe failure throws - a
 *  wrong visibility would apply the public-only blocks to a private repo
 *  (422) or silently drop them from a public one. */
function fetchRepoIsPrivate(repo: string): boolean {
  const proc = captureNetwork(["gh", "api", `repos/${repo}`, "--jq", ".private"]);
  if (proc.exitCode !== 0) {
    throw new Error(`${repo}: visibility probe failed (${proc.stderr.trim().split("\n")[0]})`);
  }
  return proc.stdout.trim() !== "false";
}

/** Facts for the operator repository itself: it is not generated from the
 *  template (no .repo-platform.yml, no .copier-answers.yml), so its module
 *  selection and visibility come from .repo-platform-answers.yml in `dir`
 *  - the same recorded answers the dogfood render uses. */
export function factsFromOperatorAnswers(dir: string): RepoFacts {
  const answers = parseAnswers(readFileSync(join(dir, ANSWERS_FILE), "utf-8"), ANSWERS_FILE);
  const modules = [...answers.modules];
  const streams = loadManifests().filter(
    (m) => m.tracking_label !== undefined && modules.includes(m.module),
  );
  if (streams.length > 0) {
    // The dogfood answers schema records no tracking-label answers today;
    // selecting a stream module here means teaching that schema (and this
    // resolver) the answer first.
    throw new Error(
      `${ANSWERS_FILE}: selects the tracking-stream module(s) ` +
        `${streams.map((m) => m.module).join(", ")} but records no tracking-label answers - ` +
        "extend the answers schema before selecting a stream module",
    );
  }
  return { modules, private: answers.private, trackingLabels: [] };
}

/** Facts fetched from the target repository's default branch (gh api)
 *  plus a live visibility probe. */
export function factsFromFetch(repo: string, manifests: ModuleManifest[]): RepoFacts {
  const registration = fetchRepoFile(repo, ".repo-platform.yml");
  if (registration === null) {
    throw new Error(
      `${repo}: no .repo-platform.yml on the default branch - the repo is not adopted, ` +
        "so there is no module selection to compute a settings baseline from",
    );
  }
  const modules = modulesFrom(registration, `${repo}/.repo-platform.yml`);
  const isPrivate = fetchRepoIsPrivate(repo);
  const streams = manifests.filter(
    (m) => m.tracking_label !== undefined && modules.includes(m.module),
  );
  let trackingLabels: { module: string; label: string }[] = [];
  if (streams.length > 0) {
    const answers = fetchRepoFile(repo, ".copier-answers.yml");
    if (answers === null) {
      throw new Error(
        `${repo}: selects tracking-stream module(s) but has no .copier-answers.yml - ` +
          "the tracking labels cannot be resolved",
      );
    }
    trackingLabels = trackingLabelsFrom(answers, modules, manifests, `${repo}/.copier-answers.yml`);
  }
  return { modules, private: isPrivate, trackingLabels };
}

/** Facts read from a local checkout: the sync's shadow-diff path. The
 *  private fact is the RECORDED answer - post-update the sync has already
 *  re-recorded the live value, so the two agree there. */
export function factsFromTargetDir(dir: string, manifests: ModuleManifest[]): RepoFacts {
  const where = (name: string) => `${join(dir, name)}`;
  const modules = modulesFrom(
    readFileSync(join(dir, ".repo-platform.yml"), "utf-8"),
    where(".repo-platform.yml"),
  );
  const answersText = readFileSync(join(dir, ".copier-answers.yml"), "utf-8");
  const recorded = parseMapping(answersText, where(".copier-answers.yml")).private;
  if (typeof recorded !== "boolean") {
    throw new Error(
      `${where(".copier-answers.yml")}: records no boolean private answer - ` +
        "the baseline's visibility-gated blocks cannot be computed",
    );
  }
  return {
    modules,
    private: recorded,
    trackingLabels: trackingLabelsFrom(
      answersText,
      modules,
      manifests,
      where(".copier-answers.yml"),
    ),
  };
}

/** The managed document as YAML bytes, with a header naming the generator
 *  so a stray scratch file self-identifies. */
export function renderManagedYaml(facts: RepoFacts, manifests?: ModuleManifest[]): string {
  return `# Managed settings baseline, computed by repo-platform's\n# .github/scripts/fleet/render_managed_settings.ts - scratch output, never committed.\n${stringifyYaml(
    managedSettings(facts, manifests),
  )}`;
}

function main(args: string[]): void {
  const flags = parseFlags(args, ["--repo", "--out"] as const, ["--target-dir"] as const);
  const repo = flags["--repo"];
  let facts: RepoFacts;
  try {
    const manifests = loadManifests();
    if (flags["--target-dir"] !== undefined) {
      facts = factsFromTargetDir(flags["--target-dir"], manifests);
    } else {
      // The operator repo is the one fleet member with no
      // .repo-platform.yml (see the header): when the target is the
      // running repository AND the cwd carries the operator answers file
      // (settings-repos.yml runs from the repo-platform checkout; a
      // client's reusable-apply-settings checkout never has it), the
      // facts come from those answers. Everything else fetches.
      const self = env("GITHUB_REPOSITORY");
      facts =
        self !== "" && repo.toLowerCase() === self.toLowerCase() && existsSync(ANSWERS_FILE)
          ? factsFromOperatorAnswers(".")
          : factsFromFetch(repo, manifests);
    }
    writeFileSync(flags["--out"], renderManagedYaml(facts, manifests));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(
    `rendered the managed settings baseline for ${facts.modules.length} module(s) into ${flags["--out"]}`,
  );
}

if (import.meta.main) {
  main(process.argv.slice(2));
}

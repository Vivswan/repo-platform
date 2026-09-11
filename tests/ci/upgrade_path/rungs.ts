// The rungs the synthetic old build leaves PENDING: the harness removes
// each one's file from the old build tree and plants the fleet shape the
// rung moves repositories off, so every update from the old build must
// find it pending and the legs assert its postcondition. The
// migration-ladder ssot rule reads this table: a rung on the ladder with
// no entry here has no upgrade-path case.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { editText, insertAfterLine, insertBeforeLine, linesOf, replaceOnce } from "./edits";

export interface PendingRung {
  /** Plants the pre-transition shape in an assembled build tree (the
   * rung file itself is already removed when this runs). */
  readonly model: (oldTree: string) => void;
}

export const MANIFEST_TEMPLATE = "template/.github/repo-platform-manifest.json.jinja";

/** The one managed-region marker pair the markdown split files use. */
export const HTML_MARKERS = {
  begin: "<!-- BEGIN REPO-PLATFORM MANAGED -->",
  end: "<!-- END REPO-PLATFORM MANAGED -->",
} as const;

/** A split manifest entry on the HTML marker pair, as the template spells it. */
export function htmlSplitEntry(landedPath: string): string {
  return (
    `"${landedPath}": {"class": "split", "grammar": "managed-region", ` +
    `"begin": "${HTML_MARKERS.begin}", "end": "${HTML_MARKERS.end}", "hash": null}`
  );
}

/** Adds an ungated manifest entry to a build tree's manifest template
 * (before AGENTS.md's, the one every build carries). */
export function plantManifestEntry(tree: string, entry: string): void {
  editText(join(tree, MANIFEST_TEMPLATE), (text) =>
    insertBeforeLine(
      text,
      (line) => line.includes('"AGENTS.md":'),
      [`{%- set _ = entries.append('    ${entry}') -%}`],
      `plant the old fixture's manifest entry ${entry.slice(0, 40)}`,
    ),
  );
}

/** Plants a file the current template no longer renders into a build tree,
 * with its manifest entry. */
export function plantTemplateFile(tree: string, rel: string, content: string, entry: string): void {
  const path = join(tree, "template", rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  plantManifestEntry(tree, entry);
}

/** The jinja condition a module's selection renders under. */
export function selected(module: string): string {
  return `'${module}' in modules`;
}

/** Wraps the manifest template's entry for `landedPath` in a jinja gate
 * (a module's selection, a visibility), the way the old template rendered
 * a conditional entry. */
export function gateManifestEntry(oldTree: string, landedPath: string, condition: string): void {
  const needle = `"${landedPath}":`;
  editText(join(oldTree, MANIFEST_TEMPLATE), (text) =>
    insertBeforeLine(
      insertAfterLine(
        text,
        (line) => line.includes(needle),
        ["{%- endif -%}"],
        `gate the old fixture's manifest entry for ${landedPath} on ${condition}`,
      ),
      (line) => line.includes(needle),
      [`{%- if ${condition} -%}`],
      `gate the old fixture's manifest entry for ${landedPath} on ${condition}`,
    ),
  );
}

const FOLDED_CHOICES = [
  "    agents - AGENTS.md agent instructions, agent-file symlinks, Copilot setup and review style: agents",
  "    auto-assign - auto-assign issues/PRs/alerts to owner: auto-assign",
  "    settings-sync - centrally managed repo settings + repo-owned settings.yml starter: settings-sync",
];

const FOLDED_EXCLUDES = [
  ["agents", ".github/agents.md"],
  ["agents", ".github/copilot-instructions.md"],
  ["agents", ".github/instructions/review.instructions.md"],
  ["settings-sync", ".github/settings.yml"],
  ["auto-assign", ".github/workflows/auto-assign.yml"],
  ["agents", ".github/workflows/copilot-setup-steps.yml"],
  ["settings-sync", ".github/workflows/settings-sync.yml"],
  ["agents", "/AGENTS.md"],
  ["agents", "/CLAUDE.md"],
  ["agents", ".github/instructions"],
].map(([module, path]) => `  - "{% if not ('${module}' in modules) %}${path}{% endif %}"`);

const AGENTS_PATHS = [
  ".github/agents.md",
  ".github/copilot-instructions.md",
  ".github/instructions/review.instructions.md",
  ".github/workflows/copilot-setup-steps.yml",
  "AGENTS.md",
  "CLAUDE.md",
];

const SETTINGS_SYNC_WORKFLOW = ".github/workflows/settings-sync.yml";

export const PENDING_RUNGS: Readonly<Record<string, PendingRung>> = {
  // The build predates the security policy's move: a split SECURITY.md
  // rendered and manifest-classed at the root (the template renders no
  // security policy at all today; the account's .github defaults serve it).
  m0001_security_policy_to_github: {
    model(oldTree) {
      plantTemplateFile(
        oldTree,
        "SECURITY.md.jinja",
        `${HTML_MARKERS.begin}\n# Security policy\n${HTML_MARKERS.end}\n`,
        htmlSplitEntry("SECURITY.md"),
      );
    },
  },
  // The build predates the fold of agents, auto-assign, and settings-sync
  // into the base tree: the three were module CHOICES whose files landed
  // only when selected (the generated _exclude gates, the manifest
  // template's module gates, the two settings questions asked only with
  // settings-sync), and settings-sync shipped a managed workflow the new
  // build retired outright. Modeled on the current tree, so the folded
  // files render byte-identical to today's base render.
  m0002_fold_base_modules: {
    model(oldTree) {
      const copierYml = join(oldTree, "copier.yml");
      editText(copierYml, (text) => {
        const choiceBlocks = linesOf(text).filter((line) => line === "  choices:").length;
        if (choiceBlocks !== 1) {
          throw new Error(
            `the old fixture's copier.yml carries ${choiceBlocks} 'choices:' blocks, not the one to model the folded choices in`,
          );
        }
        let edited = insertAfterLine(
          text,
          (line) => line === "  choices:",
          FOLDED_CHOICES,
          "model the pre-fold module choices",
        );
        edited = insertAfterLine(
          edited,
          (line) => line.startsWith("  # BEGIN GENERATED: conditional-excludes"),
          FOLDED_EXCLUDES,
          "model the pre-fold _exclude gates",
        );
        // The two settings questions were asked only with settings-sync selected.
        let key = "";
        const gated = edited.split("\n").flatMap((line) => {
          if (/^[a-z_]+:$/.test(line)) key = line;
          if (line === '  default: ""' && (key === "homepage:" || key === "topics:")) {
            return [line, `  when: "{{ 'settings-sync' in modules }}"`];
          }
          return [line];
        });
        const whenGates = gated.filter(
          (line) => line === `  when: "{{ 'settings-sync' in modules }}"`,
        ).length;
        if (whenGates !== 2) {
          throw new Error(
            `gated ${whenGates} of the old fixture's homepage and topics questions on settings-sync, not 2`,
          );
        }
        return gated.join("\n");
      });
      for (const path of AGENTS_PATHS) gateManifestEntry(oldTree, path, selected("agents"));
      // Planted before the gates wrap the manifest entries, so it rides its own gate.
      writeFileSync(
        join(oldTree, "template", SETTINGS_SYNC_WORKFLOW),
        "# This file is managed by Vivswan/repo-platform.\nname: Settings Sync\non:\n  push:\n    branches: [main]\n",
      );
      const autoAssignEntry = `{%- set _ = entries.append('    ".github/workflows/auto-assign.yml": {"class": "managed", "hash": null}') -%}\n`;
      editText(join(oldTree, MANIFEST_TEMPLATE), (text) =>
        replaceOnce(
          text,
          autoAssignEntry,
          `${autoAssignEntry}{%- set _ = entries.append('    "${SETTINGS_SYNC_WORKFLOW}": {"class": "managed", "hash": null}') -%}\n`,
          "model the old fixture's manifest entry for settings-sync.yml beside auto-assign.yml's",
        ),
      );
      gateManifestEntry(oldTree, ".github/workflows/auto-assign.yml", selected("auto-assign"));
      for (const path of [".github/settings.yml", SETTINGS_SYNC_WORKFLOW]) {
        gateManifestEntry(oldTree, path, selected("settings-sync"));
      }
    },
  },
};

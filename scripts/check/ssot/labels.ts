// Rules over the label rosters: the managed labels' sites, issue-form
// labels, the release guard's literals, dependabot's tuples, and the
// tracking-label validators.

import { parse as parseYaml } from "yaml";
import { loadLayer } from "../../../.github/scripts/fleet/settings_layers.ts";
import { normalizeJinja, placeholderJinja } from "../../lib/jinja_subset.ts";
import { constRegexSource, constStringValue } from "../../lib/ts_extract.ts";
import { type Mismatch, mustMatch } from "./comparison.ts";
import {
  asRecord,
  copierConfig,
  jinjaVars,
  loadManifests,
  managedLabelRoster,
  read,
  trackingManifests,
  walkFiles,
} from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** Normalize python-style \Z end anchors to $, for regex-pair comparison. */
export function zToDollar(pattern: string): string {
  return pattern.replace(/\\Z$/, "$");
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const labelRules: Rule[] = [
  {
    name: "labels",
    run: () => {
      const mismatches: Mismatch[] = [];
      // The layer files are the label roster's single home; this
      // regression tripwire keeps the hand-maintained tuples from quietly
      // losing a member the fleet's tools recreate (dependabot, the
      // release machinery) - losing one restarts the nightly
      // delete/recreate loop the roster exists to kill.
      const rosterNames = new Set(managedLabelRoster().map((label) => label.name));
      const required = [
        "dependencies",
        "github_actions",
        "javascript",
        "bug",
        "enhancement",
        "fix-lint",
        "settings-as-code-report",
        "autorelease: pending",
        "autorelease: tagged",
        "release-blocker",
        "release-override",
      ];
      for (const name of required) {
        if (!rosterNames.has(name)) {
          mismatches.push({
            file: ".github/settings-baseline.yml (or a module's settings.yml layer)",
            expected: `label '${name}' in the managed roster`,
            got: "missing",
          });
        }
      }

      // Tracking-label streams: each manifest's tracking_label block is the
      // single source; the hand-written copier question is anchored back to
      // it here (the tracking scratch layer renders the stream labels from
      // the same manifest tuples, so it cannot drift), and the create-tuple
      // carriers (the action's defaults for the fuzz stream, the starter's
      // overrides for the nightly stream) below.
      for (const { module, tracking } of trackingManifests()) {
        const question = asRecord(copierConfig()[tracking.answer], `copier.yml ${tracking.answer}`);
        if (String(question.default) !== tracking.default) {
          mismatches.push({
            file: `copier.yml ${tracking.answer} default`,
            expected: `${tracking.default} (templates/${module}/module.yml tracking_label)`,
            got: String(question.default),
          });
        }
      }

      // The fuzz stream's create tuple lives in the action's DEFAULTS, so
      // the fuzz starter must pass no override - asserted, so adding one
      // later fails this rule instead of silently orphaning its premise.
      const fuzzTracking = trackingManifests().find((m) => m.module === "fuzzer")?.tracking;
      if (!fuzzTracking) throw new Error("templates/fuzzer/module.yml lost tracking_label");
      const action = read("actions/fuzz-issue/fuzz-issue.ts");
      const color = constStringValue(action, "DEFAULT_LABEL_COLOR", {
        where: "fuzz-issue.ts",
        what: "label color",
      });
      const description = constStringValue(action, "DEFAULT_LABEL_DESCRIPTION", {
        where: "fuzz-issue.ts",
        what: "label description",
      });
      if (color !== fuzzTracking.color || description !== fuzzTracking.description) {
        mismatches.push({
          file: "actions/fuzz-issue/fuzz-issue.ts label defaults",
          expected: `${fuzzTracking.color} / ${fuzzTracking.description} (templates/fuzzer/module.yml tracking_label)`,
          got: `${color} / ${description}`,
        });
      }
      const fuzzStarter = read("templates/fuzzer/.github/workflows/nightly-fuzz.yml.jinja");
      if (/label-(?:color|description):/.test(fuzzStarter)) {
        mismatches.push({
          file: "templates/fuzzer/.github/workflows/nightly-fuzz.yml.jinja",
          expected:
            "no label-color/label-description override (the fuzz tuple is anchored to the action's defaults)",
          got: "an override - anchor this rule to it instead",
        });
      }
      // The fuzz starter's explicit title must stay the action's title
      // default: already-rendered fleet starters omit the input and depend
      // on the default (the action's own test pins DEFAULT_TITLE to it).
      const titleDefault = mustMatch(
        read("actions/fuzz-issue/action.yml"),
        /^ {2}title:\n(?: {4}.+\n)*? {4}default: (.+)$/m,
        "actions/fuzz-issue/action.yml",
        "title default",
      )[1];
      const starterTitle = mustMatch(
        fuzzStarter,
        /^ {10}title: (.+)$/m,
        "nightly-fuzz.yml.jinja",
        "title input",
      )[1];
      if (starterTitle !== titleDefault) {
        mismatches.push({
          file: "templates/fuzzer/.github/workflows/nightly-fuzz.yml.jinja title",
          expected: `${titleDefault} (actions/fuzz-issue/action.yml title default)`,
          got: starterTitle,
        });
      }

      // The nightly stream's create tuple is passed by its starter.
      const nightlyTracking = trackingManifests().find((m) => m.module === "nightly")?.tracking;
      if (!nightlyTracking) throw new Error("templates/nightly/module.yml lost tracking_label");
      const starter = read("templates/nightly/.github/workflows/nightly.yml.jinja");
      const starterColor = mustMatch(
        starter,
        /label-color: "([^"]+)"/,
        "nightly.yml.jinja",
        "label-color input",
      )[1];
      const starterDescription = mustMatch(
        starter,
        /label-description: (.+)/,
        "nightly.yml.jinja",
        "label-description input",
      )[1];
      if (
        starterColor !== nightlyTracking.color ||
        starterDescription !== nightlyTracking.description
      ) {
        mismatches.push({
          file: "templates/nightly/.github/workflows/nightly.yml.jinja label overrides",
          expected: `${nightlyTracking.color} / ${nightlyTracking.description} (templates/nightly/module.yml tracking_label)`,
          got: `${starterColor} / ${starterDescription}`,
        });
      }

      // The docs-site stream's create tuple is passed by the shared deploy
      // (reusable-pages.yml files the link-rot issue for every caller).
      const docsTracking = trackingManifests().find((m) => m.module === "docs-site")?.tracking;
      if (!docsTracking) throw new Error("templates/docs-site/module.yml lost tracking_label");
      const reusablePages = read(".github/workflows/reusable-pages.yml");
      const rotColor = mustMatch(
        reusablePages,
        /label-color: "([^"]+)"/,
        "reusable-pages.yml",
        "label-color input",
      )[1];
      const rotDescription = mustMatch(
        reusablePages,
        /label-description: (.+)/,
        "reusable-pages.yml",
        "label-description input",
      )[1];
      if (rotColor !== docsTracking.color || rotDescription !== docsTracking.description) {
        mismatches.push({
          file: ".github/workflows/reusable-pages.yml label overrides",
          expected: `${docsTracking.color} / ${docsTracking.description} (templates/docs-site/module.yml tracking_label)`,
          got: `${rotColor} / ${rotDescription}`,
        });
      }
      return mismatches;
    },
  },
  {
    name: "issue-labels",
    run: () => {
      const mismatches: Mismatch[] = [];
      const rosterNames = new Set(managedLabelRoster().map((label) => label.name));
      const forms = walkFiles("templates/issue-templates").map((f) => f.path);
      let sawLabels = false;
      for (const rel of forms) {
        const text = read(rel);
        if (!/^labels:/m.test(text)) continue;
        // Parse the whole form so block-style lists count too; a labels key
        // that stops parsing must fail loudly, not drop out of the check.
        const doc = asRecord(parseYaml(placeholderJinja(normalizeJinja(text, jinjaVars()))), rel);
        if (!Array.isArray(doc.labels)) {
          throw new Error(`${rel}: labels key present but not a parsable list`);
        }
        sawLabels = true;
        for (const name of doc.labels.map(String)) {
          if (!rosterNames.has(name)) {
            mismatches.push({
              file: rel,
              expected: `label '${name}' declared in the managed settings roster (settings_layers.ts)`,
              got: "missing - the label sync would delete what the issue form applies",
            });
          }
        }
      }
      if (!sawLabels) throw new Error("no issue form declares labels - anchor lost");
      return mismatches;
    },
  },
  {
    // The stale-pending guard in the release-please workflow queries and
    // names the autorelease labels as string literals. gh pr list exits 0
    // and empty for a label that does not exist, so a literal that drifts
    // from the managed roster degrades the guard to a permanent silent
    // no-op - anchor the literals to the release-please manifest's
    // settings layer here instead. Only the template side exists to check:
    // repo-platform runs no release pipeline of its own.
    name: "release-guard-labels",
    run: () => {
      const mismatches: Mismatch[] = [];
      const releaseLabels = (loadLayer("templates/release-please/settings.yml").labels ?? []) as {
        name: string;
      }[];
      if (releaseLabels.length === 0) {
        throw new Error("templates/release-please/settings.yml declares no labels - anchor lost");
      }
      const roster = new Set(releaseLabels.map((label) => label.name));
      const rel = "templates/release-please/.github/workflows/release.yml.jinja";
      const text = read(rel);
      const queried = mustMatch(
        text,
        /gh pr list --state merged --label '([^']+)'/,
        rel,
        "guard label query",
      )[1];
      const worn = mustMatch(text, /have worn '([^']+)'/, rel, "guard error's pending label")[1];
      const target = mustMatch(
        text,
        /move the label to '([^']+)'/,
        rel,
        "guard error's tagged label",
      )[1];
      for (const name of [queried, worn, target]) {
        if (!roster.has(name)) {
          mismatches.push({
            file: rel,
            expected: `label '${name}' declared in templates/release-please/settings.yml`,
            got: "not in the manifest roster",
          });
        }
      }
      if (worn !== queried) {
        mismatches.push({
          file: rel,
          expected: `guard error names the queried label '${queried}'`,
          got: `'${worn}'`,
        });
      }
      // The prescribed fix must point at the tagged label specifically -
      // roster membership alone would accept any declared label.
      if (target !== "autorelease: tagged") {
        mismatches.push({
          file: rel,
          expected: "guard error prescribes moving to 'autorelease: tagged'",
          got: `'${target}'`,
        });
      }
      return mismatches;
    },
  },
  {
    name: "dependabot-label-tuples",
    run: () => {
      // A toolchain module's dependabot label now has two homes: the
      // manifest's `dependabot` tuple (which drives the generated
      // dependabot.yml and the docs) and the module's own settings layer
      // (which drives the label roster the apply syncs). If they drift,
      // dependabot recreates a label the settings apply then deletes -
      // the nightly delete/recreate loop this whole roster exists to kill.
      const mismatches: Mismatch[] = [];
      for (const manifest of loadManifests()) {
        const tuple = manifest.dependabot;
        if (tuple === undefined) continue;
        const rel = `templates/${manifest.module}/settings.yml`;
        const declared = (loadLayer(rel).labels ?? []) as {
          name: string;
          color: string;
          description: string;
        }[];
        const entry = declared.find((label) => label.name === tuple.label);
        if (entry === undefined) {
          mismatches.push({
            file: rel,
            expected: `a label '${tuple.label}' (the manifest's dependabot.label)`,
            got: declared.map((label) => label.name).join(", ") || "no labels",
          });
          continue;
        }
        if (entry.color !== tuple.color) {
          mismatches.push({
            file: `${rel} label '${tuple.label}' color`,
            expected: `${tuple.color} (templates/${manifest.module}/module.yml dependabot.color)`,
            got: entry.color,
          });
        }
      }
      return mismatches;
    },
  },
  {
    // Every tracking-label copier question (one per manifest tracking_label
    // stream) must validate exactly the shape the fuzz-issue action
    // enforces, and every later stream's validator must carry the
    // case-insensitive cross-answer collision clause against each earlier
    // answer - the validator is the collision boundary at generation
    // time (the fleet preflight covers the applies), so deleting the
    // clause must fail here.
    name: "tracking-label-regex",
    run: () => {
      const mismatches: Mismatch[] = [];
      const action = read("actions/fuzz-issue/fuzz-issue.ts");
      const labelRe = constRegexSource(action, "LABEL_RE", {
        where: "fuzz-issue.ts",
        what: "LABEL_RE",
        exported: true,
      });
      const streams = trackingManifests();
      for (const [index, { tracking }] of streams.entries()) {
        const question = asRecord(copierConfig()[tracking.answer], `copier.yml ${tracking.answer}`);
        const validator = String(question.validator ?? "");
        const copierRe = zToDollar(
          mustMatch(
            validator,
            /regex_search\('([^']+)'\)/,
            `copier.yml ${tracking.answer} validator`,
            "pattern",
          )[1],
        );
        if (copierRe !== labelRe) {
          mismatches.push({
            file: `copier.yml ${tracking.answer} validator`,
            expected: `${labelRe} (actions/fuzz-issue/fuzz-issue.ts LABEL_RE)`,
            got: copierRe,
          });
        }
        for (const earlier of streams.slice(0, index)) {
          const clause = `${tracking.answer} | lower == ${earlier.tracking.answer} | lower`;
          if (!validator.includes(clause)) {
            mismatches.push({
              file: `copier.yml ${tracking.answer} validator`,
              expected: `the collision clause '${clause}' (streams sharing a label close each other's issues)`,
              got: "missing",
            });
          }
        }
      }
      // Copier asks questions in FILE order, and each stream's generated
      // validator references every earlier stream's answer, so the
      // questions must physically follow the streams' MODULE_ORDER - out
      // of order, the earlier validator reads a not-yet-answered question
      // and every render fails at the prompt.
      const questionKeys = Object.keys(copierConfig());
      for (let index = 1; index < streams.length; index++) {
        const prev = streams[index - 1].tracking.answer;
        const next = streams[index].tracking.answer;
        if (questionKeys.indexOf(next) < questionKeys.indexOf(prev)) {
          mismatches.push({
            file: "copier.yml",
            expected: `the '${next}' question declared after '${prev}' (stream order; validators reference earlier answers)`,
            got: "declared before it",
          });
        }
      }
      return mismatches;
    },
  },
];

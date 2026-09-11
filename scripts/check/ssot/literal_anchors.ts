// Rules anchoring facts quoted as literals across hand-written docs,
// workflows, and scripts: doc-quoted constants, the owner slug, PAT URLs,
// and inlined twin functions.

import { parse as parseYaml } from "yaml";
import { callCarriesLiteral, constNumberValue, constRegexSource } from "../../lib/ts_extract.ts";
import { type Mismatch, mustMatch, stripGeneratedRegions } from "./comparison.ts";
import {
  asRecord,
  ciJobs,
  managedLabelRoster,
  modules,
  OWNER,
  read,
  repoSlug,
  trackedFiles,
  trackingStreams,
} from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

// The docs carrying a generated region (scripts/files_table.ts's table). A
// strip over one of these that removes nothing means the marker grammar
// drifted and every stripped-prose rule is silently checking unstripped
// text.
const DOCS_WITH_REGIONS = new Set(["docs/new-repo.md"]);

function handProse(rel: string): string {
  const { prose, regions } = stripGeneratedRegions(read(rel), rel);
  if (regions === 0 && DOCS_WITH_REGIONS.has(rel)) {
    throw new Error(
      `${rel}: stripping removed no generated regions from a doc known to ` +
        "carry them - the marker grammar drifted from scripts/files_table.ts",
    );
  }
  return prose;
}

/** Every `async function <name>() { ... }` block in `text`, matched from
 *  the declaration to the closing brace at the declaration's own indent,
 *  raw bytes included - for rules that pin inline script copies
 *  byte-identical. */
export function inlineFunctionCopies(text: string, name: string): string[] {
  // The name is a function identifier the calling rule spells out, never input.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const block = new RegExp(`^( *)async function ${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\1\\}`, "gm");
  return [...text.matchAll(block)].map((match) => match[0]);
}

/** The release-cut wiring across its three files, compared on the PARSED
 *  documents: release-health.ts writes the output, action.yml declares it
 *  off the step that runs the script, and fleet-release.yml turns
 *  release-please's tag phase off unless it reads "true". A rename or a
 *  dropped `id:` on any side reads as an empty output, which is not
 *  "true": every run would skip the tag phase and no release would ever
 *  cut, silently. */
export function releaseCutWiringMismatches(files: {
  workflow: string;
  action: string;
  script: string;
}): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const workflowRel = ".github/workflows/fleet-release.yml";
  const actionRel = "actions/release-health/action.yml";
  const scriptRel = "actions/release-health/release-health.ts";

  if (!callCarriesLiteral(files.script, "setOutput", "release-cut")) {
    mismatches.push({
      file: scriptRel,
      expected: 'a setOutput("release-cut", ...) write in release mode',
      got: "no such write",
    });
  }

  const action = asRecord(parseYaml(files.action), actionRel);
  const outputs = asRecord(action.outputs ?? {}, `${actionRel} outputs`);
  const releaseCut = asRecord(outputs["release-cut"] ?? {}, `${actionRel} outputs.release-cut`);
  const expectedValue = "${{ steps.check.outputs.release-cut }}";
  if (releaseCut.value !== expectedValue) {
    mismatches.push({
      file: `${actionRel} outputs.release-cut`,
      expected: expectedValue,
      got: releaseCut.value === undefined ? "no such output" : String(releaseCut.value),
    });
  }
  const actionSteps = (asRecord(action.runs ?? {}, `${actionRel} runs`).steps ?? []) as Record<
    string,
    unknown
  >[];
  if (
    !actionSteps.some(
      (step) => step.id === "check" && /release-health\.ts/.test(String(step.run ?? "")),
    )
  ) {
    mismatches.push({
      file: `${actionRel} runs.steps`,
      expected: "the step running release-health.ts carries id: check",
      got: "no such step",
    });
  }

  const jobs = ciJobs(asRecord(parseYaml(files.workflow), workflowRel), workflowRel);
  const steps = (asRecord(jobs["release-please"] ?? {}, `${workflowRel} release-please`).steps ??
    []) as Record<string, unknown>[];
  const health = steps.find((step) =>
    String(step.uses ?? "").startsWith("Vivswan/repo-platform/actions/release-health@"),
  );
  if (health === undefined || health.id !== "health") {
    mismatches.push({
      file: `${workflowRel} release-please`,
      expected: "the release-health step carries id: health",
      got: health === undefined ? "no release-health step" : `id: ${String(health.id ?? "")}`,
    });
  }
  const release = steps.find((step) => step.id === "release");
  const skip = String(
    asRecord(release?.with ?? {}, `${workflowRel} release.with`)["skip-github-release"] ?? "",
  );
  const expectedSkip = "${{ steps.health.outputs.release-cut != 'true' }}";
  if (skip !== expectedSkip) {
    mismatches.push({
      file: `${workflowRel} release-please step 'release'`,
      expected: `skip-github-release: ${expectedSkip}`,
      got: skip === "" ? "no skip-github-release input" : skip,
    });
  }
  return mismatches;
}

/** Whether the owner-slug rule's match at `index` (its owner segment in
 *  `segment`) sits inside this repository's OWN Pages origin,
 *  `<username>.github.io/<slug>` (the docs site's URL): the io segment
 *  must be preceded by exactly `<username>.github.` at a hostname boundary
 *  - start of text or a non-hostname character - so any other owner's
 *  Pages URL still flags, a username-suffixed near miss like
 *  `not<username>.github.io` included. */
export function isOwnPagesOrigin(
  text: string,
  index: number,
  segment: string,
  username: string,
): boolean {
  if (segment.toLowerCase() !== "io") return false;
  const before = text.slice(0, index).toLowerCase();
  const origin = `${username.toLowerCase()}.github.`;
  if (!before.endsWith(origin)) return false;
  // The origin must be the WHOLE hostname: a preceding hostname character
  // is another owner's name ending in the username, and a preceding dot
  // makes it a subdomain - neither is this repository's Pages origin.
  const boundary = before.charAt(before.length - origin.length - 1);
  return boundary === "" || !/[a-z0-9.-]/.test(boundary);
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const literalAnchorRules: Rule[] = [
  {
    name: "pins-and-identities",
    run: () => {
      const mismatches: Mismatch[] = [];

      // No git-identity arm: every committer is TypeScript and imports
      // shared/git_identity.ts, so the import is the guarantee.

      // Every PAT URL in every file must match, not just the first per file.
      const patUrls = (rel: string) => {
        const urls = [
          ...read(rel).matchAll(
            /https:\/\/github\.com\/settings\/personal-access-tokens\/new\?[^\s")\]]+/g,
          ),
        ].map((m) => m[0]);
        if (urls.length === 0) {
          throw new Error(`${rel}: anchor for PAT-creation URL not found`);
        }
        return [...new Set(urls)];
      };
      const patFiles = [
        "README.md",
        ".github/workflows/sync-repos.yml",
        ".github/workflows/settings-repos.yml",
      ];
      const referenceUrl = patUrls(patFiles[0])[0];
      for (const rel of patFiles) {
        const stray = patUrls(rel).filter((url) => url !== referenceUrl);
        if (stray.length > 0) {
          mismatches.push({ file: rel, expected: referenceUrl, got: stray.join(", ") });
        }
      }

      const schemaVersion = mustMatch(
        read("biome.json"),
        /biomejs\.dev\/schemas\/([^/]+)\/schema\.json/,
        "biome.json",
        "$schema version",
      )[1];
      const pkg = asRecord(JSON.parse(read("package.json")), "package.json");
      const devDeps = asRecord(pkg.devDependencies, "devDependencies");
      const biomePin = String(devDeps["@biomejs/biome"]).replace(/^[\^~]/, "");
      if (schemaVersion !== biomePin) {
        mismatches.push({
          file: "biome.json",
          expected: `$schema version ${biomePin} (package.json @biomejs/biome pin)`,
          got: schemaVersion,
        });
      }
      return mismatches;
    },
  },
  {
    name: "docs-constants",
    run: () => {
      const mismatches: Mismatch[] = [];
      const action = read("actions/fuzz-issue/fuzz-issue.ts");
      const num = (name: string) =>
        constNumberValue(action, name, { where: "fuzz-issue.ts", what: name });
      const reportLines = num("REPORT_LINES");
      const maxBody = num("MAX_BODY");
      const maxBlockChars = num("MAX_BLOCK_CHARS");
      // The doc quotes DIR_NAME's body between its ^...$ anchors; a
      // reshaped regex (anchors gone) is a lost anchor, not a new quote.
      const dirRe = mustMatch(
        constRegexSource(action, "DIR_NAME", { where: "fuzz-issue.ts", what: "DIR_NAME" }),
        /^\^([\s\S]+)\$$/,
        "fuzz-issue.ts",
        "DIR_NAME",
      )[1];

      const fuzzerDoc = read("docs/fuzzer.md");
      const wanted: [string, string][] = [
        [`first ${reportLines} lines`, "REPORT_LINES"],
        [`${maxBlockChars.toLocaleString("en-US")} characters`, "MAX_BLOCK_CHARS"],
        [`\`${dirRe}\``, "DIR_NAME"],
        [`${maxBody.toLocaleString("en-US")} characters`, "MAX_BODY"],
      ];
      for (const [needle, what] of wanted) {
        if (!fuzzerDoc.includes(needle)) {
          mismatches.push({
            file: "docs/fuzzer.md",
            expected: `${JSON.stringify(needle)} (${what})`,
            got: "missing",
          });
        }
      }
      if (maxBody >= 65536) {
        mismatches.push({
          file: "actions/fuzz-issue/fuzz-issue.ts",
          expected: "MAX_BODY under GitHub's 65,536-character cap",
          got: String(maxBody),
        });
      }

      // Anchored on the parameter table's row (like the pages cells): a
      // bare backticked "skills" occurs in the doc for unrelated reasons,
      // so only the row's Default cell can satisfy this.
      const skillsDefault = modules().find((m) => m.name === "skills")?.skills_dir?.default;
      if (skillsDefault === undefined) {
        throw new Error("files.yml modules.skills declares no skills_dir default - anchor lost");
      }
      const skillsCell = mustMatch(
        handProse("docs/skills.md"),
        /^\| `skills\.dir` \|.+\| ([^|]+) \|$/m,
        "docs/skills.md",
        "the skills.dir table row",
      )[1].trim();
      if (skillsCell !== `\`${skillsDefault}\``) {
        mismatches.push({
          file: "docs/skills.md",
          expected: `the skills.dir Default cell \`${skillsDefault}\``,
          got: skillsCell,
        });
      }

      const settingsProse = handProse("docs/settings.md");
      // Only the two labels the hand prose quotes: the per-toolchain
      // dependabot labels are the dependabot-label-tuples rule's. Name
      // and color must appear in the exact quoted shape `name` (`color`) /
      // `name` (color `color`) - a spannable gap would let a wrong
      // hand-written color pass by matching a backticked color later in
      // the doc.
      const roster = new Map(managedLabelRoster().map((label) => [label.name, label]));
      for (const name of ["dependencies", "github_actions"]) {
        const label = roster.get(name);
        if (!label) throw new Error(`the settings layers: label '${name}' vanished - anchor lost`);
        const joint = new RegExp(`\`${name}\` \\((?:color )?\`${label.color}\`\\)`);
        if (!joint.test(settingsProse)) {
          mismatches.push({
            file: "docs/settings.md",
            expected: `label \`${name}\` quoted as \`${name}\` (\`${label.color}\`) in hand prose`,
            got: "missing, reworded, or a different color",
          });
        }
      }

      // Every tracking stream's default is quoted in its module doc and in
      // docs/settings.md, whose hand prose also quotes the label color
      // (files.yml is the anchor, so the docs follow the same source).
      for (const stream of trackingStreams()) {
        for (const doc of [`docs/${stream.module}.md`, "docs/settings.md"]) {
          if (!handProse(doc).includes(`\`${stream.default}\``)) {
            mismatches.push({
              file: doc,
              expected: `the ${stream.key} tracking label default \`${stream.default}\``,
              got: "missing",
            });
          }
        }
        if (!settingsProse.includes(`\`${stream.color}\``)) {
          mismatches.push({
            file: "docs/settings.md",
            expected: `the ${stream.module} tracking label color \`${stream.color}\``,
            got: "missing",
          });
        }
      }
      return mismatches;
    },
  },
  {
    name: "owner-slug",
    run: () => {
      const mismatches: Mismatch[] = [];
      const slug = repoSlug();
      const files = trackedFiles().filter((rel) => !rel.endsWith(".test.ts"));
      const slugRe = new RegExp(`([A-Za-z0-9-]+)/${slug}(?![A-Za-z0-9-])`, "g");
      let sawExpected = false;
      for (const rel of files) {
        const text = read(rel);
        for (const match of text.matchAll(slugRe)) {
          // <something>/repo-platform.<ext> is a filename inside a path
          // (say, a scratch repo-platform.yml), not an owner slug.
          if (/^\.[A-Za-z0-9]/.test(text.slice(match.index + match[0].length))) continue;
          // The sync branch name is not an owner slug either.
          if (match[1] === "automation") continue;
          // <username>.github.io/<slug> is this repository's OWN Pages
          // origin (the docs site), not an owner slug.
          if (isOwnPagesOrigin(text, match.index, match[1], OWNER)) continue;
          if (match[1].toLowerCase() === OWNER.toLowerCase()) {
            sawExpected = true;
            continue;
          }
          mismatches.push({
            file: rel,
            expected: `${OWNER}/${slug} (the fleet owner)`,
            got: match[0],
          });
        }
      }
      if (!sawExpected)
        throw new Error(`no '${OWNER}/${slug}' literal found anywhere - anchor lost`);
      return mismatches;
    },
  },
  {
    // The release-PR predicates of fleet-ci.yml's two release gates,
    // compared on the PARSED jobs (they share the same condition text, so
    // a whole-file grep would stay green with one of them changed or
    // deleted): a renamed release-please branch prefix would make the job
    // skip and the gate stand down; a dropped module clause would run the
    // release gates in repositories without release-please.
    name: "release-gate-predicates",
    run: () => {
      const mismatches: Mismatch[] = [];
      const fleetCi = ".github/workflows/fleet-ci.yml";
      const releaseGateIf =
        "contains(fromJSON(needs.plan.outputs.modules), 'release-please') && github.event_name == 'pull_request' && startsWith(github.head_ref, 'release-please--')";
      const fleetJobs = ciJobs(asRecord(parseYaml(read(fleetCi)), fleetCi), fleetCi);
      for (const job of ["release-freshness", "release-health"]) {
        const actual = String(asRecord(fleetJobs[job] ?? {}, job).if ?? "").trim();
        if (actual !== releaseGateIf) {
          mismatches.push({
            file: `${fleetCi} job '${job}'`,
            expected: `the pinned release-PR condition ${releaseGateIf}`,
            got: actual === "" ? "no condition" : actual,
          });
        }
      }
      return mismatches;
    },
  },
  {
    // Why the wiring is pinned is on releaseCutWiringMismatches.
    name: "release-cut-wiring",
    run: () =>
      releaseCutWiringMismatches({
        workflow: read(".github/workflows/fleet-release.yml"),
        action: read("actions/release-health/action.yml"),
        script: read("actions/release-health/release-health.ts"),
      }),
  },
  {
    // The CODEOWNERS assignee-resolution function is inlined twice: once
    // in reusable-auto-assign.yml and once in
    // reusable-auto-assign-alerts.yml (split for permissions - see the file
    // headers). It cannot be hoisted: a reusable workflow runs from the
    // CALLER's checkout, where this repo's scripts do not exist. Pin the
    // copies byte-identical so a fix to one cannot silently leave the
    // other behind.
    name: "auto-assign-codeowners-parity",
    run: () => {
      const mismatches: Mismatch[] = [];
      const sites = [
        { file: ".github/workflows/reusable-auto-assign.yml", copies: 1 },
        { file: ".github/workflows/reusable-auto-assign-alerts.yml", copies: 1 },
      ];
      const found: { file: string; body: string }[] = [];
      for (const site of sites) {
        const blocks = inlineFunctionCopies(read(site.file), "resolveAssignees");
        if (blocks.length !== site.copies) {
          throw new Error(
            `${site.file}: expected ${site.copies} resolveAssignees ` +
              `cop${site.copies === 1 ? "y" : "ies"}, found ${blocks.length} - anchor lost`,
          );
        }
        for (const body of blocks) found.push({ file: site.file, body });
      }
      const [canon, ...rest] = found;
      for (const copy of rest) {
        if (copy.body !== canon.body) {
          mismatches.push({
            file: copy.file,
            expected: `a resolveAssignees block byte-identical to ${canon.file}'s first copy`,
            got: "a drifted copy - update every inline copy together",
          });
        }
      }
      return mismatches;
    },
  },
];

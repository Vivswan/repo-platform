// Rules anchoring facts quoted as literals across hand-written docs,
// workflows, and scripts: doc-quoted constants, the AGENTS.md smoke recipe,
// the owner slug, PAT URLs, hidden-capture names, and inlined twin functions.

import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { stageComposedTreeArgv } from "../../../.github/scripts/shared/stage_tree.ts";
import { captureName } from "../../../.github/scripts/sync/run_hidden.ts";
import {
  argvFlagLeads,
  argvStringAfter,
  constNumberValue,
  constRegexSource,
  constStringValue,
  literalMatches,
  wrappedArgvLabels,
} from "../../lib/ts_extract.ts";
import { type Mismatch, mustMatch, stripGeneratedRegions } from "./comparison.ts";
import {
  asRecord,
  ciJobs,
  copierConfig,
  jinjaVars,
  managedLabelRoster,
  read,
  trackedFiles,
  trackingManifests,
  walkFiles,
} from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

// The docs scripts/generate/targets.ts lists with markdown regions. A strip over one of
// these that removes nothing means the marker grammar drifted and every
// stripped-prose rule is silently checking unstripped text.
const DOCS_WITH_REGIONS = new Set([
  "README.md",
  "docs/new-repo.md",
  "docs/settings.md",
  "docs/pages.md",
]);

function handProse(rel: string): string {
  const { prose, regions } = stripGeneratedRegions(read(rel), rel);
  if (regions === 0 && DOCS_WITH_REGIONS.has(rel)) {
    throw new Error(
      `${rel}: stripping removed no generated regions from a doc known to ` +
        "carry them - the marker grammar drifted from scripts/generate/markers.ts",
    );
  }
  return prose;
}

/** Every `async function <name>() { ... }` block in `text`, matched from
 *  the declaration to the closing brace at the declaration's own indent,
 *  raw bytes included - for rules that pin inline script copies
 *  byte-identical. */
export function inlineFunctionCopies(text: string, name: string): string[] {
  const block = new RegExp(`^( *)async function ${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\1\\}`, "gm");
  return [...text.matchAll(block)].map((match) => match[0]);
}

/** Whether the owner-slug rule's match at `index` (its owner segment in
 *  `segment`) sits inside this repository's OWN Pages origin,
 *  `<username>.github.io/<slug>` (the dogfooded docs site's URL): the io
 *  segment must be preceded by exactly `<username>.github.` at a hostname
 *  boundary - start of text or a non-hostname character - so any other
 *  owner's Pages URL still flags, a username-suffixed near miss like
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

/** AGENTS.md's smoke-generate recipe stages a scratch build tree by hand,
 *  mirroring shared/stage_tree.ts's hermetic argv with no code twin the
 *  wiring tests can see (they pin call SITES; a doc line is not one). A rule
 *  rather than an accepted residual: a drifted recipe re-opens for the
 *  human's scratch tree the exact producer-vs-verifier skew the shared argv
 *  closed, so the doc command is derived FROM stageComposedTreeArgv and
 *  compared exactly, anchored between the recipe's init and commit legs so
 *  a vanished or moved staging command fails loudly rather than vacuously. */
export function agentsStagingMismatches(agents: string): Mismatch[] {
  const argv = stageComposedTreeArgv("/tmp/bt");
  // Joining argv with spaces is only an exact shell rendering while
  // every element is a bare word; a helper argv that ever grows an
  // element needing quoting must fail HERE, not derive a doc
  // expectation that would break a human's shell.
  for (const word of argv) {
    if (!/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) {
      throw new Error(
        `stageComposedTreeArgv: '${word}' is not a bare shell word - the recipe pin cannot render it`,
      );
    }
  }
  const expected = argv.join(" ");
  // Anchored to the smoke bullet itself (markdown bullets are one
  // source line by repo convention) and LAZY up to the first
  // staging-shaped span, so neither a staging command quoted elsewhere
  // in the doc nor a second copy later on the same bullet line can
  // stand in for the recipe's own leg.
  const recipe = mustMatch(
    agents,
    /^- Smoke-generate locally[^\n]*?`git -C \/tmp\/bt init -b build && ([^`]+?) && git -C \/tmp\/bt commit -m build`/m,
    "AGENTS.md",
    "the smoke recipe's staging command",
  )[1];
  if (recipe === expected) return [];
  return [
    {
      file: "AGENTS.md",
      expected: `the staging command '${expected}' (stageComposedTreeArgv - the recipe must stage the same bytes the producers publish)`,
      got: `'${recipe}'`,
    },
  ];
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

      // The answers-file path is spelled in four places that nothing binds
      // behaviorally end to end: copier.yml's _answers_file (where copier
      // WRITES; reads honor only the CLI flag), apply_update.ts's standing
      // --answers-file flag (the consequential one), answers_file.ts's
      // ANSWERS_PATH (the sync's filesystem reads, clean_renders.ts included),
      // and the template filename under templates/base/.github/, anchored via
      // the rendered-path derivation. One editor moving one of them alone must
      // be named here, not discovered at a fleet sync.
      const answersPath = mustMatch(
        read("copier.yml"),
        /^_answers_file: (\S+)$/m,
        "copier.yml",
        "_answers_file",
      )[1];
      const answersSites: Array<[string, string, () => string]> = [
        [
          ".github/scripts/sync/apply_update.ts",
          "--answers-file flag value",
          () =>
            argvStringAfter(
              read(".github/scripts/sync/apply_update.ts"),
              "--answers-file",
              ["--vcs-ref"],
              {
                where: ".github/scripts/sync/apply_update.ts",
                what: "the copier --answers-file argv pair",
              },
            ),
        ],
        [
          ".github/scripts/sync/answers_file.ts",
          "ANSWERS_PATH",
          () =>
            constStringValue(read(".github/scripts/sync/answers_file.ts"), "ANSWERS_PATH", {
              where: ".github/scripts/sync/answers_file.ts",
              what: "the answers boundary's path",
            }),
        ],
      ];
      for (const [rel, label, extract] of answersSites) {
        const got = extract();
        if (got !== answersPath) {
          mismatches.push({
            file: rel,
            expected: `${label} ${answersPath} (copier.yml _answers_file)`,
            got,
          });
        }
      }
      const answersTemplate = `templates/base/${answersPath}.jinja`;
      if (!existsSync(answersTemplate)) {
        mismatches.push({
          file: "templates/base",
          expected: `${answersTemplate} (the template rendering copier.yml's _answers_file path)`,
          got: "no such template file",
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

      const floor = String(copierConfig()._min_copier_version);
      if (!handProse("docs/new-repo.md").includes(`>= ${floor}`)) {
        mismatches.push({
          file: "docs/new-repo.md",
          expected: `the copier floor '>= ${floor}'`,
          got: "missing",
        });
      }

      // Anchored on the parameter table's row (like the pages cells): a
      // bare backticked "skills" occurs in the doc for unrelated reasons,
      // so only the row's Default cell can satisfy this.
      const skillsDefault = String(asRecord(copierConfig().skills_dir, "skills_dir").default);
      const skillsCell = mustMatch(
        handProse("docs/skills.md"),
        /^\| `skills_dir` \|.+\| ([^|]+) \|$/m,
        "docs/skills.md",
        "the skills_dir table row",
      )[1].trim();
      if (skillsCell !== `\`${skillsDefault}\``) {
        mismatches.push({
          file: "docs/skills.md",
          expected: `the skills_dir Default cell \`${skillsDefault}\``,
          got: skillsCell,
        });
      }

      const settingsProse = handProse("docs/settings.md");
      // Only the two labels the hand prose quotes: the per-toolchain
      // dependabot labels sit in generated dependabot-labels regions
      // (generate:check owns those). Name and color must appear in the
      // exact quoted shape `name` (`color`) / `name` (color `color`) -
      // a spannable gap would let a wrong hand-written color pass by
      // matching a backticked color later in the doc.
      const roster = new Map(managedLabelRoster().map((label) => [label.name, label]));
      for (const name of ["dependencies", "github_actions"]) {
        const label = roster.get(name);
        if (!label) throw new Error(`settings_layers.ts: label '${name}' vanished - anchor lost`);
        const joint = new RegExp(`\`${name}\` \\((?:color )?\`${label.color}\`\\)`);
        if (!joint.test(settingsProse)) {
          mismatches.push({
            file: "docs/settings.md",
            expected: `label \`${name}\` quoted as \`${name}\` (\`${label.color}\`) in hand prose`,
            got: "missing, reworded, or a different color",
          });
        }
      }

      // Every tracking stream's copier default is quoted in its module doc
      // and in docs/settings.md, whose hand prose also quotes the label
      // color (the manifest is the fragments' anchor, so the docs follow
      // the same source).
      for (const { module, tracking } of trackingManifests()) {
        for (const doc of [`docs/${module}.md`, "docs/settings.md"]) {
          if (!handProse(doc).includes(`\`${tracking.default}\``)) {
            mismatches.push({
              file: doc,
              expected: `the ${tracking.answer} default \`${tracking.default}\``,
              got: "missing",
            });
          }
        }
        if (!settingsProse.includes(`\`${tracking.color}\``)) {
          mismatches.push({
            file: "docs/settings.md",
            expected: `the ${module} tracking label color \`${tracking.color}\``,
            got: "missing",
          });
        }
      }
      return mismatches;
    },
  },
  {
    name: "agents-recipe",
    run: () => {
      const mismatches: Mismatch[] = [];
      const smoke = read(".github/scripts/ci/smoke_generate.ts");
      // Reassembled into the flag string AGENTS.md's recipe carries.
      const vcsRef = argvStringAfter(smoke, "--vcs-ref", ["--defaults", "--trust"], {
        where: "smoke_generate.ts",
        what: "copier flags",
      });
      const flags = `--vcs-ref ${vcsRef} --defaults --trust`;
      const keys = argvFlagLeads(smoke, "-d").flatMap((lead) => {
        const key = /^([a-z_]+)=/.exec(lead);
        return key === null ? [] : [key[1]];
      });
      if (keys.length === 0)
        throw new Error("smoke_generate.ts: no -d answers found - anchor lost");
      const agents = read("AGENTS.md");
      if (!agents.includes(flags)) {
        mismatches.push({
          file: "AGENTS.md",
          expected: `the copier flags '${flags}'`,
          got: "missing",
        });
      }
      for (const key of new Set(keys)) {
        if (!agents.includes(`${key}=`)) {
          mismatches.push({
            file: "AGENTS.md",
            expected: `a -d ${key}=... answer in the recipe`,
            got: "missing",
          });
        }
      }
      // The recipe's staging leg, pinned to the shared hermetic argv
      // (agentsStagingMismatches states the decision and its reason).
      mismatches.push(...agentsStagingMismatches(agents));
      return mismatches;
    },
  },
  {
    name: "owner-slug",
    run: () => {
      const mismatches: Mismatch[] = [];
      const { username, slug } = jinjaVars();
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
          // origin (the dogfooded docs site), not an owner slug.
          if (isOwnPagesOrigin(text, match.index, match[1], username)) continue;
          if (match[1].toLowerCase() === username.toLowerCase()) {
            sawExpected = true;
            continue;
          }
          mismatches.push({
            file: rel,
            expected: `${username}/${slug} (copier.yml github_username default)`,
            got: match[0],
          });
        }
      }
      if (!sawExpected)
        throw new Error(`no '${username}/${slug}' literal found anywhere - anchor lost`);
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
        "contains(fromJSON(inputs.modules), 'release-please') && github.event_name == 'pull_request' && startsWith(github.head_ref, 'release-please--')";
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
    // open_pr.ts reads run_hidden.ts capture files by name to put hidden
    // validation diagnostics into the PR body; the names derive from the
    // labels at the run_hidden call sites - inline in the sync workflow,
    // or argv arrays in the sync scripts. Rewording a label would silently
    // break that hand-off, so every referenced capture name must match a
    // label-derived one.
    name: "hidden-capture-names",
    run: () => {
      const mismatches: Mismatch[] = [];
      const labels = [
        ...[
          ...read(".github/workflows/reusable-template-sync.yml").matchAll(
            /run_hidden\.ts "([^"]+)" --/g,
          ),
        ].map((match) => match[1]),
        ...walkFiles(".github/scripts/sync")
          .filter((file) => file.path.endsWith(".ts") && !file.symlink)
          .flatMap((file) => wrappedArgvLabels(read(file.path), "run_hidden.ts")),
      ];
      if (labels.length === 0) {
        throw new Error("no run_hidden labels found in the sync call sites - anchor lost");
      }
      const derived = new Set(labels.map(captureName));
      const referenced = literalMatches(
        read(".github/scripts/sync/open_pr.ts"),
        /hidden-[A-Za-z0-9-]+\.log/g,
      );
      if (referenced.length === 0) {
        throw new Error("open_pr.ts references no hidden capture files - anchor lost");
      }
      for (const name of referenced) {
        if (!derived.has(name)) {
          mismatches.push({
            file: ".github/scripts/sync/open_pr.ts",
            expected: `a capture name derived from a run_hidden label (${[...derived].join(", ")})`,
            got: name,
          });
        }
      }
      return mismatches;
    },
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

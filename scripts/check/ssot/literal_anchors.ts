import { parse as parseYaml } from "yaml";
import { type GitIdentity, SYNC_IDENTITY } from "../../../.github/scripts/shared/git_identity.ts";
import { substitute } from "../../../.github/scripts/sync/writer/placeholders.ts";
import { PLATFORM_NAME, PLATFORM_OWNER, PLATFORM_SLUG } from "../../../actions/shared/platform.ts";
import { callCarriesLiteral, constNumberValue, constRegexSource } from "../../lib/ts_extract.ts";
import { SKELETON_SOURCE } from "./all_green.ts";
import { canonical, type Mismatch, mustMatch, stripGeneratedRegions } from "./comparison.ts";
import {
  asRecord,
  ciJobs,
  managedLabelRoster,
  read,
  repoSlug,
  trackedFiles,
  trackingStreams,
  walkFiles,
} from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";
import { stepsOf } from "./settings_workflow.ts";

// A strip that removes nothing from one of these means the marker grammar drifted from scripts/files_table.ts,
// and every stripped-prose rule would silently check unstripped text.
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

/** Pinned on the parsed documents, not a grep: a commented-out write or a stray literal would still match as text.
 *
 *  a renamed or dropped `id:` on any side   -> an empty output, which is not "true": every run skips the cut, silently
 *  the health step without `mode: release`  -> release-health.ts never writes the output at all */
export function releaseCutWiringMismatches(files: {
  workflow: string;
  action: string;
  script: string;
  skeleton: string;
}): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const workflowRel = ".github/workflows/fleet-release.yml";
  const actionRel = "actions/release-health/action.yml";
  const scriptRel = "actions/release-health/release-health.ts";
  const skeletonRel = "files/base/.github/workflows/ci.yml";

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
  const job = asRecord(jobs["release-please"] ?? {}, `${workflowRel} release-please`);
  const steps = (job.steps ?? []) as Record<string, unknown>[];
  const health = steps.find((step) =>
    String(step.uses ?? "").startsWith(`${PLATFORM_SLUG}/actions/release-health@`),
  );
  if (health === undefined || health.id !== "health") {
    mismatches.push({
      file: `${workflowRel} release-please`,
      expected: "the release-health step carries id: health",
      got: health === undefined ? "no release-health step" : `id: ${String(health.id ?? "")}`,
    });
  }
  if (health !== undefined) {
    const mode = asRecord(health.with ?? {}, `${workflowRel} health.with`).mode;
    if (mode !== "release") {
      mismatches.push({
        file: `${workflowRel} release-please step 'health'`,
        expected: "mode: release",
        got: mode === undefined ? "no mode input" : `mode: ${String(mode)}`,
      });
    }
  }
  const releasePlease = steps.filter((step) =>
    String(step.uses ?? "").startsWith("googleapis/release-please-action@"),
  );
  for (const step of releasePlease) {
    if (step.id !== "cut" && step.id !== "propose") {
      mismatches.push({
        file: `${workflowRel} release-please`,
        expected:
          "every release-please step is the cut or the propose step (a third one would tag on every push run)",
        got: `a release-please step with id: ${String(step.id ?? "")}`,
      });
    }
  }
  const cut = releasePlease.find((step) => step.id === "cut");
  const cutIf = "steps.health.outputs.release-cut == 'true'";
  if (String(cut?.if ?? "").trim() !== cutIf) {
    mismatches.push({
      file: `${workflowRel} release-please step 'cut'`,
      expected: `if: ${cutIf}`,
      got:
        cut === undefined ? "no cut step" : cut.if === undefined ? "no condition" : String(cut.if),
    });
  }
  const cutWith = asRecord(cut?.with ?? {}, `${workflowRel} cut.with`);
  if (
    cutWith["skip-github-pull-request"] !== true ||
    cutWith["skip-github-release"] !== undefined
  ) {
    mismatches.push({
      file: `${workflowRel} release-please step 'cut'`,
      expected:
        "skip-github-pull-request: true and no skip-github-release (the cut tags and does no PR work)",
      got: canonical(cut?.with ?? null),
    });
  }
  const propose = releasePlease.find((step) => step.id === "propose");
  const proposeClauses = String(propose?.if ?? "")
    .split("&&")
    .map((clause) => clause.trim());
  if (!proposeClauses.includes("steps.health.outputs.release-cut == 'false'")) {
    mismatches.push({
      file: `${workflowRel} release-please step 'propose'`,
      expected:
        "an if: carrying steps.health.outputs.release-cut == 'false' (the propose step stands down on a release-PR merge; a positive test, since an absent output passes !=)",
      got:
        propose === undefined
          ? "no propose step"
          : propose.if === undefined
            ? "no condition"
            : String(propose.if),
    });
  }
  if (
    asRecord(propose?.with ?? {}, `${workflowRel} propose.with`)["skip-github-release"] !== true
  ) {
    mismatches.push({
      file: `${workflowRel} release-please step 'propose'`,
      expected: "skip-github-release: true (the propose step never tags)",
      got: canonical(propose?.with ?? null),
    });
  }
  const lane = asRecord(job.concurrency ?? {}, `${workflowRel} release-please.concurrency`);
  const expectedLane = "release-cut-${{ inputs.sha || github.sha }}";
  if (lane.group !== expectedLane || lane["cancel-in-progress"] !== false) {
    mismatches.push({
      file: `${workflowRel} release-please`,
      expected: `concurrency group ${expectedLane} with cancel-in-progress: false (a lane no other run shares, so nothing cancels a pending cut)`,
      got: job.concurrency === undefined ? "no job lane" : canonical(job.concurrency),
    });
  }

  const skeletonText = substitute(files.skeleton, { github_username: "owner" });
  const skeletonJobs = ciJobs(asRecord(parseYaml(skeletonText), skeletonRel), skeletonRel);
  const caller = asRecord(skeletonJobs.release ?? {}, `${skeletonRel} release`);
  if (caller.concurrency !== undefined) {
    mismatches.push({
      file: `${skeletonRel} job 'release'`,
      expected:
        "no concurrency lane on the caller (a caller-side lane keeps one pending call and cancels the older one, so a release merge would lose its tag)",
      got: canonical(caller.concurrency),
    });
  }
  return mismatches;
}

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

export const AUTOMATION_PR_ACTION = "peter-evans/create-pull-request";

/** A workflow cannot import SYNC_IDENTITY, so every create-pull-request step spells it in both inputs; the action's
 *  defaults would commit as github-actions[bot] authored by whoever dispatched the run. */
export function automationPrIdentityMismatches(
  workflows: Record<string, string>,
  identity: GitIdentity,
): Mismatch[] {
  const signature = `${identity.name} <${identity.email}>`;
  const mismatches: Mismatch[] = [];
  let steps = 0;
  for (const [rel, text] of Object.entries(workflows)) {
    for (const step of stepsOf(text, rel)) {
      if (!step.uses?.startsWith(`${AUTOMATION_PR_ACTION}@`)) continue;
      steps += 1;
      const inputs = step.with ?? {};
      for (const key of ["committer", "author"]) {
        if (inputs[key] === signature) continue;
        mismatches.push({
          file: `${rel} step "${step.name ?? step.uses}"`,
          expected: `with.${key}: ${signature}`,
          got: key in inputs ? `with.${key}: ${String(inputs[key])}` : `no ${key}: on the step`,
        });
      }
    }
  }
  if (steps === 0) {
    throw new Error(`no ${AUTOMATION_PR_ACTION} step in any workflow - anchor lost`);
  }
  return mismatches;
}

const PLATFORM_NAME_SOURCE = "actions/shared/platform.ts";
const PLATFORM_NAME_CODE_DIRS = [".github/scripts/", "actions/", "scripts/"];
/** The two spellings no import can replace: a skill directory's name, and docs_check.ts's SITE_CONFIG, which the
 *  site-config-parity rule extracts as a plain string literal. */
const PLATFORM_NAME_ALLOWED_FORMS = [
  `skills/${PLATFORM_NAME}-`,
  `"site_title": "${PLATFORM_NAME}"`,
];

/** Code spells the platform's name through PLATFORM_NAME_SOURCE; a literal that reappears is a second source. Matched
 *  case-insensitively so a marker label or a heading built by hand trips too. */
export function platformNameLiteralMismatches(files: Record<string, string>): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const needle = PLATFORM_NAME.toLowerCase();
  for (const [rel, text] of Object.entries(files)) {
    text.split("\n").forEach((line, index) => {
      let rest = line;
      for (const form of PLATFORM_NAME_ALLOWED_FORMS) rest = rest.replaceAll(form, "");
      if (rest.toLowerCase().includes(needle)) {
        mismatches.push({
          file: `${rel}:${index + 1}`,
          expected: `the platform's name imported from ${PLATFORM_NAME_SOURCE}`,
          got: line.trim(),
        });
      }
    });
  }
  return mismatches;
}

export const literalAnchorRules: Rule[] = [
  {
    name: "pins-and-identities",
    run: () => {
      // TypeScript committers import shared/git_identity.ts, so only the workflow-spelled identities are judged.
      const mismatches = automationPrIdentityMismatches(
        Object.fromEntries(
          walkFiles(".github/workflows").map((f) => [f.path, read(f.path)] as const),
        ),
        SYNC_IDENTITY,
      );

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

      const settingsProse = handProse("docs/settings.md");
      // Only the two labels the hand prose quotes; the per-toolchain dependabot labels are the dependabot-label-tuples rule's.
      // Name and color are matched jointly: a spannable gap would let a wrong hand-written color pass
      // by matching a backticked color later in the doc.
      //   `name` (`color`)  or  `name` (color `color`)
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
          // <something>/<name>.<ext> is a filename inside a path (say, a
          // scratch registration), not an owner slug.
          if (/^\.[A-Za-z0-9]/.test(text.slice(match.index + match[0].length))) continue;
          // The sync branch name is not an owner slug either.
          if (match[1] === "automation") continue;
          if (isOwnPagesOrigin(text, match.index, match[1], PLATFORM_OWNER)) continue;
          if (match[1].toLowerCase() === PLATFORM_OWNER.toLowerCase()) {
            sawExpected = true;
            continue;
          }
          mismatches.push({
            file: rel,
            expected: `${PLATFORM_OWNER}/${slug} (the fleet owner)`,
            got: match[0],
          });
        }
      }
      if (!sawExpected)
        throw new Error(`no '${PLATFORM_OWNER}/${slug}' literal found anywhere - anchor lost`);
      return mismatches;
    },
  },
  {
    name: "platform-name-once",
    run: () => {
      const code = trackedFiles().filter(
        (rel) =>
          PLATFORM_NAME_CODE_DIRS.some((dir) => rel.startsWith(dir)) &&
          /\.m?ts$/.test(rel) &&
          !rel.endsWith(".test.ts") &&
          rel !== PLATFORM_NAME_SOURCE,
      );
      if (code.length === 0) throw new Error("no platform code files found - anchor lost");
      return platformNameLiteralMismatches(Object.fromEntries(code.map((rel) => [rel, read(rel)])));
    },
  },
  {
    // Compared on the parsed jobs: the two share one condition text, so a whole-file grep would stay green with one of them changed or deleted.
    //   a renamed release-please branch prefix -> the job skips and the gate stands down
    //   a dropped module clause                -> the release gates run in repositories without release-please
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
    name: "release-cut-wiring",
    run: () =>
      releaseCutWiringMismatches({
        workflow: read(".github/workflows/fleet-release.yml"),
        action: read("actions/release-health/action.yml"),
        script: read("actions/release-health/release-health.ts"),
        skeleton: read(SKELETON_SOURCE),
      }),
  },
];

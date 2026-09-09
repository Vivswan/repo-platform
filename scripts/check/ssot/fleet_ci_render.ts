// Rules over the template ci.yml's rendered gate shape and the pr-title
// module's natively-required check.

import { parse as parseYaml } from "yaml";
import { type JinjaVars, renderJinjaFile } from "../../lib/jinja_subset.ts";
import { canonical, type Mismatch, setMismatch } from "./comparison.ts";
import { asRecord, jinjaVars, read } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** Another module's leg this one runs AFTER when that module is selected:
 *  a needs edge and a `!cancelled()` clause, both under that module's
 *  jinja gate. The clause makes the edge an ORDER, not a gate: GitHub's
 *  implied success() would skip the leg behind a failed or skipped
 *  upstream, while the spelled-out gate clauses keep deciding. */
export interface LegOrder {
  job: string;
  module: string;
}

/** The clause that makes an ordering edge an order: the status function
 *  disarms GitHub's implied success() on the needs list. */
const ORDER_CLAUSE = "      !cancelled() &&";

/** The spellings of a LegOrder's jinja gate: inline on the needs line, and
 *  whitespace-stripping around the ORDER_CLAUSE line only while that
 *  clause is gated (an unconditional order edge in `ordered` makes the
 *  clause unconditional, so the block pair must be absent). */
function orderTags(after: LegOrder | null, ordered: string[]): string[] {
  if (after === null) return [];
  const inline = [`{% if '${after.module}' in modules %}`, "{% endif %}"];
  if (ordered.length > 0) return inline;
  return [...inline, `{%- if '${after.module}' in modules %}`, "{%- endif %}"];
}

/** The folded job-level condition of a gate-downstream caller: green
 *  results of `upstream`, spelled out, on a push to main, led by the
 *  `!cancelled()` clause when the leg has order edges: unconditional when
 *  `ordered` names always-present jobs, else under the `after` ordering's
 *  jinja gate when there is one. */
export function downstreamGateBlock(
  upstream: string[],
  after: LegOrder | null = null,
  ordered: string[] = [],
): string {
  const orderClause =
    ordered.length > 0
      ? [ORDER_CLAUSE]
      : after === null
        ? []
        : [`{%- if '${after.module}' in modules %}`, ORDER_CLAUSE, "{%- endif %}"];
  return [
    "    if: >-",
    ...orderClause,
    ...upstream.map((job) => `      needs.${job}.result == 'success' &&`),
    "      github.event_name == 'push' &&",
    "      github.ref == 'refs/heads/main'",
  ].join("\n");
}

/** Pins the condition as one adjacent block that also ENDS the folded
 *  scalar: a continuation (an || arm, even past blank lines) would weaken
 *  the gate while the block pin stayed satisfied. */
function pinDownstreamGate(
  text: string,
  block: string,
  file: string,
  what: string,
  mismatches: Mismatch[],
): void {
  const at = text.indexOf(block);
  if (at === -1) {
    mismatches.push({
      file,
      expected: `${what} carrying the verbatim gate block (${block
        .split("\n")
        .slice(1)
        .filter((line) => !line.startsWith("{%"))
        .map((line) => line.trim().replace(/ &&$/, ""))
        .join(
          ", ",
        )}) - dropping any clause releases post-gate work off unjudged, red, or PR-shaped runs`,
      got: "missing or reshaped",
    });
    return;
  }
  const nextLine =
    text
      .slice(at + block.length)
      .split("\n")
      .slice(1)
      .find((line) => line.trim() !== "") ?? "";
  if (/^ {6,}/.test(nextLine)) {
    mismatches.push({
      file,
      expected: `${what}'s gate block ending the if: scalar (a continuation line after it could re-weaken the gate)`,
      got: nextLine.trim(),
    });
  }
}

/** The grants under `    permissions:` at `start`, to the first dedent.
 *  A non-canonical line (a quoted `"write"`) is returned verbatim so the
 *  ceiling census fails closed on it. */
function permissionGrants(lines: string[], start: number): string[] {
  const grants: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^ {6}/.test(line)) break;
    grants.push(/^ {6}([a-z-]+: (?:read|write))$/.exec(line)?.[1] ?? line.trim());
  }
  return grants;
}

/** The lines of the job `id`'s own block: from its key to the next
 *  job-indent key or compose anchor. Empty when the job is absent. */
function jobBlock(lines: string[], id: string): string[] {
  const at = lines.indexOf(`  ${id}:`);
  if (at === -1) return [];
  const end = lines.findIndex(
    (line, index) =>
      index > at && (/^ {2}[A-Za-z0-9_-]+:/.test(line) || line.startsWith("{# compose:")),
  );
  return lines.slice(at + 1, end === -1 ? undefined : end);
}

/** `key :` at any depth: YAML reads it as `key:`, the censuses do not. */
const SPACED_KEY = /^\s*(?:-\s+)?[A-Za-z0-9_-]+\s+:(?:\s|$)/;

/** Keys repeated under one parent in a job block, at any depth (YAML's
 *  last duplicate wins silently). Indent-driven over jinja source; each
 *  `- ` item is its own mapping. */
export function duplicateJobKeys(block: string[]): string[] {
  const seen = new Map<string, number>();
  const stack: { indent: number; path: string }[] = [];
  let items = 0;
  for (const line of block) {
    const match = /^( *)(-\s+)?([A-Za-z0-9_-]+):/.exec(line);
    if (match === null) continue;
    const dashAt = match[1].length;
    const keyAt = dashAt + (match[2]?.length ?? 0);
    if (match[2] !== undefined) {
      while (stack.length > 0 && stack[stack.length - 1].indent >= dashAt) stack.pop();
      const parent = stack.length > 0 ? stack[stack.length - 1].path : "";
      stack.push({ indent: dashAt, path: `${parent}[${items++}]` });
    }
    while (stack.length > 0 && stack[stack.length - 1].indent >= keyAt) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1].path : "";
    const path = parent === "" ? match[3] : `${parent}.${match[3]}`;
    seen.set(path, (seen.get(path) ?? 0) + 1);
    stack.push({ indent: keyAt, path });
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([path]) => path);
}

/** YAML's alternate key spellings parse identically but evade the
 *  bare-key line censuses: quoted (`"push":`), explicit-key (`? push`),
 *  anchored, tagged, alias, and explicit-value lines, and `key :` with
 *  whitespace before the colon. Nothing in the pinned files legitimately
 *  opens a line with any of those, so they are refused as an alphabet. */
function keySpellingMismatches(line: string, file: string): Mismatch[] {
  const mismatches: Mismatch[] = [];
  if (/^\s*["'?&!*:]/.test(line)) {
    mismatches.push({
      file,
      expected:
        "no quoted, explicit-key, anchored, tagged, alias, or explicit-value lines (every YAML spelling beyond bare keys evades the censuses)",
      got: line.trim(),
    });
  }
  if (SPACED_KEY.test(line)) {
    mismatches.push({
      file,
      expected:
        "no whitespace before a mapping colon at any depth (`key :` parses as `key:` but evades every key census)",
      got: line.trim(),
    });
  }
  return mismatches;
}

/** The anchors ci.yml's jobs region may carry: the fleet-ci call's
 *  with-block data anchor and one anchor per gate-downstream module leg
 *  (each leg's fragment is pinned by spliceLegMismatches). */
export const LEG_ANCHORS = [
  "{# compose:codeql-languages #}",
  "{# compose:all-green-pages #}",
  "{# compose:all-green-docs-site #}",
  "{# compose:all-green-release #}",
];

/** A gate-downstream leg a module splices into ci.yml through its
 *  anchor: exactly one caller job, released only by the spelled-out green
 *  results of its upstream jobs on a push to main, holding its own lane,
 *  calling a repo-local workflow with the judged sha under an
 *  additive-closed permissions ceiling. The pages, docs-site, and
 *  release-please modules each ship one; this is the shape they share. */
export interface SpliceLeg {
  legRel: string;
  jobId: string;
  /** The jobs the leg needs, in needs-list order; each is also a
   *  spelled-out gate clause. */
  upstream: string[];
  /** Why the needs list is exactly `upstream` plus the order edges. */
  needsWhy: string;
  /** Always-present jobs the leg is ordered behind without gating on
   *  them (needs edges after `upstream`, with an unconditional
   *  `!cancelled()` clause so their red or skip never holds the leg). */
  ordered: string[];
  /** The leg this one is ordered behind on repositories selecting that
   *  module; null orders behind nothing. */
  after: LegOrder | null;
  lane: string;
  laneWhy: string;
  uses: string;
  usesWhy: string;
  permissions: string[];
  /** Why `secrets: inherit` rides the leg; null bans the line - a leg
   *  whose called workflow reads no secrets passes none. */
  secretsWhy: string | null;
}

/** One spliced leg's fragment against its SpliceLeg model: jinja-minimal
 *  text (inline {% raw %} pairs, plus the `after` ordering's gate tags
 *  exactly once each where the needs and gate pins place them - any other
 *  tag or comment could hide a pinned line while rendering without it;
 *  the composer supplies the module gate around the whole fragment), one
 *  job, one needs line, one if:, the gate block, and each load-bearing
 *  line exactly once (YAML's last duplicate wins silently, so a compliant
 *  copy next to a gutted one must be loud). */
export function spliceLegMismatches(legText: string, leg: SpliceLeg): Mismatch[] {
  const { legRel, jobId } = leg;
  const mismatches: Mismatch[] = [];
  const allowedTags = orderTags(leg.after, leg.ordered);
  for (const tag of allowedTags) {
    const count = legText.split(tag).length - 1;
    if (count !== 1) {
      mismatches.push({
        file: legRel,
        expected: `the ordering tag ${JSON.stringify(tag)} exactly once, on the needs line or around the !cancelled() clause (a tag anywhere else could hide a pinned line from repositories without '${leg.after?.module}')`,
        got: count === 0 ? "missing" : `${count} occurrences`,
      });
    }
  }
  for (const [index, line] of legText.split("\n").entries()) {
    if (line.split("{% raw %}").length !== line.split("{% endraw %}").length) {
      mismatches.push({
        file: `${legRel}:${index + 1}`,
        expected:
          "raw/endraw paired on one line (inline expression wrapping only - a multiline raw block smuggles text past the jinja ban)",
        got: line.trim(),
      });
      continue;
    }
    let stripped = line.replaceAll("{% raw %}", "").replaceAll("{% endraw %}", "");
    for (const tag of allowedTags) stripped = stripped.replace(tag, "");
    if (stripped.includes("{%") || stripped.includes("{#") || stripped.includes("#}")) {
      mismatches.push({
        file: `${legRel}:${index + 1}`,
        expected:
          "no jinja tags or comments in the fragment beyond {% raw %} pairs and the ordering gate (the composer supplies the module gate; a tag-wrapped or commented copy would satisfy the textual pins while rendering to nothing)",
        got: line.trim(),
      });
    }
    // An expression outside raw is jinja to copier: it renders mangled
    // or empty instead of reaching GitHub.
    if (line.includes("${{") && !line.includes("{% raw %}")) {
      mismatches.push({
        file: `${legRel}:${index + 1}`,
        expected: "every ${{ }} expression wrapped in {% raw %} (jinja eats a bare one)",
        got: line.trim(),
      });
    }
    // ORDER_CLAUSE opens with `!`, the tag indicator the alphabet refuses
    // at line start; inside the pinned folded if: scalar it is content.
    if (line !== ORDER_CLAUSE) mismatches.push(...keySpellingMismatches(line, legRel));
    // Every job-indent line must be a bare key.
    if (/^ {2}[^ \t#]/.test(line) && !/^ {2}[A-Za-z0-9_-]+:$/.test(line)) {
      mismatches.push({
        file: legRel,
        expected:
          "every job-indent line spelled as a bare `key:` with nothing after it (an inline flow mapping carries if:/needs: keys the line censuses cannot see; any other spelling is a job the census cannot see)",
        got: line.trim(),
      });
    }
  }
  const legJobs = [...legText.matchAll(/^ {2}([A-Za-z0-9_-]+):(?: |$)/gm)].map((match) => match[1]);
  if (legJobs.length === 0) {
    throw new Error(`${legRel}: no job id - anchor lost`);
  }
  // Exactly ONE job, by design: with a second job in the fragment, a
  // decoy could carry the pinned lines while the real job lost them.
  if (canonical(legJobs) !== canonical([jobId])) {
    mismatches.push({
      file: legRel,
      expected: `exactly one spliced job, '${jobId}' (a decoy second job could carry the pinned lines while the ${jobId} job lost them)`,
      got: legJobs.join(", "),
    });
  }
  const legLines = legText.split("\n");
  for (const key of duplicateJobKeys(jobBlock(legLines, jobId))) {
    mismatches.push({
      file: `${legRel} job '${jobId}'`,
      expected: `the key '${key}' once (YAML's last duplicate wins silently, shadowing the pinned value)`,
      got: "a duplicate key",
    });
  }
  const orderedNeed =
    leg.after === null
      ? ""
      : `{% if '${leg.after.module}' in modules %}, ${leg.after.job}{% endif %}`;
  const needsLine = `    needs: [${[...leg.upstream, ...leg.ordered].join(", ")}${orderedNeed}]`;
  const legNeedsLines = legLines.filter((line) => /^ {4}needs:/.test(line));
  if (canonical(legNeedsLines) !== canonical([needsLine])) {
    mismatches.push({
      file: legRel,
      expected: `exactly one needs: line, ${JSON.stringify(needsLine)} (a rival needs key silently wins in YAML; ${leg.needsWhy})`,
      got: legNeedsLines.join(" | ") || "no needs lines",
    });
  }
  if (/^\s+(strategy|continue-on-error):/m.test(legText)) {
    mismatches.push({
      file: legRel,
      expected: `no strategy: or continue-on-error: in the ${jobId} leg`,
      got: "a banned key",
    });
  }
  // One if: only - YAML lets a duplicate key win silently, so a second
  // condition could shadow the pinned block below.
  const ifCount = legLines.filter((line) => /^ {4}if:/.test(line)).length;
  if (ifCount !== 1) {
    mismatches.push({
      file: legRel,
      expected: "exactly one job-level if: (a duplicate key could shadow the gate condition)",
      got: `${ifCount} if: lines`,
    });
  }
  // The gate condition: released only by green upstream results on a
  // push to main.
  pinDownstreamGate(
    legText,
    downstreamGateBlock(leg.upstream, leg.after, leg.ordered),
    legRel,
    `the ${jobId} job`,
    mismatches,
  );
  const ordering = [
    ...(leg.ordered.length > 0 ? [`, ordered behind ${leg.ordered.join(" and ")}`] : []),
    ...(leg.after === null
      ? []
      : [`, ordered behind ${leg.after.job} where '${leg.after.module}' is selected`]),
  ].join("");
  const legPins: [string, string][] = [
    [
      needsLine,
      `the ${jobId} leg runs downstream of ${leg.upstream.join(" and ")}${ordering}, nothing else`,
    ],
    ["    concurrency:", `${jobId} runs serialize in their own lane; an unserialized pair races`],
    [`      group: ${leg.lane}`, leg.laneWhy],
    [
      "      cancel-in-progress: false",
      "a cancelled half-finished run leaves its shared state wedged",
    ],
    [`    uses: ${leg.uses}`, leg.usesWhy],
    [
      "      sha: {% raw %}${{ github.sha }}{% endraw %}",
      "the JUDGED commit, explicit - same-run today, and the explicit pass is what keeps a future caller honest",
    ],
  ];
  if (leg.secretsWhy !== null) legPins.push(["    secrets: inherit", leg.secretsWhy]);
  for (const [line, why] of legPins) {
    const count = legLines.filter((candidate) => candidate === line).length;
    if (count !== 1) {
      mismatches.push({
        file: legRel,
        expected: `the line ${JSON.stringify(line)} exactly once (${why})`,
        got: count === 0 ? "missing" : `${count} occurrences`,
      });
    }
  }
  if (leg.secretsWhy === null) {
    for (const line of legLines.filter((candidate) => /^ {4}secrets:/.test(candidate))) {
      mismatches.push({
        file: legRel,
        expected: `no secrets: on the ${jobId} leg (the called workflow reads none; passing them widens what a called run can reach)`,
        got: line.trim(),
      });
    }
  }
  // The permissions ceiling, additive-closed: the pins prove the needed
  // grants present, this census refuses extras riding to every
  // selecting repository silently.
  const permissionsAt = legLines.indexOf("    permissions:");
  if (permissionsAt === -1) {
    mismatches.push({
      file: legRel,
      expected: `a job-level permissions: ceiling for the called ${jobId} workflow`,
      got: "missing",
    });
  } else {
    mismatches.push(
      ...setMismatch(
        `${legRel} ${jobId} permissions ceiling`,
        leg.permissions,
        permissionGrants(legLines, permissionsAt),
      ),
    );
  }
  return mismatches;
}

/** The pages module's gate-downstream leg and its two called halves: the
 *  fragment (spliceLegMismatches' model, ordered behind the release leg
 *  where release-please is selected), the managed pages.yml it calls
 *  (judged sha passed on, NO push trigger, so the deploy's only way onto
 *  main is downstream of the gate; nightly and dispatch kept; the lane
 *  keyed per run on a call), and reusable-pages.yml's sha input. Source
 *  pins are line censuses over jinja, so the RENDERED shape is judged too:
 *  the all-modules and pages-no-release-please goldens, one per arm. */
export function pagesLegMismatches(
  pagesLegText: string,
  pagesWorkflowText: string,
  reusablePagesText: string,
  rendered: { pagesText: string; ciText: string; ciTextNoRelease: string },
): Mismatch[] {
  const pagesRel = "templates/pages/.github/workflows/pages.yml.jinja";
  const reusableRel = ".github/workflows/reusable-pages.yml";
  const mismatches = spliceLegMismatches(pagesLegText, {
    legRel: "templates/pages/fragments/all-green-pages.jinja",
    jobId: "pages",
    upstream: ["all-green"],
    needsWhy:
      "the deploy waits on the gate, and on the release leg only as an order - an ungated edge to the hook or the release leg would let a red one hold the site back",
    ordered: [],
    after: { job: "release", module: "release-please" },
    lane: "pages",
    laneWhy:
      "the lane every deploy holds (pages.yml takes it at workflow level on its nightly and dispatch runs and keys a called run per run, so the call never waits on its caller's lane)",
    uses: "./.github/workflows/pages.yml",
    usesWhy:
      "the leg calls the managed pages.yml by local path, where the deploy's inputs live once",
    permissions: ["contents: read", "pages: write", "id-token: write", "issues: write"],
    secretsWhy: null,
  });
  const lines = pagesWorkflowText.split("\n");
  const pins: [string, string][] = [
    [
      "  schedule:",
      "the nightly rebuild stays (tags created without a push and pipeline updates land there)",
    ],
    ["  workflow_dispatch:", "the manual rebuild stays"],
    [
      "  group: {% raw %}${{ inputs.sha != '' && format('pages-called-{0}', github.run_id) || 'pages' }}{% endraw %}",
      "the pages lane on nightly and dispatch runs, a per-run group on a call (ci.yml's pages job holds the lane; a called workflow waiting on it self-deadlocks)",
    ],
    [
      "      sha: {% raw %}${{ inputs.sha }}{% endraw %}",
      "the judged commit rides on to reusable-pages, whose checkout builds it",
    ],
  ];
  for (const [line, why] of pins) {
    const count = lines.filter((candidate) => candidate === line).length;
    if (count !== 1) {
      mismatches.push({
        file: pagesRel,
        expected: `the line ${JSON.stringify(line)} exactly once (${why})`,
        got: count === 0 ? "missing" : `${count} occurrences`,
      });
    }
  }
  const callBlock = ["on:", "  workflow_call:", "    inputs:", "      sha:"].join("\n");
  if (pagesWorkflowText.split(callBlock).length !== 2) {
    mismatches.push({
      file: pagesRel,
      expected: `the verbatim block starting ${JSON.stringify("on:")} exactly once (the workflow_call must declare the sha input the leg passes - an undeclared input fails the call outright, fleet-wide)`,
      got: "missing, reshaped, or duplicated",
    });
  }
  // The trigger ban reads bare lines, so the alternate spellings that
  // would smuggle a `"push":` past it are refused file-wide first.
  for (const line of lines) mismatches.push(...keySpellingMismatches(line, pagesRel));
  for (const trigger of ["push", "pull_request"]) {
    if (lines.some((line) => new RegExp(`^ {2}${trigger}:`).test(line))) {
      mismatches.push({
        file: pagesRel,
        expected: `no ${trigger}: trigger (a deploy on ${trigger} bypasses the all-green gate; the deploy's way onto main is ci.yml's pages leg)`,
        got: `a ${trigger}: trigger`,
      });
    }
  }
  // reusable-pages.yml's half, parsed (the file is plain YAML): the sha
  // input declared, and the checkout reading it first.
  const reusable = asRecord(parseYaml(reusablePagesText), reusableRel);
  const call = asRecord(
    asRecord(reusable.on ?? {}, `${reusableRel} on`).workflow_call ?? {},
    `${reusableRel} workflow_call`,
  );
  if (!("sha" in asRecord(call.inputs ?? {}, `${reusableRel} inputs`))) {
    mismatches.push({
      file: reusableRel,
      expected:
        "a workflow_call input named sha (pages.yml passes it; an undeclared input fails every deploy outright)",
      got: "no such input",
    });
  }
  const jobs = asRecord(reusable.jobs ?? {}, `${reusableRel} jobs`);
  const steps = (asRecord(jobs.deploy ?? {}, `${reusableRel} deploy`).steps ?? []) as Record<
    string,
    unknown
  >[];
  const checkout = steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
  if (checkout === undefined) throw new Error(`${reusableRel}: no checkout step - anchor lost`);
  const ref = String(asRecord(checkout.with ?? {}, `${reusableRel} checkout with`).ref ?? "");
  if (!ref.startsWith("${{ inputs.sha || ")) {
    mismatches.push({
      file: reusableRel,
      expected:
        "the deploy checkout's ref starting `${{ inputs.sha || ` (the caller's judged commit wins; a checkout ignoring it builds a commit the gate never judged)",
      got: ref || "no ref",
    });
  }
  // The rendered shape, parsed.
  const goldenRel = "tests/golden-renders/all-modules/.github/workflows";
  const renderedPages = asRecord(parseYaml(rendered.pagesText), `${goldenRel}/pages.yml`);
  const triggers = asRecord(renderedPages.on ?? {}, `${goldenRel}/pages.yml on`);
  mismatches.push(
    ...setMismatch(
      `${goldenRel}/pages.yml triggers (the rendered deploy runs only as ci.yml's called leg, nightly, and by hand - any other trigger deploys off an unjudged commit)`,
      ["workflow_call", "schedule", "workflow_dispatch"],
      Object.keys(triggers),
    ),
  );
  const deployWith = asRecord(
    asRecord(
      asRecord(renderedPages.jobs ?? {}, `${goldenRel}/pages.yml jobs`).deploy ?? {},
      "deploy",
    ).with ?? {},
    `${goldenRel}/pages.yml deploy with`,
  );
  if (deployWith.sha !== "${{ inputs.sha }}") {
    mismatches.push({
      file: `${goldenRel}/pages.yml`,
      expected: "the rendered deploy passing sha: ${{ inputs.sha }} on to reusable-pages",
      got: canonical(deployWith.sha ?? null),
    });
  }
  // Both arms of the ordering gate, as the folded if: GitHub reads.
  const gateIf =
    "needs.all-green.result == 'success' && github.event_name == 'push' && github.ref == 'refs/heads/main'";
  const arms: [string, string, { needs: string[]; if: string }][] = [
    [
      `${goldenRel}/ci.yml`,
      rendered.ciText,
      { needs: ["all-green", "release"], if: `!cancelled() && ${gateIf}` },
    ],
    [
      "tests/golden-renders/pages-no-release-please/.github/workflows/ci.yml",
      rendered.ciTextNoRelease,
      { needs: ["all-green"], if: gateIf },
    ],
  ];
  for (const [ciRel, ciText, arm] of arms) {
    const renderedCi = asRecord(parseYaml(ciText), ciRel);
    const pagesJob = asRecord(
      asRecord(renderedCi.jobs ?? {}, `${ciRel} jobs`).pages ?? {},
      `${ciRel} pages`,
    );
    const renderedLeg = {
      needs: pagesJob.needs ?? null,
      if: pagesJob.if ?? null,
      uses: pagesJob.uses ?? null,
      sha: asRecord(pagesJob.with ?? {}, `${ciRel} pages with`).sha ?? null,
    };
    const expectedLeg = {
      ...arm,
      uses: "./.github/workflows/pages.yml",
      sha: "${{ github.sha }}",
    };
    if (canonical(renderedLeg) !== canonical(expectedLeg)) {
      mismatches.push({
        file: `${ciRel} job 'pages'`,
        expected: `the rendered leg needing ${arm.needs.join(" and ")} under the gate condition, calling pages.yml by local path with the judged sha: ${canonical(expectedLeg)}`,
        got: canonical(renderedLeg),
      });
    }
  }
  return mismatches;
}

/** The lines of a job block that pin its shape: comments and blank lines
 *  dropped. */
function pinnedLines(lines: string[]): string[] {
  return lines.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

/** The docs-site module's gate-downstream leg: the fragment
 *  (spliceLegMismatches' model, ORDERED behind the hook always and behind
 *  the release leg where release-please is selected, under an
 *  unconditional `!cancelled()`: a tag minted this run lands on this
 *  deploy, a red or skipped hook or release never holds the site back),
 *  the called docs-site.yml (the pull_request check kept, the
 *  workflow_call with the sha input, the lane keyed per called run, the
 *  sha handed on, NO push trigger), and the rendered shapes, parsed: the
 *  docs-site-release-please golden carries the three-edge leg and the
 *  callable workflow, the all-modules golden (pages too) carries neither -
 *  the fragment condition in the module manifest collapses the leg there.
 *  This repository dogfoods the standalone shape by hand in its own ci.yml
 *  (not a rendered file): its docs-site job is held equal to the
 *  fragment's release-free arm, rendered with the shared jinja subset. */
export function docsSiteLegMismatches(
  legText: string,
  docsSiteWorkflowText: string,
  rendered: {
    standalone: { ciText: string; docsSiteText: string };
    composed: { ciText: string; docsSiteText: string };
  },
  ownCiText: string,
  vars: JinjaVars,
): Mismatch[] {
  const legRel = "templates/docs-site/fragments/all-green-docs-site.jinja";
  const workflowRel = "templates/docs-site/.github/workflows/docs-site.yml.jinja";
  const ownRel = ".github/workflows/ci.yml";
  const after: LegOrder = { job: "release", module: "release-please" };
  const mismatches = spliceLegMismatches(legText, {
    legRel,
    jobId: "docs-site",
    upstream: ["all-green"],
    needsWhy:
      "the deploy waits on the gate, then on the hook and the release leg as ORDER edges only (a tag minted this run lands on this deploy; their red or skip never holds the site back)",
    ordered: ["post-green"],
    after,
    lane: "pages",
    laneWhy:
      "the lane every deploy holds (docs-site.yml's deploy takes it on its nightly and dispatch runs and keys a called run per run, so the call never waits on its caller's lane)",
    uses: "./.github/workflows/docs-site.yml",
    usesWhy:
      "the leg calls the managed docs-site.yml by local path, where the deploy's inputs live once",
    permissions: ["contents: read", "pages: write", "id-token: write", "issues: write"],
    secretsWhy: null,
  });
  // The called workflow's half, at the jinja source: the pull_request check
  // stays, the call and the rebuilds render under the pages-free gate, the
  // lane keys per called run, the sha rides on, and nothing deploys on push.
  const lines = docsSiteWorkflowText.split("\n");
  const pins: [string, string][] = [
    ["  pull_request:", "the strict docs check on every PR touching docs/ stays"],
    [
      "  schedule:",
      "the nightly rebuild stays (theme updates and tags created without a push land there)",
    ],
    ["  workflow_dispatch:", "the manual rebuild stays"],
    [
      "      group: {% raw %}${{ inputs.sha != '' && format('pages-called-{0}', github.run_id) || 'pages' }}{% endraw %}",
      "the pages lane on nightly and dispatch runs, a per-run group on a call (ci.yml's docs-site job holds the lane; a called workflow waiting on it self-deadlocks)",
    ],
    [
      "      sha: {% raw %}${{ inputs.sha }}{% endraw %}",
      "the judged commit rides on to reusable-pages, whose checkout builds it",
    ],
  ];
  for (const [line, why] of pins) {
    const count = lines.filter((candidate) => candidate === line).length;
    if (count !== 1) {
      mismatches.push({
        file: workflowRel,
        expected: `the line ${JSON.stringify(line)} exactly once (${why})`,
        got: count === 0 ? "missing" : `${count} occurrences`,
      });
    }
  }
  const callBlock = [
    "{% if 'pages' not in modules %}  workflow_call:",
    "    inputs:",
    "      sha:",
  ].join("\n");
  if (docsSiteWorkflowText.split(callBlock).length !== 2) {
    mismatches.push({
      file: workflowRel,
      expected: `the verbatim block starting ${JSON.stringify(callBlock.split("\n")[0])} exactly once (the workflow_call, under the pages-free gate, must declare the sha input the leg passes - an undeclared input fails the call outright, fleet-wide)`,
      got: "missing, reshaped, or duplicated",
    });
  }
  for (const line of lines) mismatches.push(...keySpellingMismatches(line, workflowRel));
  if (lines.some((line) => /^ {2}push:/.test(line))) {
    mismatches.push({
      file: workflowRel,
      expected:
        "no push: trigger (a deploy on push bypasses the all-green gate and races the build publish; the deploy's way onto main is ci.yml's docs-site leg)",
      got: "a push: trigger",
    });
  }
  // The rendered shapes, parsed.
  const goldenRel = (arm: "standalone" | "composed") =>
    `tests/golden-renders/${arm === "standalone" ? "docs-site-release-please" : "all-modules"}/.github/workflows`;
  const renderedDocsSite = (arm: "standalone" | "composed") => {
    const doc = asRecord(parseYaml(rendered[arm].docsSiteText), `${goldenRel(arm)}/docs-site.yml`);
    return {
      triggers: Object.keys(asRecord(doc.on ?? {}, `${goldenRel(arm)}/docs-site.yml on`)),
      jobs: asRecord(doc.jobs ?? {}, `${goldenRel(arm)}/docs-site.yml jobs`),
    };
  };
  const standalone = renderedDocsSite("standalone");
  mismatches.push(
    ...setMismatch(
      `${goldenRel("standalone")}/docs-site.yml triggers (the rendered deploy runs as ci.yml's called leg, nightly, and by hand, and the check on pull requests - any other trigger deploys off an unjudged commit)`,
      ["pull_request", "workflow_call", "schedule", "workflow_dispatch"],
      standalone.triggers,
    ),
  );
  const deployWith = asRecord(
    asRecord(standalone.jobs.deploy ?? {}, "deploy").with ?? {},
    `${goldenRel("standalone")}/docs-site.yml deploy with`,
  );
  if (deployWith.sha !== "${{ inputs.sha }}") {
    mismatches.push({
      file: `${goldenRel("standalone")}/docs-site.yml`,
      expected: "the rendered deploy passing sha: ${{ inputs.sha }} on to reusable-pages",
      got: canonical(deployWith.sha ?? null),
    });
  }
  const composed = renderedDocsSite("composed");
  mismatches.push(
    ...setMismatch(
      `${goldenRel("composed")}/docs-site.yml triggers (with pages carrying the site, only the pull_request check renders)`,
      ["pull_request"],
      composed.triggers,
    ),
    ...setMismatch(
      `${goldenRel("composed")}/docs-site.yml jobs (with pages carrying the site, only the check job renders)`,
      ["check"],
      Object.keys(composed.jobs),
    ),
  );
  const renderedJob = (arm: "standalone" | "composed") =>
    asRecord(
      asRecord(parseYaml(rendered[arm].ciText), `${goldenRel(arm)}/ci.yml`).jobs ?? {},
      `${goldenRel(arm)}/ci.yml jobs`,
    )["docs-site"];
  const standaloneJob = asRecord(renderedJob("standalone") ?? {}, "docs-site");
  const renderedLeg = {
    needs: standaloneJob.needs ?? null,
    if: standaloneJob.if ?? null,
    uses: standaloneJob.uses ?? null,
    sha:
      asRecord(standaloneJob.with ?? {}, `${goldenRel("standalone")}/ci.yml docs-site with`).sha ??
      null,
  };
  const expectedLeg = {
    needs: ["all-green", "post-green", "release"],
    if: "!cancelled() && needs.all-green.result == 'success' && github.event_name == 'push' && github.ref == 'refs/heads/main'",
    uses: "./.github/workflows/docs-site.yml",
    sha: "${{ github.sha }}",
  };
  if (canonical(renderedLeg) !== canonical(expectedLeg)) {
    mismatches.push({
      file: `${goldenRel("standalone")}/ci.yml job 'docs-site'`,
      expected: `the rendered leg ordered behind the hook and the release leg, gated on the all-green result past a cancelled check, calling docs-site.yml by local path with the judged sha: ${canonical(expectedLeg)}`,
      got: canonical(renderedLeg),
    });
  }
  if (renderedJob("composed") !== undefined) {
    mismatches.push({
      file: `${goldenRel("composed")}/ci.yml`,
      expected:
        "no docs-site job (pages carries the site there; the fragment condition in templates/docs-site/module.yml collapses the leg)",
      got: "a docs-site job",
    });
  }
  // This repository's hand-written twin of the release-free arm. A tag
  // beyond the ordering gate already failed the jinja ban above; the
  // renderer throws on it, reported here rather than losing the findings.
  let armBlock: string[] | null = null;
  try {
    const armText = renderJinjaFile(legText, vars, { [`'${after.module}' in modules`]: false });
    armBlock = pinnedLines(jobBlock(armText.split("\n"), "docs-site"));
  } catch (error) {
    mismatches.push({
      file: legRel,
      expected:
        "a fragment the shared jinja subset renders with the release ordering as its only condition",
      got: error instanceof Error ? error.message : String(error),
    });
  }
  const ownBlock = pinnedLines(jobBlock(ownCiText.split("\n"), "docs-site"));
  if (ownBlock.length === 0) {
    mismatches.push({
      file: ownRel,
      expected:
        "a docs-site job (this repository dogfoods the docs-site module; its ci.yml is hand-written, so the leg is carried by hand and held to the fragment here)",
      got: "no such job",
    });
  } else if (armBlock !== null && canonical(ownBlock) !== canonical(armBlock)) {
    mismatches.push({
      file: `${ownRel} job 'docs-site'`,
      expected: `the fragment's release-free arm, comments aside: ${canonical(armBlock)}`,
      got: canonical(ownBlock),
    });
  }
  return mismatches;
}

/** The fleet gate's render shape at the jinja SOURCE, pinned as exact
 *  lines against a maintainer's accidental omission (the rendered shape is
 *  asserted by verify_smoke_gating.sh); docs/all-green.md has the model. */
export function fleetCiRenderMismatches(
  ciTemplateText: string,
  releaseLegText: string,
  releaseWorkflowText: string,
): Mismatch[] {
  const ciRel = "templates/base/.github/workflows/ci.yml.jinja";
  const legRel = "templates/release-please/fragments/all-green-release.jinja";
  const releaseRel = "templates/release-please/.github/workflows/release.yml.jinja";
  const mismatches: Mismatch[] = [];
  const jobsAt = ciTemplateText.indexOf("\njobs:\n");
  if (jobsAt === -1) throw new Error(`${ciRel}: no jobs: section - anchor lost`);
  const jobIds = [...ciTemplateText.slice(jobsAt).matchAll(/^ {2}([A-Za-z0-9_-]+):(?: |$)/gm)].map(
    (match) => match[1],
  );
  if (canonical(jobIds) !== canonical(["checks", "ci", "all-green", "post-green"])) {
    mismatches.push({
      file: ciRel,
      expected:
        "exactly the 'checks' and 'ci' caller jobs, the 'all-green' gate, and the " +
        "gate-downstream 'post-green' hook caller (every fleet gate lives inside the two calls; " +
        "the pages, docs-site, and release legs splice through their anchors, and a job added " +
        "here would gate every repo with no roster to make it loud)",
      got: jobIds.join(", ") || "no job ids",
    });
  }
  // Line censuses over the jobs region; each mismatch message states
  // its why. 4-space only: the gate's with-block passes a `needs:` INPUT
  // at step depth, which is data, not a YAML job key.
  const needsLines = ciTemplateText
    .slice(jobsAt)
    .split("\n")
    .filter((line) => /^ {4}needs:/.test(line));
  if (
    canonical([...needsLines].sort()) !==
    canonical(["    needs: [all-green]", "    needs: [checks, ci]"])
  ) {
    mismatches.push({
      file: ciRel,
      expected:
        'exactly two needs: lines, "    needs: [checks, ci]" on the gate and "    needs: [all-green]" on the post-green hook (a rival needs key on any job silently wins in YAML and un-gates a caller)',
      got: needsLines.join(" | ") || "no needs lines",
    });
  }
  for (const line of ciTemplateText.slice(jobsAt).split("\n")) {
    if (/^\s+(strategy|continue-on-error|concurrency):/.test(line)) {
      mismatches.push({
        file: ciRel,
        expected:
          "no strategy:, continue-on-error:, or concurrency: anywhere in ci.yml's jobs (a matrixed gate renames its check; softening waves failures through; a caller lane self-deadlocks against a repo-owned post-green job taking the same name)",
        got: line.trim(),
      });
    }
    if (/^ {5,}if:/.test(line)) {
      mismatches.push({
        file: ciRel,
        expected:
          "no step-level if: in ci.yml's jobs (a conditioned judgment step is a green no-op gate)",
        got: line.trim(),
      });
    }
    if (/^ {4}name:/.test(line)) {
      mismatches.push({
        file: ciRel,
        expected:
          "no job-level name: (the all-green job's id is the required check-run name, and caller ids are the anchor census's identity)",
        got: line.trim(),
      });
    }
    if (/^ {4}if:/.test(line) && line !== "    if: always()" && line !== "    if: >-") {
      mismatches.push({
        file: ciRel,
        expected:
          "no job-level if: beyond the gate's exact `if: always()` and the post-green hook's folded `if: >-` (a condition on a caller job skips it, and a skipped caller stands down from the gate)",
        got: line.trim(),
      });
    }
    // YAML's alternate key spellings all parse identically but evade the
    // bare-key censuses above: quoted keys ('"if": false'), explicit
    // keys (? extra), anchored or tagged keys (&a extra:, !!str extra:),
    // aliases, and explicit values (: {...}). Nothing in this file
    // legitimately opens a line with any of those markers, so they are
    // refused as an alphabet, and - the closing half - every line at
    // EXACTLY the job indent must BE a bare job key: a job-level key the
    // job census cannot read is a job the roster cannot see.
    if (/^\s*["'?&!*:]/.test(line)) {
      mismatches.push({
        file: ciRel,
        expected:
          "no quoted, explicit-key, anchored, tagged, alias, or explicit-value lines (every YAML spelling beyond bare keys evades the censuses)",
        got: line.trim(),
      });
    }
    if (SPACED_KEY.test(line)) {
      mismatches.push({
        file: ciRel,
        expected:
          "no whitespace before a mapping colon at any depth (`key :` parses as `key:` but evades every key census)",
        got: line.trim(),
      });
    }
    if (/^ {2}[^ \t#]/.test(line) && !/^ {2}[A-Za-z0-9_-]+:$/.test(line)) {
      mismatches.push({
        file: ciRel,
        expected:
          "every job-indent line spelled as a bare `key:` with nothing after it (an inline flow mapping carries if:/needs: keys the line censuses cannot see; any other spelling is a job the census cannot see)",
        got: line.trim(),
      });
    }
    // The job census reads the template's own text, so a fragment anchor
    // after jobs: could splice a job the census never sees; only the
    // with-block data anchor and the three gate-downstream leg anchors may
    // stand (each leg's shape is pinned at its own fragment below).
    if (line.startsWith("{# compose:") && !LEG_ANCHORS.includes(line)) {
      mismatches.push({
        file: ciRel,
        expected:
          "no fragment anchor in ci.yml's jobs beyond the codeql-languages data anchor and the all-green-pages, all-green-docs-site, and all-green-release leg anchors (a spliced job would evade the job census; module jobs live in fleet-ci)",
        got: line.trim(),
      });
    }
  }
  // Exact-line pins, each once in the file (a compliant copy next to a
  // gutted one must be loud) and, for job-body pins, inside the named
  // job's block (a pin moved onto another job is the same disarm).
  const ciLines = ciTemplateText.split("\n");
  const blocks = {
    "all-green": jobBlock(ciLines, "all-green"),
    "post-green": jobBlock(ciLines, "post-green"),
  };
  for (const id of jobIds) {
    for (const key of duplicateJobKeys(jobBlock(ciLines, id))) {
      mismatches.push({
        file: `${ciRel} job '${id}'`,
        expected: `the key '${key}' once (YAML's last duplicate wins silently, shadowing the pinned value)`,
        got: "a duplicate key",
      });
    }
  }
  const ciPins: [string, string, keyof typeof blocks | null][] = [
    ["  all-green:", "the gate job whose check run the ruleset requires, by this exact id", null],
    [
      "    needs: [checks, ci]",
      "the gate must need BOTH caller jobs - dropping one un-gates every job of that call, fleet-wide",
      "all-green",
    ],
    [
      "    if: always()",
      "a failed caller must FAIL the gate, not skip it (a skipped required check leaves the merge box waiting)",
      "all-green",
    ],
    [
      "      - uses: {{ github_username }}/repo-platform/actions/all-green@build",
      "the shared judgment at the green-gated build ref - any other target is not the fleet's gate",
      "all-green",
    ],
    [
      "          needs: {% raw %}${{ toJSON(needs) }}{% endraw %}",
      "the needs context is what the action judges - anything else judges a fiction of the run",
      "all-green",
    ],
    ["  post-green:", "the repo-owned hook's caller, by the id the release leg needs", null],
    ["    needs: [all-green]", "the hook runs downstream of the gate, nothing else", "post-green"],
    [
      "    if: >-",
      "the hook's folded gate condition (a bare needs edge would run the hook on PR-shaped runs too)",
      "post-green",
    ],
    [
      "    uses: ./.github/workflows/post-green.yml",
      "the caller calls the repo-owned hook by local path",
      "post-green",
    ],
    [
      "      sha: {% raw %}${{ github.sha }}{% endraw %}",
      "the JUDGED commit, explicit - same-run today, and the explicit pass is what keeps a future caller honest",
      "post-green",
    ],
    [
      "    secrets: inherit",
      "the repo's own post-green work needs the repo's secrets",
      "post-green",
    ],
    [
      "{# compose:all-green-pages #}",
      "the pages leg's anchor (splices the gate-downstream Pages deploy caller on selecting repos)",
      null,
    ],
    [
      "{# compose:all-green-docs-site #}",
      "the docs-site leg's anchor (splices the gate-downstream docs deploy caller on repos selecting docs-site without pages)",
      null,
    ],
    [
      "{# compose:all-green-release #}",
      "the release-please leg's anchor (splices the gate-downstream release job on selecting repos)",
      null,
    ],
  ];
  for (const [line, why, block] of ciPins) {
    const count = ciLines.filter((candidate) => candidate === line).length;
    if (count !== 1) {
      mismatches.push({
        file: ciRel,
        expected: `the line ${JSON.stringify(line)} exactly once (${why})`,
        got: count === 0 ? "missing" : `${count} occurrences`,
      });
    } else if (block !== null && !blocks[block].includes(line)) {
      mismatches.push({
        file: ciRel,
        expected: `the line ${JSON.stringify(line)} inside the ${block} job's own block (${why})`,
        got: "present, but on another job",
      });
    }
  }
  pinDownstreamGate(
    blocks["post-green"].join("\n"),
    downstreamGateBlock(["all-green"]),
    ciRel,
    "the post-green hook caller",
    mismatches,
  );
  // The hook caller's ceiling: a called job cannot raise above it.
  const hookPermissionsAt = blocks["post-green"].indexOf("    permissions:");
  if (hookPermissionsAt === -1) {
    mismatches.push({
      file: `${ciRel} job 'post-green'`,
      expected:
        "a job-level permissions: ceiling of contents: read for the called repo-owned hook (a called job cannot raise GITHUB_TOKEN above its caller, so this line keeps repo-owned post-green work at read scope; privileged work rides inherited secrets)",
      got: "missing",
    });
  } else {
    mismatches.push(
      ...setMismatch(
        `${ciRel} post-green permissions ceiling (contents: read only - a called job cannot raise GITHUB_TOKEN above its caller; privileged work rides inherited secrets)`,
        ["contents: read"],
        permissionGrants(blocks["post-green"], hookPermissionsAt),
      ),
    );
  }
  mismatches.push(
    ...spliceLegMismatches(releaseLegText, {
      legRel,
      jobId: "release",
      upstream: ["all-green", "post-green"],
      needsWhy: "dropping post-green mints the tag before the repo's own post-green work landed",
      ordered: [],
      after: null,
      lane: "post-green-release",
      laneWhy:
        "the caller's lane, deliberately no group the called release.yml takes (sharing self-deadlocks)",
      uses: "./.github/workflows/release.yml",
      usesWhy: "the leg calls the managed release pipeline by local path",
      permissions: [
        "contents: write",
        "pull-requests: write",
        "packages: write",
        "id-token: write",
        "attestations: write",
        "issues: read",
        "vulnerability-alerts: read",
      ],
      secretsWhy: "publish steps need the repo's secrets",
    }),
  );
  // The called release.yml's half of the judged-sha pass, pinned as two
  // ADJACENT blocks (the file is jinja-heavy, so no YAML parse): the sha
  // input declared under workflow_call, and the head-gate step whose
  // JUDGED env and comparison ride in one piece - a decoy carrying the
  // JUDGED line in a skipped step while the real gate reads github.sha
  // would satisfy line-anywhere pins, so the load-bearing lines are also
  // counted UNIQUE below (the one comparison in the file is the pinned
  // one).
  const releaseBlocks: [string, string][] = [
    [
      ["on:", "  workflow_call:", "    inputs:", "      sha:"].join("\n"),
      "the workflow_call must declare the sha input the leg passes (an undeclared input fails the call outright, fleet-wide)",
    ],
    [
      [
        "      - name: Check this run judged the current head",
        "        id: head",
        "        env:",
        "          GH_TOKEN: {% raw %}${{ github.token }}{% endraw %}",
        "          JUDGED: {% raw %}${{ inputs.sha || github.sha }}{% endraw %}",
        "        run: |",
        '          head="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha)"',
        '          if [ "$head" = "$JUDGED" ]; then',
        '            echo "current=true" >> "$GITHUB_OUTPUT"',
        "          else",
        '            echo "::notice::main moved to ${head:0:7} since ${JUDGED:0:7} was judged; the newer run releases"',
        '            echo "current=false" >> "$GITHUB_OUTPUT"',
        "          fi",
      ].join("\n"),
      "the WHOLE head gate in one piece, both branches through fi - a rewired else emitting current=true would release from a stale judged commit",
    ],
  ];
  for (const [block, why] of releaseBlocks) {
    if (releaseWorkflowText.split(block).length !== 2) {
      mismatches.push({
        file: releaseRel,
        expected: `the verbatim block starting ${JSON.stringify(block.split("\n")[0])} exactly once (${why})`,
        got: "missing, reshaped, or duplicated",
      });
    }
  }
  // Uniqueness of the gate's load-bearing lines: with each appearing ONCE
  // (inside the pinned block, per above), no second step or job can carry
  // a rival JUDGED or head comparison that the gate does not use.
  const releaseLines = releaseWorkflowText.split("\n");
  // The release action's consumer binding, anchored on its OWN uses: line
  // (version-agnostic, so dependabot bumps stay free): exactly one
  // release-please-action step, whose next two lines must be the id and
  // the head-gate condition - a decoy step carrying the id/if pair while
  // the real action runs ungated must be unrepresentable.
  const actionUses = "      - uses: googleapis/release-please-action@";
  const actionIndexes = releaseLines.flatMap((line, index) =>
    line.startsWith(actionUses) ? [index] : [],
  );
  if (actionIndexes.length !== 1) {
    mismatches.push({
      file: releaseRel,
      expected: `exactly one step whose uses: starts ${JSON.stringify(actionUses.trim())} (the one release cutter)`,
      got: `${actionIndexes.length} occurrences`,
    });
  } else {
    const [idLine, ifLine] = releaseLines.slice(actionIndexes[0] + 1, actionIndexes[0] + 3);
    if (
      idLine !== "        id: release" ||
      ifLine !== "        if: steps.head.outputs.current == 'true'"
    ) {
      mismatches.push({
        file: releaseRel,
        expected:
          "the release-please-action step must itself consume the head gate: its next two lines are 'id: release' then \"if: steps.head.outputs.current == 'true'\" (an always() or dropped condition releases regardless of the gate)",
        got: [idLine ?? "<end of file>", ifLine ?? "<end of file>"]
          .map((l) => l.trim())
          .join(" / "),
      });
    }
  }
  for (const marker of ["JUDGED: {% raw %}", 'if [ "$head" =']) {
    const count = releaseLines.filter((candidate) => candidate.includes(marker)).length;
    if (count !== 1) {
      mismatches.push({
        file: releaseRel,
        expected: `exactly one line carrying ${JSON.stringify(marker)} (a rival copy outside the pinned head gate could shadow the judged-sha read)`,
        got: `${count} occurrences`,
      });
    }
  }
  // The self-deadlock ban's other half: the caller's lane name must never
  // appear inside the called workflow (concurrency groups are
  // case-insensitive on GitHub, so the scan is too).
  if (releaseWorkflowText.toLowerCase().includes("post-green-release")) {
    mismatches.push({
      file: releaseRel,
      expected:
        "no 'post-green-release' concurrency group inside the called workflow, any casing (the calling leg holds that lane; a job here waiting for it would self-deadlock)",
      got: "a post-green-release mention",
    });
  }
  return mismatches;
}

/** The pr-title module's natively-required check, pinned at its three sources.
 *  The workflow runs on every judged event PLUS synchronize (a required check
 *  must exist at the PR's NEWEST head, or the merge box waits forever), its job
 *  id is the ruleset's check-run name, and the semantic-title action is the one
 *  unconditional step (a replaced step is a green no-op). The BASELINE holds the
 *  ruleset DISABLED, context pinned to the GitHub Actions app (integration_id
 *  15368), so deselection heals via the ordinary apply; the MODULE layer holds
 *  only the enforcement flip, in its own ruleset (a same-type rule REPLACES). */
export function prTitleWorkflowMismatches(
  workflowText: string,
  baselineText: string,
  moduleLayerText: string,
): Mismatch[] {
  const wfRel = "templates/pr-title/.github/workflows/pr-title.yml.jinja";
  const baselineRel = ".github/settings-baseline.yml";
  const moduleRel = "templates/pr-title/settings.yml";
  const mismatches: Mismatch[] = [];
  const lines = workflowText.split("\n");
  const pins: readonly [string, string][] = [
    ["on:", "the trigger block"],
    ["  pull_request:", "the check judges pull requests"],
    [
      "    types: [opened, edited, reopened, synchronize]",
      "opened/edited/reopened re-judge the title; synchronize keeps the required check present at every pushed head",
    ],
    ["  pr-title:", "the job id IS the check-run name the ruleset requires"],
  ];
  for (const [line, why] of pins) {
    const count = lines.filter((candidate) => candidate === line).length;
    if (count !== 1) {
      mismatches.push({
        file: wfRel,
        expected: `the line ${JSON.stringify(line)} exactly once (${why})`,
        got: count === 0 ? "missing" : `${count} occurrences`,
      });
    }
  }
  // A display name would rename the check run away from the required
  // context, and a job- or step-level condition (or a swapped-out step)
  // would leave a required check that judges nothing; the job census
  // above pins the id, these pin the body.
  if (lines.some((line) => /^ {4}name:/.test(line))) {
    mismatches.push({
      file: wfRel,
      expected: "no job-level name: (the check-run name must stay the job id the ruleset requires)",
      got: "a job-level name override",
    });
  }
  if (lines.some((line) => /^ {4,}if:/.test(line))) {
    mismatches.push({
      file: wfRel,
      expected:
        "no job- or step-level if: (a skipped required check reads green while judging nothing)",
      got: "a condition",
    });
  }
  if (lines.some((line) => line.trimStart().startsWith("continue-on-error:"))) {
    mismatches.push({
      file: wfRel,
      expected:
        "no continue-on-error anywhere (a softened judgment step is a green check over a failed validation)",
      got: "a continue-on-error key",
    });
  }
  const actionUses = "      - uses: amannn/action-semantic-pull-request@";
  const actionCount = lines.filter((line) => line.startsWith(actionUses)).length;
  if (actionCount !== 1) {
    mismatches.push({
      file: wfRel,
      expected: `exactly one step whose uses: starts ${JSON.stringify(actionUses.trim())} (the judgment itself - without it the required check is a green no-op)`,
      got: `${actionCount} occurrences`,
    });
  }
  // The baseline's disabled full shape.
  const baseline = asRecord(parseYaml(baselineText), baselineRel);
  const baselineRulesets = (baseline.rulesets ?? []) as Record<string, unknown>[];
  const ruleset = baselineRulesets.find((entry) => entry.name === "pr-title");
  if (ruleset === undefined) {
    mismatches.push({
      file: baselineRel,
      expected:
        "a 'pr-title' ruleset carrying the full shape disabled (the deselection heal: the apply never deletes a whole undeclared ruleset)",
      got: `rulesets: ${baselineRulesets.map((entry) => String(entry.name)).join(", ") || "none"}`,
    });
    return mismatches;
  }
  if (ruleset.enforcement !== "disabled") {
    mismatches.push({
      file: baselineRel,
      expected:
        "enforcement: disabled on the baseline's pr-title ruleset (active here would require the check on every managed repo, module or not)",
      got: String(ruleset.enforcement ?? "missing"),
    });
  }
  // Applicability: an active ruleset requiring the right context still
  // gates nothing if it targets tags or the wrong ref.
  if (ruleset.target !== "branch") {
    mismatches.push({
      file: baselineRel,
      expected: "target: branch on the pr-title ruleset (a tag ruleset gates no merges)",
      got: String(ruleset.target ?? "missing"),
    });
  }
  const refName = asRecord(
    asRecord(ruleset.conditions ?? {}, `${baselineRel} conditions`).ref_name ?? {},
    `${baselineRel} ref_name`,
  );
  if (canonical(refName.include ?? null) !== canonical(["~DEFAULT_BRANCH"])) {
    mismatches.push({
      file: baselineRel,
      expected:
        'conditions.ref_name.include exactly ["~DEFAULT_BRANCH"] (anywhere else the required check gates no default-branch merges)',
      got: canonical(refName.include ?? null),
    });
  }
  if (canonical(refName.exclude ?? null) !== canonical([])) {
    mismatches.push({
      file: baselineRel,
      expected:
        "conditions.ref_name.exclude exactly [] (an exclude entry can carve the default branch back out of the include)",
      got: canonical(refName.exclude ?? null),
    });
  }
  const checksRule = ((ruleset.rules ?? []) as Record<string, unknown>[]).find(
    (rule) => rule.type === "required_status_checks",
  );
  const contexts = (
    (asRecord(checksRule?.parameters ?? {}, `${baselineRel} parameters`).required_status_checks ??
      []) as Record<string, unknown>[]
  ).map((check) => `${String(check.context)}@${String(check.integration_id)}`);
  if (canonical(contexts) !== canonical(["pr-title@15368"])) {
    mismatches.push({
      file: baselineRel,
      expected:
        "exactly one required check, context 'pr-title' pinned to integration_id 15368 (the GitHub Actions app that creates the job's check run)",
      got: contexts.join(", ") || "no required_status_checks rule",
    });
  }
  // The module layer: exactly the enforcement flip. Any other key on the
  // entry could shadow the baseline's shape (a rules list of the same
  // type REPLACES the baseline's rule in the merge).
  const moduleLayer = asRecord(parseYaml(moduleLayerText), moduleRel);
  const moduleEntries = (moduleLayer.rulesets ?? []) as Record<string, unknown>[];
  const flip = moduleEntries.find((entry) => entry.name === "pr-title");
  if (
    moduleEntries.length !== 1 ||
    flip === undefined ||
    canonical(flip) !== canonical({ name: "pr-title", enforcement: "active" })
  ) {
    mismatches.push({
      file: moduleRel,
      expected:
        "exactly one ruleset entry, {name: pr-title, enforcement: active} and nothing else (the shape lives disabled in the baseline; any other key here could shadow it in the merge)",
      got: canonical(moduleLayer.rulesets ?? null),
    });
  }
  return mismatches;
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const fleetCiRenderRules: Rule[] = [
  {
    // The fleet gate's render shape at the source
    // (fleetCiRenderMismatches has the model): the template ci.yml
    // carries exactly the two caller jobs, the pinned all-green gate, and
    // the gate-downstream post-green hook caller, and the release leg
    // splicing after them must need both with the judged sha passed
    // through (the pages leg splicing beside it: the pages-leg rule).
    name: "fleet-ci-render-roster",
    run: () =>
      fleetCiRenderMismatches(
        read("templates/base/.github/workflows/ci.yml.jinja"),
        read("templates/release-please/fragments/all-green-release.jinja"),
        read("templates/release-please/.github/workflows/release.yml.jinja"),
      ),
  },
  {
    // The pages module's gate-downstream deploy leg at its three sources
    // and in the rendered goldens (pagesLegMismatches has the model): the
    // spliced caller's shape, ordered behind the release leg where
    // release-please is selected, the called pages.yml with no push
    // trigger and the sha handed on, reusable-pages.yml's checkout reading
    // it, and the parsed renders agreeing on both arms of the ordering.
    name: "pages-leg",
    run: () =>
      pagesLegMismatches(
        read("templates/pages/fragments/all-green-pages.jinja"),
        read("templates/pages/.github/workflows/pages.yml.jinja"),
        read(".github/workflows/reusable-pages.yml"),
        {
          pagesText: read("tests/golden-renders/all-modules/.github/workflows/pages.yml"),
          ciText: read("tests/golden-renders/all-modules/.github/workflows/ci.yml"),
          ciTextNoRelease: read(
            "tests/golden-renders/pages-no-release-please/.github/workflows/ci.yml",
          ),
        },
      ),
  },
  {
    // The docs-site module's gate-downstream deploy leg at its sources and
    // in the rendered goldens (docsSiteLegMismatches has the model): the
    // spliced caller ordered behind the hook and the release leg, the
    // called docs-site.yml with no push trigger and the sha handed on, the
    // standalone and pages-composed renders, and this repository's
    // hand-written twin.
    name: "docs-site-leg",
    run: () =>
      docsSiteLegMismatches(
        read("templates/docs-site/fragments/all-green-docs-site.jinja"),
        read("templates/docs-site/.github/workflows/docs-site.yml.jinja"),
        {
          standalone: {
            ciText: read("tests/golden-renders/docs-site-release-please/.github/workflows/ci.yml"),
            docsSiteText: read(
              "tests/golden-renders/docs-site-release-please/.github/workflows/docs-site.yml",
            ),
          },
          composed: {
            ciText: read("tests/golden-renders/all-modules/.github/workflows/ci.yml"),
            docsSiteText: read("tests/golden-renders/all-modules/.github/workflows/docs-site.yml"),
          },
        },
        read(".github/workflows/ci.yml"),
        jinjaVars(),
      ),
  },
  {
    // The pr-title module's natively-required check at its sources
    // (prTitleWorkflowMismatches has the model): the workflow's trigger
    // shape, the job id the ruleset requires, and the module settings
    // layer's pinned context.
    name: "pr-title-workflow",
    run: () =>
      prTitleWorkflowMismatches(
        read("templates/pr-title/.github/workflows/pr-title.yml.jinja"),
        read(".github/settings-baseline.yml"),
        read("templates/pr-title/settings.yml"),
      ),
  },
];

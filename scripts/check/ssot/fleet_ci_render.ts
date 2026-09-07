// Rules over the template ci.yml's rendered gate shape and the pr-title
// module's natively-required check.

import { parse as parseYaml } from "yaml";
import { canonical, type Mismatch, setMismatch } from "./comparison.ts";
import { asRecord, read } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** The folded job-level condition of a gate-downstream caller: green
 *  results of `upstream`, spelled out, on a push to main. */
export function downstreamGateBlock(upstream: string[]): string {
  return [
    "    if: >-",
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
        "the release leg splices through its anchor, and a job added here would gate every repo " +
        "with no roster to make it loud)",
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
    // with-block data anchor and the release leg's anchor may stand.
    if (
      line.startsWith("{# compose:") &&
      line !== "{# compose:codeql-languages #}" &&
      line !== "{# compose:all-green-release #}"
    ) {
      mismatches.push({
        file: ciRel,
        expected:
          "no fragment anchor in ci.yml's jobs beyond the codeql-languages data anchor and the all-green-release leg anchor (a spliced job would evade the job census; module jobs live in fleet-ci)",
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
  // The release leg is jinja-minimal by design: inline {% raw %} pairs
  // wrap the judged-sha expression, and everything else is banned -
  // a multi-line {# ... #} or an if-tag could otherwise hide a pinned
  // line while rendering without it (the composer supplies the module
  // gate around the whole fragment).
  for (const [index, line] of releaseLegText.split("\n").entries()) {
    if (line.split("{% raw %}").length !== line.split("{% endraw %}").length) {
      mismatches.push({
        file: `${legRel}:${index + 1}`,
        expected:
          "raw/endraw paired on one line (inline expression wrapping only - a multiline raw block smuggles text past the jinja ban)",
        got: line.trim(),
      });
      continue;
    }
    const stripped = line.replaceAll("{% raw %}", "").replaceAll("{% endraw %}", "");
    if (stripped.includes("{%") || stripped.includes("{#") || stripped.includes("#}")) {
      mismatches.push({
        file: `${legRel}:${index + 1}`,
        expected:
          "no jinja tags or comments in the fragment beyond {% raw %} pairs (the composer supplies the module gate; a tag-wrapped or commented copy would satisfy the textual pins while rendering to nothing)",
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
    // YAML's alternate key spellings parse identically but evade the
    // bare-key censuses (quoted, explicit-key, anchored, tagged, alias,
    // explicit-value); every job-indent line must be a bare key.
    if (/^\s*["'?&!*:]/.test(line)) {
      mismatches.push({
        file: legRel,
        expected:
          "no quoted, explicit-key, anchored, tagged, alias, or explicit-value lines (every YAML spelling beyond bare keys evades the censuses)",
        got: line.trim(),
      });
    }
    if (SPACED_KEY.test(line)) {
      mismatches.push({
        file: legRel,
        expected:
          "no whitespace before a mapping colon at any depth (`key :` parses as `key:` but evades every key census)",
        got: line.trim(),
      });
    }
    if (/^ {2}[^ \t#]/.test(line) && !/^ {2}[A-Za-z0-9_-]+:$/.test(line)) {
      mismatches.push({
        file: legRel,
        expected:
          "every job-indent line spelled as a bare `key:` with nothing after it (an inline flow mapping carries if:/needs: keys the line censuses cannot see; any other spelling is a job the census cannot see)",
        got: line.trim(),
      });
    }
  }
  const legJobs = [...releaseLegText.matchAll(/^ {2}([A-Za-z0-9_-]+):(?: |$)/gm)].map(
    (match) => match[1],
  );
  if (legJobs.length === 0) {
    throw new Error(`${legRel}: no job id - anchor lost`);
  }
  // Exactly ONE job, by design: with a second job in the fragment, a
  // decoy could carry the pinned lines while the release job lost them.
  if (canonical(legJobs) !== canonical(["release"])) {
    mismatches.push({
      file: legRel,
      expected:
        "exactly one spliced job, 'release' (a decoy second job could carry the pinned lines while the release job lost them)",
      got: legJobs.join(", "),
    });
  }
  for (const key of duplicateJobKeys(jobBlock(releaseLegText.split("\n"), "release"))) {
    mismatches.push({
      file: `${legRel} job 'release'`,
      expected: `the key '${key}' once (YAML's last duplicate wins silently, shadowing the pinned value)`,
      got: "a duplicate key",
    });
  }
  const legNeedsLines = releaseLegText.split("\n").filter((line) => /^ {4}needs:/.test(line));
  if (canonical(legNeedsLines) !== canonical(["    needs: [all-green, post-green]"])) {
    mismatches.push({
      file: legRel,
      expected:
        'exactly one needs: line, "    needs: [all-green, post-green]" (a rival needs key silently wins in YAML; dropping post-green mints the tag before the repo\'s own post-green work landed)',
      got: legNeedsLines.join(" | ") || "no needs lines",
    });
  }
  if (/^\s+(strategy|continue-on-error):/m.test(releaseLegText)) {
    mismatches.push({
      file: legRel,
      expected: "no strategy: or continue-on-error: in the release leg",
      got: "a banned key",
    });
  }
  // One if: only - YAML lets a duplicate key win silently, so a second
  // condition could shadow the pinned block below.
  const ifCount = releaseLegText.split("\n").filter((line) => /^ {4}if:/.test(line)).length;
  if (ifCount !== 1) {
    mismatches.push({
      file: legRel,
      expected: "exactly one job-level if: (a duplicate key could shadow the gate condition)",
      got: `${ifCount} if: lines`,
    });
  }
  // The gate condition: released only by a green all-green AND a green
  // post-green hook on a push to main.
  pinDownstreamGate(
    releaseLegText,
    downstreamGateBlock(["all-green", "post-green"]),
    legRel,
    "the release job",
    mismatches,
  );
  // The per-line pins: each exactly once (YAML's last duplicate wins
  // silently, so a compliant copy next to a gutted one must be loud).
  const legPins: [string, string][] = [
    [
      "    needs: [all-green, post-green]",
      "the release leg runs downstream of the gate and the repo-owned hook, nothing else",
    ],
    [
      "    concurrency:",
      "releases serialize in their own lane; an unserialized pair can double-publish",
    ],
    [
      "      group: post-green-release",
      "the caller's lane, deliberately no group the called release.yml takes (sharing self-deadlocks)",
    ],
    ["      cancel-in-progress: false", "a cancelled half-finished release is a wedged draft"],
    [
      "    uses: ./.github/workflows/release.yml",
      "the leg calls the managed release pipeline by local path",
    ],
    [
      "      sha: {% raw %}${{ github.sha }}{% endraw %}",
      "the JUDGED commit, explicit - same-run today, and the explicit pass is what keeps a future caller honest",
    ],
    ["    secrets: inherit", "publish steps need the repo's secrets"],
  ];
  const legLines = releaseLegText.split("\n");
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

  // The permissions ceiling, additive-closed: the pins prove the needed
  // grants present, this census refuses extras riding to every
  // release-selecting repository silently.
  const permissionsAt = legLines.indexOf("    permissions:");
  if (permissionsAt === -1) {
    mismatches.push({
      file: legRel,
      expected: "a job-level permissions: ceiling for the called release pipeline",
      got: "missing",
    });
  } else {
    mismatches.push(
      ...setMismatch(
        `${legRel} release permissions ceiling`,
        [
          "contents: write",
          "pull-requests: write",
          "packages: write",
          "id-token: write",
          "attestations: write",
          "issues: read",
          "vulnerability-alerts: read",
        ],
        permissionGrants(legLines, permissionsAt),
      ),
    );
  }
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

/** The pr-title module's natively-required check, pinned at its three
 *  sources. The managed workflow template must run on every event that
 *  changes what the check judges PLUS synchronize (a required check must
 *  exist at the PR's NEWEST head commit - a types list without it leaves
 *  the merge box waiting on a check nothing creates), its job id must be
 *  the exact check-run name the ruleset requires, and the semantic-title
 *  action must be the one unconditional step (a replaced step is a green
 *  no-op check). The BASELINE carries the ruleset's full shape DISABLED
 *  (so deselection heals through the ordinary apply - whole undeclared
 *  rulesets are never deleted), with the context pinned to the GitHub
 *  Actions app (integration_id 15368, the app that creates job check
 *  runs); the MODULE layer carries exactly the enforcement flip, and
 *  nothing else - a rules list there would REPLACE the baseline's
 *  same-type rule, not merge into it. Its own ruleset, not a rule in
 *  `main`: the override layer's same-type rule would replace a
 *  required_status_checks rule merged into `main`. Pure over the three
 *  texts for the suite's forcing cases. */
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
    // through.
    name: "fleet-ci-render-roster",
    run: () =>
      fleetCiRenderMismatches(
        read("templates/base/.github/workflows/ci.yml.jinja"),
        read("templates/release-please/fragments/all-green-release.jinja"),
        read("templates/release-please/.github/workflows/release.yml.jinja"),
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

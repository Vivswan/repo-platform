// The fleet ci render and pr-title models (scripts/check/ssot/fleet_ci_render.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  duplicateJobKeys,
  fleetCiRenderMismatches,
  pagesLegMismatches,
  prTitleWorkflowMismatches,
} from "../../../scripts/check/ssot/fleet_ci_render.ts";

describe("fleetCiRenderMismatches", () => {
  const ciTemplate = [
    "name: CI",
    "",
    "jobs:",
    "  checks:",
    "  ci:",
    "  all-green:",
    "    needs: [checks, ci]",
    "    if: always()",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: {{ github_username }}/repo-platform/actions/all-green@build",
    "        with:",
    "          needs: {% raw %}${{ toJSON(needs) }}{% endraw %}",
    "  post-green:",
    "    needs: [all-green]",
    "    if: >-",
    "      needs.all-green.result == 'success' &&",
    "      github.event_name == 'push' &&",
    "      github.ref == 'refs/heads/main'",
    "    permissions:",
    "      contents: read",
    "    uses: ./.github/workflows/post-green.yml",
    "    with:",
    "      sha: {% raw %}${{ github.sha }}{% endraw %}",
    "    secrets: inherit",
    "{# compose:all-green-pages #}",
    "{# compose:all-green-release #}",
    "",
  ].join("\n");
  const leg = [
    "",
    "  release:",
    "    needs: [all-green, post-green]",
    "    if: >-",
    "      needs.all-green.result == 'success' &&",
    "      needs.post-green.result == 'success' &&",
    "      github.event_name == 'push' &&",
    "      github.ref == 'refs/heads/main'",
    "    concurrency:",
    "      group: post-green-release",
    "      cancel-in-progress: false",
    "    permissions:",
    "      contents: write",
    "      pull-requests: write",
    "      packages: write",
    "      id-token: write",
    "      attestations: write",
    "      issues: read",
    "      vulnerability-alerts: read",
    "    uses: ./.github/workflows/release.yml",
    "    with:",
    "      sha: {% raw %}${{ github.sha }}{% endraw %}",
    "    secrets: inherit",
    "",
  ].join("\n");
  const releaseWf = [
    "on:",
    "  workflow_call:",
    "    inputs:",
    "      sha:",
    "        required: false",
    "jobs:",
    "  release-please:",
    "    steps:",
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
    "      - uses: googleapis/release-please-action@v5",
    "        id: release",
    "        if: steps.head.outputs.current == 'true'",
    "",
  ].join("\n");

  test("the canonical shape passes clean", () => {
    expect(fleetCiRenderMismatches(ciTemplate, leg, releaseWf)).toEqual([]);
  });

  test("a job added to the template ci.yml goes red - it would gate every repo with no roster", () => {
    const found = fleetCiRenderMismatches(`${ciTemplate}  extra-gate:\n`, leg, releaseWf);
    expect(found).toHaveLength(1);
    expect(found[0].got).toContain("extra-gate");
  });

  test("re-adding an info-release job to the template ci.yml goes red the same way", () => {
    const found = fleetCiRenderMismatches(
      `${ciTemplate}  info-release:\n    needs: [checks, ci]\n`,
      leg,
      releaseWf,
    );
    expect(found.some((m) => m.got.includes("info-release"))).toBe(true);
  });

  test("a flow-mapping job ('extra: { ... }') is caught in the template census too", () => {
    const found = fleetCiRenderMismatches(
      `${ciTemplate}  extra: { uses: ./x.yml }\n`,
      leg,
      releaseWf,
    );
    expect(found.some((m) => m.got.includes("extra"))).toBe(true);
  });

  test("a KNOWN job respelled as a flow mapping goes red - its inline if: would evade the job-level if: census", () => {
    const conditioned = fleetCiRenderMismatches(
      ciTemplate.replace(
        "  checks:\n",
        "  checks: {uses: ./.github/workflows/checks.yml, if: github.event_name == 'workflow_dispatch'}\n",
      ),
      leg,
      releaseWf,
    );
    expect(conditioned.some((m) => m.expected.includes("with nothing after it"))).toBe(true);
    const legInline = fleetCiRenderMismatches(
      ciTemplate,
      `${leg}  release: {needs: [all-green]}\n`,
      releaseWf,
    );
    expect(legInline.some((m) => m.expected.includes("with nothing after it"))).toBe(true);
  });

  test("a job-level name: anywhere, or an if: beyond the gate's always() and the hook's folded if:, goes red", () => {
    const renamed = fleetCiRenderMismatches(`${ciTemplate}    name: info-checks\n`, leg, releaseWf);
    expect(renamed.some((m) => m.expected.includes("no job-level name:"))).toBe(true);
    const conditioned = fleetCiRenderMismatches(`${ciTemplate}    if: false\n`, leg, releaseWf);
    expect(conditioned.some((m) => m.expected.includes("beyond the gate's exact"))).toBe(true);
  });

  test("the post-green hook caller: dropping the job, any pin, or a gate clause goes red, and a lane or a wider ceiling goes red", () => {
    const hook = ciTemplate.slice(
      ciTemplate.indexOf("  post-green:"),
      ciTemplate.indexOf("{# compose:"),
    );
    const noHook = fleetCiRenderMismatches(ciTemplate.replace(hook, ""), leg, releaseWf);
    expect(noHook.some((m) => m.expected.includes("'post-green' hook caller"))).toBe(true);
    expect(noHook.some((m) => m.expected.includes('"  post-green:" exactly once'))).toBe(true);
    for (const line of [
      "    needs: [all-green]\n",
      "    uses: ./.github/workflows/post-green.yml\n",
      "      sha: {% raw %}${{ github.sha }}{% endraw %}\n",
      "    secrets: inherit\n",
    ]) {
      const found = fleetCiRenderMismatches(ciTemplate.replace(line, ""), leg, releaseWf);
      expect(found.some((m) => m.expected.includes(JSON.stringify(line.trimEnd())))).toBe(true);
    }
    // The hook's own gate: every clause, and the scalar's end.
    for (const clause of [
      "      needs.all-green.result == 'success' &&\n",
      "      github.event_name == 'push' &&\n",
      "      github.ref == 'refs/heads/main'\n",
    ]) {
      const dropped = fleetCiRenderMismatches(ciTemplate.replace(clause, ""), leg, releaseWf);
      expect(
        dropped.some((m) =>
          m.expected.includes("the post-green hook caller carrying the verbatim gate block"),
        ),
      ).toBe(true);
    }
    const weakened = fleetCiRenderMismatches(
      ciTemplate.replace(
        "      github.ref == 'refs/heads/main'\n    permissions:",
        "      github.ref == 'refs/heads/main'\n      || always()\n    permissions:",
      ),
      leg,
      releaseWf,
    );
    expect(
      weakened.some((m) => m.expected.includes("hook caller's gate block ending the if: scalar")),
    ).toBe(true);
    // A folded scalar keeps blank lines as content, so an arm past one
    // still weakens the gate.
    const pastBlank = fleetCiRenderMismatches(
      ciTemplate.replace(
        "      github.ref == 'refs/heads/main'\n    permissions:",
        "      github.ref == 'refs/heads/main'\n\n      || always()\n    permissions:",
      ),
      leg,
      releaseWf,
    );
    expect(
      pastBlank.some((m) => m.expected.includes("hook caller's gate block ending the if: scalar")),
    ).toBe(true);
    // A caller lane deadlocks against any repo-owned job taking its name.
    const laned = fleetCiRenderMismatches(
      ciTemplate.replace(
        "    secrets: inherit",
        "    concurrency:\n      group: post-green\n    secrets: inherit",
      ),
      leg,
      releaseWf,
    );
    expect(laned.some((m) => m.expected.includes("or concurrency:"))).toBe(true);
    // The ceiling is contents: read alone; a called job cannot raise above
    // it, so an ADDED grant (contents: read kept) must go red too.
    for (const ceiling of [
      "      contents: write\n    uses:",
      "      contents: read\n      pull-requests: write\n    uses:",
      // A quoted value is a grant to GitHub all the same.
      '      contents: read\n      pull-requests: "write"\n    uses:',
    ]) {
      const widened = fleetCiRenderMismatches(
        ciTemplate.replace("      contents: read\n    uses:", ceiling),
        leg,
        releaseWf,
      );
      expect(widened.some((m) => m.file.includes("post-green permissions ceiling"))).toBe(true);
    }
    // A pin moved onto another job is the same disarm.
    const moved = fleetCiRenderMismatches(
      ciTemplate
        .replace("    secrets: inherit\n", "")
        .replace("  ci:\n", "  ci:\n    secrets: inherit\n"),
      leg,
      releaseWf,
    );
    expect(moved.some((m) => m.expected.includes("inside the post-green job's own block"))).toBe(
      true,
    );
    // A second uses: after the pinned one ships (YAML's last duplicate wins).
    const shadowed = fleetCiRenderMismatches(
      ciTemplate.replace("    secrets: inherit\n", "    secrets: inherit\n    uses: ./evil.yml\n"),
      leg,
      releaseWf,
    );
    expect(shadowed.some((m) => m.expected.includes("the key 'uses' once"))).toBe(true);
    // Nested pins shadow the same way: a second with.sha on the hook, a
    // second with.needs under the gate's judgment step.
    const shadowedSha = fleetCiRenderMismatches(
      ciTemplate.replace(
        "      sha: {% raw %}${{ github.sha }}{% endraw %}\n",
        "      sha: {% raw %}${{ github.sha }}{% endraw %}\n      sha: deadbeef\n",
      ),
      leg,
      releaseWf,
    );
    expect(shadowedSha.some((m) => m.expected.includes("the key 'with.sha' once"))).toBe(true);
    const shadowedNeeds = fleetCiRenderMismatches(
      ciTemplate.replace(
        "          needs: {% raw %}${{ toJSON(needs) }}{% endraw %}\n",
        '          needs: {% raw %}${{ toJSON(needs) }}{% endraw %}\n          needs: \'{"ci": {"result": "success"}}\'\n',
      ),
      leg,
      releaseWf,
    );
    expect(
      shadowedNeeds.some((m) => m.expected.includes("the key 'steps[0].with.needs' once")),
    ).toBe(true);
    // A wider dash prefix scopes the item the same way: the item's keys
    // sit at the prefix's end, so with: nests under the item, not under
    // uses (a fixed two-column prefix would path it steps[0].uses.with).
    expect(
      duplicateJobKeys([
        "    steps:",
        "      -   uses: x",
        "          with:",
        "            needs: a",
        "            needs: b",
        "      - uses: y",
      ]),
    ).toEqual(["steps[0].with.needs"]);
  });

  test("the release leg must need the post-green hook and read its result - or the tag is minted before the repo's own post-green work", () => {
    const gateOnly = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("    needs: [all-green, post-green]", "    needs: [all-green]"),
      releaseWf,
    );
    expect(gateOnly.some((m) => m.expected.includes("exactly one needs: line"))).toBe(true);
    const unread = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("      needs.post-green.result == 'success' &&\n", ""),
      releaseWf,
    );
    expect(
      unread.some((m) => m.expected.includes("the release job carrying the verbatim gate block")),
    ).toBe(true);
  });

  test("dropping any gate pin goes red - needs edge, always(), the shared action, the needs wiring", () => {
    for (const line of [
      "    needs: [checks, ci]\n",
      "    if: always()\n",
      "      - uses: {{ github_username }}/repo-platform/actions/all-green@build\n",
      "          needs: {% raw %}${{ toJSON(needs) }}{% endraw %}\n",
    ]) {
      const found = fleetCiRenderMismatches(ciTemplate.replace(line, ""), leg, releaseWf);
      expect(
        found.some((m) => m.expected.includes(JSON.stringify(line.trimEnd().replace(/^\n/, "")))),
      ).toBe(true);
    }
  });

  test("a rival needs: line, a step-level if:, a strategy:, or continue-on-error goes red", () => {
    // YAML's last duplicate key wins silently, so a second needs on the
    // gate would un-gate a caller while the pinned line stayed present;
    // a conditioned or matrixed gate is the same class one level down.
    const rivalNeeds = fleetCiRenderMismatches(
      ciTemplate.replace("    if: always()", "    needs: [checks]\n    if: always()"),
      leg,
      releaseWf,
    );
    expect(rivalNeeds.some((m) => m.expected.includes("exactly two needs: lines"))).toBe(true);
    const stepIf = fleetCiRenderMismatches(
      ciTemplate.replace("        with:", "        if: false\n        with:"),
      leg,
      releaseWf,
    );
    expect(stepIf.some((m) => m.expected.includes("no step-level if:"))).toBe(true);
    const matrixed = fleetCiRenderMismatches(
      ciTemplate.replace("    if: always()", "    if: always()\n    strategy:"),
      leg,
      releaseWf,
    );
    expect(matrixed.some((m) => m.expected.includes("no strategy:"))).toBe(true);
    const softenedLeg = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("    secrets: inherit", "    secrets: inherit\n    continue-on-error: true"),
      releaseWf,
    );
    expect(softenedLeg.some((m) => m.expected.includes("no strategy: or continue-on-error:"))).toBe(
      true,
    );
    const rivalLegNeeds = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("    concurrency:", "    needs: []\n    concurrency:"),
      releaseWf,
    );
    expect(rivalLegNeeds.some((m) => m.expected.includes("exactly one needs: line"))).toBe(true);
  });

  test("a fragment anchor re-added after ci.yml's jobs goes red - a spliced job would evade the job census", () => {
    const found = fleetCiRenderMismatches(
      `${ciTemplate}{# compose:ci-release-please #}\n`,
      leg,
      releaseWf,
    );
    expect(found.some((m) => m.expected.includes("no fragment anchor"))).toBe(true);
  });

  test("the codeql-languages data anchor and the two leg anchors stay exempt from the anchor ban", () => {
    const found = fleetCiRenderMismatches(
      `${ciTemplate}{# compose:codeql-languages #}\n`,
      leg,
      releaseWf,
    );
    expect(found.filter((m) => m.expected.includes("no fragment anchor"))).toEqual([]);
  });

  test("dropping the pages leg's anchor goes red - selecting repos would render no deploy at all", () => {
    const found = fleetCiRenderMismatches(
      ciTemplate.replace("{# compose:all-green-pages #}\n", ""),
      leg,
      releaseWf,
    );
    expect(
      found.some((m) => m.expected.includes(JSON.stringify("{# compose:all-green-pages #}"))),
    ).toBe(true);
  });

  test("leading-quote and explicit-key lines are refused in the template and the leg - both parse identically but evade the censuses", () => {
    const templateFound = fleetCiRenderMismatches(`${ciTemplate}  "extra":\n`, leg, releaseWf);
    expect(
      templateFound.some((m) => m.expected.includes("every YAML spelling beyond bare keys")),
    ).toBe(true);
    const quotedIf = fleetCiRenderMismatches(
      ciTemplate.replace("        with:", '        "if": false\n        with:'),
      leg,
      releaseWf,
    );
    expect(quotedIf.some((m) => m.expected.includes("every YAML spelling beyond bare keys"))).toBe(
      true,
    );
    // Every alternate YAML key spelling is the same evasion: explicit
    // keys, anchored keys, tagged keys, and any other job-indent line
    // that is not a bare `key:` must go red.
    for (const spoof of [
      "  ? extra\n  : { needs: all-green }\n",
      "  &a extra: { needs: all-green }\n",
      "  !!str extra: { needs: all-green }\n",
      "  extra : { needs: all-green }\n",
      // A unicode blank after the indent is a content char to YAML but
      // whitespace to \\s - the trigger must be ASCII-space-only.
      "  \u00a0x: { needs: all-green }\n",
    ]) {
      const found = fleetCiRenderMismatches(`${ciTemplate}${spoof}`, leg, releaseWf);
      expect(
        found.some(
          (m) =>
            m.expected.includes("every YAML spelling beyond bare keys") ||
            m.expected.includes("bare `key:`"),
        ),
      ).toBe(true);
    }
    const legFound = fleetCiRenderMismatches(ciTemplate, `${leg}  "decoy":\n`, releaseWf);
    expect(legFound.some((m) => m.expected.includes("every YAML spelling beyond bare keys"))).toBe(
      true,
    );
  });

  test("a gate pin satisfied from ANOTHER job's body goes red - the pins are scoped to the all-green block", () => {
    const moved = fleetCiRenderMismatches(
      ciTemplate.replace("    if: always()\n", "").replace("  ci:\n", "  ci:\n    if: always()\n"),
      leg,
      releaseWf,
    );
    expect(moved.some((m) => m.expected.includes("inside the all-green job's own block"))).toBe(
      true,
    );
  });

  test("a continuation line after the release gate block goes red - it could re-weaken the folded if:", () => {
    const weakened = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace(
        "      github.ref == 'refs/heads/main'\n",
        "      github.ref == 'refs/heads/main' ||\n      always()\n",
      ),
      releaseWf,
    );
    expect(
      weakened.some(
        (m) =>
          m.expected.includes("gate block ending the if: scalar") ||
          m.expected.includes("verbatim gate block"),
      ),
    ).toBe(true);
    const appended = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace(
        "      github.ref == 'refs/heads/main'\n",
        "      github.ref == 'refs/heads/main'\n      || always()\n",
      ),
      releaseWf,
    );
    expect(appended.some((m) => m.expected.includes("gate block ending the if: scalar"))).toBe(
      true,
    );
    const pastBlank = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace(
        "      github.ref == 'refs/heads/main'\n",
        "      github.ref == 'refs/heads/main'\n\n      || always()\n",
      ),
      releaseWf,
    );
    expect(pastBlank.some((m) => m.expected.includes("gate block ending the if: scalar"))).toBe(
      true,
    );
  });

  test("a key spelled with whitespace before its colon goes red at every depth - YAML reads `key :` as `key:`, the censuses do not", () => {
    for (const [line, spaced] of [
      [
        "    permissions:\n      contents: read\n    uses:",
        "    strategy :\n    permissions:\n      contents: read\n    uses:",
      ],
      ["    secrets: inherit\n{#", "    concurrency :\n      group: x\n    secrets: inherit\n{#"],
      [
        "      sha: {% raw %}${{ github.sha }}{% endraw %}\n",
        "      sha : deadbeef\n      sha: {% raw %}${{ github.sha }}{% endraw %}\n",
      ],
      [
        "          needs: {% raw %}${{ toJSON(needs) }}{% endraw %}\n",
        "          needs : '{}'\n          needs: {% raw %}${{ toJSON(needs) }}{% endraw %}\n",
      ],
    ]) {
      expect(ciTemplate).toContain(line);
      const found = fleetCiRenderMismatches(ciTemplate.replace(line, spaced), leg, releaseWf);
      expect(found.some((m) => m.expected.includes("no whitespace before a mapping colon"))).toBe(
        true,
      );
    }
    // YAML allows any run of spaces after a sequence dash.
    const wideDash = fleetCiRenderMismatches(
      ciTemplate.replace(
        "          needs: {% raw %}${{ toJSON(needs) }}{% endraw %}\n",
        "          needs: {% raw %}${{ toJSON(needs) }}{% endraw %}\n      -  uses : ./evil.yml\n",
      ),
      leg,
      releaseWf,
    );
    expect(wideDash.some((m) => m.expected.includes("no whitespace before a mapping colon"))).toBe(
      true,
    );
    const legSpaced = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace(
        "      cancel-in-progress: false\n",
        "      cancel-in-progress: false\n      group : sync-repos\n",
      ),
      releaseWf,
    );
    expect(legSpaced.some((m) => m.expected.includes("no whitespace before a mapping colon"))).toBe(
      true,
    );
  });

  test("the release ceiling fails closed on a quoted grant, and a duplicate job-level key in the leg goes red", () => {
    const quoted = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("      issues: read\n", '      issues: read\n      deployments: "write"\n'),
      releaseWf,
    );
    expect(quoted.some((m) => m.file.includes("release permissions ceiling"))).toBe(true);
    const shadowed = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("    secrets: inherit\n", "    secrets: inherit\n    uses: ./evil.yml\n"),
      releaseWf,
    );
    expect(shadowed.some((m) => m.expected.includes("the key 'uses' once"))).toBe(true);
    const shadowedLane = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace(
        "      cancel-in-progress: false\n",
        "      cancel-in-progress: false\n      group: sync-repos\n",
      ),
      releaseWf,
    );
    expect(shadowedLane.some((m) => m.expected.includes("the key 'concurrency.group' once"))).toBe(
      true,
    );
  });

  test("a deleted caller job goes red the same way", () => {
    const found = fleetCiRenderMismatches("name: CI\n\njobs:\n  checks:\n", leg, releaseWf);
    expect(found.some((m) => m.expected.includes("'checks' and 'ci'"))).toBe(true);
  });

  test("dropping any gate clause from the release leg goes red - a weakened gate releases off unjudged or red runs", () => {
    for (const clause of [
      "      needs.all-green.result == 'success' &&\n",
      "      github.event_name == 'push' &&\n",
      "      github.ref == 'refs/heads/main'",
    ]) {
      const found = fleetCiRenderMismatches(ciTemplate, leg.replace(clause, ""), releaseWf);
      expect(found.some((m) => m.expected.includes("verbatim gate block"))).toBe(true);
    }
  });

  test("a second job-level if: goes red - YAML's duplicate key could shadow the release gate", () => {
    const mutated = leg.replace("    secrets: inherit", "    secrets: inherit\n    if: true");
    const found = fleetCiRenderMismatches(ciTemplate, mutated, releaseWf);
    expect(found.some((m) => m.expected.includes("exactly one job-level if:"))).toBe(true);
  });

  test("renaming the release job or adding a decoy goes red - a decoy could carry the pins while the leg lost them", () => {
    const renamed = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("  release:", "  publish:"),
      releaseWf,
    );
    expect(renamed.some((m) => m.expected.includes("exactly one spliced job, 'release'"))).toBe(
      true,
    );
    const decoy = fleetCiRenderMismatches(ciTemplate, `${leg}  decoy:\n`, releaseWf);
    expect(decoy.some((m) => m.expected.includes("exactly one spliced job, 'release'"))).toBe(true);
  });

  test("dropping the needs edge or the judged-sha pass goes red - each is an exact-line pin", () => {
    for (const line of [
      "    needs: [all-green, post-green]\n",
      "      sha: {% raw %}${{ github.sha }}{% endraw %}\n",
      "      group: post-green-release\n",
      "    secrets: inherit\n",
    ]) {
      const found = fleetCiRenderMismatches(ciTemplate, leg.replace(line, ""), releaseWf);
      expect(
        found.some((m) => m.expected.includes(JSON.stringify(line.trimEnd().replace(/^\n/, "")))),
      ).toBe(true);
    }
  });

  test("jinja tags and comments are banned in the leg - a multiline {# #} could hide a pinned line while rendering without it", () => {
    for (const spoof of ["{#\n    needs: [all-green]\n#}\n", "{% if false %}\n{% endif %}\n"]) {
      const found = fleetCiRenderMismatches(ciTemplate, `${leg}${spoof}`, releaseWf);
      expect(found.some((m) => m.expected.includes("no jinja tags or comments"))).toBe(true);
    }
  });

  test("a bare ${{ }} outside {% raw %} goes red - jinja eats it before GitHub ever sees it", () => {
    const mutated = leg.replace(
      "      sha: {% raw %}${{ github.sha }}{% endraw %}",
      "      sha: ${{ github.sha }}",
    );
    const found = fleetCiRenderMismatches(ciTemplate, mutated, releaseWf);
    expect(found.some((m) => m.expected.includes("wrapped in {% raw %}"))).toBe(true);
  });

  test("the permissions ceiling is pinned both ways: a missing grant and an added one both go red", () => {
    const missing = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("      id-token: write\n", ""),
      releaseWf,
    );
    expect(
      missing.some((m) => m.file.includes("permissions ceiling") && !m.got.includes("id-token")),
    ).toBe(true);
    const added = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("      issues: read", "      issues: read\n      deployments: write"),
      releaseWf,
    );
    expect(
      added.some((m) => m.file.includes("permissions ceiling") && m.got.includes("deployments")),
    ).toBe(true);
  });

  test("release.yml must declare the sha input and read it in the head gate", () => {
    const undeclared = fleetCiRenderMismatches(
      ciTemplate,
      leg,
      releaseWf.replace("      sha:\n", ""),
    );
    expect(undeclared.some((m) => m.expected.includes('"on:"'))).toBe(true);
    const unread = fleetCiRenderMismatches(
      ciTemplate,
      leg,
      releaseWf.replace(
        "{% raw %}${{ inputs.sha || github.sha }}{% endraw %}",
        "{% raw %}${{ github.sha }}{% endraw %}",
      ),
    );
    expect(unread.some((m) => m.expected.includes("WHOLE head gate"))).toBe(true);
  });

  test("a rewired else branch or an ungated release action goes red - the gate must hold through fi to its consumer", () => {
    const flipped = fleetCiRenderMismatches(
      ciTemplate,
      leg,
      releaseWf.replace(
        '            echo "current=false" >> "$GITHUB_OUTPUT"',
        '            echo "current=true" >> "$GITHUB_OUTPUT"',
      ),
    );
    expect(flipped.some((m) => m.expected.includes("WHOLE head gate"))).toBe(true);
    const ungated = fleetCiRenderMismatches(
      ciTemplate,
      leg,
      releaseWf.replace("        if: steps.head.outputs.current == 'true'", "        if: always()"),
    );
    expect(ungated.some((m) => m.expected.includes("consume the head gate"))).toBe(true);
    // The consumer pin is anchored on the action's own uses: line, so a
    // dummy step wearing the id/if pair cannot cover an ungated action.
    const decoyConsumer = fleetCiRenderMismatches(
      ciTemplate,
      leg,
      releaseWf.replace(
        "      - uses: googleapis/release-please-action@v5\n        id: release\n        if: steps.head.outputs.current == 'true'",
        "      - run: echo decoy\n        id: release\n        if: steps.head.outputs.current == 'true'\n      - uses: googleapis/release-please-action@v5\n        if: always()",
      ),
    );
    expect(decoyConsumer.some((m) => m.expected.includes("consume the head gate"))).toBe(true);
  });

  test("a decoy JUDGED line in a skipped step goes red - the gate's lines are unique-in-file", () => {
    // The attack: the real head gate reads github.sha while a dead step
    // carries the expected JUDGED expression. The block pin catches the
    // reshaped gate, and the uniqueness census catches the rival copy.
    const decoy = releaseWf
      .replace(
        "{% raw %}${{ inputs.sha || github.sha }}{% endraw %}",
        "{% raw %}${{ github.sha }}{% endraw %}",
      )
      .replace(
        "    steps:\n",
        "    steps:\n      - if: false\n        env:\n" +
          "          JUDGED: {% raw %}${{ inputs.sha || github.sha }}{% endraw %}\n" +
          "        run: echo decoy\n",
      );
    const found = fleetCiRenderMismatches(ciTemplate, leg, decoy);
    expect(found.some((m) => m.expected.includes("WHOLE head gate"))).toBe(true);
    expect(found.some((m) => m.expected.includes("exactly one line carrying"))).toBe(true);
  });

  test("the caller's concurrency lane appearing inside release.yml goes red in ANY casing - groups are case-insensitive", () => {
    for (const lane of ["post-green-release", "Post-Green-Release"]) {
      const found = fleetCiRenderMismatches(
        ciTemplate,
        leg,
        `${releaseWf}    concurrency:\n      group: ${lane}\n`,
      );
      expect(found.some((m) => m.expected.includes("self-deadlock"))).toBe(true);
    }
  });

  test("a leg with no job id throws anchor-lost instead of passing vacuously", () => {
    expect(() => fleetCiRenderMismatches(ciTemplate, "    steps: []\n", releaseWf)).toThrow(
      "anchor lost",
    );
  });

  test("a template with no jobs section throws anchor-lost", () => {
    expect(() => fleetCiRenderMismatches("name: CI\n", leg, releaseWf)).toThrow("anchor lost");
  });

  // The live-file forcing test: the exact structural judgment the ssot
  // rule runs on the REAL sources, so breaking any pinned link goes red
  // here.
  const liveMismatches = () =>
    fleetCiRenderMismatches(
      readFileSync("templates/base/.github/workflows/ci.yml.jinja", "utf-8"),
      readFileSync("templates/release-please/fragments/all-green-release.jinja", "utf-8"),
      readFileSync("templates/release-please/.github/workflows/release.yml.jinja", "utf-8"),
    );

  test("the fleet-ci render is ARMED: every link the ssot rule pins holds on the live templates", () => {
    expect(liveMismatches()).toEqual([]);
  });
});

describe("pagesLegMismatches", () => {
  const leg = [
    "",
    "  pages:",
    "    needs: [all-green]",
    "    if: >-",
    "      needs.all-green.result == 'success' &&",
    "      github.event_name == 'push' &&",
    "      github.ref == 'refs/heads/main'",
    "    concurrency:",
    "      group: pages",
    "      cancel-in-progress: false",
    "    permissions:",
    "      contents: read",
    "      pages: write",
    "      id-token: write",
    "      issues: write",
    "    uses: ./.github/workflows/pages.yml",
    "    with:",
    "      sha: {% raw %}${{ github.sha }}{% endraw %}",
  ].join("\n");
  const pagesWf = [
    "name: Pages",
    "",
    "on:",
    "  workflow_call:",
    "    inputs:",
    "      sha:",
    "        required: true",
    "        type: string",
    "  schedule:",
    '    - cron: "23 4 * * *"',
    "  workflow_dispatch:",
    "",
    "concurrency:",
    "  group: {% raw %}${{ inputs.sha != '' && format('pages-called-{0}', github.run_id) || 'pages' }}{% endraw %}",
    "  cancel-in-progress: false",
    "",
    "jobs:",
    "  deploy:",
    "    uses: {{ github_username }}/repo-platform/.github/workflows/reusable-pages.yml@build",
    "    with:",
    "      sha: {% raw %}${{ inputs.sha }}{% endraw %}",
    "      setup: {{ pages_setup }}",
    "",
  ].join("\n");
  const reusable = [
    "on:",
    "  workflow_call:",
    "    inputs:",
    "      sha:",
    "        required: false",
    "        type: string",
    '        default: ""',
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "        with:",
    "          fetch-depth: 0",
    "          ref: ${{ inputs.sha || (github.event_name == 'push' && github.sha || github.event.repository.default_branch) }}",
    "",
  ].join("\n");

  const renderedPages = [
    "on:",
    "  workflow_call:",
    "    inputs:",
    "      sha:",
    "        required: true",
    "  schedule:",
    '    - cron: "23 4 * * *"',
    "  workflow_dispatch:",
    "jobs:",
    "  deploy:",
    "    uses: Vivswan/repo-platform/.github/workflows/reusable-pages.yml@build",
    "    with:",
    "      sha: ${{ inputs.sha }}",
    "",
  ].join("\n");
  const renderedCi = [
    "jobs:",
    "  all-green:",
    "    needs: [checks, ci]",
    "  pages:",
    "    needs: [all-green]",
    "    uses: ./.github/workflows/pages.yml",
    "    with:",
    "      sha: ${{ github.sha }}",
    "",
  ].join("\n");
  const rendered = { pagesText: renderedPages, ciText: renderedCi };
  const judge = (
    legText = leg,
    pagesText = pagesWf,
    reusableText = reusable,
    renderedTexts = rendered,
  ) => pagesLegMismatches(legText, pagesText, reusableText, renderedTexts);

  test("the canonical sources and render pass clean", () => {
    expect(judge()).toEqual([]);
  });

  test("the RENDERED pages.yml is judged as parsed YAML - a push trigger reaching the render through any source spelling or jinja tag goes red", () => {
    for (const trigger of [
      "push:\n    branches: [main]",
      '"push":\n    branches: [main]',
      "pull_request:",
    ]) {
      const found = judge(leg, pagesWf, reusable, {
        ...rendered,
        pagesText: renderedPages.replace("  schedule:", `  ${trigger}\n  schedule:`),
      });
      expect(found.some((m) => m.file.includes("pages.yml triggers"))).toBe(true);
    }
    const unpassed = judge(leg, pagesWf, reusable, {
      ...rendered,
      pagesText: renderedPages.replace("      sha: ${{ inputs.sha }}\n", ""),
    });
    expect(unpassed.some((m) => m.expected.includes("the rendered deploy passing sha"))).toBe(true);
  });

  test("the RENDERED ci.yml pages leg is judged as parsed YAML - a missing job, a hook edge, or an unpassed sha goes red", () => {
    for (const ciText of [
      renderedCi.replace(/ {2}pages:[\s\S]*$/, ""),
      renderedCi.replace("    needs: [all-green]", "    needs: [all-green, post-green]"),
      renderedCi.replace("      sha: ${{ github.sha }}\n", ""),
    ]) {
      const found = judge(leg, pagesWf, reusable, { ...rendered, ciText });
      expect(found.some((m) => m.file.includes("ci.yml job 'pages'"))).toBe(true);
    }
  });

  test("a push: trigger back on pages.yml goes red - a push deploy bypasses the all-green gate", () => {
    const found = judge(
      leg,
      pagesWf.replace("  schedule:", "  push:\n    branches: [main]\n  schedule:"),
      reusable,
    );
    expect(found.some((m) => m.expected.includes("no push: trigger"))).toBe(true);
    const pr = judge(leg, pagesWf.replace("  schedule:", "  pull_request:\n  schedule:"), reusable);
    expect(pr.some((m) => m.expected.includes("no pull_request: trigger"))).toBe(true);
  });

  test('a push trigger in any alternate YAML spelling goes red too - `"push":`, `? push`, and `push :` all parse as the trigger', () => {
    for (const [spelling, expected] of [
      ['  "push":', "no quoted, explicit-key"],
      ["  ? push", "no quoted, explicit-key"],
      ["  push :", "no whitespace before a mapping colon"],
    ]) {
      const found = judge(
        leg,
        pagesWf.replace("  schedule:", `${spelling}\n    branches: [main]\n  schedule:`),
        reusable,
      );
      expect(found.some((m) => m.expected.includes(expected))).toBe(true);
    }
  });

  test("an edge to the hook or the release leg goes red - a red one would hold the site back", () => {
    for (const needs of ["    needs: [all-green, post-green]", "    needs: [all-green, release]"]) {
      const found = judge(leg.replace("    needs: [all-green]", needs), pagesWf, reusable);
      expect(found.some((m) => m.expected.includes("exactly one needs: line"))).toBe(true);
    }
  });

  test("secrets: on the pages leg goes red - the called deploy reads none", () => {
    const found = judge(`${leg}\n    secrets: inherit`, pagesWf, reusable);
    expect(found.some((m) => m.expected.includes("no secrets: on the pages leg"))).toBe(true);
  });

  test("dropping any gate clause or the judged-sha pass from the leg goes red", () => {
    for (const clause of [
      "      needs.all-green.result == 'success' &&\n",
      "      github.event_name == 'push' &&\n",
      "      github.ref == 'refs/heads/main'",
    ]) {
      const found = judge(leg.replace(clause, ""), pagesWf, reusable);
      expect(found.some((m) => m.expected.includes("verbatim gate block"))).toBe(true);
    }
    const unpassed = judge(
      leg.replace("      sha: {% raw %}${{ github.sha }}{% endraw %}", ""),
      pagesWf,
      reusable,
    );
    expect(unpassed.some((m) => m.expected.includes("the JUDGED commit, explicit"))).toBe(true);
  });

  test("the pages permissions ceiling is pinned both ways", () => {
    const missing = judge(leg.replace("      pages: write\n", ""), pagesWf, reusable);
    expect(missing.some((m) => m.file.includes("pages permissions ceiling"))).toBe(true);
    const added = judge(
      leg.replace("      issues: write", "      issues: write\n      contents: write"),
      pagesWf,
      reusable,
    );
    expect(added.some((m) => m.file.includes("pages permissions ceiling"))).toBe(true);
  });

  test("pages.yml must declare the sha input, key its lane per called run, and hand the sha on", () => {
    const undeclared = judge(
      leg,
      pagesWf.replace(
        "  workflow_call:\n    inputs:\n      sha:\n        required: true\n        type: string\n",
        "  workflow_call:\n",
      ),
      reusable,
    );
    expect(undeclared.some((m) => m.expected.includes("declare the sha input"))).toBe(true);
    const plainLane = judge(leg, pagesWf.replace(/ {2}group: .*\n/, "  group: pages\n"), reusable);
    expect(plainLane.some((m) => m.expected.includes("pages-called-"))).toBe(true);
    const unpassed = judge(
      leg,
      pagesWf.replace("      sha: {% raw %}${{ inputs.sha }}{% endraw %}\n", ""),
      reusable,
    );
    expect(unpassed.some((m) => m.expected.includes("rides on to reusable-pages"))).toBe(true);
    const nightlyGone = judge(leg, pagesWf.replace("  workflow_dispatch:\n", ""), reusable);
    expect(nightlyGone.some((m) => m.expected.includes("the manual rebuild stays"))).toBe(true);
  });

  test("reusable-pages.yml must declare the sha input and check it out first", () => {
    const undeclared = judge(
      leg,
      pagesWf,
      reusable.replace(
        '      sha:\n        required: false\n        type: string\n        default: ""\n',
        "      other:\n        type: string\n",
      ),
    );
    expect(undeclared.some((m) => m.expected.includes("a workflow_call input named sha"))).toBe(
      true,
    );
    const ignored = judge(
      leg,
      pagesWf,
      reusable.replace(/ {10}ref: .*\n/, "          ref: ${{ github.sha }}\n"),
    );
    expect(ignored.some((m) => m.expected.includes("the deploy checkout's ref starting"))).toBe(
      true,
    );
    expect(() =>
      judge(
        leg,
        pagesWf,
        "on:\n  workflow_call:\n    inputs:\n      sha: {}\njobs:\n  deploy:\n    steps: []\n",
      ),
    ).toThrow("anchor lost");
  });

  test("the pages leg is ARMED: every link the pages-leg rule pins holds on the live sources", () => {
    expect(
      pagesLegMismatches(
        readFileSync("templates/pages/fragments/all-green-pages.jinja", "utf-8"),
        readFileSync("templates/pages/.github/workflows/pages.yml.jinja", "utf-8"),
        readFileSync(".github/workflows/reusable-pages.yml", "utf-8"),
        {
          pagesText: readFileSync(
            "tests/golden-renders/all-modules/.github/workflows/pages.yml",
            "utf-8",
          ),
          ciText: readFileSync(
            "tests/golden-renders/all-modules/.github/workflows/ci.yml",
            "utf-8",
          ),
        },
      ),
    ).toEqual([]);
  });
});

describe("prTitleWorkflowMismatches", () => {
  const workflow = [
    "name: PR Title",
    "",
    "on:",
    "  pull_request:",
    "    types: [opened, edited, reopened, synchronize]",
    "",
    "jobs:",
    "  pr-title:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: amannn/action-semantic-pull-request@v6",
    "",
  ].join("\n");
  const baseline = [
    "rulesets:",
    "  - name: pr-title",
    "    target: branch",
    "    enforcement: disabled",
    "    conditions:",
    "      ref_name:",
    "        include:",
    '          - "~DEFAULT_BRANCH"',
    "        exclude: []",
    "    rules:",
    "      - type: required_status_checks",
    "        parameters:",
    "          required_status_checks:",
    "            - context: pr-title",
    "              integration_id: 15368",
    "",
  ].join("\n");
  const moduleLayer = ["rulesets:", "  - name: pr-title", "    enforcement: active", ""].join("\n");

  test("passes the compliant trio", () => {
    expect(prTitleWorkflowMismatches(workflow, baseline, moduleLayer)).toEqual([]);
  });

  test("a tag target, a non-default-branch include, or a re-excluded branch goes red - the check would gate no merges", () => {
    const tagged = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("target: branch", "target: tag"),
      moduleLayer,
    );
    expect(tagged.some((m) => m.expected.includes("target: branch"))).toBe(true);
    const rebranched = prTitleWorkflowMismatches(
      workflow,
      baseline.replace('- "~DEFAULT_BRANCH"', "- refs/heads/develop"),
      moduleLayer,
    );
    expect(rebranched.some((m) => m.expected.includes("~DEFAULT_BRANCH"))).toBe(true);
    const unconditioned = prTitleWorkflowMismatches(
      workflow,
      baseline.replace(
        '\n    conditions:\n      ref_name:\n        include:\n          - "~DEFAULT_BRANCH"\n        exclude: []',
        "",
      ),
      moduleLayer,
    );
    expect(unconditioned.some((m) => m.expected.includes("~DEFAULT_BRANCH"))).toBe(true);
    const carvedOut = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("        exclude: []", '        exclude: ["~DEFAULT_BRANCH"]'),
      moduleLayer,
    );
    expect(carvedOut.some((m) => m.expected.includes("exclude exactly []"))).toBe(true);
  });

  test("a types list without synchronize goes red - the required check must exist at every pushed head", () => {
    const found = prTitleWorkflowMismatches(
      workflow.replace(
        "    types: [opened, edited, reopened, synchronize]",
        "    types: [opened, edited]",
      ),
      baseline,
      moduleLayer,
    );
    expect(found.some((m) => m.expected.includes("synchronize"))).toBe(true);
  });

  test("renaming the job or overriding its display name goes red - the id is the required context", () => {
    const renamed = prTitleWorkflowMismatches(
      workflow.replace("  pr-title:", "  title:"),
      baseline,
      moduleLayer,
    );
    expect(renamed.some((m) => m.expected.includes('"  pr-title:"'))).toBe(true);
    const displayNamed = prTitleWorkflowMismatches(
      workflow.replace("    runs-on:", "    name: info-title\n    runs-on:"),
      baseline,
      moduleLayer,
    );
    expect(displayNamed.some((m) => m.expected.includes("no job-level name:"))).toBe(true);
  });

  test("a swapped-out judgment step or any condition goes red - a required check must never be a green no-op", () => {
    const swapped = prTitleWorkflowMismatches(
      workflow.replace("      - uses: amannn/action-semantic-pull-request@v6", "      - run: true"),
      baseline,
      moduleLayer,
    );
    expect(swapped.some((m) => m.expected.includes("action-semantic-pull-request"))).toBe(true);
    const conditioned = prTitleWorkflowMismatches(
      workflow.replace("    runs-on:", "    if: false\n    runs-on:"),
      baseline,
      moduleLayer,
    );
    expect(conditioned.some((m) => m.expected.includes("no job- or step-level if:"))).toBe(true);
    const softened = prTitleWorkflowMismatches(
      workflow.replace("    runs-on:", "    continue-on-error: true\n    runs-on:"),
      baseline,
      moduleLayer,
    );
    expect(softened.some((m) => m.expected.includes("no continue-on-error"))).toBe(true);
  });

  test("a dropped integration pin, a renamed context, or an extra context goes red", () => {
    const unpinned = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("\n              integration_id: 15368", ""),
      moduleLayer,
    );
    expect(unpinned.some((m) => m.expected.includes("integration_id 15368"))).toBe(true);
    const renamed = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("- context: pr-title", "- context: pr-check"),
      moduleLayer,
    );
    expect(renamed.some((m) => m.expected.includes("context 'pr-title'"))).toBe(true);
    const extra = prTitleWorkflowMismatches(
      workflow,
      baseline.replace(
        "              integration_id: 15368",
        "              integration_id: 15368\n            - context: decoy\n              integration_id: 15368",
      ),
      moduleLayer,
    );
    expect(extra.some((m) => m.expected.includes("exactly one required check"))).toBe(true);
  });

  test("a missing baseline ruleset or an ACTIVE baseline copy goes red", () => {
    const missing = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("- name: pr-title", "- name: decoy"),
      moduleLayer,
    );
    expect(missing.some((m) => m.expected.includes("a 'pr-title' ruleset"))).toBe(true);
    const active = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("enforcement: disabled", "enforcement: active"),
      moduleLayer,
    );
    expect(active.some((m) => m.expected.includes("enforcement: disabled"))).toBe(true);
  });

  test("a module layer that does more (or less) than the enforcement flip goes red", () => {
    const disabled = prTitleWorkflowMismatches(
      workflow,
      baseline,
      moduleLayer.replace("enforcement: active", "enforcement: disabled"),
    );
    expect(disabled.some((m) => m.expected.includes("enforcement: active"))).toBe(true);
    const shadowing = prTitleWorkflowMismatches(
      workflow,
      baseline,
      moduleLayer.replace("    enforcement: active", "    enforcement: active\n    rules: []"),
    );
    expect(shadowing.some((m) => m.expected.includes("nothing else"))).toBe(true);
    const empty = prTitleWorkflowMismatches(workflow, baseline, "labels: []\n");
    expect(empty.some((m) => m.file.includes("templates/pr-title/settings.yml"))).toBe(true);
  });

  // The live-file forcing test: the exact judgment the pr-title-workflow
  // rule runs on the REAL sources, so breaking any of the three files
  // goes red here.
  const livePrTitle = () =>
    prTitleWorkflowMismatches(
      readFileSync("templates/pr-title/.github/workflows/pr-title.yml.jinja", "utf-8"),
      readFileSync(".github/settings-baseline.yml", "utf-8"),
      readFileSync("templates/pr-title/settings.yml", "utf-8"),
    );

  test("the pr-title workflow is ARMED: every link the rule pins holds on the live sources", () => {
    expect(livePrTitle()).toEqual([]);
  });
});

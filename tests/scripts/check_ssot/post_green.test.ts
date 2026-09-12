import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  FLEET_TOKEN_NON_WRITERS,
  FLEET_WRITERS,
  fleetTokenHolderMismatches,
  fleetWriterMismatches,
  postGreenCallerMismatches,
  settingsGreenGateMismatches,
} from "../../../scripts/check/ssot/post_green.ts";

describe("settingsGreenGateMismatches", () => {
  const live = () => readFileSync(".github/workflows/settings-repos.yml", "utf-8");

  // A minimal well-gated workflow, mutated per red case below: the
  // negative controls proving the judgment can fail through the same
  // path its green run takes.
  const GATE =
    "      - name: Require a green commit\n" +
    "        run: bun .github/scripts/fleet/require_green_commit.ts\n";
  const SELECT = "      - run: bun .github/scripts/fleet/select_settings_repos.ts\n";
  const CHECKOUT = "      - uses: actions/checkout@v7\n";
  const valid = `
jobs:
  apply:
    steps:
${CHECKOUT}${GATE}${SELECT}`;

  test("the synthetic fixture is judged clean - the control for every red case below", () => {
    expect(settingsGreenGateMismatches(valid)).toEqual([]);
  });

  const REL = ".github/workflows/settings-repos.yml";
  const GATE_MISSING = {
    file: REL,
    expected: "a step running fleet/require_green_commit.ts in the apply job",
    got: "missing - the fleet-wide settings writer would run ungated from raw pushes",
  };
  test.each([
    { reason: "a deleted gate", text: valid.replace(GATE, ""), mismatch: GATE_MISSING },
    {
      reason: "a gate commented out - a mention in a comment runs nothing",
      text: valid.replace(GATE, "      # run: bun .github/scripts/fleet/require_green_commit.ts\n"),
      mismatch: GATE_MISSING,
    },
    {
      reason: "a gate-shaped echo decoy - it carries the command without running it",
      text: valid.replace(
        "        run: bun .github/scripts/fleet/require_green_commit.ts\n",
        "        run: echo bun .github/scripts/fleet/require_green_commit.ts\n",
      ),
      mismatch: GATE_MISSING,
    },
    {
      reason: "a gate moved behind the selection",
      text: valid.replace(GATE, "").replace(SELECT, SELECT + GATE),
      mismatch: {
        file: REL,
        expected: "the green gate BEFORE the target selection",
        got: "the gate runs after targets are computed",
      },
    },
    {
      reason: "a conditioned gate",
      text: valid.replace(GATE, `${GATE}        if: github.event_name != 'schedule'\n`),
      mismatch: {
        file: REL,
        expected: "an unconditional green gate (every trigger reads main's tip)",
        got: "if: github.event_name != 'schedule'",
      },
    },
    {
      reason: "a checkout pinned to a ref - a tree the gate never judged",
      text: valid.replace(
        CHECKOUT,
        `${CHECKOUT}        with:\n          ref: \${{ github.event.before }}\n`,
      ),
      mismatch: {
        file: REL,
        expected:
          "the apply job's checkout without a ref - it lands on the trigger commit the gate judged",
        got: "ref: ${{ github.event.before }}",
      },
    },
    {
      reason: "a second checkout - it could replace the judged tree",
      text: valid.replace(SELECT, CHECKOUT + SELECT),
      mismatch: {
        file: REL,
        expected:
          "exactly one checkout in the apply job (a second one could replace the judged tree)",
        got: "2 checkout step(s)",
      },
    },
    {
      reason: "a second job with a ref'd checkout, however well the selecting job is gated",
      text: `${valid}  report:\n    steps:\n${CHECKOUT}        with:\n          ref: main\n`,
      mismatch: {
        file: REL,
        expected:
          "the report job's checkout without a ref - it lands on the trigger commit the gate judged",
        got: "ref: main",
      },
    },
  ])("$reason is the one mismatch", ({ text, mismatch }) => {
    expect(settingsGreenGateMismatches(text)).toEqual([mismatch]);
  });

  test("a selection step named by an echo decoy alone is anchor-lost, never a pass", () => {
    const decoy = valid.replace(SELECT, SELECT.replace("run: bun", "run: echo bun"));
    expect(() => settingsGreenGateMismatches(decoy)).toThrow("anchor lost");
  });

  test("the settings-repos green gate is ARMED: the live workflow passes the rule's judgment", () => {
    expect(settingsGreenGateMismatches(live())).toEqual([]);
  });
});

describe("fleetWriterMismatches", () => {
  const SETTINGS = ".github/workflows/settings-repos.yml";
  const live = (rel: string) => readFileSync(rel, "utf-8");

  // A minimal well-wired settings writer plus its post-green caller,
  // mutated per red case below: the negative controls for the judgment.
  const writer = `
on:
  schedule:
    - cron: "2 8 * * *"
  workflow_dispatch:
    inputs:
      repo: { type: string }
  workflow_call:
    inputs:
      repos: { type: string, required: true }
      sha: { type: string, required: true }
concurrency:
  group: \${{ inputs.sha != '' && format('settings-repos-called-{0}', github.run_id) || 'settings-repos' }}
jobs:
  apply:
    steps:
      - name: Require a green commit
        id: gate
        env:
          SOURCE_SHA: \${{ inputs.sha }}
        run: bun .github/scripts/fleet/require_green_commit.ts
      - name: Select settings targets
        env:
          ONLY_REPO: \${{ inputs.repos }}
        run: bun .github/scripts/fleet/select_settings_repos.ts
`;
  const caller = `
jobs:
  settings-fleet:
    concurrency:
      group: settings-repos
    uses: ./.github/workflows/settings-repos.yml
    with:
      repos: all
      sha: \${{ inputs.sha }}
`;
  // The workflows handed to the judgment: post-green.yml alone, unless a
  // case plants a second caller elsewhere.
  const POST_GREEN = ".github/workflows/post-green.yml";
  const only = (postGreen: string): Record<string, string> => ({ [POST_GREEN]: postGreen });
  const OWNER = "Vivswan";
  const SF = ".github/workflows/post-green.yml job settings-fleet";

  test("the synthetic pair is judged clean - the control for every red case below", () => {
    expect(fleetWriterMismatches(SETTINGS, writer, only(caller), OWNER)).toEqual([]);
  });

  test.each([
    {
      reason: "a push trigger - the apply would run outside the gate, racing its own CI run",
      text: writer.replace("on:\n  schedule:", "on:\n  push:\n    branches: [main]\n  schedule:"),
      postGreen: caller,
      expected: "triggers exactly schedule, workflow_dispatch, workflow_call",
    },
    {
      reason: "a dispatch input shadowing a call-only name (a hand run would take the called path)",
      text: writer.replace(
        "      repo: { type: string }\n",
        "      repo: { type: string }\n      sha: { type: string }\n",
      ),
      postGreen: caller,
      expected: "no workflow_dispatch input named repos or sha",
    },
    {
      reason: "a call without the sha input",
      text: writer.replace("      sha: { type: string, required: true }\n", ""),
      postGreen: caller,
      expected: "workflow_call inputs exactly repos and sha",
    },
    {
      reason: "a literal lane on a called run (it would wait on the lane its caller holds)",
      text: writer.replace(/group: \$\{\{ inputs\.sha.*$/m, "group: settings-repos"),
      postGreen: caller,
      expected: "concurrency group: ${{ inputs.sha != ''",
    },
    {
      reason:
        "the sha input not reaching the gate step (a called run would silently take the dispatch path)",
      text: writer.replace("          SOURCE_SHA: ${{ inputs.sha }}\n", ""),
      postGreen: caller,
      expected: "reads SOURCE_SHA: ${{ inputs.sha }}",
    },
    {
      reason: "the scope input reaching a decoy step instead of the selector",
      text: writer
        .replace("        env:\n          ONLY_REPO: ${{ inputs.repos }}\n", "")
        .replace(
          "      - name: Select settings targets",
          "      - name: decoy\n        env:\n          ONLY_REPO: ${{ inputs.repos }}\n        run: echo bun .github/scripts/fleet/select_settings_repos.ts\n      - name: Select settings targets",
        ),
      postGreen: caller,
      expected: "reads ONLY_REPO: ${{ inputs.repos }}",
    },
    {
      reason: "no caller job in post-green.yml",
      text: writer,
      postGreen: "jobs:\n  publish-build:\n    steps: []\n",
      expected: "a 'settings-fleet' job calling ./.github/workflows/settings-repos.yml",
    },
    {
      reason: "the caller re-deriving the sha from context",
      text: writer,
      postGreen: caller.replace("sha: ${{ inputs.sha }}", "sha: ${{ github.sha }}"),
      expected: "with.sha: ${{ inputs.sha }}",
    },
    {
      reason: "the caller holding no lane",
      text: writer,
      postGreen: caller.replace("    concurrency:\n      group: settings-repos\n", ""),
      expected: "concurrency group settings-repos",
    },
  ])("$reason is refused", ({ text, postGreen, expected }) => {
    const got = fleetWriterMismatches(SETTINGS, text, only(postGreen), OWNER).map(
      (m) => m.expected,
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toContain(expected);
  });

  test("a second caller anywhere in the repository is refused - it would be a second way into the fleet", () => {
    // A push-triggered workflow calling the writer bypasses the gate no
    // matter how well post-green.yml's own call is wired.
    const stray =
      "on:\n  push:\njobs:\n  apply:\n    uses: ./.github/workflows/settings-repos.yml\n";
    const got = fleetWriterMismatches(
      SETTINGS,
      writer,
      { ...only(caller), ".github/workflows/nightly.yml": stray },
      OWNER,
    ).map((m) => m.got);
    expect(got).toEqual([`called by ${SF}, .github/workflows/nightly.yml job apply`]);
  });

  test("the canonical same-repository spelling of a stray call is censused too", () => {
    const stray =
      "on:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  heal:\n    uses: Vivswan/repo-platform/.github/workflows/settings-repos.yml@main\n";
    const got = fleetWriterMismatches(
      SETTINGS,
      writer,
      { ...only(caller), ".github/workflows/heal.yaml": stray },
      OWNER,
    ).map((m) => m.got);
    expect(got).toEqual([
      `called by ${SF}, .github/workflows/heal.yaml job heal via Vivswan/repo-platform/.github/workflows/settings-repos.yml@main`,
    ]);
  });

  test("post-green.yml's own leg calling the writer by ref instead of ./ is refused - it would run an unjudged ref", () => {
    const byRef = caller.replace(
      "uses: ./.github/workflows/settings-repos.yml",
      "uses: Vivswan/repo-platform/.github/workflows/settings-repos.yml@main",
    );
    const got = fleetWriterMismatches(SETTINGS, writer, only(byRef), OWNER);
    expect(got.map((m) => m.got)).toEqual([
      `called by ${SF} via Vivswan/repo-platform/.github/workflows/settings-repos.yml@main`,
      // The job check reads the same `uses:` and reports the spelling too.
      "uses: Vivswan/repo-platform/.github/workflows/settings-repos.yml@main",
    ]);
  });

  test("a foreign repository's same workflow path is not this writer and is not censused", () => {
    const foreign =
      "on:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  heal:\n    uses: Other/repo-platform/.github/workflows/settings-repos.yml@main\n";
    expect(
      fleetWriterMismatches(
        SETTINGS,
        writer,
        { ...only(caller), ".github/workflows/foreign.yml": foreign },
        OWNER,
      ),
    ).toEqual([]);
  });

  test("a gate step renamed away from its exact command is anchor-lost, never a pass", () => {
    const renamed = writer.replace(
      "run: bun .github/scripts/fleet/require_green_commit.ts",
      "run: bun .github/scripts/fleet/green_gate.ts",
    );
    expect(() => fleetWriterMismatches(SETTINGS, renamed, only(caller), OWNER)).toThrow(
      "anchor lost",
    );
  });

  test("every registered fleet writer is ARMED: the live files hold every link the rule pins", () => {
    const workflows = Object.fromEntries(
      readdirSync(".github/workflows")
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => [`.github/workflows/${name}`, live(`.github/workflows/${name}`)]),
    );
    for (const rel of Object.keys(FLEET_WRITERS)) {
      expect(fleetWriterMismatches(rel, live(rel), workflows, OWNER)).toEqual([]);
    }
  });
});

describe("postGreenCallerMismatches", () => {
  const OWNER = "Vivswan";
  const ci =
    "on:\n  push:\njobs:\n  all-green:\n    steps: []\n  post-green:\n    needs: [all-green]\n    uses: ./.github/workflows/post-green.yml\n";
  const workflows = (extra: Record<string, string> = {}): Record<string, string> => ({
    ".github/workflows/ci.yml": ci,
    ".github/workflows/post-green.yml": "on:\n  workflow_call:\njobs: {}\n",
    ...extra,
  });

  test("ci.yml's post-green job as the sole caller is clean - the control", () => {
    expect(postGreenCallerMismatches(workflows(), OWNER)).toEqual([]);
  });

  test.each<{ reason: string; extra: Record<string, string>; got: string }>([
    {
      reason:
        "a second caller in another workflow (every post-green leg would run behind its trigger)",
      extra: {
        ".github/workflows/nightly.yaml":
          "on:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  run:\n    uses: Vivswan/repo-platform/.github/workflows/post-green.yml@main\n",
      },
      got: "called by .github/workflows/ci.yml job post-green, .github/workflows/nightly.yaml job run via Vivswan/repo-platform/.github/workflows/post-green.yml@main",
    },
    {
      reason: "no caller at all (the legs would never run)",
      extra: { ".github/workflows/ci.yml": "on:\n  push:\njobs:\n  all-green:\n    steps: []\n" },
      got: "no caller at all",
    },
    {
      reason: "the right job calling by ref instead of ./ (an unjudged ref's copy would run)",
      extra: {
        ".github/workflows/ci.yml": ci.replace(
          "uses: ./.github/workflows/post-green.yml",
          "uses: vivswan/Repo-Platform/.github/workflows/post-green.yml@v1",
        ),
      },
      got: "called by .github/workflows/ci.yml job post-green via vivswan/Repo-Platform/.github/workflows/post-green.yml@v1",
    },
  ])("$reason is refused", ({ extra, got }) => {
    expect(postGreenCallerMismatches(workflows(extra), OWNER).map((m) => m.got)).toEqual([got]);
  });

  test("the live repository holds the invariant", () => {
    const live = Object.fromEntries(
      readdirSync(".github/workflows")
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => [
          `.github/workflows/${name}`,
          readFileSync(`.github/workflows/${name}`, "utf-8"),
        ]),
    );
    expect(postGreenCallerMismatches(live, OWNER)).toEqual([]);
  });
});

describe("fleetTokenHolderMismatches", () => {
  const holder =
    "jobs:\n  x:\n    steps:\n      - env:\n          T: ${{ secrets.REPO_PLATFORM_TOKEN }}\n";
  const complete = (): Record<string, string> =>
    Object.fromEntries(
      [...Object.keys(FLEET_WRITERS), ...Object.keys(FLEET_TOKEN_NON_WRITERS)].map((rel) => [
        rel,
        holder,
      ]),
    );

  test("every registered holder reading the token, and nothing else, is clean - the control", () => {
    expect(fleetTokenHolderMismatches(complete())).toEqual([]);
  });

  test("an unregistered workflow reading the fleet token is an unclassified candidate writer", () => {
    const got = fleetTokenHolderMismatches({
      ...complete(),
      ".github/workflows/nightly.yml": holder,
    });
    expect(got).toEqual([
      {
        file: ".github/workflows/nightly.yml",
        expected: expect.stringContaining("FLEET_WRITERS"),
        got: "reads secrets.REPO_PLATFORM_TOKEN unclassified",
      },
    ]);
  });

  test.each([
    { reason: "the token gone", text: "jobs: {}\n" },
    {
      reason: "the token named only in a comment (the census reads the parsed document)",
      text: "# ${{ secrets.REPO_PLATFORM_TOKEN }}\njobs: {}\n",
    },
  ])(
    "a classified holder that stopped reading the token - $reason - is a stale entry, not a silent pass",
    ({ text }) => {
      const workflows = complete();
      workflows[".github/workflows/refresh-gitignore.yml"] = text;
      expect(fleetTokenHolderMismatches(workflows).map((m) => m.file)).toEqual([
        "scripts/check/ssot/post_green.ts FLEET_TOKEN_NON_WRITERS",
      ]);
    },
  );

  test.each([
    {
      reason: "bracket access",
      text: "jobs:\n  x:\n    steps:\n      - env:\n          T: ${{ secrets['REPO_PLATFORM_TOKEN'] }}\n",
    },
    {
      reason: "a called workflow handed every secret",
      text: "jobs:\n  x:\n    uses: ./.github/workflows/sync-repos.yml\n    secrets: inherit\n",
    },
    {
      reason: "the whole secrets context",
      text: "jobs:\n  x:\n    steps:\n      - env:\n          ALL: ${{ toJSON(secrets) }}\n",
    },
    {
      reason: "a case-variant context and name (Actions resolves both in any case)",
      text: "jobs:\n  x:\n    steps:\n      - env:\n          T: ${{ SECRETS.repo_platform_token }}\n",
    },
    {
      reason: "a computed secret name",
      text: "jobs:\n  x:\n    steps:\n      - env:\n          T: ${{ secrets[format('REPO_{0}_TOKEN', 'PLATFORM')] }}\n",
    },
  ])("an unregistered holder reading the token by $reason is censused too", ({ text }) => {
    const got = fleetTokenHolderMismatches({ ...complete(), ".github/workflows/other.yml": text });
    expect(got.map((m) => [m.file, m.got])).toEqual([
      [".github/workflows/other.yml", "reads secrets.REPO_PLATFORM_TOKEN unclassified"],
    ]);
  });

  test("a workflow naming only OTHER secrets is no holder - the census is not a bare word match", () => {
    const other =
      "jobs:\n  x:\n    steps:\n      - env:\n          A: ${{ secrets.GITHUB_TOKEN }}\n          B: ${{ secrets['NPM_TOKEN'] }}\n      - run: echo secrets are read above\n";
    expect(
      fleetTokenHolderMismatches({ ...complete(), ".github/workflows/other.yml": other }),
    ).toEqual([]);
  });

  test("the live repository's holders are exactly the two rosters", () => {
    const live = Object.fromEntries(
      readdirSync(".github/workflows")
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => [
          `.github/workflows/${name}`,
          readFileSync(`.github/workflows/${name}`, "utf-8"),
        ]),
    );
    expect(fleetTokenHolderMismatches(live)).toEqual([]);
  });
});

// The render's wiring: the records that pin its owner and build commit
// (the answers file, then the manifest once the sync writer has retired
// it), and the ci.yml single-call gate shape that gates its merge.

import { describe, expect, test } from "bun:test";
import { RESYNC } from "../../../../../actions/validate-template-report/validator/checks/manifest_shape.ts";
import {
  coveredPaths,
  declaredOwnership,
  type RenderSelection,
} from "../../../../../actions/validate-template-report/validator/ownership.ts";
import { tempDirs } from "../../../../shared/temp_dir.ts";
import {
  ANSWERS,
  BASELINE,
  COMMIT,
  CUT_OVER_OMIT,
  MANAGED_HEADER,
  MANIFEST,
  managedEntry,
  manifestOf,
  stampedEntries,
  V2_REGISTRATION,
  validatorRunner,
} from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

describe("the render's owner and provenance answers", () => {
  test.each([
    {
      reason: "the key is absent",
      answers: `_commit: ${COMMIT}\n_src_path: gh:Vivswan/repo-platform\n`,
    },
    {
      reason: "the value carries regex metacharacters and a slash",
      answers: `_commit: ${COMMIT}\n_src_path: gh:Vivswan/repo-platform\ngithub_username: attacker/repo.*\n`,
    },
  ])("a managed render whose answers cannot pin an owner fails: $reason", ({ answers }) => {
    const { exitCode, stderr } = runValidator({ ".github/.copier-answers.yml": answers });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("`github_username` is missing or not a GitHub username");
  });

  // The sync records the build commit's full sha; anything else (copier's
  // describe output on a tagged or short-abbrev checkout, a hand edit)
  // cannot name the template commit the render must be judged at.
  const COMMIT_ERROR = (shape: string) =>
    `.github/.copier-answers.yml: _commit ${shape} - every render's stamp hook records the ` +
    "build commit's full sha; run a template sync to rewrite it, since the render cannot be " +
    "judged at its own template commit until then";
  test.each([
    { reason: "a short sha", value: "abc1234" },
    { reason: "a tag name", value: "ci-build-42/new" },
    { reason: "a PEP 440 version", value: "0.0.0.post5.dev0+abc1234" },
    { reason: "uppercase hex", value: COMMIT.toUpperCase() },
    { reason: "39 hex digits", value: COMMIT.slice(1) },
    { reason: "41 hex digits", value: `${COMMIT}0` },
  ])("a _commit that is not a full 40-hex sha is the run's one error: $reason", ({ value }) => {
    // The auto-stamped manifest carries the same value, so nothing else
    // is wrong with the render: the shape error stands alone.
    const { exitCode, stderr } = runValidator({
      ".github/.copier-answers.yml": ANSWERS().replace(COMMIT, value),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      `error: ${COMMIT_ERROR(`'${value}' is not a full 40-hex commit sha`)}\n\n1 error(s).\n`,
    );
  });

  test("a missing _commit is one error, owned here: provenance has nothing to compare and defers", () => {
    // The manifest's stamp still carries the render's commit; without the
    // recorded value the provenance check cannot judge it, and a second
    // error for the same deleted key would only pile on.
    const { exitCode, stderr } = runValidator({
      ".github/.copier-answers.yml": ANSWERS().replace(`_commit: ${COMMIT}\n`, ""),
      [MANIFEST]: manifestOf({
        ...stampedEntries(BASELINE),
        [MANIFEST]: `{"class": "managed", "hash": null, "commit": "${COMMIT}"}`,
        ".github/.copier-answers.yml": managedEntry(ANSWERS().replace(`_commit: ${COMMIT}\n`, "")),
      }),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toBe(`error: ${COMMIT_ERROR("is missing")}\n\n1 error(s).\n`);
  });

  test("a quoted github_username is read as its YAML value", () => {
    const { exitCode, stderr } = runValidator({
      ".github/.copier-answers.yml":
        `${MANAGED_HEADER}_commit: ${COMMIT}\n_src_path: gh:Vivswan/repo-platform\n` +
        'github_username: "Vivswan"\nprivate: true\n',
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("self mode accepts any well-formed owner without answers to pin from", () => {
    const { exitCode, stderr } = runValidator(
      {
        ".github/.copier-answers.yml": "_commit: abc\n_src_path: /tmp/src\n",
        ".github/workflows/ci.yml": BASELINE[".github/workflows/ci.yml"].replace(
          "Vivswan/repo-platform/actions/all-green@build",
          "SomeFork/repo-platform/actions/all-green@build",
        ),
      },
      ["--self"],
    );
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});

describe("a render the sync writer has cut over", () => {
  // The writer derives the registration's project block from the answers
  // file and retires the file; from then on the manifest's own entry is the
  // build record, the owner is unpinned, and the visibility is unrecorded.
  const cutOver = (extra: Record<string, string> = {}) =>
    runValidator({ ".repo-platform.yml": V2_REGISTRATION, ...extra }, [], {
      omit: CUT_OVER_OMIT,
    });
  const writerManifest = (commit: string | null, tree: Record<string, string> = {}) =>
    manifestOf({
      ...stampedEntries(cutOverTree(tree)),
      [MANIFEST]: `{"class": "managed", "hash": null, "commit": ${JSON.stringify(commit)}}`,
    });
  const cutOverTree = (extra: Record<string, string>) => {
    const tree: Record<string, string> = {
      ...BASELINE,
      ".repo-platform.yml": V2_REGISTRATION,
      ...extra,
    };
    for (const rel of CUT_OVER_OMIT) delete tree[rel];
    return tree;
  };

  test("passes with no answers file: the manifest records the build", () => {
    const { exitCode, stderr } = cutOver();
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test.each([
    { reason: "no commit", commit: null, shape: "no build commit" },
    {
      reason: "a short sha",
      commit: "abc1234",
      shape: "'abc1234', which is not a full 40-hex commit sha",
    },
  ])(
    "a manifest stamping $reason is the run's one error, naming the manifest",
    ({ commit, shape }) => {
      const { exitCode, stderr } = cutOver({ [MANIFEST]: writerManifest(commit) });
      expect(exitCode).toBe(1);
      expect(stderr).toBe(
        `error: ${MANIFEST}: its own entry records ${shape} - the sync writer stamps the build ` +
          "commit it wrote the tree from there, and the tree cannot be judged at its own build " +
          `commit until it does; ${RESYNC}\n\n1 error(s).\n`,
      );
    },
  );

  test("the answers file stays required while the registration keeps the template's shape", () => {
    const { exitCode, stderr } = runValidator({}, [], { omit: [".github/.copier-answers.yml"] });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      ".github/.copier-answers.yml is missing while .repo-platform.yml still has the shape the template rendered",
    );
  });

  test("the managed header and the fleet caller are still checked, for any owner", () => {
    const forked = BASELINE[".github/workflows/ci.yml"].replaceAll("Vivswan/", "SomeFork/");
    const ok = cutOver({ ".github/workflows/ci.yml": forked });
    expect(ok.stderr).toBe("");
    expect(ok.exitCode).toBe(0);
    const headerless = cutOver({ ".yamllint": "extends: default\n" });
    expect(headerless.exitCode).toBe(1);
    expect(headerless.stderr).toContain(
      ".yamllint: does not open with the managed header ('This file is managed by <owner>/repo-platform.')",
    );
    const noCaller = cutOver({
      ".github/workflows/ci.yml": BASELINE[".github/workflows/ci.yml"].replace(
        "Vivswan/repo-platform/.github/workflows/fleet-ci.yml@build",
        "./.github/workflows/other.yml",
      ),
    });
    expect(noCaller.exitCode).toBe(1);
    expect(noCaller.stderr).toContain("no job calls repo-platform's fleet-ci.yml reusable");
  });

  test("while the answers file still exists beside a converted registration it stays the record", () => {
    // A hand-converted registration ahead of the sync: the answers still
    // pin the owner, so a fork's fleet-ci caller is refused as before.
    const pinned = runValidator({
      ".repo-platform.yml": V2_REGISTRATION,
      ".github/workflows/ci.yml": BASELINE[".github/workflows/ci.yml"].replace(
        "Vivswan/repo-platform/.github/workflows/fleet-ci.yml@build",
        "SomeFork/repo-platform/.github/workflows/fleet-ci.yml@build",
      ),
    });
    expect(pinned.exitCode).toBe(1);
    expect(pinned.stderr).toContain("no job calls repo-platform's fleet-ci.yml reusable");
    const clean = runValidator({ ".repo-platform.yml": V2_REGISTRATION });
    expect(clean.stderr).toBe("");
    expect(clean.exitCode).toBe(0);
  });

  test("the tables stand down exactly what the cutover fixture omits", () => {
    // Public-only entries stand down while the visibility is unrecorded, and
    // the template renders none today, so only the answers file leaves. A
    // returning public-only file fails this and needs its own cut-over case.
    const publicRender: RenderSelection = {
      isPrivateRender: false,
      selectedModules: ["uv"],
      registeredByAnswers: true,
    };
    const cutOverRender: RenderSelection = {
      ...publicRender,
      isPrivateRender: null,
      registeredByAnswers: false,
    };
    const cutRoster = new Set(declaredOwnership(cutOverRender).map((entry) => entry.path));
    const cutCovered = coveredPaths(cutOverRender);
    expect({
      roster: declaredOwnership(publicRender)
        .map((entry) => entry.path)
        .filter((path) => !cutRoster.has(path)),
      covered: [...coveredPaths(publicRender)].filter((path) => !cutCovered.has(path)),
    }).toEqual({ roster: CUT_OVER_OMIT, covered: CUT_OVER_OMIT });
  });
});

describe("the single-call gate shape", () => {
  // The meta-check inversion: the required check is the all-green JOB's
  // own check run, so client renders carry checks + ci + all-green, and
  // the fleet-ci caller must exist unconditional (a skipped caller
  // stands down from the gate and every fleet gate silently drops).
  const gateCi = (ciJob: string[] = [], gate: string[] = []): string =>
    [
      "# This file is managed by Vivswan/repo-platform.",
      "name: CI",
      "jobs:",
      "  checks:",
      "    uses: ./.github/workflows/checks.yml",
      ...(ciJob.length > 0
        ? ciJob
        : ["  ci:", "    uses: Vivswan/repo-platform/.github/workflows/fleet-ci.yml@build"]),
      ...(gate.length > 0
        ? gate
        : [
            "  all-green:",
            "    needs: [checks, ci]",
            "    if: always()",
            "    runs-on: ubuntu-latest",
            "    steps:",
            "      - uses: Vivswan/repo-platform/actions/all-green@build",
            "        with:",
            "          needs: ${{ toJSON(needs) }}",
          ]),
      "",
    ].join("\n");
  const GATE_CI = gateCi();

  test("the single-call gate shape passes", () => {
    const { exitCode, stderr } = runValidator({
      ".github/workflows/ci.yml": GATE_CI,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test.each<{ reason: string; ciJob: string[] }>([
    {
      reason: "no job calls it at all (a decoy run job in its place)",
      ciJob: ["  ci:", "    runs-on: ubuntu-latest", "    steps: [{ run: echo decoy }]"],
    },
    {
      reason: "a look-alike under another owner",
      ciJob: ["  ci:", "    uses: evil/repo-platform/.github/workflows/fleet-ci.yml@build"],
    },
  ])(
    "a ci.yml without the owned fleet-ci caller fails (every fleet gate silently dropped): $reason",
    ({ ciJob }) => {
      const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": gateCi(ciJob) });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("no job calls repo-platform's fleet-ci.yml");
    },
  );

  test("a conditioned fleet-ci caller fails (a skipped caller stands down from the gate)", () => {
    const { exitCode, stderr } = runValidator({
      ".github/workflows/ci.yml": gateCi([
        "  ci:",
        "    if: false",
        "    uses: Vivswan/repo-platform/.github/workflows/fleet-ci.yml@build",
      ]),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("fleet-ci caller job carries a job-level if:");
  });

  test("no all-green job fails - the required check is never created", () => {
    const { exitCode, stderr } = runValidator({
      ".github/workflows/ci.yml": gateCi([], ["  info-none:", "    needs: [checks, ci]"]),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no `all-green` job");
  });

  // One predicate (judgesThroughAction) decides the judgment step: the
  // repo-platform all-green action (any owner), unconditioned and
  // unsoftened, with the live needs context wired in.
  const ACTION_STEP = "      - uses: Vivswan/repo-platform/actions/all-green@build";
  const mutateGate = (from: string, to: string): string => {
    if (!GATE_CI.includes(from)) throw new Error(`GATE_CI fixture lost its ${from.trim()} line`);
    return GATE_CI.replace(from, to);
  };
  test.each([
    {
      reason: "a step that judges nothing (checkout alone)",
      ci: gateCi(
        [],
        [
          "  all-green:",
          "    needs: [checks, ci]",
          "    if: always()",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v7",
        ],
      ),
    },
    {
      reason: "an all-green action from another repository",
      ci: mutateGate(
        "Vivswan/repo-platform/actions/all-green@build",
        "Vivswan/other-repo/actions/all-green@main",
      ),
    },
    {
      reason: "a conditioned action step (the YAML parser normalizes a quoted if: key too)",
      ci: mutateGate(
        ACTION_STEP,
        '      - "if": false\n        uses: Vivswan/repo-platform/actions/all-green@build',
      ),
    },
    {
      reason: "a softened action step (continue-on-error)",
      ci: mutateGate(
        ACTION_STEP,
        "      - continue-on-error: true\n        uses: Vivswan/repo-platform/actions/all-green@build",
      ),
    },
    {
      reason: "a canned needs input (judges a fiction of the run)",
      ci: mutateGate(
        "          needs: ${{ toJSON(needs) }}",
        '          needs: \'{"ci": {"result": "success"}}\'',
      ),
    },
  ])(
    "an all-green job without the owned, wired, unconditioned action has no judgment step: $reason",
    ({ ci }) => {
      const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": ci });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("no judgment step");
    },
  );

  test("an inline run: script in the gate's place is the judgment error, naming that shape", () => {
    const { exitCode, stderr } = runValidator({
      ".github/workflows/ci.yml": gateCi(
        [],
        [
          "  all-green:",
          "    needs: [checks, ci]",
          "    if: always()",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: |",
          '          if [ "$RESULT" != "success" ]; then exit 1; fi',
        ],
      ),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ci.yml: the all-green job has no judgment step");
    expect(stderr).toContain("an inline `run:` script or a disabled action step judges nothing");
    expect(stderr).toContain("run a template sync to restore the managed ci.yml");
  });

  test("a rendered job absent from all-green's needs fails (the composer guards' backstop)", () => {
    // The composer's gate_jobs parity and preamble guards catch honest
    // mistakes at compose time but deliberately not obfuscated jinja; this
    // check, run by smoke-generate on every push, is the render-side
    // backstop they name: any job that ends up in a rendered ci.yml
    // without gating the merge is an error here.
    const { exitCode, stderr } = runValidator({
      ".github/workflows/ci.yml": BASELINE[".github/workflows/ci.yml"].replace(
        "  all-green:\n",
        "  release-freshness:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo rendered but undeclared\n  all-green:\n",
      ),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("all-green `needs:` is missing job(s): release-freshness");
  });

  test("a caller job missing from the gate's needs fails", () => {
    const unneeded = GATE_CI.replace("needs: [checks, ci]", "needs: [checks]");
    const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": unneeded });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("all-green `needs:` is missing job(s): ci");
  });

  test("a gate without exactly if: always() fails", () => {
    for (const mutated of [
      GATE_CI.replace("    if: always()\n", ""),
      GATE_CI.replace("if: always()", "if: success()"),
    ]) {
      const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": mutated });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("must carry exactly `if: always()`");
    }
  });

  test("gate-downstream jobs (needs: [all-green]) are exempt from the needs census", () => {
    const withRelease = `${GATE_CI}  release:\n    needs: [all-green]\n    uses: ./.github/workflows/release.yml\n`;
    const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": withRelease });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("the post-green hook caller, a release leg needing it, and a hook chained behind the leg are all gate-downstream", () => {
    const withHook = [
      GATE_CI,
      "  post-green:",
      "    needs: [all-green]",
      "    uses: ./.github/workflows/post-green.yml",
      "  release:",
      "    needs: [ci, all-green, post-green]",
      "    uses: owner/repo-platform/.github/workflows/fleet-release.yml@build",
      "  update-release:",
      "    needs: [release]",
      "    uses: ./.github/workflows/update-release.yml",
      "  publish-release:",
      "    needs: [release, update-release]",
      "    uses: owner/repo-platform/.github/workflows/fleet-release-publish.yml@build",
      "",
    ].join("\n");
    const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": withHook });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});

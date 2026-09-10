// Ownership-manifest byte parity, first half: hash and region parity,
// absence, provenance, and the roster cross-check against the ownership
// tables. manifest_entries.test.ts continues the same describe.

import { describe, expect, test } from "bun:test";
import { tempDirs } from "../../../../shared/temp_dir.ts";
import {
  ANSWERS,
  B,
  BASELINE,
  COMMIT,
  E,
  HB,
  HE,
  MANAGED_HEADER,
  MANIFEST,
  manifestOf,
  SELF_ENTRY,
  shaLatin1 as sha,
  stampedBaseline,
  validatorRunner,
} from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

describe("ownership-manifest byte parity", () => {
  const splitEntry = (grammar: string, begin: string, end: string, hash: string) =>
    `{"class": "split", "grammar": ${JSON.stringify(grammar)}, "begin": ${JSON.stringify(begin)}, ` +
    `"end": ${JSON.stringify(end)}, "hash": "${hash}"}`;

  test("a missing manifest is an error", () => {
    const { exitCode, stderr } = runValidator({}, [], { noManifest: true });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${MANIFEST} is missing - every build ships it`);
  });

  test("a stamped manifest with matching hashes passes", () => {
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(stampedBaseline()) });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a drifted managed file fails parity", () => {
    const entries = {
      ...stampedBaseline(),
      ".github/workflows/ci.yml": `{"class": "managed", "hash": "${"0".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".github/workflows/ci.yml: content does not match the sha256");
  });

  test("split parity covers the managed region only: side edits pass, region edits fail", () => {
    const region = `${B}\n# Security\n${E}\n`;
    const entries = {
      ...stampedBaseline(),
      ".github/SECURITY.md":
        `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(B)}, ` +
        `"end": ${JSON.stringify(E)}, "hash": "${sha(region)}"}`,
    };
    const sidesEdited = runValidator({
      [MANIFEST]: manifestOf(entries),
      ".github/SECURITY.md": `repo-owned preamble, freely edited\n${region}repo-owned tail, freely edited\n`,
    });
    expect(sidesEdited.stderr).toBe("");
    expect(sidesEdited.exitCode).toBe(0);
    const regionEdited = runValidator({
      [MANIFEST]: manifestOf(entries),
      ".github/SECURITY.md": `${B}\n# Security, reworded\n${E}\ntail\n`,
    });
    expect(regionEdited.exitCode).toBe(1);
    expect(regionEdited.stderr).toContain(".github/SECURITY.md: its managed region does");
  });

  test("an unstamped managed entry is an error naming the stamp hook", () => {
    const entries = { ...stampedBaseline(), ".yamllint": '{"class": "managed", "hash": null}' };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      ".yamllint": "extends: default\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".yamllint: .github/repo-platform-manifest.json records no hash");
  });

  // A listed file missing from the repo is deletion damage, whatever its hash state. The
  // workflow row selects pr-title (the roster then expects pr-title.yml); the docs row is
  // the baseline plus one entry the roster does not cover.
  const PR_TITLE = BASELINE[".repo-platform.yml"].replace(
    "modules: [uv]",
    "modules: [uv, pr-title]",
  );
  const DELETED = "but missing from the repo - a managed file deleted outside a sync";
  test.each([
    {
      reason: "a hash-null workflow entry is a deleted managed file",
      path: ".github/workflows/pr-title.yml",
      registration: PR_TITLE,
      entry: '{"class": "managed", "hash": null}',
    },
    {
      reason: "a stamped entry with no file is a deleted managed file",
      path: "docs/handbook.md",
      registration: BASELINE[".repo-platform.yml"],
      entry: `{"class": "managed", "hash": "${"a".repeat(64)}"}`,
    },
  ])("a listed file missing from the repo: $reason", ({ path, registration, entry }) => {
    const result = runValidator({
      ".repo-platform.yml": registration,
      [MANIFEST]: manifestOf({ ...stampedBaseline(), [path]: entry }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${path}: listed as managed in ${MANIFEST} ${DELETED}`);
    expect(result.stdout).not.toContain(path);
    // One verdict per path: the count is of findings naming the path.
    expect(result.stderr.split("\n").filter((line) => line.includes(path))).toHaveLength(1);
  });

  test("an unlisted roster path is an error even when its file is absent too", () => {
    // The roster and the manifest come from the same template commit, so a
    // roster path the manifest omits is a hand-deleted entry whether or not
    // the file survived; the deletion attack below is the file-present case.
    const entries = { ...stampedBaseline() } as Record<string, string>;
    delete entries[".yamllint"];
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) }, [], {
      omit: [".yamllint"],
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${MANIFEST} does not list '.yamllint'`);
    expect(stderr).toContain("the entry was deleted by hand");
  });

  // Absence and provenance are STRICT: every build ships the manifest and
  // the stamper always writes the recorded _commit, so a missing manifest,
  // a stamp differing from the recorded value, and a deleted roster entry
  // (file present or not) are errors on every render.
  test("a deleted roster entry whose file still exists is an error", () => {
    // THE deletion attack: drop ci.yml's entry, edit the file under its
    // header - without strict absence this would ride an advisory.
    const entries = { ...stampedBaseline() } as Record<string, string>;
    delete entries[".github/workflows/ci.yml"];
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      ".github/workflows/ci.yml": `${BASELINE[".github/workflows/ci.yml"]}# local tweak\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      ".github/repo-platform-manifest.json does not list '.github/workflows/ci.yml'",
    );
    expect(stderr).toContain("the entry was deleted by hand");
  });

  test("a nulled or mismatched provenance stamp is an error", () => {
    // Nulling the self entry's commit must not buy any lenient path: the
    // stamper always writes the recorded _commit.
    const nulled = runValidator({
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        [MANIFEST]: '{"class": "managed", "hash": null}',
      }),
    });
    expect(nulled.exitCode).toBe(1);
    expect(nulled.stderr).toContain("its provenance stamp is null but the render records _commit");
    const mismatched = runValidator({
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        [MANIFEST]: '{"class": "managed", "hash": null, "commit": "0.0.0.post4.dev0+dead999"}',
      }),
    });
    expect(mismatched.exitCode).toBe(1);
    expect(mismatched.stderr).toContain("stamped provenance");
  });

  test("a provenance error downgrades absence to an advisory naming it", () => {
    // One diagnostic per cause: under an already-reported provenance error,
    // a missing roster entry must not pile a second error per path on the
    // same tamper - but every absence still surfaces as an advisory.
    const entries = { ...stampedBaseline() } as Record<string, string>;
    delete entries[".github/workflows/ci.yml"];
    entries[MANIFEST] = '{"class": "managed", "hash": null}';
    const { exitCode, stdout, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("its provenance stamp is null");
    expect(stderr).not.toContain("the entry was deleted by hand");
    expect(stdout).toContain("does not list '.github/workflows/ci.yml'");
    expect(stdout).toContain("its provenance stamp is unusable (error above)");
  });

  // PyYAML (copier's writer) dumps shas shaped digits-e-digits UNQUOTED
  // (its float pattern needs a dot or signed exponent); the yaml core schema
  // reads them as a float. A typed read turned such build shas into a false
  // tampering report; the failsafe re-read keeps them strings.
  const EXPONENT_COMMIT = `95e1875${"0".repeat(33)}`;
  test("an exponent-shaped build sha reads as a string, not a YAML float", () => {
    // A render whose auto-stamped manifest carries the same sha as its
    // self-entry commit passes clean (no "stamped provenance" mismatch, no
    // missing-_commit text, nothing else).
    const { exitCode, stderr } = runValidator({
      ".github/.copier-answers.yml": `${MANAGED_HEADER}_commit: ${EXPONENT_COMMIT}\n_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n`,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("the exponent-shaped sha still feeds the provenance check (positive oracle)", () => {
    // The absence assertions above would also pass if provenance checking
    // silently stopped running. Same bare-exponent _commit, mismatched
    // stamp: the error must fire AND quote the sha as the recorded value,
    // proving the failsafe read returned the string and the check ran.
    const mismatched = runValidator({
      ".github/.copier-answers.yml": `${MANAGED_HEADER}_commit: ${EXPONENT_COMMIT}\n_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n`,
      [MANIFEST]: manifestOf({
        [MANIFEST]: '{"class": "managed", "hash": null, "commit": "zzz9999"}',
      }),
    });
    expect(mismatched.exitCode).toBe(1);
    expect(mismatched.stderr).toContain("stamped provenance");
    expect(mismatched.stderr).toContain(
      `(self-entry commit 'zzz9999') does not match the recorded render ${EXPONENT_COMMIT}`,
    );
  });

  test("with no recorded _commit, unlisted roster paths are advisories naming that gap", () => {
    // The registration check owns the missing-_commit error; here nothing
    // can be compared, so absence takes the caveat instead of a second
    // error per path.
    const entries = { ...stampedBaseline() } as Record<string, string>;
    delete entries[".yamllint"];
    const { exitCode, stdout, stderr } = runValidator({
      ".github/.copier-answers.yml": ANSWERS().replace(`_commit: ${COMMIT}\n`, ""),
      [MANIFEST]: manifestOf(entries),
    });
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("stamped provenance");
    expect(stderr).not.toContain("does not list '.yamllint'");
    expect(stdout).toContain(
      `advisory: ${MANIFEST} does not list '.yamllint', which this validator's ownership tables declare - the render records no _commit to compare against (the registration check's error)`,
    );
  });

  // One condition judges a roster-covered entry whose render condition is
  // off (the path is covered by SOME render, not this one): such an entry
  // cannot come from the template, so it is manifest drift.
  const PRIVATE_ANSWERS = ANSWERS("private: true\n");
  test.each<{ reason: string; path: string; tree: Record<string, string> }>([
    {
      reason: "a public-only file (CONTRIBUTING.md) listed on a private render",
      path: "CONTRIBUTING.md",
      tree: {
        ".github/.copier-answers.yml": PRIVATE_ANSWERS,
        [MANIFEST]: manifestOf({
          ...stampedBaseline(),
          ".github/.copier-answers.yml": `{"class": "managed", "hash": "${sha(PRIVATE_ANSWERS)}"}`,
          "CONTRIBUTING.md": splitEntry("managed-region", B, E, "a".repeat(64)),
        }),
      },
    },
    {
      reason:
        "the fleet LICENSE.md listed with custom-license selected (the repo owns its license)",
      path: "LICENSE.md",
      tree: {
        ".repo-platform.yml": BASELINE[".repo-platform.yml"].replace(
          "modules: [uv]",
          "modules: [uv, custom-license]",
        ),
        [MANIFEST]: manifestOf({
          ...stampedBaseline(),
          "LICENSE.md": splitEntry("managed-region", B, E, "a".repeat(64)),
        }),
      },
    },
    {
      reason: "an unselected module's workflow (pr-title.yml; the baseline selects only uv)",
      path: ".github/workflows/pr-title.yml",
      tree: {
        [MANIFEST]: manifestOf({
          ...stampedBaseline(),
          ".github/workflows/pr-title.yml": '{"class": "managed", "hash": null}',
        }),
      },
    },
  ])(
    "a roster entry whose render condition is off is manifest drift: $reason",
    ({ path, tree }) => {
      const { exitCode, stderr } = runValidator(tree);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`entry '${path}' should not exist for this render`);
    },
  );

  test("a tree carrying the base marker roster passes against the mirror-stamped manifest", () => {
    // The mirror-coverage claim's teeth: this fixture carries every base
    // marker/header path the mirror declares, all validated through the
    // auto-stamped manifest - a drifted mirror entry for any of them fails
    // the roster cross-check here instead of sitting inert.
    const { exitCode, stderr } = runValidator({
      ".editorconfig": `${HB}\n[*]\nindent_size = 2\n${HE}\n`,
      ".gitattributes": `${HB}\n*.bin binary\n${HE}\n`,
      ".github/CODEOWNERS": `${HB}\n/docs/ @Vivswan\n${HE}\n`,
      ".github/dependabot.yml": `${MANAGED_HEADER}version: 2\nupdates: []\n`,
      ".typography-allow": `${MANAGED_HEADER}`,
      ".yamllint": `${MANAGED_HEADER}extends: default\n`,
      ".github/CODE_OF_CONDUCT.md": `${MANAGED_HEADER}\n# Contributor Covenant Code of Conduct\n`,
      "CONTRIBUTING.md": `${B}\n# Contributing\n${E}\n`,
      "LICENSE.md": `${B}\n# License\n${E}\n`,
      ".github/SECURITY.md": `${B}\n# Security\n${E}\n`,
      "AGENTS.md": `${B}\n# AGENTS.md\n${E}\n`,
      ".github/instructions/review.instructions.md":
        '---\napplyTo: "**"\n---\n<!-- This file is managed by Vivswan/repo-platform. -->\n# Review rules\n',
      ".github/workflows/auto-assign.yml": `${MANAGED_HEADER}name: assign\non: [issues]\n`,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a managed entry hand-flipped to starter fails the roster cross-check", () => {
    // THE tamper scenario the cross-check exists for: sync baselines
    // non-conflicting local manifest edits, so without the tables this flip
    // would disable ci.yml's parity permanently and invisibly.
    const entries = { ...SELF_ENTRY, ".github/workflows/ci.yml": '{"class": "starter"}' };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      // A drifted ci.yml that keeps the managed header, so neither the
      // headers check nor the (now skipped) hash can be what flags it.
      ".github/workflows/ci.yml": `${BASELINE[".github/workflows/ci.yml"]}# local tweak\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `${MANIFEST}: entry '.github/workflows/ci.yml' claims class "starter"`,
    );
    expect(stderr).toContain("ownership tables declare it managed");
  });

  // One roster cross-check condition judges a region entry's present
  // metadata: begin, end, and grammar must each match the DECLARED pair
  // (.github/SECURITY.md's is the HTML form), or parity would cover a skewed
  // region. Each row's hash matches the region ITS OWN pair slices, so
  // parity is not what reports the disagreement.
  test.each([
    {
      reason: "a drifted end string",
      entry: splitEntry(
        "managed-region",
        B,
        "# NOT THE END",
        sha(`${B}\n# Security\n# NOT THE END\n`),
      ),
      body: `${B}\n# Security\n# NOT THE END\n${E}\ntail\n`,
    },
    {
      reason: "the hash marker spelling (a real pair, not the declared one)",
      entry: splitEntry("managed-region", HB, HE, sha(`${HB}\n# Security\n${HE}\n`)),
      body: `${HB}\n# Security\n${HE}\ntail\n`,
    },
    {
      reason: "an unknown grammar (prefix) on the declared pair",
      entry: splitEntry("prefix", B, E, sha(`${B}\n# Security\n${E}\n`)),
      body: `${B}\n# Security\n${E}\ntail\n`,
    },
  ])(
    "split metadata disagreeing with the declared pair fails the cross-check: $reason",
    ({ entry, body }) => {
      const { exitCode, stderr } = runValidator({
        [MANIFEST]: manifestOf({ ...stampedBaseline(), ".github/SECURITY.md": entry }),
        ".github/SECURITY.md": body,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(
        "carries split metadata outside its declared managed-region grammar",
      );
    },
  );

  test("a grammar-carrying region entry matching the declaration passes", () => {
    const region = `${B}\n# Security\n${E}\n`;
    const entries = {
      ...stampedBaseline(),
      ".github/SECURITY.md":
        `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(B)}, ` +
        `"end": ${JSON.stringify(E)}, "hash": "${sha(region)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      ".github/SECURITY.md": `${region}repo tail\n`,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a .gitignore entry hand-flipped to starter fails the cross-check", () => {
    const entries = {
      ...stampedBaseline(),
      ".gitignore": '{"class": "starter"}',
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`entry '.gitignore' claims class "starter"`);
    expect(stderr).toContain("ownership tables declare it split");
  });
});

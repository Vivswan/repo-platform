// The pages-caller parity model (scripts/check/ssot/pages_callers.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  PAGES_CALLERS,
  PAGES_CHECK,
  pagesCallerMismatches,
  pagesCheckMismatches,
} from "../../../scripts/check/ssot/pages_callers.ts";

describe("pagesCallerMismatches", () => {
  const MOUNTS = `'[{"path": "/", "source": "vitepress", "versioned": true}]'`;
  const caller = (job: string, withLines: string) =>
    `jobs:\n  ${job}:\n    uses: ./.github/workflows/reusable-pages.yml\n    with:\n${withLines}`;
  const shared =
    `      mounts: ${MOUNTS}\n` +
    "      site_title: repo-platform\n" +
    "      link_rot_label: docs-link-rot\n" +
    "      custom_domain: ${{ vars.CUSTOM_DOMAIN }}\n";
  const push = caller("docs-site", `      sha: \${{ github.sha }}\n${shared}`);
  const rebuild = caller("deploy", shared);

  test("equal shared inputs with sha on the push side alone yield nothing - the control", () => {
    expect(pagesCallerMismatches(push, rebuild)).toEqual([]);
  });

  test.each([
    {
      reason: "a title changed on one side",
      pushText: push,
      rebuildText: rebuild.replace("site_title: repo-platform", "site_title: platform"),
      mismatch: {
        file: PAGES_CALLERS.rebuild.file,
        expected:
          "site_title: repo-platform (the .github/workflows/ci.yml docs-site job's site_title)",
        got: "site_title: platform",
      },
    },
    {
      reason: "a mount added to the push deploy alone",
      pushText: push.replace(
        MOUNTS,
        `'[{"path": "/", "source": "vitepress", "versioned": true}, {"path": "/skills/", "source": "vitepress"}]'`,
      ),
      rebuildText: rebuild,
      mismatch: {
        file: PAGES_CALLERS.rebuild.file,
        expected: `mounts: [{"path": "/", "source": "vitepress", "versioned": true}, {"path": "/skills/", "source": "vitepress"}] (the .github/workflows/ci.yml docs-site job's mounts)`,
        got: `mounts: [{"path": "/", "source": "vitepress", "versioned": true}]`,
      },
    },
    {
      reason: "an input dropped from the rebuild",
      pushText: push,
      rebuildText: rebuild.replace("      link_rot_label: docs-link-rot\n", ""),
      mismatch: {
        file: PAGES_CALLERS.rebuild.file,
        expected:
          "a link_rot_label input on the deploy job, as .github/workflows/ci.yml passes link_rot_label",
        got: "missing - the two deploys would build different sites",
      },
    },
    {
      reason: "an input added to the rebuild alone",
      pushText: push,
      rebuildText: `${rebuild}      docs_dir: docs\n`,
      mismatch: {
        file: PAGES_CALLERS.push.file,
        expected:
          "a docs_dir input on the docs-site job, as .github/workflows/docs-site.yml passes docs_dir",
        got: "missing - the two deploys would build different sites",
      },
    },
    {
      reason: "a sha pinned on the rebuild",
      pushText: push,
      rebuildText: `${rebuild}      sha: \${{ github.sha }}\n`,
      mismatch: {
        file: PAGES_CALLERS.rebuild.file,
        expected: "no sha input on the deploy job (the rebuild builds the default branch head)",
        got: "sha: ${{ github.sha }}",
      },
    },
  ])("$reason is one mismatch", ({ pushText, rebuildText, mismatch }) => {
    expect(pagesCallerMismatches(pushText, rebuildText)).toEqual([mismatch]);
  });

  test.each([
    {
      reason: "the push job renamed",
      pushText: push.replace("docs-site:", "deploy-docs:"),
      rebuildText: rebuild,
    },
    {
      reason: "the rebuild calling another workflow",
      pushText: push,
      rebuildText: rebuild.replace("reusable-pages.yml", "pages.yml"),
    },
  ])("$reason throws - a lost anchor is never a clean pass", ({ pushText, rebuildText }) => {
    expect(() => pagesCallerMismatches(pushText, rebuildText)).toThrow(/anchor lost|job/);
  });

  test("the live callers agree", () => {
    expect(
      pagesCallerMismatches(
        readFileSync(PAGES_CALLERS.push.file, "utf-8"),
        readFileSync(PAGES_CALLERS.rebuild.file, "utf-8"),
      ),
    ).toEqual([]);
  });
});

describe("pagesCheckMismatches", () => {
  const MOUNTS = `'[{"path": "/", "source": "vitepress", "versioned": true}]'`;
  const push =
    "jobs:\n  docs-site:\n    uses: ./.github/workflows/reusable-pages.yml\n    with:\n" +
    `      mounts: ${MOUNTS}\n` +
    "      site_title: repo-platform\n" +
    "      link_rot_label: docs-link-rot\n";
  const check = (withLines: string) =>
    "jobs:\n  check:\n    steps:\n      - uses: actions/checkout@v7\n" +
    "      - uses: Vivswan/repo-platform/actions/pages-site@build\n        with:\n" +
    `          check: "true"\n${withLines}`;
  const shared = `          mounts: ${MOUNTS}\n          site-title: repo-platform\n`;

  test("the check step carrying the push deploy's mounts and title yields nothing - the control", () => {
    expect(pagesCheckMismatches(push, check(shared))).toEqual([]);
  });

  test.each([
    {
      reason: "a mount added to the push deploy alone",
      pushText: push.replace(
        MOUNTS,
        `'[{"path": "/", "source": "vitepress", "versioned": true, "include": [{"path": "skills", "mount": "skills", "page": "SKILL.md"}]}]'`,
      ),
      checkText: check(shared),
      mismatch: {
        file: PAGES_CHECK.file,
        expected: `mounts: [{"path": "/", "source": "vitepress", "versioned": true, "include": [{"path": "skills", "mount": "skills", "page": "SKILL.md"}]}] (the .github/workflows/ci.yml docs-site job's mounts)`,
        got: `mounts: [{"path": "/", "source": "vitepress", "versioned": true}]`,
      },
    },
    {
      reason: "the mounts dropped from the check step",
      pushText: push,
      checkText: check("          site-title: repo-platform\n"),
      mismatch: {
        file: PAGES_CHECK.file,
        expected:
          "a mounts input on the check job's pages-site step, as .github/workflows/ci.yml passes mounts",
        got: "missing - the PR check would judge a different site than the deploy builds",
      },
    },
    {
      reason: "a docs dir on the check step alone",
      pushText: push,
      checkText: check(`${shared}          docs-dir: docs\n`),
      mismatch: {
        file: PAGES_CALLERS.push.file,
        expected:
          "a docs_dir input on the docs-site job, as .github/workflows/docs-site.yml passes docs-dir",
        got: "missing - the PR check would judge a different site than the deploy builds",
      },
    },
  ])("$reason is one mismatch", ({ pushText, checkText, mismatch }) => {
    expect(pagesCheckMismatches(pushText, checkText)).toEqual([mismatch]);
  });

  test("a check job without the pages-site check step throws - a lost anchor is never a clean pass", () => {
    expect(() => pagesCheckMismatches(push, check(shared).replace('"true"', '"false"'))).toThrow(
      /anchor lost/,
    );
  });

  test("the live check step agrees with the push deploy", () => {
    expect(
      pagesCheckMismatches(
        readFileSync(PAGES_CALLERS.push.file, "utf-8"),
        readFileSync(PAGES_CHECK.file, "utf-8"),
      ),
    ).toEqual([]);
  });
});

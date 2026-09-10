// The pages-caller parity model (scripts/check/ssot/pages_callers.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PAGES_CALLERS, pagesCallerMismatches } from "../../../scripts/check/ssot/pages_callers.ts";

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
        expected: "site_title: repo-platform (the .github/workflows/ci.yml docs-site job's value)",
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
        expected: `mounts: [{"path": "/", "source": "vitepress", "versioned": true}, {"path": "/skills/", "source": "vitepress"}] (the .github/workflows/ci.yml docs-site job's value)`,
        got: `mounts: [{"path": "/", "source": "vitepress", "versioned": true}]`,
      },
    },
    {
      reason: "an input dropped from the rebuild",
      pushText: push,
      rebuildText: rebuild.replace("      link_rot_label: docs-link-rot\n", ""),
      mismatch: {
        file: PAGES_CALLERS.rebuild.file,
        expected: "a link_rot_label input on the deploy job, as .github/workflows/ci.yml passes",
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
          "a docs_dir input on the docs-site job, as .github/workflows/docs-site.yml passes",
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

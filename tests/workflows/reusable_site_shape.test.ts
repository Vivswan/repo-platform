// The fleet's site deploy: what lychee and the fuzz-issue contract define and the yaml cannot show. The urls step is
// executed as the runner runs it; the rest is cross-file (the action, ci.yml, fuzz-issue) or cross-step (the Pages gate).

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildBody, failureDirs } from "../../actions/fuzz-issue/fuzz-issue.ts";
import { loadAction, REPO_ROOT, runBashStep, type StepRun, stepNamed } from "../shared/action_step";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
// buildBody stamps the UTC day at call time, so the clock is frozen for the file and the expected date is a literal.
const DATE = "2026-03-04";
beforeAll(() => setSystemTime(new Date(`${DATE}T12:00:00Z`)));
afterAll(() => setSystemTime());

interface Step extends Record<string, unknown> {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
}

const source = readFileSync(
  join(import.meta.dir, "../../.github/workflows/reusable-site.yml"),
  "utf8",
);
const workflow = parseYaml(source) as { jobs: Record<string, { steps?: Step[] }> };
const steps = workflow.jobs.site?.steps ?? [];
const SITE_URLS = loadAction("actions/site-urls/action.yml");
const step = (id: string) => steps.find((candidate) => candidate.id === id);

describe("reusable-site.yml", () => {
  /** The site-urls action's own step run as the runner runs it, for `repository` checked out at `workspace`. */
  function resolveUrls(repository: string, workspace: string): StepRun {
    return runBashStep(stepNamed(SITE_URLS, "Resolve the site URLs"), {
      fills: {
        "${{ github.action_path }}": join(REPO_ROOT, "actions/site-urls"),
        "${{ github.event.repository.default_branch }}": "main",
        "${{ steps.action-bun.outputs.path }}": process.execPath,
      },
      env: {
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: repository,
        GITHUB_WORKSPACE: workspace,
      },
      cwd: temp.dir("site-urls-cwd-"),
      root: temp.dir("site-urls-"),
    });
  }

  // The step's id and the output names are the contract between two files: an output the workflow reads under a
  // name the action never declares reads as empty, and lychee then excludes nothing (edit-links) or remaps nothing.
  test("the urls step is the site-urls action, and every output the workflow reads from it is declared", () => {
    expect(step("urls")?.uses).toBe("$/actions/site-urls");
    const read = [...source.matchAll(/steps\.urls\.outputs\.([\w-]+)/g)].map((match) => match[1]);
    expect(new Set(read)).toEqual(new Set(Object.keys(SITE_URLS.outputs ?? {})));
  });

  // The lowercase host is lychee's reporting convention: a link to the own site in another case would be reported as
  // external. The remap is lychee's regex pair (pattern, a space, the replacement with $N captures): a blob link into the own
  // default branch, with a line fragment, a query, or a trailing slash (GitHub serves all three), must land on the
  // checkout's file; another repository's link, another branch, or the branch in another case (another ref) must
  // not match, or GitHub's 503 on anonymous blob crawls would be back as rot, or a dead ref would read as alive.
  test("the urls step, executed, resolves the project-pages base path, the lowercase owner origin, and the tree remap", () => {
    const remap =
      `^${RegExp.escape("https://github.com/Vivswan/Example-Repo/")}(blob|tree)/${RegExp.escape("main")}/([^?#]*?)/*([?#].*)?$ ` +
      "file:///home/runner/work/Example-Repo/Example-Repo/$2";
    expect(
      resolveUrls("Vivswan/Example-Repo", "/home/runner/work/Example-Repo/Example-Repo"),
    ).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
      outputs: {
        "base-path": "/Example-Repo/",
        "origin": "https://vivswan.github.io",
        "edit-links": `^${RegExp.escape("https://github.com/Vivswan/Example-Repo/edit/")}`,
        "tree-links": remap,
      },
    });
    // Rust's and JavaScript's regex syntax agree on these constructs.
    const [pattern, replacement] = remap.split(" ");
    const regex = new RegExp(pattern);
    const apply = (url: string) => (regex.test(url) ? url.replace(regex, replacement) : url);
    expect({
      blobWithFragment: apply("https://github.com/Vivswan/Example-Repo/blob/main/src/a.ts#L10-L12"),
      treeWithQuery: apply("https://github.com/Vivswan/Example-Repo/tree/main/docs?plain=1"),
      trailingSlash: apply("https://github.com/Vivswan/Example-Repo/blob/main/README.md/"),
      otherRepo: apply("https://github.com/Vivswan/other/blob/main/README.md"),
      otherBranch: apply("https://github.com/Vivswan/Example-Repo/blob/v1.2.0/src/a.ts"),
      branchInAnotherCase: apply("https://github.com/Vivswan/Example-Repo/blob/MAIN/README.md"),
    }).toEqual({
      blobWithFragment: "file:///home/runner/work/Example-Repo/Example-Repo/src/a.ts",
      treeWithQuery: "file:///home/runner/work/Example-Repo/Example-Repo/docs",
      trailingSlash: "file:///home/runner/work/Example-Repo/Example-Repo/README.md",
      otherRepo: "https://github.com/Vivswan/other/blob/main/README.md",
      otherBranch: "https://github.com/Vivswan/Example-Repo/blob/v1.2.0/src/a.ts",
      branchInAnotherCase: "https://github.com/Vivswan/Example-Repo/blob/MAIN/README.md",
    });
  });

  // GitHub serves the repository named <owner>.github.io, in whatever case, at the origin's root, so the hook builds
  // for "/".
  test("the urls step serves the owner's <owner>.github.io repository at the root", () => {
    const { outputs } = resolveUrls(
      "Vivswan/Vivswan.github.io",
      "/home/runner/work/Vivswan.github.io/Vivswan.github.io",
    );
    expect(outputs).toMatchObject({
      "base-path": "/",
      "origin": "https://vivswan.github.io",
    });
  });

  // The nightly's own-site exclude must be the same regex the assembly remapped into the artifact, which only the
  // assembly knows (a user site owns its top-level entries, not its origin), so it is read from the assembly step.
  // Read under a name the action never declares, it is empty, and lychee would crawl the site's own links.
  test("the nightly excludes the own links the assembly step declares", () => {
    const links = steps.find((candidate) => candidate.id === "links");
    const assembly = steps.find((candidate) => candidate.uses === "$/actions/pages-site");
    const args = (links?.with as Record<string, string> | undefined)?.args ?? "";
    expect(args).toContain(`--exclude '\${{ steps.${assembly?.id}.outputs.own-links }}'`);
    expect(Object.keys(loadAction("actions/pages-site/action.yml").outputs ?? {})).toContain(
      "own-links",
    );
  });

  // One lychee judges a site: the assembly's internal check (actions/pages-site/action.yml), the nightly, and the
  // install ci.yml's test job runs so the broken-link test is judged by it, all the same action at the same
  // version. The internal step's own knobs are judged by the live run in tests/ci/pages_site_build.
  test("the assembly's internal link check, the test job, and the nightly run one lychee at one version", () => {
    const internal = stepNamed(
      loadAction("actions/pages-site/action.yml"),
      "Check the site's internal links",
    ) as Step;
    const ci = parseYaml(
      readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8"),
    ) as { jobs: Record<string, { steps?: Step[] }> };
    const fixtures = ci.jobs["script-tests"]?.steps?.find(
      (candidate) => candidate.uses === internal.uses,
    );
    const nightly = step("links");
    const pin = (of: Step | undefined) => ({ uses: of?.uses, version: of?.with?.lycheeVersion });
    expect([pin(internal), pin(fixtures)]).toEqual([pin(nightly), pin(nightly)]);
    expect(nightly?.with?.lycheeVersion).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  // lychee's markdown report as the action writes it (lychee 0.24.2 over a fixture site, the run link appended by
  // lychee-action), before the fuzz-issue action reads it as a contract-v1 failure report.
  const LYCHEE_REPORT = [
    "# Summary",
    "",
    "| Status         | Count |",
    "|----------------|-------|",
    "| 🔍 Total       | 12    |",
    "| 🔗 Unique      | 11    |",
    "| ✅ Successful  | 1     |",
    "| ⏳ Timeouts    | 0     |",
    "| 🔀 Redirected  | 0     |",
    "| 👻 Excluded    | 8     |",
    "| ❓ Unknown     | 0     |",
    "| 🚫 Errors      | 3     |",
    "| ⛔ Unsupported | 0     |",
    "",
    "## Errors per input",
    "",
    "### Errors in docs/latest/index.html",
    "",
    "* [404] <https://github.com/o/r/blob/main/docs/no-such-page.md> (at 3:10) | Rejected status code: 404 Not Found",
    "* [ERROR] <https://no-such-host.example-fixture.org/a> (at 2:10) | Connection failed. Check network connectivity and firewall settings",
    "",
    "### Errors in index.html",
    "",
    "* [ERROR] <https://no-such-host.example-fixture.org/a> (at 10:10) | Connection failed. Check network connectivity and firewall settings",
    "",
    "[Full Github Actions output](https://github.com/o/r/actions/runs/42?check_suite_focus=true)",
    "",
  ].join("\n");

  test("lychee's report is the one failure of the fuzz-issue contract: written under the artifacts-dir, it rides into the issue body whole", () => {
    const output = String(step("links")?.with?.output);
    const report = steps.find((candidate) => candidate.with?.mode === "report");
    const artifactsDir = String(report?.with?.["artifacts-dir"]);
    expect(output.startsWith(`${artifactsDir}/`)).toBe(true);
    const rel = output.slice(artifactsDir.length + 1);
    expect(rel).toMatch(/^[A-Za-z0-9._-]+\/report\.md$/);
    const root = temp.dir("link-rot-");
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), LYCHEE_REPORT);
    const env = {
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_RUN_ID: "42",
    } as NodeJS.ProcessEnv;
    expect(buildBody(failureDirs(root), env, "", "generic")).toBe(
      [
        `Nightly run on ${DATE} produced 1 report(s).`,
        "",
        ...LYCHEE_REPORT.split("\n")
          .slice(0, -1)
          .map((line, index) => (index === 0 ? "## Summary" : line)),
        "",
        "Run: https://github.com/o/r/actions/runs/42",
      ].join("\n"),
    );
  });

  // The gate names a step id of this file and an output declared in another (actions/pages-site/action.yml). Either
  // one misspelled reads as false, so every Pages step skips and the deploy is silently off until a repository
  // notices its site never updates. Exact gates: a skipped or unset `publish` reads as false downstream too.
  test("the Pages steps and the link check gate on the assembly step's declared publish output alone", () => {
    const assembly = steps.find((candidate) => candidate.uses === "$/actions/pages-site");
    const declared = Object.keys(loadAction("actions/pages-site/action.yml").outputs ?? {});
    expect(declared).toEqual(expect.arrayContaining(["publish", "link-rot-label"]));
    const read = (output: string) => `steps.${assembly?.id}.outputs.${output}`;
    const gate = `${read("publish")} == 'true'`;
    const at = (action: string) =>
      steps.findIndex((candidate) => (candidate.uses ?? "").startsWith(`actions/${action}@`));
    expect(assembly?.id).toBeDefined();
    expect(steps.indexOf(assembly as Step)).toBeLessThan(at("configure-pages"));
    expect({
      configure: steps[at("configure-pages")].if,
      upload: steps[at("upload-pages-artifact")].if,
      deploy: steps[at("deploy-pages")].if,
      links: step("links")?.if,
    }).toEqual({
      configure: gate,
      upload: gate,
      deploy: gate,
      links: `github.event_name == 'schedule' && ${gate} && ${read("link-rot-label")} != ''`,
    });
  });
});

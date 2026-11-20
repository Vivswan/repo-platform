// The fleet's site deploy: what lychee and the fuzz-issue contract define and the yaml cannot show. The urls step is
// executed as the runner runs it; the rest is cross-file (the action, ci.yml, fuzz-issue) or cross-step (the Pages gate).

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildBody, failureDirs } from "../../actions/fuzz-issue/fuzz-issue.ts";
import { loadAction, REPO_ROOT, runBashStep, type StepRun, stepNamed } from "../shared/action_step";
import { evaluateCondition, interpolate, readsIn, stringsIn } from "../shared/github_expression";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const DATE = "2026-03-04";

// buildBody stamps the UTC day at call time, so the clock is frozen for the file and the expected date is a literal.
beforeAll(() => setSystemTime(new Date(`${DATE}T12:00:00Z`)));
afterAll(() => setSystemTime());

interface Step extends Record<string, unknown> {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
}

const source = readFileSync(
  join(import.meta.dir, "../../.github/workflows/reusable-site.yml"),
  "utf8",
);
const workflow = parseYaml(source) as {
  jobs: Record<string, { steps?: Step[]; environment?: { url?: string } }>;
};
const steps = workflow.jobs.site?.steps ?? [];
const SITE_URLS = loadAction("actions/site-urls/action.yml");
const LYCHEE = loadAction("actions/lychee/action.yml");
const step = (id: string) => steps.find((candidate) => candidate.id === id);
const PAGE_URL = "https://vivswan.github.io/Example-Repo/";

describe("reusable-site.yml", () => {
  /** The site-urls action's own step run as the runner runs it, for `repository` checked out at `workspace`;
   *  `siteUrl` is the address GitHub reports, "" for a caller with no Pages API to ask. */
  function resolveUrls(repository: string, workspace: string, siteUrl = ""): StepRun {
    return runBashStep(stepNamed(SITE_URLS, "Resolve the site URLs"), {
      context: {
        "github.action_path": join(REPO_ROOT, "actions/site-urls"),
        "github.event.repository.default_branch": "main",
        "inputs.site-url": siteUrl,
        "steps.action-bun.outputs.path": process.execPath,
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
    const read = readsIn(workflow)
      .filter(([context, id, field]) => context === "steps" && id === "urls" && field === "outputs")
      .map(([, , , key]) => key);
    expect(new Set(read)).toEqual(new Set(Object.keys(SITE_URLS.outputs ?? {})));
  });

  // Cross-file with actions/plan/action.yml: an input the action never declares is dropped with a warning, so the
  // hook's variables would read empty. A plan step after the hook exports too late for it.
  test("every plan input the workflow passes is declared, and each plan step runs before the hook", () => {
    const declared = Object.keys(loadAction("actions/plan/action.yml").inputs ?? {});
    const plans = steps.filter((candidate) => candidate.uses === "$/actions/plan");
    const passed = plans.flatMap((candidate) => Object.keys(candidate.with ?? {}));
    const hook = steps.indexOf(step("hook") as Step);
    expect(declared).toEqual(expect.arrayContaining(passed));
    expect(plans.filter((candidate) => steps.indexOf(candidate) > hook)).toEqual([]);
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

  // The hook's two inputs under the address GitHub reports. configure-pages spells it without a trailing slash and
  // members' hooks join onto `base-path` with one, so a custom domain is "/" and a project site keeps "/<repo>/"; the
  // repository's name decides nothing once GitHub has answered.
  test.each([
    { siteUrl: "https://docs.example.com", basePath: "/", origin: "https://docs.example.com" },
    {
      siteUrl: "https://neworg.github.io/Example-Repo",
      basePath: "/Example-Repo/",
      origin: "https://neworg.github.io",
    },
  ])("the urls step, handed $siteUrl, gives the hook $origin and $basePath", (row) => {
    const { exitCode, stderr, outputs } = resolveUrls(
      "Vivswan/Example-Repo",
      "/home/runner/work/Example-Repo/Example-Repo",
      row.siteUrl,
    );
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(outputs).toMatchObject({ "base-path": row.basePath, "origin": row.origin });
  });

  // The nightly's own-site exclusion must be the regex the assembly remapped into the artifact, which only the assembly
  // knows (a user site owns its top-level entries, not its origin), so the assembly writes the crawl's .lycheeignore
  // and the workflow stages that file; an argument could not carry it (one argument string is capped at 128 KiB).
  // Staged under a name the action never declares, the copy fails and the nightly skips.
  test("the nightly stages the assembly's .lycheeignore and excludes no own-links argument", () => {
    const staging = steps.find((candidate) => candidate.name === "Stage the crawl's .lycheeignore");
    const links = steps.find((candidate) => candidate.id === "links");
    const assembly = steps.find((candidate) => candidate.uses === "$/actions/pages-site");
    const env = staging?.env as Record<string, string> | undefined;
    const args = (links?.with as Record<string, string> | undefined)?.args ?? "";
    expect(env?.IGNORE).toBe(`\${{ steps.${assembly?.id}.outputs.link-rot-ignore }}`);
    expect(staging?.run).toBe('cp "$IGNORE" "$SITE_DIR/.lycheeignore"');
    expect(args).not.toContain("own-links");
    expect(Object.keys(loadAction("actions/pages-site/action.yml").outputs ?? {})).toContain(
      "link-rot-ignore",
    );
  });

  // One lychee judges a site: the assembly's internal check (actions/pages-site/action.yml) and the nightly are the
  // one lychee action, whose lock names the version. The internal step's own knobs are judged by the live run in
  // tests/ci/pages_site_build, which runs that action's step.
  test("the assembly's internal link check and the nightly are the one lychee action, each naming only inputs it declares", () => {
    const internal = stepNamed(
      loadAction("actions/pages-site/action.yml"),
      "Check the site's internal links",
    ) as Step;
    const nightly = step("links");
    const declared = Object.keys(LYCHEE.inputs ?? {});
    expect([internal.uses, nightly?.uses]).toEqual(["$/actions/lychee", "$/actions/lychee"]);
    for (const caller of [internal, nightly]) {
      expect(declared).toEqual(expect.arrayContaining(Object.keys(caller?.with ?? {})));
    }
  });

  // The steps after the check gate on the code it publishes: read under a name the action never declares, the code
  // reads as empty and every night fails without a verdict.
  test("every output the workflow reads from the link check is declared", () => {
    const read = readsIn(workflow)
      .filter(
        ([context, id, field]) => context === "steps" && id === "links" && field === "outputs",
      )
      .map(([, , , key]) => key);
    expect(new Set(read)).toEqual(new Set(Object.keys(LYCHEE.outputs ?? {})));
  });

  // lychee's markdown report as the action writes it (lychee 0.24.2 over a fixture site), before the fuzz-issue action
  // reads it as a contract-v1 failure report.
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
  ].join("\n");

  test("lychee's report is the one failure of the fuzz-issue contract: written under the artifacts-dir, it rides into the issue body whole", () => {
    const output = String(step("links")?.with?.report);
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

  // The address is asked before anything is built and handed to both readers: a reader left unwired builds by the
  // rule, green and wrong under a custom domain, and an input the action never declares is dropped with a warning.
  test("configure-pages runs unconditionally before the urls step, and the urls step and the assembly both take its base_url", () => {
    const pages = step("pages");
    const assembly = steps.find((candidate) => candidate.uses === "$/actions/pages-site");
    const address = "${{ steps.pages.outputs.base_url }}";
    expect(pages?.uses).toStartWith("actions/configure-pages@");
    expect(pages?.if).toBeUndefined();
    expect(steps.indexOf(pages as Step)).toBeLessThan(steps.indexOf(step("urls") as Step));
    expect([step("urls")?.with?.["site-url"], assembly?.with?.["site-url"]]).toEqual([
      address,
      address,
    ]);
    for (const action of ["actions/site-urls/action.yml", "actions/pages-site/action.yml"]) {
      expect(Object.keys(loadAction(action).inputs ?? {})).toContain("site-url");
    }
  });

  // The gate names a step id of this file and an output declared in another (actions/pages-site/action.yml). Either
  // one misspelled reads as false, so the upload and the deploy skip and the site is silently off until a repository
  // notices it never updates. Exact gates: a skipped or unset `publish` reads as false downstream too.
  test("the upload, the deploy, and the link check gate on the assembly step's declared publish output alone", () => {
    const assembly = steps.find((candidate) => candidate.uses === "$/actions/pages-site");
    const declared = Object.keys(loadAction("actions/pages-site/action.yml").outputs ?? {});
    expect(declared).toEqual(expect.arrayContaining(["publish", "link-rot-label"]));
    const read = (output: string) => `steps.${assembly?.id}.outputs.${output}`;
    const gate = `${read("publish")} == 'true'`;
    const at = (action: string) =>
      steps.findIndex((candidate) => (candidate.uses ?? "").startsWith(`actions/${action}@`));
    expect(assembly?.id).toBeDefined();
    expect({
      upload: steps[at("upload-pages-artifact")].if,
      deploy: steps[at("deploy-pages")].if,
      links: step("links")?.if,
    }).toEqual({
      upload: gate,
      deploy: gate,
      links: `github.event_name == 'schedule' && ${gate} && ${read("link-rot-label")} != ''`,
    });
  });

  // What drifts silently: `continue-on-error` hides the first deploy's failure from the job, so only the retry's
  // condition and the second operand of every page_url reader tell a missed artifact listing from a site that never
  // shipped. The deploy steps run as the runner runs them: a failure without `continue-on-error` ends the job there.
  test.each([
    { run: "nothing to publish", publish: "false", results: [], job: "green", deploys: 0, url: "" },
    {
      run: "no publish output",
      publish: undefined,
      results: [],
      job: "green",
      deploys: 0,
      url: "",
    },
    {
      run: "a first deploy that ships",
      publish: "true",
      results: ["success"],
      job: "green",
      deploys: 1,
      url: PAGE_URL,
    },
    {
      run: "a missed artifact listing, then a retry that ships",
      publish: "true",
      results: ["failure", "success"],
      job: "green",
      deploys: 2,
      url: PAGE_URL,
    },
    {
      run: "two failed deploys",
      publish: "true",
      results: ["failure", "failure"],
      job: "red",
      deploys: 2,
      url: "",
    },
  ])("$run ends $job after $deploys deploy(s), every page_url reader holding '$url'", (row) => {
    const deploys = steps.filter((candidate) =>
      candidate.uses?.startsWith("actions/deploy-pages@"),
    );
    const context: Record<string, string> = { "steps.site.outcome": "success" };
    if (row.publish !== undefined) context["steps.site.outputs.publish"] = row.publish;
    let job = "green";
    let ran = 0;
    for (const deploy of deploys) {
      if (job === "red" || !evaluateCondition(String(deploy.if), context)) continue;

      const outcome = row.results[ran] ?? "a deploy the row never expected";
      ran += 1;
      context[`steps.${deploy.id}.outcome`] = outcome;
      if (outcome === "success") context[`steps.${deploy.id}.outputs.page_url`] = PAGE_URL;
      if (outcome === "failure" && deploy["continue-on-error"] !== true) job = "red";
    }

    const readers = stringsIn(workflow).filter((text) =>
      readsIn(text).some((read) => read.includes("page_url")),
    );
    expect(readers).toContain(String(workflow.jobs.site?.environment?.url));
    expect({
      job,
      deploys: ran,
      urls: new Set(readers.map((reader) => interpolate(reader, context))),
      // One artifact at one pin: a retry naming another artifact would ship a different site.
      same: deploys.map((deploy) => ({ uses: deploy.uses, with: deploy.with })),
    }).toEqual({
      job: row.job,
      deploys: row.deploys,
      urls: new Set([row.url]),
      same: deploys.map(() => ({ uses: deploys[0].uses, with: deploys[0].with })),
    });
  });

  // What drifts silently: `fail: false` keeps the check green whatever lychee did, so only these conditions tell a
  // crashed lychee, or a check that never ran, from a clean night that closes the issue. The steps after the check
  // run as the runner runs them, a step after a failed one skipped; exit codes 1 and 3 are lychee's own errors and
  // 101 a Rust panic.
  test.each([
    { night: "a push, the check skipped", outcome: "skipped", code: undefined, does: [] },
    { night: "a clean night", outcome: "success", code: "0", does: ["resolve"] },
    { night: "broken links", outcome: "success", code: "2", does: ["report"] },
    { night: "lychee's general failure", outcome: "success", code: "1", does: ["fail"] },
    { night: "lychee's config failure", outcome: "success", code: "3", does: ["fail"] },
    { night: "a lychee panic", outcome: "success", code: "101", does: ["fail"] },
    { night: "an empty code", outcome: "success", code: "", does: ["fail"] },
    { night: "no code published", outcome: "success", code: undefined, does: ["fail"] },
  ])("after the link check, $night does $does and nothing else", ({ outcome, code, does }) => {
    const context: Record<string, string> = { "steps.links.outcome": outcome };
    if (code !== undefined) context["steps.links.outputs.exit-code"] = code;
    const after = steps.slice(steps.indexOf(step("links") as Step) + 1);
    const done: string[] = [];
    for (const next of after) {
      if (next.if !== undefined && !evaluateCondition(next.if, context)) continue;

      done.push(/^exit 1$/m.test(next.run ?? "") ? "fail" : String(next.with?.mode));
      if (done.at(-1) === "fail") break;
    }

    expect(done).toEqual([...does]);
  });
});

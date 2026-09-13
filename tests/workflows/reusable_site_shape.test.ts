// The fleet's site deploy in one job: the repo-owned hook runs from the checkout before the fleet's assembly,
// so its output crosses no job boundary and the Pages artifact is the only artifact.

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildBody, failureDirs } from "../../actions/fuzz-issue/fuzz-issue.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
// buildBody stamps the UTC day at call time, so the clock is frozen for the file and the expected date is a literal.
const DATE = "2026-03-04";
beforeAll(() => setSystemTime(new Date(`${DATE}T12:00:00Z`)));
afterAll(() => setSystemTime());

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  concurrency?: unknown;
  permissions?: Record<string, string>;
  environment?: { name: string; url: string };
  steps?: Step[];
}

const source = readFileSync(
  join(import.meta.dir, "../../.github/workflows/reusable-site.yml"),
  "utf8",
);
const workflow = parseYaml(source) as {
  on: { workflow_call: { inputs: Record<string, { required?: boolean; default?: unknown }> } };
  concurrency?: unknown;
  jobs: Record<string, Job>;
};
const job = workflow.jobs.site;
const steps = job?.steps ?? [];
const HOOK = "./.github/actions/site-build";
const PUBLISH = "steps.site.outputs.publish == 'true'";
const stepIndex = (predicate: (step: Step) => boolean) => steps.findIndex(predicate);
const usesIndex = (fragment: string) => stepIndex((step) => (step.uses ?? "").includes(fragment));

describe("reusable-site.yml", () => {
  test("one job, no concurrency of its own (the caller holds the pages lane), the deploy grant with issues for the link-rot issue", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["site"]);
    expect(workflow.concurrency).toBeUndefined();
    expect(job?.concurrency).toBeUndefined();
    expect(job?.needs).toBeUndefined();
    expect(job?.if).toBeUndefined();
    expect(job?.permissions).toEqual({
      "contents": "read",
      "pages": "write",
      "id-token": "write",
      "issues": "write",
    });
    expect(job?.environment).toEqual({
      name: "github-pages",
      url: "${{ steps.deployment.outputs.page_url }}",
    });
  });

  test("a full checkout of the caller's sha comes first: version tags and per-ref trees are read from history", () => {
    expect(steps[0]?.uses).toContain("actions/checkout@");
    expect(steps[0]?.with).toEqual({ "fetch-depth": 0, "ref": "${{ inputs.sha }}" });
  });

  test("the hook runs from the checkout when it exists, with the resolved URLs, BEFORE the fleet's assembly reads its dist", () => {
    const urls = stepIndex((step) => step.id === "urls");
    const hook = usesIndex(HOOK);
    const site = usesIndex("repo-platform/actions/pages-site@stable");
    expect([urls, hook, site].every((index) => index >= 0)).toBe(true);
    expect(urls).toBeLessThan(hook);
    expect(hook).toBeLessThan(site);
    // A composite action in the caller's checkout is the one hook shape a
    // fleet workflow can run absent-tolerantly: skipped by hashFiles, not a
    // run that fails to start.
    expect(steps[hook]).toMatchObject({
      id: "hook",
      if: "hashFiles('.github/actions/site-build/action.yml') != ''",
      with: {
        "base-path": "${{ steps.urls.outputs.base_path }}",
        "origin": "${{ steps.urls.outputs.origin }}",
      },
    });
    expect(steps[site]).toMatchObject({
      id: "site",
      with: {
        "site-dir": "${{ steps.hook.outputs.dist }}",
        "config": "${{ inputs.config }}",
        "custom-domain": "${{ inputs.custom_domain }}",
        "max-versions": "${{ vars.PAGES_MAX_VERSIONS || '5' }}",
      },
    });
    expect(steps[site]?.if).toBeUndefined();
    // The hook ran and named nothing: a notice, keyed on the hook's outcome
    // (never a negative output test, which an absent output would pass).
    const notice = steps.find((step) => (step.run ?? "").includes("named no dist directory"));
    expect(notice?.if).toBe("steps.hook.outcome == 'success'");
    expect(notice?.env).toEqual({ DIST: "${{ steps.hook.outputs.dist }}" });
  });

  // The urls step's bash EXECUTED as the runner runs it, one whole output
  // set per domain shape: the hook and the fleet action build against
  // exactly these values.
  const resolveUrls = (customDomain: string) => {
    const run = steps.find((step) => step.id === "urls")?.run ?? "";
    const output = join(temp.dir("reusable-site-urls-"), "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_OUTPUT: output,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "Vivswan/Example-Repo",
        CUSTOM_DOMAIN: customDomain,
      },
    });
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, "utf8") };
  };

  const CUSTOM_DOMAIN_OUTPUT = [
    "base_path=/",
    "origin=https://docs.example.com",
    "own_links=^https://docs\\.example\\.com([/?#]|$)",
    "edit_links=^https://github\\.com/Vivswan/Example-Repo/edit/",
    "",
  ].join("\n");

  test.each([
    {
      customDomain: "",
      output: [
        "base_path=/Example-Repo/",
        "origin=https://vivswan.github.io",
        "own_links=^https://vivswan\\.github\\.io/Example-Repo([/?#]|$)",
        "edit_links=^https://github\\.com/Vivswan/Example-Repo/edit/",
        "",
      ].join("\n"),
    },
    {
      customDomain: "docs.example.com",
      output: CUSTOM_DOMAIN_OUTPUT,
    },
    {
      customDomain: "Docs.Example.com",
      output: CUSTOM_DOMAIN_OUTPUT,
    },
  ])(
    "the urls step, executed with CUSTOM_DOMAIN=$customDomain, resolves the base path and origin",
    ({ customDomain, output }) => {
      expect(steps.find((step) => step.id === "urls")?.env).toEqual({
        CUSTOM_DOMAIN: "${{ inputs.custom_domain }}",
      });
      expect(resolveUrls(customDomain)).toEqual({ status: 0, stdout: "", output });
    },
  );

  test("configure, the ONE artifact upload, and the deploy gate on publish; nothing else uploads an artifact", () => {
    const configure = usesIndex("actions/configure-pages@");
    const upload = usesIndex("actions/upload-pages-artifact@");
    const deploy = usesIndex("actions/deploy-pages@");
    expect(usesIndex("repo-platform/actions/pages-site@stable")).toBeLessThan(configure);
    expect(configure).toBeLessThan(upload);
    expect(upload).toBeLessThan(deploy);
    for (const index of [configure, upload, deploy]) expect(steps[index]?.if).toBe(PUBLISH);
    expect(steps[upload]?.with).toEqual({ path: "${{ steps.site.outputs.site-dir }}" });
    expect(steps[deploy]?.id).toBe("deployment");
    // The whole list of upload steps, not the first match: a second Pages
    // upload or a stray upload-artifact must read as an extra entry.
    const uploads = steps.filter((step) => /upload-[a-z-]*artifact@/.test(step.uses ?? ""));
    expect(uploads.map((step) => step.uses?.split("@")[0])).toEqual([
      "actions/upload-pages-artifact",
    ]);
    expect(steps.filter((step) => (step.uses ?? "").includes("download-artifact@"))).toEqual([]);
  });

  // lychee's markdown report as the action writes it (lychee 0.24.2 over a
  // fixture site, the run link appended by lychee-action), before the
  // fuzz-issue action reads it as a contract-v1 failure report.
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
  const LINK_ROT_LABEL = "${{ steps.site.outputs.link-rot-label }}";
  const ARTIFACTS_DIR = "${{ runner.temp }}/link-rot";

  test("link rot runs on the schedule alone, after a deploy: lychee over the assembled site's html, http(s) links only, never failing the deploy that shipped", () => {
    const links = steps.find((step) => step.id === "links");
    expect(links?.if).toBe(
      `github.event_name == 'schedule' && ${PUBLISH} && steps.site.outputs.link-rot-label != ''`,
    );
    expect(links?.uses).toMatch(/^lycheeverse\/lychee-action@[0-9a-f]{40}$/);
    expect(usesIndex("actions/deploy-pages@")).toBeLessThan(stepIndex((s) => s.id === "links"));
    expect(links?.with).toEqual({
      workingDirectory: "${{ steps.site.outputs.site-dir }}",
      token: "",
      args: [
        "--no-progress",
        "--root-dir ${{ steps.site.outputs.site-dir }}",
        "--scheme https --scheme http",
        "--exclude-all-private",
        "--exclude '${{ steps.urls.outputs.own_links }}'",
        "--exclude '${{ steps.urls.outputs.edit_links }}'",
        "--timeout 30 --max-retries 3 --retry-wait-time 5",
        "--glob-ignore-case '**/*.html' '**/*.htm'",
      ].join(" "),
      fail: false,
      format: "markdown",
      output: `${ARTIFACTS_DIR}/external-links/report.md`,
    });
    const rot = steps.find((step) => step.id === "rot");
    expect(rot?.if).toBe("steps.links.outcome == 'success'");
    expect(rot?.env).toEqual({ EXIT_CODE: "${{ steps.links.outputs.exit_code }}" });
    const issues = steps.filter((step) => (step.uses ?? "").includes("actions/fuzz-issue@stable"));
    expect(issues.map((step) => [step.if, step.with?.mode, step.with?.label])).toEqual([
      ["steps.rot.outputs.found == 'true'", "report", LINK_ROT_LABEL],
      ["steps.rot.outputs.found == 'false'", "resolve", LINK_ROT_LABEL],
    ]);
    expect(issues[0]?.with?.["artifacts-dir"]).toBe(ARTIFACTS_DIR);
  });

  test("lychee's report is the one failure of the fuzz-issue contract: written under the artifacts-dir, it rides into the issue body whole", () => {
    const output = String(steps.find((step) => step.id === "links")?.with?.output);
    const report = steps.find((step) => step.with?.mode === "report");
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

  // The verdict step's bash EXECUTED as the runner runs it: each row is one
  // whole verdict (exit code, log, the found output), so a flipped case
  // reads as the wrong verdict, not a missing substring.
  const readVerdict = (exitCode: string | undefined) => {
    const run = steps.find((step) => step.id === "rot")?.run ?? "";
    const output = join(temp.dir("reusable-site-rot-"), "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_OUTPUT: output,
        ...(exitCode === undefined ? {} : { EXIT_CODE: exitCode }),
      },
    });
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, "utf8") };
  };
  const noVerdict = (exitCode: string) => ({
    status: 1,
    stdout: `::error::lychee published no verdict: exit code '${exitCode}' (0 = clean, 2 = broken links)\n`,
    output: "",
  });

  test.each([
    { exitCode: "0", verdict: { status: 0, stdout: "", output: "found=false\n" } },
    { exitCode: "2", verdict: { status: 0, stdout: "", output: "found=true\n" } },
    { exitCode: "1", verdict: noVerdict("1") },
    { exitCode: "3", verdict: noVerdict("3") },
    { exitCode: "", verdict: noVerdict("") },
    { exitCode: undefined, verdict: noVerdict("") },
  ])(
    "the verdict step, executed with EXIT_CODE=$exitCode, yields one whole verdict",
    ({ exitCode, verdict }) => {
      expect(readVerdict(exitCode)).toEqual(verdict);
    },
  );

  test("every input is optional: sha, custom_domain, and config (empty = the registration)", () => {
    expect(Object.keys(workflow.on.workflow_call.inputs).sort()).toEqual([
      "config",
      "custom_domain",
      "sha",
    ]);
    for (const [name, input] of Object.entries(workflow.on.workflow_call.inputs)) {
      expect([name, input.required, input.default]).toEqual([name, false, ""]);
    }
  });
});

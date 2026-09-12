// The fleet's site deploy in one job: the repo-owned hook runs from the
// checkout before the fleet's assembly, so its output crosses no job
// boundary and the Pages artifact is the only artifact; the deploy steps
// gate on the assembly's positive publish output, the link-rot steps on
// the schedule. Each property here is one a refactor could lose while the
// deploy still works on a happy path.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

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
    const site = usesIndex("repo-platform/actions/pages-site@build");
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
        GITHUB_REPOSITORY: "Vivswan/Example-Repo",
        CUSTOM_DOMAIN: customDomain,
      },
    });
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, "utf8") };
  };

  test.each([
    {
      customDomain: "",
      output: "base_path=/Example-Repo/\norigin=https://vivswan.github.io\n",
    },
    { customDomain: "docs.example.com", output: "base_path=/\norigin=https://docs.example.com\n" },
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
    expect(usesIndex("repo-platform/actions/pages-site@build")).toBeLessThan(configure);
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

  test("link rot runs on the schedule alone, after a deploy, over the assembled site, and files under the assembly's label", () => {
    const links = steps.find((step) => step.id === "links");
    expect(links?.if).toBe(
      `github.event_name == 'schedule' && ${PUBLISH} && steps.site.outputs.link-rot-label != ''`,
    );
    expect(links?.uses).toContain("repo-platform/actions/pages-site/check-links@build");
    expect(links?.with).toEqual({ "site-dir": "${{ steps.site.outputs.site-dir }}" });
    expect(usesIndex("actions/deploy-pages@")).toBeLessThan(stepIndex((s) => s.id === "links"));
    const rot = steps.find((step) => step.id === "rot");
    expect(rot?.if).toBe("steps.links.outcome == 'success'");
    expect(rot?.run).toContain("exit 1");
    const issues = steps.filter((step) => (step.uses ?? "").includes("actions/fuzz-issue@build"));
    expect(issues.map((step) => [step.if, step.with?.mode, step.with?.label])).toEqual([
      ["steps.rot.outputs.found == 'true'", "report", "${{ steps.site.outputs.link-rot-label }}"],
      ["steps.rot.outputs.found == 'false'", "resolve", "${{ steps.site.outputs.link-rot-label }}"],
    ]);
    expect(issues[0]?.with?.["artifacts-dir"]).toBe("${{ steps.links.outputs.report-dir }}");
  });

  // The count step's bash EXECUTED as the runner runs it: each row is one
  // whole verdict (exit code, log, the found output), so a flipped
  // comparison reads as the wrong verdict, not a missing substring.
  const readCount = (broken: string | undefined) => {
    const run = steps.find((step) => step.id === "rot")?.run ?? "";
    const output = join(temp.dir("reusable-site-rot-"), "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_OUTPUT: output,
        ...(broken === undefined ? {} : { BROKEN: broken }),
      },
    });
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, "utf8") };
  };

  test.each([
    { broken: "0", verdict: { status: 0, stdout: "", output: "found=false\n" } },
    { broken: "3", verdict: { status: 0, stdout: "", output: "found=true\n" } },
    {
      broken: "",
      verdict: {
        status: 1,
        stdout: "::error::check-links published no broken count: ''\n",
        output: "",
      },
    },
    {
      broken: "many",
      verdict: {
        status: 1,
        stdout: "::error::check-links published no broken count: 'many'\n",
        output: "",
      },
    },
    {
      broken: undefined,
      verdict: {
        status: 1,
        stdout: "::error::check-links published no broken count: ''\n",
        output: "",
      },
    },
  ])(
    "the count step, executed with BROKEN=$broken, yields one whole verdict",
    ({ broken, verdict }) => {
      expect(readCount(broken)).toEqual(verdict);
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

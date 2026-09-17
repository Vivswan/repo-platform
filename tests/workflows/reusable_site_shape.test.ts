// The fleet's site deploy: what lychee and the fuzz-issue contract define and the yaml cannot show. The urls and verdict
// steps are executed as the runner runs them; the two lychee knobs whose wrong value changes behavior silently are pinned.

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildBody, failureDirs } from "../../actions/fuzz-issue/fuzz-issue.ts";
import { argvStub } from "../shared/argv_stub";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
// buildBody stamps the UTC day at call time, so the clock is frozen for the file and the expected date is a literal.
const DATE = "2026-03-04";
beforeAll(() => setSystemTime(new Date(`${DATE}T12:00:00Z`)));
afterAll(() => setSystemTime());

interface Step {
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
const step = (id: string) => steps.find((candidate) => candidate.id === id);

describe("reusable-site.yml", () => {
  // The escaped-dot patterns must match the assembly's ownSitePattern (actions/pages-site), and the lowercase host is
  // lychee's reporting convention: a link to the own site in another case would be reported as external.
  test("the urls step, executed, resolves the project-pages base path and the lowercase owner origin", () => {
    const urls = step("urls");
    expect(urls?.env).toBeUndefined();
    const output = join(temp.dir("reusable-site-urls-"), "output");
    writeFileSync(output, "");
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", urls?.run ?? ""],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          GITHUB_OUTPUT: output,
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "Vivswan/Example-Repo",
        },
      },
    );
    expect({
      status: result.status,
      stdout: result.stdout,
      output: readFileSync(output, "utf8"),
    }).toEqual({
      status: 0,
      stdout: "",
      output: [
        "base_path=/Example-Repo/",
        "origin=https://vivswan.github.io",
        "own_links=^https://vivswan\\.github\\.io/Example-Repo([/?#]|$)",
        "edit_links=^https://github\\.com/Vivswan/Example-Repo/edit/",
        "",
      ].join("\n"),
    });
  });

  // Two knobs only lychee defines, each wrong value silent: with a token lychee asks the GitHub API and calls a private
  // repository's link alive, so the link-rot issue is closed wrongly; with fail unset a finding fails the deploy that shipped.
  test("lychee runs with no token and never fails the deploy", () => {
    expect(step("links")?.with).toEqual(expect.objectContaining({ token: "", fail: false }));
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

  // lychee reads .lycheeignore from its working directory alone, so the file is copied into the site directory: after the
  // upload, or the served site carries it; before the check, or the ignores are lost and the link-rot issue opens on links
  // the repository chose not to judge. Both silent. The copy runs on the check's own condition, plus the file existing.
  test("the root .lycheeignore is staged after the upload and before lychee, on the check's own condition", () => {
    const index = (predicate: (step: Step) => boolean) => steps.findIndex(predicate);
    const stage = index((candidate) => (candidate.run ?? "").startsWith("cp .lycheeignore"));
    const upload = index((candidate) =>
      (candidate.uses ?? "").includes("actions/upload-pages-artifact@"),
    );
    const links = index((candidate) => candidate.id === "links");
    expect([upload, stage, links].every((at) => at >= 0)).toBe(true);
    expect(upload).toBeLessThan(stage);
    expect(stage).toBeLessThan(links);
    expect(steps[stage].if).toBe(`${steps[links].if} && hashFiles('.lycheeignore') != ''`);
    expect({ env: steps[stage].env, run: steps[stage].run }).toEqual({
      env: { SITE_DIR: String(steps[links].with?.workingDirectory) },
      run: 'cp .lycheeignore "$SITE_DIR/"',
    });
  });

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

  // The verdict step's bash EXECUTED as the runner runs it: lychee's exit codes are its own (0 clean, 2 broken links). The
  // script treats an unset and an empty EXIT_CODE alike (no verdict); both rows pin that.
  const readVerdict = (exitCode: string | undefined) => {
    const run = step("rot")?.run ?? "";
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

  // GitHub reserves Pages-site creation to a token other than the job's, whatever `pages: write` grants, so the deploy
  // can only ask (a repository that selected the module before the settings apply ran saw configure-pages fail on the
  // 404). The check EXECUTED with gh stubbed to answer as `gh api --include` does (status line, CRLF headers, one JSON
  // body line, exit 1 off 2xx): the request it sends, and the whole outcome per status.
  const askPages = (status: string, body: string) => {
    const root = temp.dir("reusable-site-pages-");
    const gh = argvStub(root, "gh", [
      'printf \'HTTP/2.0 %s\\nContent-Type: application/json; charset=utf-8\\r\\n\\r\\n%s\' "$GH_STATUS" "$GH_BODY"',
    ]);
    const output = join(root, "output");
    writeFileSync(output, "");
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", step("pages")?.run ?? ""],
      {
        encoding: "utf8",
        env: {
          PATH: `${gh.bin}:${process.env.PATH ?? ""}`,
          GH_STATUS: status,
          GH_BODY: body,
          STUB_EXIT: status.startsWith("2") ? "0" : "1",
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "o/r",
        },
      },
    );
    expect(gh.calls()).toEqual([["gh", "api", "--include", "repos/o/r/pages"]]);
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, "utf8") };
  };

  test.each([
    {
      status: "200 OK",
      body: '{"url":"https://api.github.com/repos/o/r/pages","status":"built"}',
      outcome: { status: 0, stdout: "", output: "exists=true\n" },
    },
    {
      status: "404 Not Found",
      body: '{"message":"Not Found","status":"404"}',
      outcome: {
        status: 0,
        stdout:
          "::warning::no Pages site yet: repo-platform's settings apply creates it on its next run (daily), and the nightly rebuild deploys; nothing to do here.\n",
        output: "exists=false\n",
      },
    },
    {
      status: "500 Internal Server Error",
      body: '{"message":"Server Error"}',
      outcome: {
        status: 1,
        stdout: '::error::reading the Pages site answered HTTP 500: {"message":"Server Error"}\n',
        output: "",
      },
    },
  ])(
    "the Pages check, executed against HTTP $status, deploys, skips, or fails",
    ({ status, body, outcome }) => {
      expect(askPages(status, body)).toEqual(outcome);
    },
  );

  // A Pages step gated on the assembly's `publish` alone runs against an absent site and fails the first deploy again,
  // silent until the next repository selects the module; a check placed after configure-pages reads as an unset output
  // there, and every deploy skips. Exact gates: a skipped check reads as false downstream too.
  test("the Pages steps and the link check run on the check's verdict alone, asked first", () => {
    const gate = "steps.pages.outputs.exists == 'true'";
    const at = (action: string) =>
      steps.findIndex((candidate) => (candidate.uses ?? "").startsWith(`actions/${action}@`));
    const check = steps.findIndex((candidate) => candidate.id === "pages");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(at("configure-pages"));
    expect({
      check: steps[check].if,
      configure: steps[at("configure-pages")].if,
      upload: steps[at("upload-pages-artifact")].if,
      deploy: steps[at("deploy-pages")].if,
      links: step("links")?.if,
    }).toEqual({
      check: "steps.site.outputs.publish == 'true'",
      configure: gate,
      upload: gate,
      deploy: gate,
      links: `github.event_name == 'schedule' && ${gate} && steps.site.outputs.link-rot-label != ''`,
    });
  });
});

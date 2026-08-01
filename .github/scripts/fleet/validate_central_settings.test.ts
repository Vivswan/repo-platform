import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  centralIdentityIssues,
  checkCentralFileLocal,
  checkCentralFileRemote,
  type Fetched,
  requiredLabels,
} from "./validate_central_settings";

const FILE = "settings/repos/my-project.yml";
const REPO = "Vivswan/my-project";

const IDENTITY = 'repository:\n  description: x\n  homepage: ""\n  topics: ""\n  private: false\n';

function central(labelNames: string[]): string {
  const labels = labelNames
    .map((name) => `  - name: ${JSON.stringify(name)}\n    color: "0366d6"\n    description: x`)
    .join("\n");
  return `${IDENTITY}labels:\n${labels}\n`;
}

function declared(labelNames: string[]): Set<string> {
  return new Set(labelNames);
}

const ok = (text: string): Fetched => ({ status: "ok", text });
const missing: Fetched = { status: "missing" };
const failed: Fetched = { status: "failed", detail: "HTTP 502" };

function fetcher(files: Record<string, Fetched>): (path: string) => Fetched {
  return (path) => files[path] ?? missing;
}

function registration(modules: string[]): Fetched {
  return ok(`modules: [${modules.join(", ")}]\n`);
}

describe("requiredLabels", () => {
  test("always requires the unconditional dependabot pair", () => {
    const names = requiredLabels([], null).map((l) => l.name);
    expect(names).toEqual(["dependencies", "github_actions"]);
  });

  test("a null fuzzer label drops that requirement instead of demanding an empty name", () => {
    const names = requiredLabels(["fuzzer"], null).map((l) => l.name);
    expect(names).toEqual(["dependencies", "github_actions"]);
  });

  test("adds each toolchain ecosystem label, the autorelease pair, and the fuzz label", () => {
    const names = requiredLabels(
      ["agents", "bun", "uv", "rust", "release-please", "fuzzer"],
      "my-fuzz",
    ).map((l) => l.name);
    expect(names).toEqual([
      "dependencies",
      "github_actions",
      "javascript",
      "python:uv",
      "rust",
      "autorelease: pending",
      "autorelease: tagged",
      "my-fuzz",
    ]);
  });
});

describe("centralIdentityIssues", () => {
  test("passes when all four identity keys are declared, empty strings included", () => {
    expect(
      centralIdentityIssues({ description: "x", homepage: "", topics: "", private: false }),
    ).toEqual([]);
    expect(
      centralIdentityIssues({
        description: "x",
        homepage: "https://example.test",
        topics: ["a", "b"],
        private: true,
      }),
    ).toEqual([]);
  });

  test("flags every undeclared or mistyped key at once", () => {
    const issues = centralIdentityIssues({ private: "false" });
    expect(issues.map((i) => i.key)).toEqual(["description", "homepage", "topics", "private"]);
    expect(issues[3].got).toBe('"false"');
  });

  test("an empty description does not count as declared", () => {
    const issues = centralIdentityIssues({
      description: "",
      homepage: "",
      topics: "",
      private: false,
    });
    expect(issues.map((i) => i.key)).toEqual(["description"]);
  });
});

describe("checkCentralFileLocal", () => {
  test("a correct file passes and yields its roster", () => {
    const result = checkCentralFileLocal(FILE, central(["dependencies", "github_actions"]));
    expect(result.errors).toEqual([]);
    expect(result.declared).toEqual(new Set(["dependencies", "github_actions"]));
  });

  test("a file with no labels section passes with a null roster", () => {
    const result = checkCentralFileLocal(FILE, IDENTITY);
    expect(result.errors).toEqual([]);
    expect(result.declared).toBeNull();
  });

  test("a missing repository block or identity key is an error", () => {
    expect(checkCentralFileLocal(FILE, "labels: []\n").errors).toHaveLength(1);
    const { errors } = checkCentralFileLocal(
      FILE,
      'repository:\n  description: x\n  homepage: ""\n  topics: ""\nlabels: []\n',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("repository.private");
  });

  test("a label entry without a name is an error, not the string 'undefined'", () => {
    const { errors, declared: roster } = checkCentralFileLocal(
      FILE,
      `${IDENTITY}labels:\n  - color: "0366d6"\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("labels[0]");
    expect(roster?.has("undefined")).toBe(false);
  });

  test("unparsable YAML and a non-list labels value are errors", () => {
    expect(checkCentralFileLocal(FILE, ": : :").errors).toHaveLength(1);
    const { errors } = checkCentralFileLocal(FILE, `${IDENTITY}labels: nope\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("labels is not a list");
  });
});

describe("checkCentralFileRemote", () => {
  test("a correct file passes", () => {
    const result = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["dependencies", "github_actions", "python:uv", "bug"]),
      fetcher({ ".repo-platform.yml": registration(["agents", "uv"]) }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("a missing dependabot ecosystem label fails, naming the label and file", () => {
    const { errors } = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["dependencies", "github_actions", "javascript"]),
      fetcher({ ".repo-platform.yml": registration(["bun", "uv"]) }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(FILE);
    expect(errors[0]).toContain('"python:uv"');
  });

  test("the fuzzer module without its tracking label fails", () => {
    const { errors } = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["dependencies", "github_actions"]),
      fetcher({
        ".repo-platform.yml": registration(["fuzzer"]),
        ".copier-answers.yml": ok("fuzzer_label: custom-fuzz\n"),
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"custom-fuzz"');
  });

  test("the recorded fuzzer_label answer satisfies the check", () => {
    const result = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["dependencies", "github_actions", "custom-fuzz"]),
      fetcher({
        ".repo-platform.yml": registration(["fuzzer"]),
        ".copier-answers.yml": ok("fuzzer_label: custom-fuzz\n"),
      }),
    );
    expect(result.errors).toEqual([]);
  });

  test("fuzzer with an unreadable fuzzer_label is an error, never a default guess", () => {
    const unreadable = [missing, ok("project_name: x\n"), ok("fuzzer_label: [not, a, string]\n")];
    for (const answers of unreadable) {
      const { errors } = checkCentralFileRemote(
        FILE,
        REPO,
        declared(["dependencies", "github_actions", "fuzz-nightly"]),
        fetcher({ ".repo-platform.yml": registration(["fuzzer"]), ".copier-answers.yml": answers }),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("fuzzer_label");
    }
  });

  test("an unregistered repo warns and does not fail", () => {
    const result = checkCentralFileRemote(FILE, REPO, declared(["dependencies"]), fetcher({}));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(".repo-platform.yml");
  });

  test("a registration fetch failure warns and skips, never fails", () => {
    const { errors, warnings } = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["dependencies"]),
      fetcher({ ".repo-platform.yml": failed }),
    );
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("HTTP 502");
    expect(warnings[0]).toContain(REPO);
    expect(warnings[0]).toContain("unverified this run");
  });

  test("an answers fetch failure warns but the other labels still count", () => {
    const flaky = fetcher({
      ".repo-platform.yml": registration(["bun", "fuzzer"]),
      ".copier-answers.yml": failed,
    });
    const covered = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["dependencies", "github_actions", "javascript"]),
      flaky,
    );
    expect(covered.errors).toEqual([]);
    expect(covered.warnings).toHaveLength(1);
    expect(covered.warnings[0]).toContain(".copier-answers.yml");
    expect(covered.warnings[0]).toContain("unverified this run");

    const violating = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["dependencies", "github_actions"]),
      flaky,
    );
    expect(violating.warnings).toHaveLength(1);
    expect(violating.errors).toHaveLength(1);
    expect(violating.errors[0]).toContain('"javascript"');
  });

  test("every missing label is reported, not just the first", () => {
    const { errors } = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["bug"]),
      fetcher({ ".repo-platform.yml": registration(["bun", "release-please"]) }),
    );
    expect(errors).toHaveLength(5);
  });

  test("an unreadable modules list is an error, not a silent pass", () => {
    const { errors } = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["dependencies"]),
      fetcher({ ".repo-platform.yml": ok("modules: not-a-list\n") }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("modules");
  });

  // hideDetails: the file's NAME is self-disclosed (committed here), but
  // the target's module facts, label values, and parse detail are not.
  test("hideDetails reduces missing labels to a count without naming them", () => {
    const { errors } = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["dependencies"]),
      fetcher({ ".repo-platform.yml": registration(["bun"]) }),
      true,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing 2 entries");
    expect(errors[0]).toContain("names hidden: private repository");
    expect(errors[0]).not.toContain("javascript");
    expect(errors[0]).not.toContain("github_actions");
    expect(errors[0]).not.toContain("bun");
  });

  test("hideDetails withholds registration parse detail", () => {
    const { errors } = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["dependencies"]),
      fetcher({ ".repo-platform.yml": ok("just a string\n") }),
      true,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("detail hidden: private repository");
    expect(errors[0]).not.toContain("mapping");
  });

  test("hideDetails keeps the fuzzer-answer failure module-free", () => {
    const { errors } = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["dependencies", "github_actions"]),
      fetcher({
        ".repo-platform.yml": registration(["fuzzer"]),
        ".copier-answers.yml": ok("fuzzer_label: ''\n"),
      }),
      true,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain("fuzzer");
    expect(errors[0]).toContain("detail hidden: private repository");
  });
});

// The exit-code split lives in main(), so these run the script itself
// with a gh stub on PATH: a flake on one file must warn without blocking
// the apply, while a real violation anywhere still fails the run.
describe("CLI exit codes", () => {
  const script = join(import.meta.dir, "validate_central_settings.ts");
  const root = mkdtempSync(join(tmpdir(), "validate-central-"));
  const bin = join(root, "bin");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // The flaky repo's fetches fail with a non-404; fuzzflaky registers
  // with the fuzzer module but its answers fetch fails; the violating
  // repo registers with no modules; every other repo is a 404.
  beforeAll(() => {
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        'case "$2" in',
        '  repos/Vivswan/flaky/*) echo "HTTP 502 from stub" >&2; exit 1 ;;',
        "  repos/Vivswan/fuzzflaky/contents/.repo-platform.yml) printf 'modules: [fuzzer]\\n' ;;",
        '  repos/Vivswan/fuzzflaky/contents/.copier-answers.yml) echo "HTTP 502 from stub" >&2; exit 1 ;;',
        "  repos/Vivswan/violating/contents/.repo-platform.yml) printf 'modules: []\\n' ;;",
        "  repos/Vivswan/shy/contents/.repo-platform.yml) printf 'modules: [bun]\\n' ;;",
        // The visibility probe (gh api repos/<slug> --jq .private): only
        // "shy" is private; every other persona proves public so the
        // pre-redaction test expectations keep their detailed messages.
        '  repos/Vivswan/shy) echo "true" ;;',
        '  repos/*/contents/*) echo "HTTP 404 from stub" >&2; exit 1 ;;',
        '  repos/*) echo "false" ;;',
        '  *) echo "HTTP 404 from stub" >&2; exit 1 ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "repo-platform" }));
  });

  function caseDir(name: string, files: Record<string, string>): string {
    const dir = join(root, name);
    mkdirSync(dir);
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    return dir;
  }

  function run(dir: string): { exitCode: number; stdout: string; stderr: string } {
    const proc = Bun.spawnSync(["bun", script, "--owner", "Vivswan", "--dir", dir], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  }

  test("a registration fetch failure alone warns and exits 0", () => {
    const dir = caseDir("transient", { "flaky.yml": central(["dependencies", "github_actions"]) });
    const { exitCode, stdout, stderr } = run(dir);
    expect(stdout).toContain("::warning::");
    expect(stdout).toContain("Vivswan/flaky");
    expect(stdout).toContain("unverified this run");
    expect(stderr).not.toContain("::error::");
    expect(exitCode).toBe(0);
  });

  test("an answers fetch failure alone warns and exits 0", () => {
    const dir = caseDir("fuzz-transient", {
      "fuzzflaky.yml": central(["dependencies", "github_actions"]),
    });
    const { exitCode, stdout, stderr } = run(dir);
    expect(stdout).toContain("Vivswan/fuzzflaky/.copier-answers.yml");
    expect(stdout).toContain("unverified this run");
    expect(stderr).not.toContain("::error::");
    expect(exitCode).toBe(0);
  });

  test("a flake on one file does not mask a violation on another", () => {
    const dir = caseDir("mixed", {
      "flaky.yml": central(["dependencies", "github_actions"]),
      "violating.yml": central(["dependencies"]),
    });
    const { exitCode, stdout, stderr } = run(dir);
    expect(stdout).toContain("Vivswan/flaky");
    expect(stderr).toContain("::error::");
    expect(stderr).toContain("violating.yml");
    expect(stderr).toContain('"github_actions"');
    expect(stderr).not.toContain("flaky");
    expect(exitCode).toBe(1);
  });

  test("a 404 keeps its meaning: not adopted, warned, exit 0", () => {
    const dir = caseDir("unadopted", {
      "unadopted.yml": central(["dependencies", "github_actions"]),
    });
    const { exitCode, stdout } = run(dir);
    expect(stdout).toContain("::warning::");
    expect(stdout).toContain("no .repo-platform.yml");
    expect(exitCode).toBe(0);
  });
});

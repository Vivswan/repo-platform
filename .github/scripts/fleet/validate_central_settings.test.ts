import { describe, expect, test } from "bun:test";
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
    const names = requiredLabels([], "").map((l) => l.name);
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

  test("a fetch failure is an error naming the repo, not a warning or a pass", () => {
    const { errors, warnings } = checkCentralFileRemote(
      FILE,
      REPO,
      declared(["dependencies"]),
      fetcher({ ".repo-platform.yml": failed }),
    );
    expect(warnings).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("HTTP 502");
    expect(errors[0]).toContain(REPO);
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
});

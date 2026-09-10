// settings_facts.ts: the fact resolvers behind the settings layer list,
// every read pinned to one commit and failing closed. Uses the REAL module
// manifests (on-disk constants) and fixture texts for the target files.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  declaredPrivate,
  factsFromFetch,
  factsFromOperatorAnswers,
  factsFromTargetDir,
  modulesFrom,
  parseYamlMapping,
  trackingLabelsFrom,
} from "../../.github/scripts/fleet/settings_facts";
import { loadManifests } from "../../scripts/lib/module_manifests";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const manifests = loadManifests();

describe("modulesFrom", () => {
  test("reads the top-level list and refuses anything else", () => {
    expect(modulesFrom("modules: [uv, pages]\n", "f")).toEqual(["uv", "pages"]);
    expect(() => modulesFrom("notmodules: true\n", "f")).toThrow("modules list");
    // The sync's registration grammar: a duplicate entry is unreadable.
    expect(() => modulesFrom("modules: [uv, uv]\n", "f")).toThrow("modules list");
    // A typo must be LOUD: no layer files exist for it, so the stack would
    // look valid while missing that module's labels, and the apply deletes
    // undeclared labels off the live repository.
    expect(() => modulesFrom("modules: [uv, pgaes]\n", "f")).toThrow("unknown module");
    // A folded name is unknown too: the repository's pending sync PR drops
    // it (its rung), and the message says so instead of tolerating it.
    expect(() => modulesFrom("modules: [uv, settings-sync]\n", "f")).toThrow("merge that PR first");
    expect(() => modulesFrom("a: [unclosed\n", "f")).toThrow("YAML parse error");
  });
});

describe("parseYamlMapping", () => {
  test("names the file on a parse error or a non-mapping document", () => {
    expect(parseYamlMapping("a: 1\n", "f")).toEqual({ a: 1 });
    expect(() => parseYamlMapping("- a\n", "f")).toThrow("f: not a YAML mapping");
    expect(() => parseYamlMapping("", "f")).toThrow("f: not a YAML mapping");
    expect(() => parseYamlMapping("a: [unclosed\n", "f")).toThrow("f: YAML parse error");
  });
});

describe("trackingLabelsFrom", () => {
  // A module lands in .repo-platform.yml one PR before the sync PR that
  // records its label answer, so an ABSENT answer is a normal state of
  // every module addition and resolves to the manifest default with this
  // notice; a PRESENT but unreadable answer is an answers-file defect.
  const WHERE = "owner/name/.github/.copier-answers.yml";
  const PENDING_FUZZER_NOTICE =
    "owner/name/.github/.copier-answers.yml: the fuzzer module is selected but the file " +
    "records no fuzzer_label answer yet, so this apply assumes the module's default label " +
    "'fuzz-nightly'. The repository's pending sync PR writes the answer; the first apply " +
    "after it merges reads the recorded value, so a label customized in that PR takes " +
    "effect then.";
  test.each<{
    reason: string;
    answers: string;
    modules: string[];
    labels: { module: string; label: string }[] | "throws";
    notices: string[];
  }>([
    {
      reason: "a recorded answer is the label, no notice",
      answers: "fuzzer_label: my-fuzz\n",
      modules: ["fuzzer"],
      labels: [{ module: "fuzzer", label: "my-fuzz" }],
      notices: [],
    },
    {
      reason: "no selected stream module resolves nothing",
      answers: "{}\n",
      modules: ["uv"],
      labels: [],
      notices: [],
    },
    {
      reason: "an absent answer for a selected stream is the manifest default, with the notice",
      answers: "github_username: o\n",
      modules: ["uv", "fuzzer"],
      labels: [{ module: "fuzzer", label: "fuzz-nightly" }],
      notices: [PENDING_FUZZER_NOTICE],
    },
    {
      reason: "the fallback is per stream: the recorded one stays recorded",
      answers: "nightly_label: my-nightly\n",
      modules: ["fuzzer", "nightly"],
      labels: [
        { module: "fuzzer", label: "fuzz-nightly" },
        { module: "nightly", label: "my-nightly" },
      ],
      notices: [PENDING_FUZZER_NOTICE],
    },
    {
      reason: "a present but empty answer still fails",
      answers: 'fuzzer_label: ""\n',
      modules: ["fuzzer"],
      labels: "throws",
      notices: [],
    },
    {
      reason: "a present but null answer still fails",
      answers: "fuzzer_label:\n",
      modules: ["fuzzer"],
      labels: "throws",
      notices: [],
    },
    {
      reason: "a present but non-string answer still fails",
      answers: "fuzzer_label: [a]\n",
      modules: ["fuzzer"],
      labels: "throws",
      notices: [],
    },
  ])("$reason", ({ answers, modules, labels, notices }) => {
    const seen: string[] = [];
    const absent = {
      fallback: "default",
      report: (message: string) => seen.push(message),
    } as const;
    if (labels === "throws") {
      expect(() => trackingLabelsFrom(answers, modules, manifests, WHERE, absent)).toThrow(
        "the fuzzer module is selected but its fuzzer_label answer is not readable",
      );
    } else {
      expect(trackingLabelsFrom(answers, modules, manifests, WHERE, absent)).toEqual(labels);
    }
    expect(seen).toEqual(notices);
  });

  test("under the fail policy an absent answer throws instead of assuming the default", () => {
    expect(() =>
      trackingLabelsFrom("github_username: o\n", ["fuzzer"], manifests, WHERE, {
        fallback: "fail",
      }),
    ).toThrow(
      "owner/name/.github/.copier-answers.yml: the fuzzer module is selected but the file " +
        "records no fuzzer_label answer - no sync PR records this file, so the tracking " +
        "label cannot be resolved; record the answer",
    );
  });
});

describe("factsFromFetch", () => {
  test("a target without .repo-platform.yml at the pin is null; nothing else is read", () => {
    const seen: string[] = [];
    const fetcher = (_repo: string, path: string): string | null => {
      seen.push(path);
      return null;
    };
    expect(factsFromFetch("owner/name", manifests, "0".repeat(40), fetcher)).toBeNull();
    expect(seen).toEqual([".repo-platform.yml"]);
  });

  test("every read uses the SAME ref, never the moving branch", () => {
    // A push between two reads would otherwise pair an old module
    // selection with a new repo layer, and the apply deletes the labels
    // of a module the repo had just selected.
    const PIN = "000000000000000000000000000000000000000a";
    const seen: { path: string; ref: string }[] = [];
    const fetcher = (_repo: string, path: string, ref: string): string | null => {
      seen.push({ path, ref });
      if (path === ".repo-platform.yml") return "modules: [uv, fuzzer]\n";
      if (path === ".github/settings.yml") return "repository:\n  private: false\n";
      if (path === ".github/.copier-answers.yml") return "fuzzer_label: my-fuzz\n";
      return null;
    };
    expect(factsFromFetch("owner/name", manifests, PIN, fetcher)).toEqual({
      modules: ["uv", "fuzzer"],
      private: false,
      trackingLabels: [{ module: "fuzzer", label: "my-fuzz" }],
      prTitleWorkflowPresent: false,
    });
    // Exactly the files that matter, in read order, every one at the pin;
    // pr-title.yml is not probed because the module is unselected.
    expect(seen).toEqual(
      [".repo-platform.yml", ".github/settings.yml", ".github/.copier-answers.yml"].map((path) => ({
        path,
        ref: PIN,
      })),
    );
  });

  test("a pending stream answer resolves to the default, naming the repository", () => {
    const fetcher = (_repo: string, path: string): string | null => {
      if (path === ".repo-platform.yml") return "modules: [uv, fuzzer]\n";
      if (path === ".github/settings.yml") return "repository:\n  private: false\n";
      if (path === ".github/.copier-answers.yml") return "github_username: o\nprivate: false\n";
      return null;
    };
    const seen: string[] = [];
    expect(
      factsFromFetch("owner/name", manifests, "0".repeat(40), fetcher, (m) => seen.push(m)),
    ).toEqual({
      modules: ["uv", "fuzzer"],
      private: false,
      trackingLabels: [{ module: "fuzzer", label: "fuzz-nightly" }],
      prTitleWorkflowPresent: false,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("owner/name/.github/.copier-answers.yml: the fuzzer module");
  });

  test("the pr-title workflow is probed only when the module is selected", () => {
    const seen: string[] = [];
    const fetcher = (_repo: string, path: string): string | null => {
      seen.push(path);
      if (path === ".repo-platform.yml") return "modules: [pr-title]\n";
      if (path === ".github/settings.yml") return "repository:\n  private: true\n";
      if (path === ".github/workflows/pr-title.yml") return "name: pr-title\n";
      return null;
    };
    expect(factsFromFetch("owner/name", manifests, "0".repeat(40), fetcher)).toEqual({
      modules: ["pr-title"],
      private: true,
      trackingLabels: [],
      prTitleWorkflowPresent: true,
    });
    expect(seen).toContain(".github/workflows/pr-title.yml");
  });
});

describe("declaredPrivate", () => {
  test("reads only a boolean repository.private", () => {
    expect(declaredPrivate("repository:\n  private: true\n")).toBe(true);
    expect(declaredPrivate("repository:\n  private: false\n")).toBe(false);
    expect(declaredPrivate("repository:\n  private: 'false'\n")).toBeNull();
    expect(declaredPrivate("repository: {}\n")).toBeNull();
    expect(declaredPrivate("a: [unclosed\n")).toBeNull();
    expect(declaredPrivate(null)).toBeNull();
  });
});

describe("factsFromTargetDir", () => {
  test("is null without .repo-platform.yml, facts with it", () => {
    const dir = temp.dir("facts-adoption-");
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github/.copier-answers.yml"), "private: false\n");
    expect(factsFromTargetDir(dir, manifests)).toBeNull();
    writeFileSync(join(dir, ".repo-platform.yml"), "modules: [uv]\n");
    expect(factsFromTargetDir(dir, manifests)).toEqual({
      modules: ["uv"],
      private: false,
      trackingLabels: [],
      prTitleWorkflowPresent: false,
    });
  });

  test("prefers the checkout's declared visibility over the recorded answer", () => {
    const dir = temp.dir("facts-visibility-");
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".repo-platform.yml"), "modules: [uv]\n");
    writeFileSync(join(dir, ".github/.copier-answers.yml"), "private: false\n");
    writeFileSync(join(dir, ".github/settings.yml"), "repository:\n  private: true\n");
    expect(factsFromTargetDir(dir, manifests)?.private).toBe(true);
    // Undeclared falls back to the recorded answer.
    writeFileSync(join(dir, ".github/settings.yml"), "repository: {}\n");
    expect(factsFromTargetDir(dir, manifests)?.private).toBe(false);
    // Neither declared nor recorded: the visibility-gated layers cannot be
    // selected, so the read fails instead of guessing.
    writeFileSync(join(dir, ".github/.copier-answers.yml"), "github_username: o\n");
    expect(() => factsFromTargetDir(dir, manifests)).toThrow("records no boolean private answer");
  });
});

describe("factsFromOperatorAnswers", () => {
  test("the operator's own selection is validated too", () => {
    // repo-platform is always a settings target, so a typo in its answers
    // file is the same destructive path as one in a client repo.
    const dir = temp.dir("operator-");
    const file = join(dir, "answers.yml");
    const real = readFileSync(".repo-platform-answers.yml", "utf-8");
    writeFileSync(file, real.replace("- bun", "- bnu"));
    expect(() => factsFromOperatorAnswers(file, manifests)).toThrow("unknown module");
  });

  test("the operator's absent stream answer is a defect, not a pending render", () => {
    // No sync PR writes .repo-platform-answers.yml, so the client-side
    // default fallback must not engage: the file is hand-maintained.
    const dir = temp.dir("operator-label-");
    const file = join(dir, "answers.yml");
    const real = readFileSync(".repo-platform-answers.yml", "utf-8");
    const stripped = real.replace(/^docs_site_label: .*\n/m, "");
    if (stripped === real) throw new Error("the real operator answers record no docs_site_label");
    writeFileSync(file, stripped);
    expect(() => factsFromOperatorAnswers(file, manifests)).toThrow(
      "records no docs_site_label answer - no sync PR records this file",
    );
  });

  test("the operator answers reproduce this repository's own facts", () => {
    // Runs against the real .repo-platform-answers.yml (cwd is the repo
    // root under bun test), so a drifted answers schema fails here first.
    const operatorFacts = factsFromOperatorAnswers(".repo-platform-answers.yml");
    expect(operatorFacts.private).toBe(false);
    // repo-platform runs no release pipeline of its own, so release-please
    // is deliberately absent from its dogfooded modules.
    expect(operatorFacts.modules).not.toContain("release-please");
    expect(operatorFacts.modules).toContain("bun");
    // The dogfooded docs-site module is a tracking-stream module, so the
    // operator facts must resolve its label from the recorded answer.
    expect(operatorFacts.trackingLabels).toEqual([{ module: "docs-site", label: "docs-link-rot" }]);
    // The checkout carries the pr-title module's workflow.
    expect(operatorFacts.prTitleWorkflowPresent).toBe(true);
  });
});

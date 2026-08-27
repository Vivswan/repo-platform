// Unit tests for the one-time settings.yml layering transition: the
// starter render from an identity seed, the dropped-overrides diff
// against the managed layer, and the end-to-end replacement (legacy
// marker triggers it once; hand-written and already-transitioned files
// are never touched; failures leave the old file for the next sync).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { capture } from "../../.github/scripts/shared/proc";
import {
  classificationUncertain,
  droppedOverrides,
  headManifestClass,
  type IdentitySeed,
  isLegacyBaseline,
  LEGACY_MERGEABLE_LINE,
  layeringSummary,
  renderStarter,
  transitionSettingsStarter,
  uncertainSummary,
} from "../../.github/scripts/sync/settings_layering";

const STARTER_TEMPLATE = readFileSync(
  join(import.meta.dir, "../../templates/settings-sync/.github/settings.yml.jinja"),
  "utf-8",
);

const seed: IdentitySeed = {
  description: "A test repo",
  homepage: "https://example.test",
  topics: "a, b",
  private: false,
  githubUsername: "Vivswan",
};

describe("isLegacyBaseline", () => {
  test("no marker AND no readable manifest is UNCERTAIN, not a starter", () => {
    // Guessing "starter" here is the silent failure: the stale baseline
    // keeps shadowing the fleet layers and the PR auto-merges.
    expect(classificationUncertain("repository: {}\n", { kind: "unreadable", detail: "x" })).toBe(
      true,
    );
    // A marker settles it, and so does a readable manifest.
    expect(
      classificationUncertain(`${LEGACY_MERGEABLE_LINE}\n`, { kind: "unreadable", detail: "x" }),
    ).toBe(false);
    expect(classificationUncertain("repository: {}\n", { kind: "read", class: "starter" })).toBe(
      false,
    );
  });

  test("the uncertain section is non-empty, so the PR is held", () => {
    const summary = uncertainSummary("git show failed");
    expect(summary).not.toBe("");
    expect(summary).toContain("could not be classified");
    expect(summary).toContain("held for review");
    expect(summary).toContain("git show failed");
  });

  test("a manifest class of mergeable triggers even with the marker deleted", () => {
    // Repos were historically allowed to delete the marker line, and the
    // merge preserved that deletion - such a file would otherwise read as
    // a starter and shadow the fleet layers forever.
    expect(isLegacyBaseline("repository: {}\n", "mergeable")).toBe(true);
    // Any other class, or none, falls back to the in-file marker.
    expect(isLegacyBaseline("repository: {}\n", "starter")).toBe(false);
    expect(isLegacyBaseline("repository: {}\n", null)).toBe(false);
    expect(isLegacyBaseline(`${LEGACY_MERGEABLE_LINE}\n`, "starter")).toBe(true);
  });

  test("matches the marker exactly at column 0, at ANY depth in the file", () => {
    expect(isLegacyBaseline(`---\n${LEGACY_MERGEABLE_LINE}\nrepository: {}\n`)).toBe(true);
    // There is no header window: a repo that kept its own comments above
    // the rendered ones would otherwise be read as an already-transitioned
    // starter, and the transition would silently never run.
    expect(isLegacyBaseline(`${"# filler\n".repeat(40)}${LEGACY_MERGEABLE_LINE}\n`)).toBe(true);
    expect(isLegacyBaseline("# filler\nrepository: {}\n")).toBe(false);
  });

  test("an indented mention (a block scalar of a hand-written file) never triggers", () => {
    expect(isLegacyBaseline(`repository:\n  description: |\n    ${LEGACY_MERGEABLE_LINE}\n`)).toBe(
      false,
    );
    expect(isLegacyBaseline(`see the ${LEGACY_MERGEABLE_LINE} marker\n`)).toBe(false);
  });
});

describe("headManifestClass", () => {
  // "Parsed successfully" is not the same as "classified". A present entry
  // this code cannot read is as unclassifiable as an unreadable file, and
  // reading "not mergeable, therefore starter" out of it would silently
  // leave a stale baseline shadowing the fleet layers.
  function repoWithManifest(contents: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "head-manifest-"));
    mkdirSync(join(dir, ".github"), { recursive: true });
    const git = (command: string[]) => {
      const result = capture(command);
      if (result.exitCode !== 0) throw new Error(`${command.join(" ")}: ${result.stderr}`);
    };
    git(["git", "-C", dir, "init", "-q", "-b", "main"]);
    // A contributor's global commit signing or hooks path must not decide
    // whether these fixtures can commit.
    git(["git", "-C", dir, "config", "commit.gpgsign", "false"]);
    git(["git", "-C", dir, "config", "core.hooksPath", "/dev/null"]);
    git(["git", "-C", dir, "config", "user.email", "t@example.com"]);
    git(["git", "-C", dir, "config", "user.name", "t"]);
    if (contents !== null) {
      writeFileSync(join(dir, ".github/repo-platform-manifest.json"), contents);
    }
    git(["git", "-C", dir, "add", "-A"]);
    git(["git", "-C", dir, "commit", "-qm", "head", "--allow-empty"]);
    return dir;
  }

  const entry = (value: string) => `{"files": {".github/settings.yml": ${value}}}\n`;

  test("a known class reads", () => {
    expect(headManifestClass(repoWithManifest(entry('{"class": "mergeable"}')))).toEqual({
      kind: "read",
      class: "mergeable",
    });
  });

  test("no entry for the file reads as null - it was never rendered", () => {
    expect(headManifestClass(repoWithManifest('{"files": {}}\n'))).toEqual({
      kind: "read",
      class: null,
    });
  });

  test("an entry with an UNKNOWN class is unreadable, not a starter", () => {
    // "mergable" is one keystroke from the retired class this transition
    // triggers on; silently reading it as "some other class" is the whole
    // failure mode.
    const head = headManifestClass(repoWithManifest(entry('{"class": "mergable"}')));
    expect(head.kind).toBe("unreadable");
  });

  test("an entry with NO class is unreadable", () => {
    expect(headManifestClass(repoWithManifest(entry("{}"))).kind).toBe("unreadable");
  });

  test("a malformed container is unreadable, not an absent entry", () => {
    // Valid JSON is not a valid manifest: reading "no entry, therefore
    // never rendered" out of a files list or a null entry skips the
    // transition on a marker-deleted legacy baseline.
    expect(headManifestClass(repoWithManifest('{"files": []}\n')).kind).toBe("unreadable");
    expect(headManifestClass(repoWithManifest('{"files": null}\n')).kind).toBe("unreadable");
    expect(headManifestClass(repoWithManifest('{"generated": true}\n')).kind).toBe("unreadable");
    expect(headManifestClass(repoWithManifest("[]\n")).kind).toBe("unreadable");
    expect(headManifestClass(repoWithManifest(entry("null"))).kind).toBe("unreadable");
    expect(headManifestClass(repoWithManifest(entry('"starter"'))).kind).toBe("unreadable");
  });

  test("unparseable JSON and a missing manifest are unreadable", () => {
    expect(headManifestClass(repoWithManifest("{not json")).kind).toBe("unreadable");
    expect(headManifestClass(repoWithManifest(null)).kind).toBe("unreadable");
  });

  test("an unknown class HOLDS the PR when the marker is gone", () => {
    const head = headManifestClass(repoWithManifest(entry('{"class": "mergable"}')));
    expect(classificationUncertain("repository: {}\n", head)).toBe(true);
  });
});

describe("renderStarter", () => {
  test("a seed value shaped like another expression is emitted verbatim", () => {
    // Sequential per-key substitution used to let a later pass re-read
    // what an earlier one wrote, rewriting the repo's own description.
    const rendered = renderStarter(STARTER_TEMPLATE, {
      ...seed,
      description: "{{ homepage | tojson }} and {{ github_username }}",
    });
    const doc = parseYaml(rendered) as { repository: Record<string, unknown> };
    expect(doc.repository.description).toBe("{{ homepage | tojson }} and {{ github_username }}");
    expect(doc.repository.homepage).toBe("https://example.test");
  });

  test("two identity expressions on one template line are refused", () => {
    // An undefined value drops the whole line, so a shared line would let
    // one key's absence delete another key's declaration.
    const bad = STARTER_TEMPLATE.replace(
      "  private: {{ private | tojson }}",
      "  private: {{ private | tojson }} # {{ homepage | tojson }}",
    );
    expect(() => renderStarter(bad, seed)).toThrow("two identity expressions on one line");
  });

  test("substitutes the four identity expressions and parses as YAML", () => {
    const rendered = renderStarter(STARTER_TEMPLATE, seed);
    const doc = parseYaml(rendered) as { repository: Record<string, unknown> };
    expect(doc.repository).toEqual({
      description: "A test repo",
      homepage: "https://example.test",
      topics: "a, b",
      private: false,
    });
    expect(rendered).not.toContain(LEGACY_MERGEABLE_LINE);
  });

  test("an undefined optional key drops its line instead of declaring empty", () => {
    const rendered = renderStarter(STARTER_TEMPLATE, {
      ...seed,
      homepage: undefined,
      topics: undefined,
    });
    const doc = parseYaml(rendered) as { repository: Record<string, unknown> };
    expect("homepage" in doc.repository).toBe(false);
    expect("topics" in doc.repository).toBe(false);
    expect(doc.repository.description).toBe("A test repo");
  });

  test("a template construct beyond the identity expressions throws", () => {
    expect(() => renderStarter("{% if private %}x{% endif %}\n", seed)).toThrow(
      "teach settings_layering.ts",
    );
    expect(() => renderStarter("{{ project_slug | tojson }}\n", seed)).toThrow(
      "teach settings_layering.ts",
    );
  });
});

describe("droppedOverrides", () => {
  const managed = {
    repository: { has_issues: true, security_and_analysis: { a: 1 } },
    labels: [
      { name: "bug", color: "d73a4a", description: "Something isn't working" },
      { name: "dependencies", color: "0366d6", description: "Dependency updates" },
    ],
    rulesets: [{ name: "main", target: "branch" }],
  };

  test("baseline-equal declarations and identity keys are not dropped", () => {
    const old = {
      repository: {
        description: "x",
        homepage: "",
        topics: "",
        private: false,
        has_issues: true,
        security_and_analysis: { a: 1 },
      },
      labels: [{ name: "bug", color: "d73a4a", description: "Something isn't working" }],
      rulesets: [{ name: "main", target: "branch" }],
    };
    expect(droppedOverrides(old, managed)).toEqual([]);
  });

  test("a mis-shaped labels section is reported with a shape warning, never skipped", () => {
    // Legacy files are exactly where mis-shapes live, and the per-entry
    // comparison (and the fleet-law skip) assume the list shape - so a
    // mapping-shaped section used to vanish from the very list the
    // reviewer re-adds overrides from.
    const old = { labels: { incident: { color: "b60205" } } };
    const dropped = droppedOverrides(old, managed, { labels: [] });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("labels (mis-shaped");
    expect(dropped[0]).toContain("incident");
  });

  test("scalar and null rulesets sections are reported as mis-shaped too", () => {
    expect(droppedOverrides({ rulesets: "main" }, managed)[0]).toContain("rulesets (mis-shaped");
    expect(droppedOverrides({ rulesets: null }, managed)[0]).toContain("rulesets (mis-shaped");
  });

  test("an enormous mis-shaped section is excerpted, not dumped whole", () => {
    const old = { labels: { blob: "x".repeat(1000) } };
    const [entry] = droppedOverrides(old, managed);
    expect(entry.length).toBeLessThan(400);
    expect(entry).toContain("...");
  });

  test("differing and repo-only declarations are dropped and listed", () => {
    const old = {
      repository: { has_issues: false, has_extras: true },
      labels: [
        { name: "BUG", color: "000000", description: "restyled" },
        { name: "incident", color: "b60205", description: "live incident" },
      ],
      rulesets: [{ name: "release-tags", target: "tag" }],
      pages: { cname: "x" },
    };
    expect(droppedOverrides(old, managed)).toEqual([
      "repository.has_issues",
      "repository.has_extras",
      'labels "BUG"',
      'labels "incident"',
      'rulesets "release-tags"',
      "pages",
    ]);
  });

  test("label matching folds case; ruleset matching is exact", () => {
    const equalDespiteCase = {
      labels: [{ name: "BUG", color: "d73a4a", description: "Something isn't working" }],
    };
    // The tuple differs from the baseline entry (the name spelling is part
    // of the tuple), so it is listed even though the names fold together.
    expect(droppedOverrides(equalDespiteCase, managed)).toEqual(['labels "BUG"']);
    expect(droppedOverrides({ rulesets: [{ name: "MAIN", target: "branch" }] }, managed)).toEqual([
      'rulesets "MAIN"',
    ]);
  });
});

describe("layeringSummary", () => {
  test("a lossless transition still gets a section: the file changed owner", () => {
    // open_pr.ts arms auto-merge only when every review-forcing section
    // is empty, and the ownership flip is itself the manual-review event -
    // so this must never be "".
    const summary = layeringSummary([]);
    expect(summary).not.toBe("");
    expect(summary).toContain("Nothing was dropped");
    expect(summary).toContain("held for review");
  });

  test("lists the dropped keys and tells the reviewer what to do", () => {
    const summary = layeringSummary(['labels "incident"', "pages"]);
    expect(summary).toContain("### settings.yml layering transition");
    expect(summary).toContain('- labels "incident"');
    expect(summary).toContain("- pages");
    expect(summary).toContain("before merging");
  });
});

describe("transitionSettingsStarter", () => {
  // The sync always runs against a git checkout whose HEAD predates this
  // update, so the helper builds one: the transition reads the ownership
  // class from `git show HEAD:`. Pass manifestClass: null for the repo
  // shape where that read FAILS (no manifest committed yet).
  function git(command: string[]): void {
    const result = capture(command);
    if (result.exitCode !== 0) throw new Error(`${command.join(" ")}: ${result.stderr}`);
  }

  function target(options: {
    settings?: string;
    modules?: string;
    answers?: string;
    manifestClass?: string | null;
  }): {
    dir: string;
    out: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "settings-layering-"));
    mkdirSync(join(dir, ".github"), { recursive: true });
    const manifestClass = options.manifestClass === undefined ? "starter" : options.manifestClass;
    git(["git", "-C", dir, "init", "-q", "-b", "main"]);
    // A contributor's global commit signing or hooks path must not decide
    // whether these fixtures can commit.
    git(["git", "-C", dir, "config", "commit.gpgsign", "false"]);
    git(["git", "-C", dir, "config", "core.hooksPath", "/dev/null"]);
    git(["git", "-C", dir, "config", "user.email", "t@example.com"]);
    git(["git", "-C", dir, "config", "user.name", "t"]);
    if (manifestClass !== null) {
      writeFileSync(
        join(dir, ".github/repo-platform-manifest.json"),
        `${JSON.stringify({ files: { ".github/settings.yml": { class: manifestClass } } }, null, 2)}\n`,
      );
    }
    git(["git", "-C", dir, "add", "-A"]);
    git(["git", "-C", dir, "commit", "-qm", "head", "--allow-empty"]);
    if (options.settings !== undefined) {
      writeFileSync(join(dir, ".github/settings.yml"), options.settings);
    }
    if (options.modules !== undefined) {
      writeFileSync(join(dir, ".repo-platform.yml"), options.modules);
    }
    if (options.answers !== undefined) {
      writeFileSync(join(dir, ".copier-answers.yml"), options.answers);
    }
    return { dir, out: join(dir, "settings-layering.md") };
  }

  const legacySettings = [
    "---",
    "# Rendered by the settings-sync module.",
    LEGACY_MERGEABLE_LINE,
    "repository:",
    "  description: Old declared description",
    '  homepage: ""',
    "  topics: kept, custom, topics",
    "  private: false",
    "  has_issues: true",
    "labels:",
    "  - name: extra-label",
    '    color: "0e8a16"',
    "    description: A deliberate repo label",
    "",
  ].join("\n");
  const answers = [
    "description: Live description",
    "private: false",
    'homepage: ""',
    'topics: ""',
    "github_username: Vivswan",
    "",
  ].join("\n");

  test("replaces a legacy file with the identity starter and lists the drops", () => {
    const { dir, out } = target({
      settings: legacySettings,
      modules: "modules: [uv, settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    const replaced = readFileSync(join(dir, ".github/settings.yml"), "utf-8");
    expect(replaced).not.toContain(LEGACY_MERGEABLE_LINE);
    const doc = parseYaml(replaced) as { repository: Record<string, unknown> };
    // Every identity key follows declared-wins: the old file's own
    // values, which the nightly heal was enforcing. The live answer is
    // only a fallback, so a declared description is never silently
    // swapped (droppedOverrides would not report it - identity keys are
    // exempt there as carried).
    expect(doc.repository.description).toBe("Old declared description");
    expect(doc.repository.topics).toBe("kept, custom, topics");
    expect(doc.repository.private).toBe(false);
    const section = readFileSync(out, "utf-8");
    expect(section).toContain('- labels "extra-label"');
    // Identity keys and baseline-equal declarations are never listed.
    expect(section).not.toContain("repository.description");
    expect(section).not.toContain("repository.has_issues");
  });

  test("a mapping-shaped legacy labels section reaches the drift output, never a refusal", () => {
    // Legacy files are exactly where mis-shapes live: the transition reads
    // the OLD file leniently (not through the settings parse boundary,
    // which refuses mis-shaped sections), so the shape problem lands in
    // the dropped-overrides list the reviewer works from instead of
    // looping the fail-soft retry forever.
    const misShaped = legacySettings.replace(
      /labels:[\s\S]*$/,
      "labels:\n  incident:\n    color: b60205\n",
    );
    const { dir, out } = target({
      settings: misShaped,
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    // The transition ran (the marker is gone) and the section reports the
    // mis-shaped labels, rendered as-is with a shape warning.
    expect(readFileSync(join(dir, ".github/settings.yml"), "utf-8")).not.toContain(
      LEGACY_MERGEABLE_LINE,
    );
    const section = readFileSync(out, "utf-8");
    expect(section).not.toContain("transition FAILED");
    expect(section).toContain("labels (mis-shaped");
    expect(section).toContain("incident");
  });

  test("a lossless transition still replaces, and is still held for review", () => {
    const lossless = legacySettings.replace(
      /labels:[\s\S]*$/,
      "labels:\n  - name: dependencies\n" +
        '    color: "0366d6"\n' +
        "    description: Dependency updates\n",
    );
    const { dir, out } = target({
      settings: lossless,
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".github/settings.yml"), "utf-8")).not.toContain(
      LEGACY_MERGEABLE_LINE,
    );
    // Nothing dropped, but the file still changed owner, so the PR is
    // still held: a non-empty section is what does the holding.
    const section = readFileSync(out, "utf-8");
    expect(section).toContain("Nothing was dropped");
    expect(section).toContain("held for review");
  });

  test("a legacy marker below a long repo-owned header still transitions", () => {
    // A repo that kept its own comments above the rendered ones pushes
    // the marker past any header window. Missing it is the silent
    // failure: the file stays, keeps shadowing the fleet layers, and the
    // PR auto-merges because nothing held it.
    const header = Array.from({ length: 12 }, (_, i) => `# repo note line ${i + 1}`).join("\n");
    const { dir, out } = target({
      settings: legacySettings.replace("---\n", `---\n${header}\n`),
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".github/settings.yml"), "utf-8")).not.toContain(
      LEGACY_MERGEABLE_LINE,
    );
    expect(readFileSync(out, "utf-8")).not.toBe("");
  });

  test("a marker-less file (hand-written or already transitioned) is never touched", () => {
    const handWritten = "repository:\n  description: mine\n";
    const { dir, out } = target({
      settings: handWritten,
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".github/settings.yml"), "utf-8")).toBe(handWritten);
    expect(readFileSync(out, "utf-8")).toBe("");
  });

  test("a legacy baseline whose marker was DELETED still transitions", () => {
    // The marker line was deletable and the three-way merge preserved the
    // deletion, so the file alone cannot answer the question; the
    // pre-update manifest class can.
    const { dir, out } = target({
      settings: legacySettings.replace(`${LEGACY_MERGEABLE_LINE}\n`, ""),
      modules: "modules: [settings-sync]\n",
      answers,
      manifestClass: "mergeable",
    });
    transitionSettingsStarter(dir, out, "t");
    const written = readFileSync(join(dir, ".github/settings.yml"), "utf-8");
    expect(written).toContain("Rendered ONCE by the settings-sync module");
    expect(written).not.toContain("extra-label");
    const section = readFileSync(out, "utf-8");
    expect(section).toContain("layering transition");
    expect(section).toContain('- labels "extra-label"');
  });

  test("marker-less AND no committed manifest HOLDS the PR without writing", () => {
    // Neither source can classify the file. Guessing either way is the
    // silent failure, so the transition refuses and says why.
    const handWritten = "repository:\n  description: mine\n";
    const { dir, out } = target({
      settings: handWritten,
      modules: "modules: [settings-sync]\n",
      answers,
      manifestClass: null,
    });
    transitionSettingsStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".github/settings.yml"), "utf-8")).toBe(handWritten);
    expect(readFileSync(out, "utf-8")).toContain("could not be classified");
  });

  test("a hidden target's classification warning redacts the manifest detail", () => {
    // headManifestClass's detail quotes target-controlled manifest content
    // (the unknown class value below); the warning lands in the PUBLIC
    // sync log, so a hidden target's copy must keep only the fact - the
    // full detail still reaches the PR-body section, which ships to the
    // private repo.
    const { dir, out } = target({
      settings: "repository:\n  description: mine\n",
      modules: "modules: [settings-sync]\n",
      answers,
      manifestClass: "mystery-class",
    });
    const logs: string[] = [];
    const originalLog = console.log;
    const priorHide = process.env.HIDE_DETAILS;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    process.env.HIDE_DETAILS = "true";
    try {
      transitionSettingsStarter(dir, out, "t");
    } finally {
      console.log = originalLog;
      if (priorHide === undefined) delete process.env.HIDE_DETAILS;
      else process.env.HIDE_DETAILS = priorHide;
    }
    const warningLine = logs.find((line) => line.includes("::warning::")) ?? "";
    expect(warningLine).toContain("detail hidden: private repository");
    expect(warningLine).not.toContain("mystery-class");
    expect(readFileSync(out, "utf-8")).toContain("mystery-class");
  });

  test("a repo without the settings-sync module keeps its legacy file", () => {
    const { dir, out } = target({
      settings: legacySettings,
      modules: "modules: [uv]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".github/settings.yml"), "utf-8")).toBe(legacySettings);
    expect(readFileSync(out, "utf-8")).toBe("");
  });

  test("an undeclared description falls back to the recorded live answer", () => {
    const { dir, out } = target({
      settings: legacySettings.replace("  description: Old declared description\n", ""),
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    const doc = parseYaml(readFileSync(join(dir, ".github/settings.yml"), "utf-8")) as {
      repository: Record<string, unknown>;
    };
    expect(doc.repository.description).toBe("Live description");
  });

  test("a description neither source declares is OMITTED, not cleared", () => {
    // Declaring "" would declare-and-clear a live description that
    // nothing ever managed - the same reason homepage and topics drop.
    const { dir, out } = target({
      settings: legacySettings.replace("  description: Old declared description\n", ""),
      modules: "modules: [settings-sync]\n",
      answers: answers.replace("description: Live description\n", ""),
    });
    transitionSettingsStarter(dir, out, "t");
    const text = readFileSync(join(dir, ".github/settings.yml"), "utf-8");
    // The commented label example also mentions description, so match the
    // repository block's own declaration line.
    expect(text.split("\n").some((line) => /^ {2}description:/.test(line))).toBe(false);
    const doc = parseYaml(text) as { repository: Record<string, unknown> };
    expect("description" in doc.repository).toBe(false);
    // private is always seeded, so the block never renders empty.
    expect(doc.repository.private).toBe(false);
  });

  test("fleet law that moved into the override is NOT reported as dropped", () => {
    // A legacy file declares the whole old baseline, and the merge policy
    // plus the main / non-bypassable rulesets now live in the override
    // layer. Diffing against layers 1-4 alone would call all of it
    // "dropped overrides" and tell the reviewer to paste fleet law back
    // into a file that cannot win over it.
    const legacy = [
      "---",
      "# Rendered by the settings-sync module.",
      LEGACY_MERGEABLE_LINE,
      "repository:",
      "  description: Old declared description",
      "  private: false",
      "  has_issues: true",
      "  allow_merge_commit: false",
      "  allow_squash_merge: true",
      "  squash_merge_commit_title: PR_TITLE",
      "labels:",
      "  - name: incident",
      '    color: "b60205"',
      "    description: A deliberate repo-only label",
      "rulesets:",
      "  - name: main",
      "    target: branch",
      "    enforcement: active",
      "  - name: non-bypassable",
      "    target: branch",
      "    enforcement: active",
      "",
    ].join("\n");
    const { dir, out } = target({
      settings: legacy,
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    const section = readFileSync(out, "utf-8");
    // The one genuine repo-only declaration is listed...
    expect(section).toContain('labels "incident"');
    // ...and nothing that the fleet layers (override included) supply is.
    for (const fleet of [
      "repository.allow_merge_commit",
      "repository.allow_squash_merge",
      "repository.squash_merge_commit_title",
      "repository.has_issues",
      'rulesets "main"',
      'rulesets "non-bypassable"',
    ]) {
      expect(section).not.toContain(fleet);
    }
  });

  test("a repo-added rule on a fleet-owned ruleset is still reported", () => {
    // The ruleset itself is fleet law and cannot be re-added, but rules
    // append by type - so a rule type the override does not declare IS a
    // genuine repo addition, and losing it silently would drop protection
    // the repo chose for itself.
    const legacy = [
      "---",
      "# Rendered by the settings-sync module.",
      LEGACY_MERGEABLE_LINE,
      "repository:",
      "  private: false",
      "rulesets:",
      "  - name: main",
      "    target: branch",
      "    rules:",
      "      - type: deletion",
      "      - type: required_signatures",
      "",
    ].join("\n");
    const { dir, out } = target({
      settings: legacy,
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    const section = readFileSync(out, "utf-8");
    // required_signatures is not in the override, so it is reported...
    expect(section).toContain('rulesets "main": rule "required_signatures"');
    expect(section).toContain("re-declaring just this rule");
    // ...while deletion, which the override declares, is not, and neither
    // is the ruleset entry on its own.
    expect(section).not.toContain('rule "deletion"');
    expect(section).not.toContain('- rulesets "main"\n');
  });

  test("a fleet-supplied rule on a fleet ruleset is not mistaken for a repo addition", () => {
    // A public toolchain repo's legacy main carries code_scanning, which
    // the OVERRIDE does not declare - the module visibility layer adds
    // it. Comparing against the override alone would report it as a repo
    // addition on essentially every public toolchain repo.
    const legacy = [
      "---",
      "# Rendered by the settings-sync module.",
      LEGACY_MERGEABLE_LINE,
      "repository:",
      "  private: false",
      "rulesets:",
      "  - name: main",
      "    target: branch",
      "    rules:",
      "      - type: deletion",
      "      - type: code_scanning",
      "        parameters:",
      "          code_scanning_tools:",
      "            - tool: CodeQL",
      "              security_alerts_threshold: high_or_higher",
      "              alerts_threshold: errors",
      "      - type: required_signatures",
      "",
    ].join("\n");
    const { dir, out } = target({
      settings: legacy,
      modules: "modules: [uv, settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    const section = readFileSync(out, "utf-8");
    // The fleet already supplies this one identically, so it is silent...
    expect(section).not.toContain('rule "code_scanning"');
    // ...the override declares this one, so it is silent too...
    expect(section).not.toContain('rule "deletion"');
    // ...and the genuinely repo-only type is still reported.
    expect(section).toContain('rulesets "main": rule "required_signatures"');
  });

  test("an explicitly null identity key is preserved, not re-seeded", () => {
    // homepage: null in the old file means the repo took the field OUT of
    // management and the heal was honouring that. Falling back to the
    // recorded answer would silently start managing it again.
    const { dir, out } = target({
      settings: legacySettings.replace('  homepage: ""', "  homepage: null"),
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    const doc = parseYaml(readFileSync(join(dir, ".github/settings.yml"), "utf-8")) as {
      repository: Record<string, unknown>;
    };
    expect("homepage" in doc.repository).toBe(true);
    expect(doc.repository.homepage).toBeNull();
  });

  test("an explicitly null private is preserved: visibility stays unmanaged", () => {
    // private takes its own path (facts.private, which falls back to the
    // recorded answer), so it needs its own guard against the same
    // absent-vs-null conflation.
    const { dir, out } = target({
      settings: legacySettings.replace("  private: false", "  private: null"),
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    const doc = parseYaml(readFileSync(join(dir, ".github/settings.yml"), "utf-8")) as {
      repository: Record<string, unknown>;
    };
    expect("private" in doc.repository).toBe(true);
    expect(doc.repository.private).toBeNull();
  });

  test("an ABSENT identity key still falls back to the recorded answer", () => {
    const { dir, out } = target({
      settings: legacySettings.replace('  homepage: ""\n', ""),
      modules: "modules: [settings-sync]\n",
      answers: answers.replace('homepage: ""', 'homepage: "https://example.test"'),
    });
    transitionSettingsStarter(dir, out, "t");
    const doc = parseYaml(readFileSync(join(dir, ".github/settings.yml"), "utf-8")) as {
      repository: Record<string, unknown>;
    };
    expect(doc.repository.homepage).toBe("https://example.test");
  });

  test("a legacy 'repository: null' stays unmanaged, it is not re-seeded", () => {
    // The section-level twin of the identity-key null: the repo took its
    // whole identity block out of management, and seeding from the
    // recorded answers would silently start managing all of it again.
    const legacy = [
      "---",
      "# Rendered by the settings-sync module.",
      LEGACY_MERGEABLE_LINE,
      "repository: null",
      "labels:",
      "  - name: incident",
      '    color: "b60205"',
      "    description: A deliberate repo-only label",
      "",
    ].join("\n");
    const { dir, out } = target({
      settings: legacy,
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    const text = readFileSync(join(dir, ".github/settings.yml"), "utf-8");
    const doc = parseYaml(text) as Record<string, unknown>;
    expect("repository" in doc).toBe(true);
    expect(doc.repository).toBeNull();
    // None of the identity values leaked back in.
    expect(text).not.toContain("Live transition description");
    expect(text.split("\n").some((l) => /^ {2}private:/.test(l))).toBe(false);
  });

  test("fail-soft: a broken answers file leaves the old file for the next sync", () => {
    const { dir, out } = target({
      settings: legacySettings,
      modules: "modules: [settings-sync]\n",
      answers: ": broken\n",
    });
    transitionSettingsStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".github/settings.yml"), "utf-8")).toBe(legacySettings);
    // A failed transition leaves the legacy file shadowing the managed
    // layer, so the section must be NON-empty: open_pr.ts arms auto-merge
    // only when every review-forcing section is empty, and this PR must
    // not merge unseen.
    const section = readFileSync(out, "utf-8");
    expect(section).not.toBe("");
    expect(section).toContain("FAILED");
    expect(section).toContain("held for review");
  });

  test("a target without settings.yml writes an empty section and touches nothing", () => {
    const { dir, out } = target({ modules: "modules: [settings-sync]\n", answers });
    transitionSettingsStarter(dir, out, "t");
    expect(existsSync(join(dir, ".github/settings.yml"))).toBe(false);
    expect(readFileSync(out, "utf-8")).toBe("");
  });
});

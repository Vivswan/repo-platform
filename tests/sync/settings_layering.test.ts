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
  starterCarry,
  transitionSettingsStarter,
  uncertainSummary,
  withCarriedDeclarations,
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

  test("a duplicated settings.yml entry is unreadable, never last-wins", () => {
    // JSON.parse keeps only the LAST duplicate: mergeable-then-starter
    // would read as an already-transitioned starter and silently skip the
    // transition on a marker-deleted legacy baseline.
    const dup =
      '{"files": {".github/settings.yml": {"class": "mergeable"}, ".github/settings.yml": {"class": "starter"}}}\n';
    const head = headManifestClass(repoWithManifest(dup));
    expect(head.kind).toBe("unreadable");
    // The conservative branch: with no marker to prove the legacy shape,
    // the transition holds the PR instead of guessing.
    expect(classificationUncertain("repository: {}\n", head)).toBe(true);
  });

  test("an escape-variant duplicate entry is unreadable too", () => {
    // The second spelling escapes the final "l" as backslash-u006c;
    // JSON.parse still collides the decoded keys last-wins.
    const escaped = String.raw`".github/settings.ym\u006c"`;
    const dup = `{"files": {".github/settings.yml": {"class": "mergeable"}, ${escaped}: {"class": "starter"}}}\n`;
    const head = headManifestClass(repoWithManifest(dup));
    expect(head.kind).toBe("unreadable");
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

  test("a scalar rulesets section is reported as mis-shaped; null is the opt-out", () => {
    expect(droppedOverrides({ rulesets: "main" }, managed)[0]).toContain("rulesets (mis-shaped");
    expect(droppedOverrides({ rulesets: null }, managed)).toEqual([]);
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
    // "incident" is absent from the managed layer, so the starter CARRIES
    // it and it is not a drop; "BUG" restyles a label the fleet supplies,
    // which stays a drop for the reviewer to decide on.
    expect(droppedOverrides(old, managed)).toEqual([
      "repository.has_issues",
      "repository.has_extras",
      'labels "BUG"',
      'rulesets "release-tags"',
      "pages",
    ]);
  });

  test("a repo-local label is carried, a fleet-supplied name is not", () => {
    // The carry rule and the drop report read the SAME computation, so a
    // label can never be both listed as lost and written into the starter.
    const old = {
      labels: [
        { name: "incident", color: "b60205", description: "live incident" },
        { name: "BUG", color: "000000", description: "restyled" },
        { name: "Incident", color: "ffffff", description: "case duplicate" },
      ],
    };
    expect(starterCarry(old, managed).labels).toEqual([
      { name: "incident", color: "b60205", description: "live incident" },
    ]);
  });

  test("a null section is the repo's own opt-out, carried rather than reported", () => {
    // `labels: null` keeps the apply off labels entirely; `rulesets: null`
    // keeps it off the module layers' rulesets. Dropping either re-arms
    // management the repo had switched off - delete-undeclared over every
    // label, or a whole-payload PUT over a live ruleset it had shaped.
    expect(starterCarry({ labels: null }, managed).optOuts).toEqual({ labels: null });
    expect(droppedOverrides({ labels: null }, managed)).toEqual([]);
    expect(starterCarry({ rulesets: null }, managed).optOuts).toEqual({ rulesets: null });
    expect(droppedOverrides({ rulesets: null }, managed)).toEqual([]);
  });

  test("a ruleset entry's own null opt-out is carried, and not also reported", () => {
    // The dialect's per-entry opt-outs. Dropping `rules: null` re-inherits
    // the lower layers' rules and the PUT writes a ruleset the repo had
    // deliberately stripped; the report must not name what the file took.
    const old = { rulesets: [{ name: "main", rules: null, conditions: null }] };
    expect(starterCarry(old, managed).optOuts).toEqual({
      rulesets: [{ name: "main", rules: null, conditions: null }],
    });
    expect(droppedOverrides(old, managed)).toEqual([]);
  });

  test("a repository-key opt-out is REPORTED as one: the starter owns that block", () => {
    // Carrying it would emit a second top-level `repository:` key, so the
    // reviewer re-adds it instead - and the report says it was an opt-out
    // rather than just naming the key.
    const old = { repository: { has_issues: null } };
    expect(starterCarry(old, managed).optOuts).toEqual({});
    expect(droppedOverrides(old, managed)).toEqual([
      "repository.has_issues: null (an opt-out from managing this key)",
    ]);
  });

  test("a repo rule the fleet does not supply is REPORTED, never carried", () => {
    // A legacy file is a rendered copy of the old fleet baseline, so a
    // rule type the fleet no longer supplies is usually retired FLEET
    // policy - carrying it would resurrect exactly what the layers
    // dropped, e.g. a private repo's copilot_code_review. Re-declaring it
    // in the new file appends it back, which is the reviewer's call.
    const old = {
      rulesets: [
        {
          name: "main",
          target: "branch",
          rules: [{ type: "required_signatures" }, { type: "deletion", parameters: { x: 1 } }],
        },
      ],
    };
    const fleet = { rulesets: [{ name: "main", target: "branch", rules: [{ type: "deletion" }] }] };
    expect(starterCarry(old, fleet).optOuts).toEqual({});
    expect(droppedOverrides(old, fleet)).toEqual([
      'rulesets "main": rule "required_signatures" (the ruleset is fleet-owned, but re-declaring just this rule in the new settings.yml appends it)',
      'rulesets "main": rule "deletion" (the ruleset is fleet-owned, but re-declaring just this rule in the new settings.yml appends it)',
    ]);
  });

  test("a repo-only ruleset is never carried: the apply does not delete undeclared rulesets", () => {
    const old = {
      rulesets: [{ name: "staging", target: "branch", rules: [{ type: "deletion" }] }],
    };
    expect(starterCarry(old, managed).optOuts).toEqual({});
    expect(droppedOverrides(old, managed)).toEqual(['rulesets "staging"']);
  });

  test("a null on a repo-only or duplicated ruleset never reaches the carry", () => {
    // A skeleton entry naming a ruleset the fleet does not declare would
    // UPSERT it from the fragment alone, narrowing a live ruleset the
    // apply otherwise never touches; a repeated name makes the apply
    // fight itself over one ruleset.
    expect(
      starterCarry({ rulesets: [{ name: "staging", conditions: null }] }, managed).optOuts,
    ).toEqual({});
    expect(
      starterCarry(
        {
          rulesets: [
            { name: "main", conditions: null },
            { name: "main", rules: null },
          ],
        },
        managed,
      ).optOuts,
    ).toEqual({ rulesets: [{ name: "main", conditions: null }] });
  });

  test("starterCarry stands down on an absent or mis-shaped section", () => {
    expect(starterCarry({}, managed)).toEqual({ optOuts: {}, labels: [] });
    expect(starterCarry({ labels: { incident: { color: "b60205" } } }, managed).labels).toEqual([]);
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

describe("withCarriedDeclarations", () => {
  const starter = () =>
    renderStarter(STARTER_TEMPLATE, {
      description: "x",
      homepage: "",
      topics: "",
      private: false,
      githubUsername: "Vivswan",
    });

  test("appends a real labels section, and is a no-op with nothing to carry", () => {
    const base = starter();
    expect(withCarriedDeclarations(base, { optOuts: {}, labels: [] })).toBe(base);
    const carried = withCarriedDeclarations(base, {
      optOuts: {},
      labels: [{ name: "provider", color: "5319e7" }],
    });
    // Parsed, not string-matched: the starter ships the labels example as
    // a COMMENT, so only a parse proves the section is real YAML.
    const doc = parseYaml(carried) as { labels: unknown };
    expect(doc.labels).toEqual([{ name: "provider", color: "5319e7" }]);
  });

  test("an opt-out is written as a literal null, never as an empty list", () => {
    // `labels: []` would declare an EMPTY roster and delete every label;
    // only null keeps the apply off the section.
    const doc = parseYaml(
      withCarriedDeclarations(starter(), {
        optOuts: { labels: null, rulesets: null },
        labels: [],
      }),
    ) as { labels: unknown; rulesets: unknown };
    expect(doc.labels).toBeNull();
    expect(doc.rulesets).toBeNull();
  });

  test("an entry-level opt-out merges with the carried label of the same name", () => {
    // The skeleton entry and the carried entry are the same label: one
    // list, one entry, or the apply would see the name twice.
    const doc = parseYaml(
      withCarriedDeclarations(starter(), {
        optOuts: { labels: [{ name: "provider", description: null }] },
        labels: [{ name: "provider", color: "5319e7" }],
      }),
    ) as { labels: unknown };
    expect(doc.labels).toEqual([{ name: "provider", description: null, color: "5319e7" }]);
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
      writeFileSync(join(dir, ".github/.copier-answers.yml"), options.answers);
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

  test("replaces a legacy file with the identity starter, carrying the repo-local label", () => {
    const { dir, out } = target({
      settings: legacySettings,
      modules: "modules: [uv, settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    const replaced = readFileSync(join(dir, ".github/settings.yml"), "utf-8");
    expect(replaced).not.toContain(LEGACY_MERGEABLE_LINE);
    const doc = parseYaml(replaced) as {
      repository: Record<string, unknown>;
      labels: Record<string, unknown>[];
    };
    // Every identity key follows declared-wins: the old file's own
    // values, which the nightly heal was enforcing. The live answer is
    // only a fallback, so a declared description is never silently
    // swapped (droppedOverrides would not report it - identity keys are
    // exempt there as carried).
    expect(doc.repository.description).toBe("Old declared description");
    expect(doc.repository.topics).toBe("kept, custom, topics");
    expect(doc.repository.private).toBe(false);
    // THE LOSS CLASS this carry exists for: no fleet layer supplies
    // extra-label, and the apply deletes every undeclared label, so
    // leaving it out of the starter would delete it from the repository
    // on the next apply.
    expect(doc.labels).toEqual([
      { name: "extra-label", color: "0e8a16", description: "A deliberate repo label" },
    ]);
    const section = readFileSync(out, "utf-8");
    expect(section).toContain('`labels "extra-label"`');
    expect(section).not.toContain('- labels "extra-label"');
    // Identity keys and baseline-equal declarations are never listed.
    expect(section).not.toContain("repository.description");
    expect(section).not.toContain("repository.has_issues");
  });

  test("a label the fleet layers DO supply is not copied into the starter", () => {
    // A duplicate would shadow the fleet entry forever, so a fleet-supplied
    // name stays with the fleet; only a restyle of one is reported as a
    // dropped override for the reviewer to decide on.
    const withFleetLabel = legacySettings.replace(
      /labels:[\s\S]*$/,
      "labels:\n  - name: dependencies\n" +
        '    color: "ff0000"\n' +
        "    description: Restyled by the repo\n",
    );
    const { dir, out } = target({
      settings: withFleetLabel,
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    const doc = parseYaml(readFileSync(join(dir, ".github/settings.yml"), "utf-8")) as {
      labels?: unknown;
    };
    expect(doc.labels).toBeUndefined();
    expect(readFileSync(out, "utf-8")).toContain('- labels "dependencies"');
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
    expect(written).toContain("Rendered once, repo-owned: template sync never");
    // The transition ran, so the repo-local label rode into the starter.
    expect(written).toContain("extra-label");
    const section = readFileSync(out, "utf-8");
    expect(section).toContain("layering transition");
    expect(section).toContain('`labels "extra-label"`');
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
    // The one genuine repo-only declaration RIDES ALONG rather than being
    // dropped: no fleet layer supplies it, and the apply deletes
    // undeclared labels.
    expect(section).toContain('`labels "incident"`');
    expect(readFileSync(join(dir, ".github/settings.yml"), "utf-8")).toContain("incident");
    // ...and nothing that the fleet layers (override included) supply is
    // reported as dropped.
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

  test("a repo-added rule on a fleet-owned ruleset is reported, never carried", () => {
    // The ruleset itself is fleet law, and rules append by type - but a
    // legacy file is a rendered copy of the old baseline, so a type the
    // fleet no longer supplies is usually retired FLEET policy. Carrying
    // it would resurrect what the layers dropped; re-declaring it in the
    // new file appends it back, and that is the reviewer's call.
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
    const doc = parseYaml(readFileSync(join(dir, ".github/settings.yml"), "utf-8")) as {
      rulesets?: unknown;
    };
    expect(doc.rulesets).toBeUndefined();
    const section = readFileSync(out, "utf-8");
    expect(section).toContain('rulesets "main": rule "required_signatures"');
    // deletion is override-declared, so it is silent, and so is the
    // ruleset entry on its own.
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
      "              alerts_threshold: errors_and_warnings",
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
    // ...and the genuinely repo-only type is reported.
    expect(section).toContain('rulesets "main": rule "required_signatures"');
  });

  test("a fleet rule the old file carries at a DIFFERENT value is reported", () => {
    // The pre-raise threshold: the fleet supplies errors_and_warnings
    // now, so an old file still at plain `errors` is a stale weaker copy,
    // not an identical fleet supply - the reviewer decides whether to
    // re-add it (which would weaken the fleet value from the repo layer).
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
      "      - type: code_scanning",
      "        parameters:",
      "          code_scanning_tools:",
      "            - tool: CodeQL",
      "              security_alerts_threshold: high_or_higher",
      "              alerts_threshold: errors",
      "",
    ].join("\n");
    const { dir, out } = target({
      settings: legacy,
      modules: "modules: [uv, settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    const section = readFileSync(out, "utf-8");
    expect(section).toContain('rulesets "main": rule "code_scanning"');
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

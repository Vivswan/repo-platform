// Ownership-manifest byte parity, second half: the shape of each entry and
// of the document itself (grammar, class, self entry, duplicate keys), plus
// the symlink and marker-slicing fixtures. Continues manifest_cross_check.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RETIRED_SHAPE_TOKENS } from "../../../../../scripts/check_ssot.ts";
import { boundedSpawnSync } from "../../../../shared/bounded_spawn.ts";
import { tempDirs } from "../../../../shared/temp_dir.ts";
import {
  B,
  BASELINE,
  E,
  gitFreeEnv,
  HB,
  HE,
  MANAGED_HEADER,
  MANIFEST,
  managedEntry,
  manifestOf,
  regionOf,
  SELF_ENTRY,
  shaLatin1 as sha,
  stampedBaseline,
  VALIDATOR,
  validatorRunner,
} from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

describe("ownership-manifest byte parity", () => {
  // An uncovered path, so the structural loop's grammar check is probed
  // alone. A grammar this validator does not read is refused loudly and
  // never read by guess, mirroring the sync's own refusal.
  test.each([
    {
      reason: "a grammar carrying the managed-region fields",
      grammar: "prefix",
      entryFields: `"begin": "# b", "end": "# e"`,
      body: "# b\n# e\n",
    },
    {
      reason: "a grammar carrying its own fields",
      grammar: "ribbon",
      entryFields: `"marker": "# m", "managed": "above"`,
      body: "# m\n",
    },
  ])(
    "a split grammar this validator does not read is refused, naming the restamp: $reason",
    ({ grammar, entryFields, body }) => {
      const entries = {
        ...stampedBaseline(),
        "docs/notes.md":
          `{"class": "split", "grammar": ${JSON.stringify(grammar)}, ${entryFields}, ` +
          `"hash": "${"d".repeat(64)}"}`,
      };
      const { exitCode, stderr } = runValidator({
        [MANIFEST]: manifestOf(entries),
        "docs/notes.md": body,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(
        `declares split grammar ${JSON.stringify(grammar)}, which this validator does not read`,
      );
      expect(stderr).toContain("run a template sync to restamp the manifest");
    },
  );

  // The retired tokens' one home is RETIRED_SHAPE_TOKENS (the no-retired-shapes rule); every
  // token that ever rode the manifest, planted on an uncovered path, draws exactly one error
  // naming the entry and the token, through the generic checks alone.
  test.each(
    RETIRED_SHAPE_TOKENS.flatMap((shape) =>
      shape.manifestEntry === undefined
        ? []
        : [[shape.name, shape.manifestEntry, shape.re] as const],
    ),
  )(
    "a manifest entry spelling %s is an error naming the entry and the token",
    (_name, entry, re) => {
      const { exitCode, stderr } = runValidator({
        [MANIFEST]: manifestOf({ ...stampedBaseline(), "docs/notes.md": entry }),
        "docs/notes.md": "# b\n# e\n",
      });
      expect(exitCode).toBe(1);
      const naming = stderr.split("\n").filter((line) => line.includes("entry 'docs/notes.md'"));
      expect(naming).toHaveLength(1);
      expect(naming[0]).toMatch(re);
    },
  );

  test("a split entry without its begin/end strings is a structural error", () => {
    const entries = {
      ...stampedBaseline(),
      "docs/notes.md":
        `{"class": "split", "grammar": "managed-region", "begin": "# b", ` +
        `"hash": "${"d".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "docs/notes.md": "# b\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("lacks its begin/end marker-line strings");
  });

  test("a split entry with no grammar field is an error", () => {
    // Every render stamps the grammar; a grammar-less split entry can only
    // be a hand edit, whatever path it sits on.
    const entries = {
      ...stampedBaseline(),
      "docs/notes.md": `{"class": "split", "begin": "# b", "end": "# e", "hash": "${"d".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "docs/notes.md": "# b\n# e\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("lacks the split grammar field every render stamps");
  });

  test("a grammar-less split entry on a roster path draws ONE diagnostic", () => {
    // The missing field is the structural loop's report alone; the roster
    // cross-check judges only present-but-disagreeing metadata, so one
    // cause does not pile two conflicting recovery instructions.
    const region = `${B}\n# Security\n${E}\n`;
    const entries = {
      ...stampedBaseline(),
      ".github/SECURITY.md":
        `{"class": "split", "begin": ${JSON.stringify(B)}, ` +
        `"end": ${JSON.stringify(E)}, "hash": "${sha(region)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      ".github/SECURITY.md": `${region}tail\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("lacks the split grammar field every render stamps");
    expect(stderr).not.toContain(
      "carries split metadata outside its declared managed-region grammar",
    );
  });

  test("a starter entry never carries a hash", () => {
    const entries = {
      ...stampedBaseline(),
      ".github/workflows/checks.yml": `{"class": "starter", "hash": "${"a".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("a starter carrying a hash");
  });

  // Every managed entry keeps full hash parity, whatever its path: the
  // .repo-platform.yml ownership flip (managed -> starter) that once
  // exempted a stale managed entry there is finished fleet-wide, so a
  // manifest still classing it managed is a hand edit like any other.
  test.each([
    {
      reason: ".repo-platform.yml classed managed with a stale hash",
      path: ".repo-platform.yml",
      content: `${BASELINE[".repo-platform.yml"]}mirrors:\n  - source: .github/SECURITY.md\n    targets: [copies/SECURITY.md]\n`,
    },
    { reason: "any other unlisted path", path: "docs/pinned.md", content: "drifted\n" },
  ])("a drifted managed entry fails parity: $reason", ({ path, content }) => {
    const { exitCode, stdout, stderr } = runValidator({
      [path]: content,
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        [path]: `{"class": "managed", "hash": "${"d".repeat(64)}"}`,
      }),
    });
    expect(exitCode).toBe(1);
    // Exactly one diagnostic names the path: no stale flip advisory and no
    // second parity report ride along.
    expect(stderr.split("\n").filter((line) => line.includes(path))).toEqual([
      `error: ${path}: content does not match the sha256 recorded in ${MANIFEST} - the file ` +
        `drifted from the last stamped sync state; local edits to a managed file are replaced by ` +
        `the next template sync (move them to a repo-owned location), and intended template-side ` +
        `updates restamp on that sync`,
    ]);
    expect(stdout).not.toContain(path);
  });

  test("a settings.yml starter entry passes: the file is repo-owned", () => {
    const entries = {
      ...stampedBaseline(),
      ".github/settings.yml": '{"class": "starter"}',
    };
    const { exitCode, stdout, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      ".github/settings.yml": "repository:\n  has_issues: true\n  custom_addition: true\n",
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain(".github/settings.yml");
  });

  test("an unknown class names the whole vocabulary", () => {
    // An uncovered path, so the structural loop's report is probed alone
    // (a roster path would draw the cross-check error first).
    const entries = {
      ...stampedBaseline(),
      "docs/handbook.md": '{"class": "bespoke"}',
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('has unknown class "bespoke" (expected managed, split, or starter)');
  });

  // The self entry's one invariant, judged before any class dispatch:
  // managed, hash null (its content includes every other hash), and a
  // null-or-string provenance commit.
  test.each([
    {
      reason: "a hash set (self-hash is circular)",
      selfEntry: `{"class": "managed", "hash": "${"b".repeat(64)}"}`,
    },
    { reason: "reclassified as starter", selfEntry: '{"class": "starter"}' },
    {
      reason: "a non-string provenance commit",
      selfEntry: '{"class": "managed", "hash": null, "commit": 42}',
    },
  ])("the manifest's own entry breaking its invariant is an error: $reason", ({ selfEntry }) => {
    const entries = { ...stampedBaseline(), [MANIFEST]: selfEntry };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("self-hash would be circular");
  });

  test("a split entry whose marker is missing from the file fails closed", () => {
    // A corrupted manifest reclassifying a managed file as split must not
    // silently exempt it from parity.
    const entries = {
      ...SELF_ENTRY,
      ".github/workflows/ci.yml":
        `{"class": "split", "grammar": "managed-region", "begin": "# no-such-begin", ` +
        `"end": "# no-such-end", "hash": "${"c".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      ".github/workflows/ci.yml: the managed-region marker lines ('# no-such-begin'",
    );
  });

  test("an entry field outside the vocabulary is an error naming the entry and the keys", () => {
    // A retired sync's `withheld` marker left on the registration starter (rostered, selected):
    // reported until the next sync restamps the entry without it. The control is the whole
    // outcome of the same manifest without the key: exit 0 and no findings.
    const stale = runValidator({
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        ".repo-platform.yml": '{"class": "starter", "withheld": true}',
      }),
    });
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr.split("\n").filter((line) => line.startsWith("error:"))).toEqual([
      `error: ${MANIFEST}: entry '.repo-platform.yml' carries field(s) "withheld" outside the manifest's vocabulary - no sync writes them; the next template sync restamps the entry without them, or revert the edit`,
    ]);
    const control = runValidator({ [MANIFEST]: manifestOf(stampedBaseline()) });
    expect({ exitCode: control.exitCode, stderr: control.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  test("a manifest that does not list itself is an error", () => {
    const entries = {
      ".github/workflows/ci.yml": `{"class": "managed", "hash": "${sha(
        BASELINE[".github/workflows/ci.yml"],
      )}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("does not list itself");
  });

  test("an unparseable manifest is its own error", () => {
    const { exitCode, stderr } = runValidator({ [MANIFEST]: "not json\n" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${MANIFEST}: does not parse as a manifest`);
  });

  test("a conflict-marked manifest is the conflict-marker check's report, with no parity double", () => {
    const conflicted = [
      `${"<".repeat(7)} before updating`,
      manifestOf(stampedBaseline()),
      "=".repeat(7),
      `${">".repeat(7)} after updating`,
      "",
    ].join("\n");
    const { exitCode, stderr } = runValidator({ [MANIFEST]: conflicted });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${MANIFEST}: contains unresolved merge-conflict markers`);
    expect(stderr).not.toContain("does not parse as a manifest");
  });

  test("self mode inverts: a present manifest is the error", () => {
    const present = runValidator({ [MANIFEST]: manifestOf(SELF_ENTRY) }, ["--self"]);
    expect(present.exitCode).toBe(1);
    expect(present.stderr).toContain(`${MANIFEST}: exists in the template repository`);
    const absent = runValidator({}, ["--self"]);
    expect(absent.stderr).toBe("");
    expect(absent.exitCode).toBe(0);
  });

  test("validator and stamper slice a trailing-space marker line the same way", () => {
    // Marker LINES match by trimmed equality at every splitter (the
    // stamper, the sync rebuild, and this validator's parity slice must
    // agree, or sync would deliver trees whose stamped region differs from
    // the one parity verifies). A marker line with a stray trailing space
    // still anchors the slice - and stays ONE substring occurrence.
    const content = `above\n${HB} \nroot = true\n${HE}\nrepo tail\n`;
    const region = regionOf(content, HB, HE);
    if (region === null) throw new Error("fixture lost its marker lines");
    const entries = {
      ...stampedBaseline(),
      ".editorconfig":
        `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(HB)}, ` +
        `"end": ${JSON.stringify(HE)}, "hash": "${sha(region)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      ".editorconfig": content,
      [MANIFEST]: manifestOf(entries),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  // CLAUDE.md and the two .github aliases are symlinks in a real render:
  // class-only roster paths with no comment channel. These fixtures land
  // the links so both the parity rule and the cross-check see real symlinks.
  const agentsLinkTree = (claudeEntry: string): string => {
    const root = temp.dir("validate-template-link-");
    const agentsMd = BASELINE["AGENTS.md"];
    const tree: Record<string, string> = { ...BASELINE };
    for (const link of ["CLAUDE.md", ".github/agents.md", ".github/copilot-instructions.md"]) {
      delete tree[link];
    }
    for (const [rel, content] of Object.entries(tree)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    symlinkSync("../AGENTS.md", join(root, ".github/agents.md"));
    symlinkSync("../AGENTS.md", join(root, ".github/copilot-instructions.md"));
    writeFileSync(
      join(root, MANIFEST),
      manifestOf({
        ...stampedBaseline(),
        "AGENTS.md":
          `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(B)}, ` +
          `"end": ${JSON.stringify(E)}, "hash": "${sha(agentsMd)}"}`,
        ".github/agents.md": managedEntry("../AGENTS.md"),
        ".github/copilot-instructions.md": managedEntry("../AGENTS.md"),
        "CLAUDE.md": claudeEntry,
      }),
    );
    return root;
  };

  test("a managed symlink's hash covers the link target", () => {
    const root = agentsLinkTree(`{"class": "managed", "hash": "${sha("AGENTS.md")}"}`);
    const result = boundedSpawnSync([process.execPath, VALIDATOR, root], { env: gitFreeEnv() });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("a symlink-classed path hand-flipped to starter fails the roster cross-check", () => {
    // Symlinks have no header or marker to enforce in-file, so without a
    // class-only roster entry this flip would disable CLAUDE.md's parity
    // permanently and invisibly (sync baselines manifest edits).
    const root = agentsLinkTree('{"class": "starter"}');
    const result = boundedSpawnSync([process.execPath, VALIDATOR, root], { env: gitFreeEnv() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`entry 'CLAUDE.md' claims class "starter"`);
    expect(result.stderr).toContain("ownership tables declare it managed");
  });

  test("a headerless pin dotfile hand-flipped to starter fails the roster cross-check", () => {
    // .bun-version carries no header; the class-only roster entry is what
    // keeps its manifest class honest.
    const registration = BASELINE[".repo-platform.yml"].replace("modules: [uv]", "modules: [bun]");
    const lockfileWorkflow = `${MANAGED_HEADER}name: x\non: [push]\n`;
    const entries = {
      ...stampedBaseline(),
      ".bun-version": '{"class": "starter"}',
      ".github/workflows/dependabot-bun-lockfile.yml": managedEntry(lockfileWorkflow),
    };
    const { exitCode, stderr } = runValidator({
      ".repo-platform.yml": registration,
      ".bun-version": "1.4.0\n",
      ".github/workflows/dependabot-bun-lockfile.yml": lockfileWorkflow,
      [MANIFEST]: manifestOf(entries),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`entry '.bun-version' claims class "starter"`);
    expect(stderr).toContain("ownership tables declare it managed");
    // The fixture pin is a hand twin of the generated TOOLCHAIN_PINS
    // table; a stale one would add its own error here invisibly (the
    // test already expects failure), so pin its freshness explicitly.
    expect(stderr).not.toContain(".bun-version: content");
  });

  // JSON.parse keeps the LAST binding silently, so a conflicted resolution
  // keeping a second, starter-classed ci.yml line (or a second class field
  // inside the entry) would switch that file's parity off invisibly. The
  // duplicate is refused before any consumer reads the last-win view.
  test.each([
    {
      reason: "two entry lines for one path (the second starter-classed)",
      entryLines: [
        `    ".github/workflows/ci.yml": ${stampedBaseline()[".github/workflows/ci.yml"]}`,
        `    ".github/workflows/ci.yml": {"class": "starter"}`,
      ],
    },
    {
      reason: "a duplicated class field inside one entry object",
      entryLines: [
        `    ".github/workflows/ci.yml": {"class": "managed", "class": "starter", "hash": null}`,
      ],
    },
  ])(
    "a duplicated manifest key is a hard error, refused before any last-win read: $reason",
    ({ entryLines }) => {
      const text = `{\n  "files": {\n${[
        `    ${JSON.stringify(MANIFEST)}: ${SELF_ENTRY[MANIFEST]}`,
        ...entryLines,
      ].join(",\n")}\n  }\n}\n`;
      const { exitCode, stderr } = runValidator({ [MANIFEST]: text });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("binds a key more than once");
      // The last-win view (ci.yml as a starter) must not have reached the
      // roster cross-check: that is the report it would draw there.
      expect(stderr).not.toContain('claims class "starter"');
    },
  );
});

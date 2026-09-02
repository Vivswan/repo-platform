// materialize_mirrors.ts's resolver and writer: the declaration reader,
// the path trust boundary, the glob expansion, the two-writer and escape
// refusals, and the byte-copy semantics. The two REFUSAL tests named in
// scripts/guard_registry.ts (mirror-target-escape-refusal,
// mirror-managed-target-refusal) are the arming audit's forcing cases -
// each must go red when its guard branch is stubbed out.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declarationSource,
  expandTargetPattern,
  type MirrorDecl,
  materializeWrites,
  mirrorPathProblem,
  planMirrors,
  readMirrors,
  renderNote,
  renderRefusals,
} from "../../.github/scripts/sync/materialize_mirrors.ts";
import type { ManifestEntryShape } from "../../actions/shared/manifest.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mirrors-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const MANIFEST: Record<string, ManifestEntryShape> = {
  "LICENSE.md": { class: "split" },
  "SECURITY.md": { class: "split" },
  ".copier-answers.yml": { class: "managed" },
  ".gitleaks.toml": { class: "starter" },
};

describe("readMirrors", () => {
  test("an absent mirrors key is the quiet no-op, not a problem", () => {
    expect(readMirrors({ modules: ["uv"] })).toEqual({ mirrors: [], problems: [] });
  });

  test("a non-list mirrors key is a problem", () => {
    const { mirrors, problems } = readMirrors({ mirrors: { source: "LICENSE.md" } });
    expect(mirrors).toEqual([]);
    expect(problems).toHaveLength(1);
  });

  test("a malformed entry is refused while well-formed siblings survive", () => {
    const { mirrors, problems } = readMirrors({
      mirrors: [
        { source: "LICENSE.md" },
        { source: "LICENSE.md", targets: ["template/LICENSE.md"] },
      ],
    });
    expect(mirrors).toEqual([{ source: "LICENSE.md", targets: ["template/LICENSE.md"] }]);
    expect(problems).toHaveLength(1);
  });

  test("an unknown key refuses the entry - a typo'd targets must not mirror nothing silently", () => {
    const { mirrors, problems } = readMirrors({
      mirrors: [{ source: "LICENSE.md", tragets: ["template/LICENSE.md"] }],
    });
    expect(mirrors).toEqual([]);
    expect(problems[0]).toContain("unknown key");
  });

  test("empty and non-string targets are problems", () => {
    expect(readMirrors({ mirrors: [{ source: "a", targets: [] }] }).problems).toHaveLength(1);
    expect(readMirrors({ mirrors: [{ source: "a", targets: [7] }] }).problems).toHaveLength(1);
    expect(readMirrors({ mirrors: [{ source: "", targets: ["b"] }] }).problems).toHaveLength(1);
  });
});

describe("mirrorPathProblem", () => {
  test("clean relative paths pass", () => {
    expect(mirrorPathProblem("skills/alpha/LICENSE.md")).toBeNull();
    expect(mirrorPathProblem("LICENSE.md")).toBeNull();
  });

  test("escape shapes are named", () => {
    expect(mirrorPathProblem("/etc/passwd")).toContain("absolute");
    expect(mirrorPathProblem("../outside.md")).toContain("escape");
    expect(mirrorPathProblem("a/./b")).toContain("escape");
    expect(mirrorPathProblem("a//b")).toContain("escape");
    expect(mirrorPathProblem("a\\b")).toContain("backslash");
    expect(mirrorPathProblem(".git/hooks/pre-commit")).toContain(".git");
    expect(mirrorPathProblem("vendor/.git/config")).toContain(".git");
    expect(mirrorPathProblem(".github/workflows/ci.yml")).toContain("Workflows scope");
  });

  test("case aliases are refused too - a case-insensitive checkout resolves them", () => {
    expect(mirrorPathProblem(".GIT/config")).toContain(".git");
    expect(mirrorPathProblem(".GitHub/Workflows/ci.yml")).toContain("Workflows scope");
  });

  test("control bytes are refused before any filesystem API can throw on them", () => {
    expect(mirrorPathProblem("bad\0name.md")).toContain("control characters");
    expect(mirrorPathProblem("bad\nname.md")).toContain("control characters");
  });
});

describe("expandTargetPattern", () => {
  test("a literal pattern resolves to itself whether or not it exists", () => {
    const root = makeTree({});
    expect(expandTargetPattern(root, "template/LICENSE.md").matches).toEqual([
      "template/LICENSE.md",
    ]);
  });

  test("a non-final '*' matches existing directories; a literal final segment lands in each", () => {
    const root = makeTree({
      "skills/alpha/LICENSE.md": "x",
      "skills/beta/SKILL.md": "y",
      "skills/README.md": "index",
    });
    expect(expandTargetPattern(root, "skills/*/LICENSE.md").matches).toEqual([
      "skills/alpha/LICENSE.md",
      "skills/beta/LICENSE.md",
    ]);
  });

  test("a final '*' matches existing regular files only", () => {
    const root = makeTree({ "docs/a.md": "a", "docs/b.md": "b" });
    mkdirSync(join(root, "docs/sub.md"));
    expect(expandTargetPattern(root, "docs/*.md").matches).toEqual(["docs/a.md", "docs/b.md"]);
  });

  test("symlinked directories never expand - and are REPORTED, not silently skipped", () => {
    const root = makeTree({ "skills/alpha/SKILL.md": "x" });
    symlinkSync(tmpdir(), join(root, "skills", "linked"));
    const { matches, symlinkedPrefixes } = expandTargetPattern(root, "skills/*/LICENSE.md");
    expect(matches).toEqual(["skills/alpha/LICENSE.md"]);
    expect(symlinkedPrefixes).toEqual(["skills/linked"]);
  });

  test("a symlinked LITERAL prefix is reported, never walked - readdir would follow it outside", () => {
    const root = makeTree({});
    symlinkSync(tmpdir(), join(root, "linked"));
    const { matches, symlinkedPrefixes } = expandTargetPattern(root, "linked/*/LICENSE.md");
    expect(matches).toEqual([]);
    expect(symlinkedPrefixes).toEqual(["linked"]);
  });

  test("a glob over a missing prefix matches nothing", () => {
    const root = makeTree({});
    expect(expandTargetPattern(root, "skills/*/LICENSE.md").matches).toEqual([]);
  });
});

describe("planMirrors", () => {
  const decl = (source: string, ...targets: string[]): MirrorDecl[] => [{ source, targets }];

  test("a manifest-absent source is refused - mirrors copy only what the render wrote", () => {
    const root = makeTree({ "notes.md": "mine" });
    const plan = planMirrors(root, decl("notes.md", "copy.md"), MANIFEST, "");
    expect(plan.writes).toEqual([]);
    expect(plan.refusals[0]).toContain("does not list it");
  });

  test("a starter-class source is refused - repo-owned content is the repo's own job", () => {
    const root = makeTree({ ".gitleaks.toml": "allow" });
    const plan = planMirrors(root, decl(".gitleaks.toml", "copy.toml"), MANIFEST, "");
    expect(plan.writes).toEqual([]);
    expect(plan.refusals[0]).toContain("class 'starter'");
  });

  test("a glob in the source is refused - a source names exactly one file", () => {
    const root = makeTree({});
    const plan = planMirrors(root, decl("skills/*/LICENSE.md", "copy.md"), MANIFEST, "");
    expect(plan.refusals[0]).toContain("exactly one file");
  });

  test("a source missing from the delivered tree is refused", () => {
    const root = makeTree({});
    const plan = planMirrors(root, decl("LICENSE.md", "copy.md"), MANIFEST, "");
    expect(plan.refusals[0]).toContain("missing from the delivered tree");
  });

  test("a null manifest refuses every entry with the stated problem", () => {
    const root = makeTree({ "LICENSE.md": "text" });
    const plan = planMirrors(root, decl("LICENSE.md", "copy.md"), null, "manifest is damaged");
    expect(plan.writes).toEqual([]);
    expect(plan.refusals[0]).toContain("manifest is damaged");
  });

  test("a '..' mirror target is REFUSED and never written - the write would escape the repository", () => {
    const root = makeTree({ "LICENSE.md": "the license" });
    const plan = planMirrors(root, decl("LICENSE.md", "../outside.md"), MANIFEST, "");
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toContain("escape");
    materializeWrites(root, plan.writes);
    expect(existsSync(join(root, "..", "outside.md"))).toBe(false);
  });

  test("a manifest-listed mirror target is REFUSED - the template is that path's writer", () => {
    const root = makeTree({ "LICENSE.md": "the license", "SECURITY.md": "policy" });
    const plan = planMirrors(root, decl("LICENSE.md", "SECURITY.md"), MANIFEST, "");
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toContain("second writer");
    materializeWrites(root, plan.writes);
    expect(readFileSync(join(root, "SECURITY.md"), "utf-8")).toBe("policy");
  });

  test("a '**' pattern is refused, never treated as a recursive glob", () => {
    const root = makeTree({ "LICENSE.md": "the license" });
    const plan = planMirrors(root, decl("LICENSE.md", "skills/**/LICENSE.md"), MANIFEST, "");
    expect(plan.refusals[0]).toContain("'**'");
  });

  test("two sources claiming one target refuse EVERY claim - order never picks the winner", () => {
    const root = makeTree({ "LICENSE.md": "l", "SECURITY.md": "s" });
    const plan = planMirrors(
      root,
      [
        { source: "LICENSE.md", targets: ["copy.md"] },
        { source: "SECURITY.md", targets: ["copy.md"] },
      ],
      MANIFEST,
      "",
    );
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toContain("`LICENSE.md`");
    expect(plan.refusals[0]).toContain("`SECURITY.md`");
    expect(existsSync(join(root, "copy.md"))).toBe(false);
  });

  test("a glob-expanded target inside .git is REFUSED - expansion output is re-validated", () => {
    const root = makeTree({ "LICENSE.md": "l", ".git/config": "[core]" });
    const plan = planMirrors(root, decl("LICENSE.md", "*/config"), MANIFEST, "");
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toContain(".git");
    materializeWrites(root, plan.writes);
    expect(readFileSync(join(root, ".git/config"), "utf-8")).toBe("[core]");
  });

  test("a workflow-path source or target is refused - the withhold push can rewrite those after mirrors", () => {
    const root = makeTree({ "LICENSE.md": "l", ".github/workflows/ci.yml": "jobs:" });
    const manifest: Record<string, ManifestEntryShape> = {
      ...MANIFEST,
      ".github/workflows/ci.yml": { class: "managed" },
    };
    const asSource = planMirrors(root, decl(".github/workflows/ci.yml", "copy.yml"), manifest, "");
    expect(asSource.writes).toEqual([]);
    expect(asSource.refusals[0]).toContain("Workflows scope");
    const asTarget = planMirrors(
      root,
      decl("LICENSE.md", ".github/workflows/mirror.yml"),
      manifest,
      "",
    );
    expect(asTarget.writes).toEqual([]);
    expect(asTarget.refusals[0]).toContain("Workflows scope");
  });

  test("a planned target that is a path prefix of another refuses both sides", () => {
    const root = makeTree({ "LICENSE.md": "l" });
    const plan = planMirrors(root, decl("LICENSE.md", "copies", "copies/one.md"), MANIFEST, "");
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(2);
    for (const refusal of plan.refusals) expect(refusal).toContain("path prefix");
  });

  test("a symlinked source ancestor is refused - the read could leave the checkout", () => {
    const root = makeTree({ "LICENSE.md": "l" });
    const outside = mkdtempSync(join(tmpdir(), "mirrors-src-"));
    writeFileSync(join(outside, "x.md"), "outside bytes");
    symlinkSync(outside, join(root, "docs"));
    const manifest: Record<string, ManifestEntryShape> = {
      ...MANIFEST,
      "docs/x.md": { class: "managed" },
    };
    const plan = planMirrors(root, decl("docs/x.md", "copy.md"), manifest, "");
    expect(plan.writes).toEqual([]);
    expect(plan.refusals[0]).toContain("symbolic link");
  });

  test("a symlinked literal glob prefix is refused, not read as matched-nothing", () => {
    const root = makeTree({ "LICENSE.md": "l" });
    symlinkSync(mkdtempSync(join(tmpdir(), "mirrors-out-")), join(root, "linked"));
    const plan = planMirrors(root, decl("LICENSE.md", "linked/*/LICENSE.md"), MANIFEST, "");
    expect(plan.writes).toEqual([]);
    expect(plan.unmatched).toEqual([]);
    expect(plan.refusals[0]).toContain("symbolic link");
  });

  test("a glob-matched symlinked directory is REFUSED and listed - never a silent skip", () => {
    // The compat-alias shape: skills/legacy -> skills/new. A silent skip
    // would ship that folder's mirror stale with an EMPTY explanation -
    // the silent-stale class this feature exists to kill.
    const root = makeTree({ "LICENSE.md": "the license", "skills/new/SKILL.md": "x" });
    symlinkSync(join(root, "skills", "new"), join(root, "skills", "legacy"));
    const plan = planMirrors(root, decl("LICENSE.md", "skills/*/LICENSE.md"), MANIFEST, "");
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toContain("skills/legacy");
    expect(plan.refusals[0]).toContain("symbolic link");
    expect(renderRefusals(plan.refusals)).toContain("skills/legacy");
    // The healthy sibling still materializes; nothing is written through
    // the link itself.
    const { written } = materializeWrites(root, plan.writes);
    expect(written).toEqual([{ source: "LICENSE.md", target: "skills/new/LICENSE.md" }]);
  });

  test("case-fold aliases of one target refuse every claim - a case-insensitive checkout folds them", () => {
    const root = makeTree({ "LICENSE.md": "l" });
    const plan = planMirrors(root, decl("LICENSE.md", "copy.md", "COPY.md"), MANIFEST, "");
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toContain("case-insensitive");
  });

  test("a case-fold alias of a manifest path is refused like the exact spelling", () => {
    const root = makeTree({ "LICENSE.md": "l" });
    const plan = planMirrors(root, decl("LICENSE.md", "security.MD"), MANIFEST, "");
    expect(plan.writes).toEqual([]);
    expect(plan.refusals[0]).toContain("second writer");
  });

  test("one source claiming a target twice (literal plus glob) is one write, not a conflict", () => {
    const root = makeTree({ "LICENSE.md": "l", "skills/alpha/SKILL.md": "x" });
    const plan = planMirrors(
      root,
      decl("LICENSE.md", "skills/alpha/LICENSE.md", "skills/*/LICENSE.md"),
      MANIFEST,
      "",
    );
    expect(plan.writes).toEqual([{ source: "LICENSE.md", target: "skills/alpha/LICENSE.md" }]);
    expect(plan.refusals).toEqual([]);
  });

  test("a glob matching nothing is stated, not refused - an empty skills dir is legitimate", () => {
    const root = makeTree({ "LICENSE.md": "l" });
    const plan = planMirrors(root, decl("LICENSE.md", "skills/*/LICENSE.md"), MANIFEST, "");
    expect(plan.unmatched).toEqual([{ source: "LICENSE.md", pattern: "skills/*/LICENSE.md" }]);
    expect(plan.refusals).toEqual([]);
  });
});

describe("materializeWrites", () => {
  test("writes byte copies, creating missing directories and files", () => {
    const root = makeTree({ "LICENSE.md": "the license\n" });
    const { written, current, refusals } = materializeWrites(root, [
      { source: "LICENSE.md", target: "template/LICENSE.md" },
    ]);
    expect(written).toHaveLength(1);
    expect(current).toEqual([]);
    expect(refusals).toEqual([]);
    expect(readFileSync(join(root, "template/LICENSE.md"), "utf-8")).toBe("the license\n");
  });

  test("a byte-equal target is current, not rewritten", () => {
    const root = makeTree({ "LICENSE.md": "same\n", "copy.md": "same\n" });
    const { written, current } = materializeWrites(root, [
      { source: "LICENSE.md", target: "copy.md" },
    ]);
    expect(written).toEqual([]);
    expect(current).toHaveLength(1);
  });

  test("a symlinked target is refused - the write would follow the link", () => {
    const root = makeTree({ "LICENSE.md": "l" });
    const outside = join(mkdtempSync(join(tmpdir(), "mirrors-out-")), "victim.md");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, join(root, "copy.md"));
    const { written, refusals } = materializeWrites(root, [
      { source: "LICENSE.md", target: "copy.md" },
    ]);
    expect(written).toEqual([]);
    expect(refusals[0]).toContain("symbolic link");
    expect(readFileSync(outside, "utf-8")).toBe("untouched");
  });

  test("a symlinked ancestor is refused", () => {
    const root = makeTree({ "LICENSE.md": "l" });
    symlinkSync(mkdtempSync(join(tmpdir(), "mirrors-out-")), join(root, "linked"));
    const { written, refusals } = materializeWrites(root, [
      { source: "LICENSE.md", target: "linked/copy.md" },
    ]);
    expect(written).toEqual([]);
    expect(refusals[0]).toContain("ancestor");
  });

  test("a directory at the target is refused, never replaced", () => {
    const root = makeTree({ "LICENSE.md": "l" });
    mkdirSync(join(root, "copy.md"));
    const { written, refusals } = materializeWrites(root, [
      { source: "LICENSE.md", target: "copy.md" },
    ]);
    expect(written).toEqual([]);
    expect(refusals[0]).toContain("not a regular file");
  });

  test("a filesystem failure at write time refuses instead of throwing", () => {
    // A regular file squats where the target's parent directory must go:
    // mkdir -p fails with ENOTDIR, which must be a refusal, not a red job.
    const root = makeTree({ "LICENSE.md": "l", squatter: "a file, not a directory" });
    const { written, refusals } = materializeWrites(root, [
      { source: "LICENSE.md", target: "squatter/copy.md" },
    ]);
    expect(written).toEqual([]);
    expect(refusals[0]).toContain("could not be written");
  });

  test("the writer boundary re-validates: a raw escaping write is refused even without planMirrors", () => {
    const root = makeTree({ "LICENSE.md": "l" });
    const { written, refusals } = materializeWrites(root, [
      { source: "LICENSE.md", target: "../raw-escape.md" },
    ]);
    expect(written).toEqual([]);
    expect(refusals[0]).toContain("escape");
    expect(existsSync(join(root, "..", "raw-escape.md"))).toBe(false);
  });
});

describe("declarationSource", () => {
  const git = (cwd: string, ...args: string[]) => {
    const proc = boundedSpawnSync(["git", "-C", cwd, ...args]);
    expect(proc.exitCode).toBe(0);
  };

  test("a plain tree reads the working-tree copy explicitly", () => {
    const root = makeTree({ ".repo-platform.yml": "modules: [uv]\n" });
    expect(declarationSource(root)).toEqual({ text: "modules: [uv]\n", refusal: null });
  });

  test("inside a git repository HEAD's copy wins over a rewritten working tree", () => {
    const root = makeTree({ ".repo-platform.yml": "modules: [uv]\nmirrors: []\n" });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@localhost",
      "commit",
      "-q",
      "-m",
      "init",
      "--no-verify",
    );
    writeFileSync(join(root, ".repo-platform.yml"), "modules: [uv]\n");
    const { text, refusal } = declarationSource(root);
    expect(refusal).toBeNull();
    expect(text).toContain("mirrors:");
  });

  test("a git repository whose HEAD lacks the file REFUSES - no silent fallback to the rewritten tree", () => {
    const root = makeTree({ "other.txt": "x" });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@localhost",
      "commit",
      "-q",
      "-m",
      "init",
      "--no-verify",
    );
    writeFileSync(join(root, ".repo-platform.yml"), "modules: [uv]\n");
    const { text, refusal } = declarationSource(root);
    expect(text).toBeNull();
    expect(refusal).toContain("no committed copy");
  });
});

describe("report rendering", () => {
  test("nothing written or unmatched renders no note", () => {
    expect(renderNote([], 3, [])).toBe("");
  });

  test("the note lists every write and every unmatched pattern", () => {
    const note = renderNote([{ source: "LICENSE.md", target: "template/LICENSE.md" }], 2, [
      { source: "LICENSE.md", pattern: "skills/*/LICENSE.md" },
    ]);
    expect(note).toContain("`template/LICENSE.md` <- `LICENSE.md`");
    expect(note).toContain("matched nothing");
    expect(note).toContain("2 declared target(s) already matched");
  });

  test("no refusals renders no review section; refusals render the warning", () => {
    expect(renderRefusals([])).toBe("");
    const review = renderRefusals(["`x`: bad"]);
    expect(review).toContain("[!WARNING]");
    expect(review).toContain("`x`: bad");
  });
});

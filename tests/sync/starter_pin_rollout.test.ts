// starter_pin_rollout.ts: the one-run sync-side port of starter
// workflows' action pins onto the delivery branch. The pure helpers are
// tested directly; the script-level tests build a rendered-repo-shaped
// tree (manifest, answers file, starter workflows) and assert the
// byte-surgical rewrite, the hands-off treatment of hand-set pins, and
// idempotence.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  renderRolloutReport,
  rolloutContent,
  starterPaths,
  withholdWorkflowRewrites,
} from "../../.github/scripts/sync/starter_pin_rollout.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/starter_pin_rollout.ts");

const USER = "Vivswan";
const OLD_PIN = `${USER}/repo-platform/actions/fuzz-issue@main`;
const NEW_PIN = `${USER}/repo-platform/actions/fuzz-issue@build`;

/** A nightly-starter-shaped workflow using the given pin twice (report and
 * resolve steps), with surrounding bytes to prove untouched. */
function starter(pin: string): string {
  return `# Nightly CI starter. Edit freely.\nname: Nightly\njobs:\n  report:\n    steps:\n      - uses: ${pin}\n        with:\n          mode: report\n      - uses: ${pin}\n        with:\n          mode: resolve\n`;
}

describe("starterPaths", () => {
  test("returns exactly the starter-classed paths", () => {
    const manifest = JSON.stringify({
      files: {
        ".github/workflows/ci.yml": { class: "managed", hash: null },
        ".github/workflows/nightly.yml": { class: "starter" },
        "AGENTS.md": {
          class: "split",
          grammar: "managed-region",
          begin: "<!-- b -->",
          end: "<!-- e -->",
        },
        ".github/workflows/nightly-fuzz.yml": { class: "starter" },
      },
    });
    expect(starterPaths(manifest, "test").sort()).toEqual([
      ".github/workflows/nightly-fuzz.yml",
      ".github/workflows/nightly.yml",
    ]);
  });

  test("throws on invalid JSON, a missing files mapping, and damaged entries", () => {
    expect(() => starterPaths("not json", "test")).toThrow("does not parse as a manifest");
    expect(() => starterPaths('{"files": []}', "test")).toThrow("no top-level 'files' mapping");
    expect(() => starterPaths('{"files": {"a": "starter"}}', "test")).toThrow("is not an object");
  });

  test("a duplicated key throws instead of last-win laundering", () => {
    // Raw JSON.parse keeps the LAST value silently: a duplicated class
    // field could flip an entry into (or out of) the starter roster with
    // no error. The shared parser rejects the duplicate before any read.
    const doubled = '{"files": {"a.yml": {"class": "managed", "class": "starter", "hash": null}}}';
    expect(() => starterPaths(doubled, "test")).toThrow("binds a key more than once");
  });

  test("throws on a starter path that could escape the target root", () => {
    const manifest = JSON.stringify({ files: { "../escape.yml": { class: "starter" } } });
    expect(() => starterPaths(manifest, "test")).toThrow("not a clean relative path");
  });
});

describe("rolloutContent", () => {
  const ACTIONS_PIN = `${USER}/repo-platform/actions/fuzz-issue@actions`;
  const ownPin = (ref: string) => `${USER}/repo-platform/actions/fuzz-issue@${ref}`;

  // One starter carrying the pin twice (report and resolve steps). A
  // retired ref ports every occurrence to NEW_PIN and reports the rewrite;
  // a hand-set pin on this owner's action stays byte-identical and is
  // listed with its ACTUAL ref (report and tree agree); a foreign owner's
  // pin is neither ours to port nor ours to list.
  test.each([
    { reason: "the @main ref is retired: ported", pin: OLD_PIN, rewrote: true, listed: false },
    {
      reason: "the split-channel era's @actions ref is retired too: ported exactly like @main",
      pin: ACTIONS_PIN,
      rewrote: true,
      listed: false,
    },
    {
      reason: "a hand-set tag is left alone and listed",
      pin: ownPin("v1.2.3"),
      rewrote: false,
      listed: true,
    },
    {
      reason: "a ref that merely starts with the retired ref (dash) is a hand pin",
      pin: ownPin("main-fork"),
      rewrote: false,
      listed: true,
    },
    {
      reason: "a ref that merely starts with the retired ref (slash) is a hand pin",
      pin: ownPin("main/topic"),
      rewrote: false,
      listed: true,
    },
    {
      reason: "a ref that merely starts with the retired ref (longer word) is a hand pin",
      pin: ownPin("maintenance"),
      rewrote: false,
      listed: true,
    },
    {
      reason: "a pin rendered for a different owner never matches",
      pin: "SomeoneElse/repo-platform/actions/fuzz-issue@main",
      rewrote: false,
      listed: false,
    },
    {
      reason: "a LONGER owner name containing the username never matches",
      pin: `Evil${USER}/repo-platform/actions/fuzz-issue@main`,
      rewrote: false,
      listed: false,
    },
  ])("$reason", ({ pin, rewrote, listed }) => {
    const before = starter(pin);
    expect(rolloutContent(before, USER)).toEqual({
      content: rewrote ? starter(NEW_PIN) : before,
      rewrote: rewrote ? [{ from: pin, to: NEW_PIN, count: 2 }] : [],
      differing: listed ? [{ pin, count: 2 }] : [],
    });
  });

  test("both retired refs in ONE file port in one pass, reported per retired ref", () => {
    const before = `${starter(OLD_PIN)}      - uses: ${ACTIONS_PIN}\n`;
    expect(rolloutContent(before, USER)).toEqual({
      content: `${starter(NEW_PIN)}      - uses: ${NEW_PIN}\n`,
      rewrote: [
        { from: OLD_PIN, to: NEW_PIN, count: 2 },
        { from: ACTIONS_PIN, to: NEW_PIN, count: 1 },
      ],
      differing: [],
    });
  });

  test("is idempotent: a rewritten file yields no further changes", () => {
    const first = rolloutContent(starter(OLD_PIN), USER);
    expect(rolloutContent(first.content, USER)).toEqual({
      content: first.content,
      rewrote: [],
      differing: [],
    });
  });

  test("a mixed file gets its old pins rewritten while the hand pin stays", () => {
    const handPin = ownPin("deadbeef");
    const before = `${starter(OLD_PIN)}      - uses: ${handPin}\n`;
    expect(rolloutContent(before, USER)).toEqual({
      content: `${starter(NEW_PIN)}      - uses: ${handPin}\n`,
      rewrote: [{ from: OLD_PIN, to: NEW_PIN, count: 2 }],
      differing: [{ pin: handPin, count: 1 }],
    });
  });
});

describe("withholdWorkflowRewrites", () => {
  test("drops workflow rewrite claims, keeps left-alone listings and non-workflow rewrites", () => {
    const rewrite = { from: OLD_PIN, to: NEW_PIN, count: 2 };
    const hand = { pin: `${USER}/repo-platform/actions/fuzz-issue@v1`, count: 1 };
    expect(
      withholdWorkflowRewrites([
        // Rewrote a withheld workflow file: the claim must drop, and with
        // nothing else to say the outcome drops too.
        { rel: ".github/workflows/nightly.yml", rewrote: [rewrite], differing: [] },
        // Rewrote AND skipped in one withheld file: only the rewrite drops.
        { rel: ".github/workflows/nightly-fuzz.yml", rewrote: [rewrite], differing: [hand] },
        // A starter outside .github/workflows is not withheld: kept whole.
        { rel: "tools/starter.yml", rewrote: [rewrite], differing: [] },
      ]),
    ).toEqual([
      { rel: ".github/workflows/nightly-fuzz.yml", rewrote: [], differing: [hand] },
      { rel: "tools/starter.yml", rewrote: [rewrite], differing: [] },
    ]);
  });
});

describe("renderRolloutReport", () => {
  test("empty for no outcomes", () => {
    expect(renderRolloutReport([])).toBe("");
  });

  test("the whole report shape: one intro paragraph, one bullet per rewrite and per hand pin, in order", () => {
    const handPin = `${USER}/repo-platform/actions/fuzz-issue@v1`;
    const report = renderRolloutReport([
      {
        rel: ".github/workflows/nightly.yml",
        rewrote: [{ from: OLD_PIN, to: NEW_PIN, count: 2 }],
        differing: [],
      },
      {
        rel: ".github/workflows/nightly-fuzz.yml",
        rewrote: [],
        differing: [{ pin: handPin, count: 2 }],
      },
    ]);
    // Every line pinned. The intro is pinned by shape only (one line,
    // its opening words, the trailing colon) because its prose lives
    // unexported in the script; the bullets are byte-exact and in outcome
    // order, then the trailing newline - a duplicated bullet, a dropped
    // intro, a wrong count, or a reordered bullet all break this.
    expect(report.split("\n")).toEqual([
      expect.stringMatching(/^One-run starter pin rollout: .*:$/),
      "",
      `- \`.github/workflows/nightly.yml\`: rewrote 2 occurrence(s) of \`${OLD_PIN}\` to \`${NEW_PIN}\``,
      `- \`.github/workflows/nightly-fuzz.yml\`: left alone - carries 2 occurrence(s) of \`${handPin}\`, a hand-set pin on none of the retired \`@main\`/\`@actions\` refs; repoint it at \`@build\` for green-gated delivery, or keep your own pin`,
      "",
    ]);
  });
});

describe("script", () => {
  function makeTree(): { root: string; renderDir: string; report: string } {
    const base = mkdtempSync(join(tmpdir(), "starter-pin-rollout-"));
    const root = join(base, "target");
    const renderDir = join(base, "render-new");
    const manifest = JSON.stringify({
      files: {
        ".github/workflows/nightly.yml": { class: "starter" },
        ".github/workflows/nightly-fuzz.yml": { class: "starter" },
        ".github/workflows/gone.yml": { class: "starter" },
        ".github/workflows/ci.yml": { class: "managed", hash: null },
      },
    });
    for (const [rel, content] of [
      [".github/.copier-answers.yml", `_commit: v0\ngithub_username: ${USER}\n`],
      [".github/workflows/nightly.yml", starter(OLD_PIN)],
      [
        ".github/workflows/nightly-fuzz.yml",
        starter(`${USER}/repo-platform/actions/fuzz-issue@v1`),
      ],
      // The managed file also carries the old pin: NOT a starter, so the
      // rollout must never touch it.
      [".github/workflows/ci.yml", starter(OLD_PIN)],
    ] as const) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    mkdirSync(join(renderDir, ".github"), { recursive: true });
    writeFileSync(join(renderDir, ".github/repo-platform-manifest.json"), manifest);
    return {
      root,
      renderDir,
      report: join(base, "starter-pin-rollout.md"),
      outcomes: join(base, "starter-pin-rollout.json"),
    };
  }

  function run(root: string, renderDir: string, report: string, outcomes: string) {
    const proc = boundedSpawnSync([
      "bun",
      script,
      "--root",
      root,
      "--render-dir",
      renderDir,
      "--report",
      report,
      "--outcomes",
      outcomes,
    ]);
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout,
      stderr: proc.stderr,
      report: existsSync(report) ? readFileSync(report, "utf-8") : "",
      outcomes: existsSync(outcomes) ? readFileSync(outcomes, "utf-8") : "",
    };
  }

  test("rewrites the old-pin starter, skips the hand-pinned one and every non-starter", () => {
    const { root, renderDir, report, outcomes } = makeTree();
    try {
      const result = run(root, renderDir, report, outcomes);
      expect(result.exitCode).toBe(0);
      // Byte-surgical: the rewritten file equals the same template with
      // only the pin substituted.
      expect(readFileSync(join(root, ".github/workflows/nightly.yml"), "utf-8")).toBe(
        starter(NEW_PIN),
      );
      // The hand-pinned starter and the managed old-pin file are untouched.
      expect(readFileSync(join(root, ".github/workflows/nightly-fuzz.yml"), "utf-8")).toBe(
        starter(`${USER}/repo-platform/actions/fuzz-issue@v1`),
      );
      expect(readFileSync(join(root, ".github/workflows/ci.yml"), "utf-8")).toBe(starter(OLD_PIN));
      // The report names the rewrite and the skip; the deleted starter
      // (gone.yml) stays silent. The structured outcomes twin agrees.
      expect(result.report).toContain("`.github/workflows/nightly.yml`: rewrote 2 occurrence(s)");
      expect(result.report).toContain("`.github/workflows/nightly-fuzz.yml`: left alone");
      expect(result.report).not.toContain("gone.yml");
      expect(JSON.parse(result.outcomes)).toEqual([
        {
          rel: ".github/workflows/nightly.yml",
          rewrote: [{ from: OLD_PIN, to: NEW_PIN, count: 2 }],
          differing: [],
        },
        {
          rel: ".github/workflows/nightly-fuzz.yml",
          rewrote: [],
          differing: [{ pin: `${USER}/repo-platform/actions/fuzz-issue@v1`, count: 2 }],
        },
      ]);

      // Idempotent: the second run rewrites nothing (nightly.yml stays
      // byte-identical, no rewrote bullet - the intro's wording aside)
      // and still lists the hand pin.
      const before = readFileSync(join(root, ".github/workflows/nightly.yml"), "utf-8");
      const second = run(root, renderDir, report, outcomes);
      expect(second.exitCode).toBe(0);
      expect(readFileSync(join(root, ".github/workflows/nightly.yml"), "utf-8")).toBe(before);
      expect(second.report).not.toContain("`: rewrote");
      expect(second.report).toContain("left alone");
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  test("fails loudly without a well-formed recorded github_username", () => {
    const { root, renderDir, report, outcomes } = makeTree();
    try {
      writeFileSync(join(root, ".github/.copier-answers.yml"), "_commit: v0\n");
      const result = run(root, renderDir, report, outcomes);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("github_username");
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });
});

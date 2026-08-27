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
        "AGENTS.md": { class: "split", grammar: "tail-marker", marker: "<!-- m -->" },
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
  test("rewrites every exact old pin and nothing else", () => {
    const before = starter(OLD_PIN);
    const { content, rewrote, differing } = rolloutContent(before, USER);
    expect(content).toBe(starter(NEW_PIN));
    expect(rewrote).toEqual([{ from: OLD_PIN, to: NEW_PIN, count: 2 }]);
    expect(differing).toEqual([]);
  });

  test("the split-channel era's @actions pin is a retired ref too", () => {
    // Repos synced during the template/actions era carry @actions; the
    // unified rollout ports them to @build exactly like @main.
    const actionsPin = `${USER}/repo-platform/actions/fuzz-issue@actions`;
    const { content, rewrote, differing } = rolloutContent(starter(actionsPin), USER);
    expect(content).toBe(starter(NEW_PIN));
    expect(rewrote).toEqual([{ from: actionsPin, to: NEW_PIN, count: 2 }]);
    expect(differing).toEqual([]);
  });

  test("both retired refs in ONE file port in one pass, reported per retired ref", () => {
    const actionsPin = `${USER}/repo-platform/actions/fuzz-issue@actions`;
    const before = `${starter(OLD_PIN)}      - uses: ${actionsPin}\n`;
    const { content, rewrote, differing } = rolloutContent(before, USER);
    expect(content).toBe(`${starter(NEW_PIN)}      - uses: ${NEW_PIN}\n`);
    expect(rewrote).toEqual([
      { from: OLD_PIN, to: NEW_PIN, count: 2 },
      { from: actionsPin, to: NEW_PIN, count: 1 },
    ]);
    expect(differing).toEqual([]);
  });

  test("is idempotent: a rewritten file yields no further changes", () => {
    const first = rolloutContent(starter(OLD_PIN), USER);
    const second = rolloutContent(first.content, USER);
    expect(second.content).toBe(first.content);
    expect(second.rewrote).toEqual([]);
    expect(second.differing).toEqual([]);
  });

  test("leaves a hand-set pin byte-identical and reports it", () => {
    const handPin = `${USER}/repo-platform/actions/fuzz-issue@v1.2.3`;
    const before = starter(handPin);
    const { content, rewrote, differing } = rolloutContent(before, USER);
    expect(content).toBe(before);
    expect(rewrote).toEqual([]);
    expect(differing).toEqual([{ pin: handPin, count: 2 }]);
  });

  test("a mixed file gets its old pins rewritten while the hand pin stays", () => {
    const handPin = `${USER}/repo-platform/actions/fuzz-issue@deadbeef`;
    const before = `${starter(OLD_PIN)}      - uses: ${handPin}\n`;
    const { content, rewrote, differing } = rolloutContent(before, USER);
    expect(content).toBe(`${starter(NEW_PIN)}      - uses: ${handPin}\n`);
    expect(rewrote).toEqual([{ from: OLD_PIN, to: NEW_PIN, count: 2 }]);
    expect(differing).toEqual([{ pin: handPin, count: 1 }]);
  });

  test("a pin rendered for a different owner never matches", () => {
    const foreign = starter("SomeoneElse/repo-platform/actions/fuzz-issue@main");
    const { content, rewrote, differing } = rolloutContent(foreign, USER);
    expect(content).toBe(foreign);
    expect(rewrote).toEqual([]);
    expect(differing).toEqual([]);
  });

  test("a LONGER owner name containing the username never matches", () => {
    const foreign = starter(`Evil${USER}/repo-platform/actions/fuzz-issue@main`);
    const { content, rewrote, differing } = rolloutContent(foreign, USER);
    expect(content).toBe(foreign);
    expect(rewrote).toEqual([]);
    expect(differing).toEqual([]);
  });

  test("refs that merely start with the old ref are hand pins, not matches", () => {
    for (const ref of ["main-fork", "main/topic", "maintenance"]) {
      const pin = `${USER}/repo-platform/actions/fuzz-issue@${ref}`;
      const before = starter(pin);
      const { content, rewrote, differing } = rolloutContent(before, USER);
      expect(content).toBe(before);
      expect(rewrote).toEqual([]);
      // Report and tree agree: the pin is listed with its ACTUAL ref.
      expect(differing).toEqual([{ pin, count: 2 }]);
    }
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

  test("names the rewritten file and pins, and the skipped hand pin", () => {
    const report = renderRolloutReport([
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
    expect(report).toContain("`.github/workflows/nightly.yml`: rewrote 2 occurrence(s)");
    expect(report).toContain(`\`${OLD_PIN}\` to \`${NEW_PIN}\``);
    expect(report).toContain("`.github/workflows/nightly-fuzz.yml`: left alone");
    expect(report).toContain(`${USER}/repo-platform/actions/fuzz-issue@v1`);
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
      [".copier-answers.yml", `_commit: v0\ngithub_username: ${USER}\n`],
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
    const proc = Bun.spawnSync(
      [
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
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
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
      writeFileSync(join(root, ".copier-answers.yml"), "_commit: v0\n");
      const result = run(root, renderDir, report, outcomes);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("github_username");
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });
});

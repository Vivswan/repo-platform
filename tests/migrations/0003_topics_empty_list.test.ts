import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const RUNG = new URL("../../migrations/0003-topics-empty-list.ts", import.meta.url).pathname;
const OVERLAY = ".github/settings.local.yml";

/** The starter's shape as the fleet holds it: a comment above the identity keys, a CRLF line, an owner's ruleset,
 *  and no trailing newline, so the respelling is checked byte for byte around the one value it changes. */
const overlayWith = (topicsLine: string) =>
  [
    "---",
    "# Demo's OWN settings overlay",
    "repository:",
    "  description: A demo repository\r",
    "  # Declared even when empty: the apply manages only declared keys.",
    topicsLine,
    "  private: false",
    "",
    "rulesets:",
    "  - name: release-branches",
    '    topics: ""',
    "    rules: [{type: deletion}]",
  ].join("\n");
const MIGRATED = overlayWith("  topics: []");
const SILENT = { exitCode: 0, stdout: "", stderr: "" };

function checkout(overlay: string | null): string {
  const root = temp.dir("migration-0003-");
  mkdirSync(join(root, ".github"));
  if (overlay !== null) writeFileSync(join(root, OVERLAY), overlay);
  return root;
}

const run = (root: string) => boundedSpawnSync([process.execPath, RUNG, root]);
const topicsOf = (text: string) =>
  (parseYaml(text) as { repository: Record<string, unknown> }).repository.topics;

describe("0003-topics-empty-list", () => {
  test.each<{ reason: string; line: string }>([
    { reason: "an empty double-quoted value", line: '  topics: ""' },
    { reason: "an empty single-quoted value", line: "  topics: ''" },
    { reason: "a whitespace value", line: '  topics: "  "' },
    { reason: "no value at all", line: "  topics:" },
  ])("respells $reason as [] and reports the overlay path", ({ line }) => {
    const root = checkout(overlayWith(line));
    expect(topicsOf(overlayWith(line))).not.toEqual([]);
    expect(run(root)).toEqual({ exitCode: 0, stdout: `${OVERLAY}\n`, stderr: "" });
    const text = readFileSync(join(root, OVERLAY), "utf-8");
    expect(text).toBe(MIGRATED);
    expect(topicsOf(text)).toEqual([]);
    expect(run(root)).toEqual(SILENT);
    expect(readFileSync(join(root, OVERLAY), "utf-8")).toBe(MIGRATED);
  });

  test.each<{ reason: string; overlay: string; edited: string }>([
    {
      reason: "a trailing comment",
      overlay: 'repository:\n  topics: ""  # none yet\n  private: false\n',
      edited: "repository:\n  topics: []  # none yet\n  private: false\n",
    },
    {
      reason: "an alias of an empty value",
      overlay: 'repository:\n  description: &empty ""\n  topics: *empty\n  private: false\n',
      edited: 'repository:\n  description: &empty ""\n  topics: []\n  private: false\n',
    },
  ])("respells the value alone for $reason", ({ overlay, edited }) => {
    const root = checkout(overlay);
    expect(run(root)).toEqual({ exitCode: 0, stdout: `${OVERLAY}\n`, stderr: "" });
    expect(readFileSync(join(root, OVERLAY), "utf-8")).toBe(edited);
  });

  test.each([
    "  topics: demo",
    '  topics: "demo, tools"',
    "  topics: []",
    "  topics: [demo, tools]",
  ])("topics of the repository's own choosing stay as written, silently: %s", (line) => {
    const kept = overlayWith(line);
    const root = checkout(kept);
    expect(run(root)).toEqual(SILENT);
    expect(readFileSync(join(root, OVERLAY), "utf-8")).toBe(kept);
  });

  test.each<{ reason: string; overlay: string | null }>([
    { reason: "no overlay", overlay: null },
    { reason: "an overlay without the key", overlay: "repository:\n  private: false\n" },
    { reason: "an overlay holding only a comment", overlay: "# nothing of our own yet\n" },
    { reason: "an overlay that is not YAML", overlay: "repository: [\n" },
  ])("$reason is a no-op", ({ overlay }) => {
    const root = checkout(overlay);
    expect(run(root)).toEqual(SILENT);
    if (overlay !== null) expect(readFileSync(join(root, OVERLAY), "utf-8")).toBe(overlay);
  });

  // The edit must read back as the original with `[]` in the value's place, or the line is a human's: a block scalar
  // carries its comment and newline in the value's range, and an anchored value carries its list into every alias.
  test.each<{ reason: string; overlay: string; refused: string }>([
    {
      reason: "an empty block scalar with a trailing comment",
      overlay: "repository:\n  private: false\n  topics: | # why\n",
      refused: "its topics value is not written on the key's line",
    },
    {
      reason: "an empty value another key aliases",
      overlay: 'repository:\n  topics: &empty ""\n  description: *empty\n  private: false\n',
      refused: "respelling its topics value would change more than the topics",
    },
  ])("$reason is refused, named, and left as written", ({ overlay, refused }) => {
    const root = checkout(overlay);
    const result = run(root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`0003-topics-empty-list: ${OVERLAY}: ${refused}`);
    expect(readFileSync(join(root, OVERLAY), "utf-8")).toBe(overlay);
  });
});

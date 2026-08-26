import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignHints,
  enrich,
  enrichedRowSchema,
  hintName,
  parseDiscoveredList,
  parseSelectionList,
  VERIFY_HEX_LENGTH,
  verifyTag,
} from "../../.github/scripts/fleet/redact.ts";

describe("hintName", () => {
  test("keeps segment initials and the long final's last char", () => {
    expect(hintName("hidden-server")).toBe("h**-s**r");
    expect(hintName("chromium-bridge")).toBe("c**-b**e");
    expect(hintName("myrepo")).toBe("m**o");
  });

  test("short finals keep no last char", () => {
    // A final under five chars would echo most of the name back.
    expect(hintName("ab")).toBe("a**");
    expect(hintName("api")).toBe("a**");
    expect(hintName("home")).toBe("h**");
    expect(hintName("a-b")).toBe("a**-b**");
  });

  test("separators render literally and empty segments become **", () => {
    expect(hintName("a.b_c")).toBe("a**.b**_c**");
    expect(hintName("a--b")).toBe("a**-**-b**");
  });

  test("case and digits pass through", () => {
    expect(hintName("Repo2")).toBe("R**2");
    expect(hintName("cloud-speech")).toBe("c**-s**h");
  });
});

describe("assignHints", () => {
  test("collisions get deterministic #N suffixes in slug order", () => {
    const hints = assignHints(["o/hidden-server", "o/hail-sooner", "o/skills"]);
    // "hail-sooner" and "hidden-server" share the base hint; slug order
    // decides who keeps it.
    expect(hints.get("o/hail-sooner")).toBe("h**-s**r");
    expect(hints.get("o/hidden-server")).toBe("h**-s**r#2");
    expect(hints.get("o/skills")).toBe("s**s");
  });

  test("duplicate slugs assign once", () => {
    const hints = assignHints(["o/a-repo", "o/a-repo"]);
    expect(hints.size).toBe(1);
  });
});

describe("verifyTag", () => {
  test("is stable, truncated, and case-insensitive over the slug", () => {
    const tag = verifyTag("pat-value", "12345", "Owner/Hidden-Server");
    expect(tag).toBe(verifyTag("pat-value", "12345", "owner/hidden-server"));
    expect(tag).toHaveLength(VERIFY_HEX_LENGTH);
    expect(tag).toMatch(/^[0-9a-f]+$/);
    // Different run, key, or slug: different tag.
    expect(verifyTag("pat-value", "99999", "Owner/Hidden-Server")).not.toBe(tag);
    expect(verifyTag("other-pat", "12345", "Owner/Hidden-Server")).not.toBe(tag);
    expect(verifyTag("pat-value", "12345", "owner/other")).not.toBe(tag);
  });

  test("rejects an empty PAT instead of deriving a publicly known key", () => {
    expect(() => verifyTag("", "424242", "o/r")).toThrow(/empty PAT/);
  });
});

describe("enrich", () => {
  const tagFor = (slug: string) => `tag(${slug})`;
  const discovered = [
    { repo: "o/pub", private: false },
    { repo: "o/hidden-one", private: true },
    { repo: "o/committed-private", private: true },
    { repo: "o/skipped-private", private: true },
  ];
  const selfDisclosed = (slug: string) => slug === "o/committed-private";

  test("classifies public, hinted, and self-disclosed rows", () => {
    const { rows } = enrich(
      [{ repo: "o/pub" }, { repo: "o/hidden-one" }, { repo: "o/committed-private" }],
      discovered,
      selfDisclosed,
      tagFor,
    );
    expect(rows[0]).toEqual({
      repo: "o/pub",
      redact_name: false,
      hide_details: false,
      display: "o/pub",
      verify: "",
    });
    expect(rows[1]).toEqual({
      repo: "o/hidden-one",
      redact_name: true,
      hide_details: true,
      display: "h**-o**",
      verify: "tag(o/hidden-one)",
    });
    // Committed name stays visible; details still hide.
    expect(rows[2]).toEqual({
      repo: "o/committed-private",
      redact_name: false,
      hide_details: true,
      display: "o/committed-private",
      verify: "",
    });
  });

  test("fails closed: absent from discovery asks the probe, defaulting private", () => {
    const { rows } = enrich([{ repo: "o/undiscovered" }], discovered, () => false, tagFor);
    expect(rows[0].redact_name).toBe(true);
    expect(rows[0].hide_details).toBe(true);
    expect(rows[0].display).toBe("u**d");
    expect(rows[0].verify).toBe("tag(o/undiscovered)");
  });

  test("a probe that proves an undiscovered repo public keeps it plain", () => {
    const { rows } = enrich(
      [{ repo: "other/cross-owner" }],
      discovered,
      () => false,
      tagFor,
      () => false,
    );
    expect(rows[0]).toEqual({
      repo: "other/cross-owner",
      redact_name: false,
      hide_details: false,
      display: "other/cross-owner",
      verify: "",
    });
  });

  test("hints stay stable when the selection narrows", () => {
    // A single-repo dispatch must number collision suffixes the same way
    // a full run does: the hint table spans all discovered privates.
    const colliding = [
      { repo: "o/hail-sooner", private: true },
      { repo: "o/hidden-server", private: true },
    ];
    const { rows } = enrich([{ repo: "o/hidden-server" }], colliding, () => false, tagFor);
    expect(rows[0].display).toBe("h**-s**r#2");
  });
});

describe("enrichedRowSchema", () => {
  const redacted = {
    repo: "o/hidden-one",
    redact_name: true,
    hide_details: true,
    display: "h**-o**",
    verify: "deadbeef",
  };
  const plain = {
    repo: "o/pub",
    redact_name: false,
    hide_details: false,
    display: "o/pub",
    verify: "",
  };

  test("accepts both row kinds", () => {
    expect(enrichedRowSchema.safeParse(redacted).success).toBe(true);
    expect(enrichedRowSchema.safeParse(plain).success).toBe(true);
  });

  test("rejects a redacted row missing its verify tag or hide_details", () => {
    expect(enrichedRowSchema.safeParse({ ...redacted, verify: "" }).success).toBe(false);
    expect(enrichedRowSchema.safeParse({ ...redacted, hide_details: false }).success).toBe(false);
  });

  test("rejects a redacted row whose display is not a hint", () => {
    expect(enrichedRowSchema.safeParse({ ...redacted, display: "o/hidden-one" }).success).toBe(
      false,
    );
  });

  test("rejects an unredacted row carrying a verify tag", () => {
    expect(enrichedRowSchema.safeParse({ ...plain, verify: "deadbeef" }).success).toBe(false);
  });

  test("rejects an unredacted row whose display is not its slug", () => {
    expect(enrichedRowSchema.safeParse({ ...plain, display: "p**" }).success).toBe(false);
  });
});

// Parity with the pre-zod hand-rolled ladders: the discovered list fails
// CLOSED (an entry without an explicit boolean `private` rejects the whole
// list), the selection stays fail-open on everything but `repo`.
describe("parseDiscoveredList", () => {
  test("accepts {repo, private} entries and passes extra keys through", () => {
    const parsed = parseDiscoveredList([
      { repo: "o/a", private: true, archived: false, pushed_at: "now" },
    ]);
    expect(parsed).toEqual([{ repo: "o/a", private: true, archived: false, pushed_at: "now" }]);
  });

  test("an empty list is valid", () => {
    expect(parseDiscoveredList([])).toEqual([]);
  });

  test("a wrong-typed EXTRA key survives unchanged (only repo and private are inspected)", () => {
    // The legacy ladder checked exactly those two fields; everything else
    // passed through untouched, whatever its type - pinned so a schema
    // tightening cannot silently change it.
    expect(parseDiscoveredList([{ repo: "o/a", private: true, extra: 42 }])).toEqual([
      { repo: "o/a", private: true, extra: 42 },
    ]);
  });

  test("rejects a missing or non-boolean private (fail closed, whole list)", () => {
    expect(parseDiscoveredList([{ repo: "o/a" }])).toBeNull();
    expect(parseDiscoveredList([{ repo: "o/a", private: "true" }])).toBeNull();
    expect(parseDiscoveredList([{ repo: "o/a", private: true }, { repo: "o/b" }])).toBeNull();
  });

  test("rejects non-object entries, a non-string repo, and a non-array payload", () => {
    expect(parseDiscoveredList(["o/a"])).toBeNull();
    expect(parseDiscoveredList([{ repo: 7, private: true }])).toBeNull();
    expect(parseDiscoveredList({ repo: "o/a", private: true })).toBeNull();
  });
});

describe("parseSelectionList", () => {
  test("only repo is validated; extras ride along untouched", () => {
    const parsed = parseSelectionList([
      { repo: "o/a", owner: "o", name: "a" },
      { repo: "o/b" },
      { repo: "o/c" },
    ]);
    expect(parsed).toEqual([
      { repo: "o/a", owner: "o", name: "a" },
      { repo: "o/b" },
      { repo: "o/c" },
    ]);
  });

  test("a wrong-typed EXTRA key survives unchanged (the ladder never inspected it)", () => {
    // Pins the fail-open side of the parity claim: only repo is validated.
    expect(parseSelectionList([{ repo: "o/a", extra: 42 }])).toEqual([{ repo: "o/a", extra: 42 }]);
  });

  test("rejects a missing or non-string repo and a non-array payload", () => {
    expect(parseSelectionList([{ owner: "o" }])).toBeNull();
    expect(parseSelectionList([{ repo: 7 }])).toBeNull();
    expect(parseSelectionList("o/a")).toBeNull();
  });
});

describe("enrich CLI", () => {
  test("end to end over fixture files", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-"));
    writeFileSync(
      join(dir, "selection.json"),
      JSON.stringify([
        { repo: "Vivswan/pub", owner: "Vivswan", name: "pub" },
        { repo: "Vivswan/hidden-server", owner: "Vivswan", name: "hidden-server" },
      ]),
    );
    writeFileSync(
      join(dir, "discovered.json"),
      JSON.stringify([
        { repo: "Vivswan/pub", private: false },
        { repo: "Vivswan/hidden-server", private: true },
      ]),
    );
    writeFileSync(join(dir, "repos.yml"), 'managed:\n  - "*"\n');
    const proc = Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "../../.github/scripts/fleet/redact.ts"),
        "enrich",
        "--selection",
        join(dir, "selection.json"),
        "--discovered",
        join(dir, "discovered.json"),
        "--registry",
        join(dir, "repos.yml"),
      ],
      { env: { ...process.env, PAT: "p", GITHUB_RUN_ID: "1" } },
    );
    expect(proc.exitCode).toBe(0);
    const result = JSON.parse(proc.stdout.toString());
    expect(result.rows[0].display).toBe("Vivswan/pub");
    expect(result.rows[1].display).toBe("h**-s**r");
    expect(result.rows[1].verify).toHaveLength(VERIFY_HEX_LENGTH);
  });

  test("hint subcommand prints the hint", () => {
    const proc = Bun.spawnSync([
      "bun",
      join(import.meta.dir, "../../.github/scripts/fleet/redact.ts"),
      "hint",
      "hidden-server",
    ]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe("h**-s**r");
  });

  test("a malformed input file fails value-free (no SyntaxError echo)", () => {
    // The bare identifier is the leaking form: a raw JSON.parse error
    // quotes it ('Unexpected identifier "hiddenserver"') into this public
    // log, and both readJson inputs carry private slugs.
    const dir = mkdtempSync(join(tmpdir(), "redact-unparseable-"));
    writeFileSync(join(dir, "selection.json"), '[{"repo": hiddenserver}]');
    writeFileSync(join(dir, "discovered.json"), "[]");
    writeFileSync(join(dir, "repos.yml"), 'managed:\n  - "*"\n');
    const proc = Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "../../.github/scripts/fleet/redact.ts"),
        "enrich",
        "--selection",
        join(dir, "selection.json"),
        "--discovered",
        join(dir, "discovered.json"),
        "--registry",
        join(dir, "repos.yml"),
      ],
      { env: { ...process.env, PAT: "p", GITHUB_RUN_ID: "1" } },
    );
    expect(proc.exitCode).toBe(1);
    expect(proc.stdout.toString()).toContain("not valid JSON");
    expect(proc.stdout.toString() + proc.stderr.toString()).not.toContain("hiddenserver");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignHints, enrich, hintName, VERIFY_HEX_LENGTH, verifyTag } from "./redact.ts";

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

  test("matches the resolver's openssl pipeline byte for byte", () => {
    // The one twinned computation: resolve_private_repo.sh re-derives the
    // tag in bash+openssl. Run that exact pipeline here and compare.
    const pat = "lockstep-test-pat";
    const runId = "424242";
    const slug = "Vivswan/Hidden-Server";
    const script = [
      `key_hex="$(printf '%s' "repo-platform-redact-key-v1" | openssl dgst -sha256 -hmac "$1" -hex | awk '{print $NF}')"`,
      `printf '%s\\0%s' "$2" "$(tr '[:upper:]' '[:lower:]' <<<"$3")" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:\${key_hex}" -hex | awk '{print $NF}' | cut -c1-32`,
    ].join("\n");
    const proc = Bun.spawnSync([
      "bash",
      "-euo",
      "pipefail",
      "-c",
      script,
      "bash",
      pat,
      runId,
      slug,
    ]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe(verifyTag(pat, runId, slug));
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
      [
        { repo: "o/pub", channel: "staging" },
        { repo: "o/hidden-one", channel: null },
        { repo: "o/committed-private", channel: "latest" },
      ],
      discovered,
      selfDisclosed,
      tagFor,
    );
    expect(rows[0]).toEqual({
      repo: "o/pub",
      channel: "staging",
      redact_name: false,
      hide_details: false,
      display: "o/pub",
      verify: "",
    });
    expect(rows[1]).toEqual({
      repo: "o/hidden-one",
      channel: "",
      redact_name: true,
      hide_details: true,
      display: "h**-o**",
      verify: "tag(o/hidden-one)",
    });
    // Committed name stays visible; details still hide.
    expect(rows[2]).toEqual({
      repo: "o/committed-private",
      channel: "latest",
      redact_name: false,
      hide_details: true,
      display: "o/committed-private",
      verify: "",
    });
  });

  test("fails closed: absent from discovery asks the probe, defaulting private", () => {
    const { rows } = enrich(
      [{ repo: "o/undiscovered", channel: null }],
      discovered,
      () => false,
      tagFor,
    );
    expect(rows[0].redact_name).toBe(true);
    expect(rows[0].hide_details).toBe(true);
    expect(rows[0].display).toBe("u**d");
    expect(rows[0].verify).toBe("tag(o/undiscovered)");
  });

  test("a probe that proves an undiscovered repo public keeps it plain", () => {
    const { rows } = enrich(
      [{ repo: "other/cross-owner", channel: null }],
      discovered,
      () => false,
      tagFor,
      () => false,
    );
    expect(rows[0]).toEqual({
      repo: "other/cross-owner",
      channel: "",
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
    const { rows } = enrich(
      [{ repo: "o/hidden-server", channel: null }],
      colliding,
      () => false,
      tagFor,
    );
    expect(rows[0].display).toBe("h**-s**r#2");
  });
});

describe("enrich CLI", () => {
  test("end to end over fixture files", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-"));
    writeFileSync(
      join(dir, "selection.json"),
      JSON.stringify([
        { repo: "Vivswan/pub", owner: "Vivswan", name: "pub", channel: "staging" },
        { repo: "Vivswan/hidden-server", owner: "Vivswan", name: "hidden-server", channel: null },
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
        join(import.meta.dir, "redact.ts"),
        "enrich",
        "--selection",
        join(dir, "selection.json"),
        "--discovered",
        join(dir, "discovered.json"),
        "--registry",
        join(dir, "repos.yml"),
        "--central-dir",
        join(dir, "no-central"),
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
      join(import.meta.dir, "redact.ts"),
      "hint",
      "hidden-server",
    ]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe("h**-s**r");
  });
});

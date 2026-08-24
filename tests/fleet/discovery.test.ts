import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  notAdoptedNotice,
  pushProbeSkipNotice,
  readDispatchRepo,
  scrubSlug,
} from "../../.github/scripts/fleet/discovery.ts";

// scrubSlug is the redaction-critical piece: it keeps a private repo's
// slug and bare name out of captured error text that both selectors print
// into publicly readable logs. Its tests are adversarial on purpose.
describe("scrubSlug", () => {
  const SLUG = "Vivswan/hidden-server";
  const HINT = "h**-s**r";

  test("a slug embedded in a URL is scrubbed to the hint", () => {
    const detail = "fatal: repository 'https://github.com/Vivswan/hidden-server.git/' not found";
    const scrubbed = scrubSlug(detail, SLUG, HINT);
    expect(scrubbed).toBe("fatal: repository 'https://github.com/h**-s**r.git/' not found");
    expect(scrubbed).not.toContain("hidden-server");
  });

  test("a bare name inside a git error is scrubbed", () => {
    const scrubbed = scrubSlug("error: failed to push some refs to hidden-server", SLUG, HINT);
    expect(scrubbed).toBe("error: failed to push some refs to h**-s**r");
  });

  test("every occurrence goes: repeated slugs and bare names alike", () => {
    const detail =
      "Vivswan/hidden-server: fetch of hidden-server failed; retrying hidden-server, then Vivswan/hidden-server again";
    const scrubbed = scrubSlug(detail, SLUG, HINT);
    expect(scrubbed).not.toContain("hidden-server");
    expect(scrubbed.split(HINT)).toHaveLength(5);
  });

  test("a name embedded in a longer token is still masked (substring semantics)", () => {
    expect(scrubSlug("branch hidden-server-backup rejected", SLUG, HINT)).toBe(
      "branch h**-s**r-backup rejected",
    );
  });

  test("every casing of the slug and bare name is scrubbed", () => {
    // GitHub identity is case-insensitive: error text may echo a casing
    // other than discovery's canonical full_name (a redirect, a tool that
    // lowercases URLs), and each variant is as private as the original.
    const scrubbed = scrubSlug(
      "GET https://api.github.com/repos/other/shared-private: 502; SHARED-PRIVATE is unreachable, Shared-Private retried",
      "Other/Shared-Private",
      "S**-P**e",
    );
    expect(scrubbed).toBe(
      "GET https://api.github.com/repos/S**-P**e: 502; S**-P**e is unreachable, S**-P**e retried",
    );
  });

  test("regex metacharacters in a slug are treated literally", () => {
    expect(
      scrubSlug("cannot read Vivswan/dotted.repo today", "Vivswan/dotted.repo", "d**.r**"),
    ).toBe("cannot read d**.r** today");
    // The "." must not match arbitrary characters: an unrelated name one
    // character apart stays untouched.
    const near = "cannot read Vivswan/dottedXrepo today";
    expect(scrubSlug(near, "Vivswan/dotted.repo", "d**.r**")).toBe(near);
  });

  test("a no-op when the display IS the slug: the bare name must not expand into the slug", () => {
    const detail = "push to hidden-server rejected";
    expect(scrubSlug(detail, SLUG, SLUG)).toBe(detail);
  });

  test("a slug without an owner segment scrubs as its own bare name", () => {
    expect(scrubSlug("cloning monorepo into monorepo", "monorepo", "m**o")).toBe(
      "cloning m**o into m**o",
    );
  });
});

// The notice builders replaced inline literals in both selectors; these
// pin the emitted text byte-for-byte to the pre-extraction strings.
describe("notice builders", () => {
  test("pushProbeSkipNotice matches the selectors' shared literal exactly", () => {
    expect(pushProbeSkipNotice("h**-l**d", 403)).toBe(
      "h**-l**d: skipped - the fleet token has no write access (push probe HTTP 403). Grant the REPO_PLATFORM_TOKEN access to this repository to enroll it, or add it to repos.yml's exclude list to silence this.",
    );
  });

  test("notAdoptedNotice without a consequence matches the sync selector's literal exactly", () => {
    expect(notAdoptedNotice("Vivswan/unadopted")).toBe(
      "Vivswan/unadopted: skipped - no .repo-platform.yml on its default branch, so it has not adopted the template. Generate it with copier (see the repo-platform README) to opt in, or add it to repos.yml's exclude list to silence this.",
    );
  });

  test("notAdoptedNotice with the settings consequence matches that selector's literal exactly", () => {
    expect(
      notAdoptedNotice(
        "Vivswan/unadopted",
        "If it carries .github/settings.yml, the central nightly heal no longer applies it.",
      ),
    ).toBe(
      "Vivswan/unadopted: skipped - no .repo-platform.yml on its default branch, so it has not adopted the template. If it carries .github/settings.yml, the central nightly heal no longer applies it. Generate it with copier (see the repo-platform README) to opt in, or add the repo to repos.yml's exclude list to silence this.",
    );
  });
});

describe("readDispatchRepo", () => {
  const root = mkdtempSync(join(tmpdir(), "discovery-dispatch-"));

  function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test("ONLY_REPO is trimmed and case-folded", () => {
    withEnv({ ONLY_REPO: "  Vivswan/Steady  ", GITHUB_EVENT_PATH: "" }, () => {
      expect(readDispatchRepo()).toBe("vivswan/steady");
    });
  });

  test("a bare name gets the owner prefixed before folding", () => {
    withEnv({ ONLY_REPO: "Central-Home", GITHUB_EVENT_PATH: "" }, () => {
      expect(readDispatchRepo("Vivswan")).toBe("vivswan/central-home");
    });
  });

  test("without an owner a bare name stays bare (the sync selector's contract)", () => {
    withEnv({ ONLY_REPO: "Central-Home", GITHUB_EVENT_PATH: "" }, () => {
      expect(readDispatchRepo()).toBe("central-home");
    });
  });

  test("a slug input is never owner-prefixed", () => {
    withEnv({ ONLY_REPO: "Other/Shared-Private", GITHUB_EVENT_PATH: "" }, () => {
      expect(readDispatchRepo("Vivswan")).toBe("other/shared-private");
    });
  });

  test("an empty ONLY_REPO falls back to the event payload's repo input", () => {
    const eventFile = join(root, "event.json");
    writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/Hidden-Server" } }));
    withEnv({ ONLY_REPO: "", GITHUB_EVENT_PATH: eventFile }, () => {
      expect(readDispatchRepo()).toBe("vivswan/hidden-server");
    });
  });

  test("a non-empty ONLY_REPO overrides the event payload", () => {
    const eventFile = join(root, "event-overridden.json");
    writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/from-event" } }));
    withEnv({ ONLY_REPO: "Vivswan/from-env", GITHUB_EVENT_PATH: eventFile }, () => {
      expect(readDispatchRepo()).toBe("vivswan/from-env");
    });
  });

  test("an event payload without a repo input reads as empty", () => {
    const eventFile = join(root, "event-empty.json");
    writeFileSync(eventFile, JSON.stringify({ inputs: {} }));
    withEnv({ ONLY_REPO: "", GITHUB_EVENT_PATH: eventFile }, () => {
      expect(readDispatchRepo()).toBe("");
    });
  });

  test("a null inputs key reads as empty (an inputs-less API dispatch)", () => {
    const eventFile = join(root, "event-null-inputs.json");
    writeFileSync(eventFile, JSON.stringify({ inputs: null }));
    withEnv({ ONLY_REPO: "", GITHUB_EVENT_PATH: eventFile }, () => {
      expect(readDispatchRepo()).toBe("");
    });
  });

  test("a payload without an inputs key reads as empty (schedule and release events)", () => {
    const eventFile = join(root, "event-no-inputs.json");
    writeFileSync(eventFile, JSON.stringify({ action: "published" }));
    withEnv({ ONLY_REPO: "", GITHUB_EVENT_PATH: eventFile }, () => {
      expect(readDispatchRepo()).toBe("");
    });
  });

  // The malformed cases exit the process (parseWith), so they run behind
  // a subprocess entry file.
  const dispatchEntry = join(root, "dispatch_entry.ts");
  writeFileSync(
    dispatchEntry,
    [
      `import { readDispatchRepo } from ${JSON.stringify(
        join(import.meta.dir, "../../.github/scripts/fleet/discovery.ts"),
      )};`,
      "console.log(JSON.stringify(readDispatchRepo()));",
      "",
    ].join("\n"),
  );

  function runDispatch(eventBody: string, name: string) {
    const eventFile = join(root, `event-${name}.json`);
    writeFileSync(eventFile, eventBody);
    const proc = Bun.spawnSync(["bun", dispatchEntry], {
      env: { ...process.env, ONLY_REPO: "", GITHUB_EVENT_PATH: eventFile },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  }

  test("a wrong-typed repo input fails loudly, naming the path but never the value", () => {
    const r = runDispatch(JSON.stringify({ inputs: { repo: 31337 } }), "wrong-type");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("::error::readDispatchRepo: event payload: unexpected shape");
    expect(r.stdout).toContain("inputs.repo");
    expect(r.stdout + r.stderr).not.toContain("31337");
  });

  test("a non-object payload fails loudly instead of miscasting", () => {
    const r = runDispatch(JSON.stringify("Vivswan/hidden-server"), "non-object");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("::error::readDispatchRepo: event payload: unexpected shape");
    expect(r.stdout + r.stderr).not.toContain("hidden-server");
  });

  test("an unparseable payload fails with a value-free diagnostic (no SyntaxError echo)", () => {
    // A truncated event file still carries the private slug; a raw
    // JSON.parse SyntaxError would echo a fragment of it.
    const r = runDispatch('{"inputs": {"repo": "Vivswan/hidden-serv', "truncated");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("::error::readDispatchRepo: event payload: not valid JSON");
    expect(r.stdout + r.stderr).not.toContain("hidden-serv");
  });

  test("nothing set reads as empty, and an owner never prefixes an empty input", () => {
    withEnv({ ONLY_REPO: "", GITHUB_EVENT_PATH: "" }, () => {
      expect(readDispatchRepo("Vivswan")).toBe("");
    });
  });
});

// discoverWritableRepos and runStage exit the process on failure, so both
// run behind a subprocess entry file with a stub gh on PATH.
describe("discoverWritableRepos and runStage", () => {
  const root = mkdtempSync(join(tmpdir(), "discovery-proc-"));
  const bin = join(root, "bin");
  const discoveryPath = join(import.meta.dir, "../../.github/scripts/fleet/discovery.ts");

  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      'if [ -n "$STUB_FAIL" ]; then',
      '  echo "gh: discovery boom" >&2',
      "  exit 7",
      "fi",
      'cat "$STUB_PAYLOAD"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const discoverEntry = join(root, "discover_entry.ts");
  writeFileSync(
    discoverEntry,
    [
      `import { discoverWritableRepos } from ${JSON.stringify(discoveryPath)};`,
      'const repos = discoverWritableRepos("discovery.test: user/repos response");',
      "console.log(JSON.stringify(repos.map((repo) => repo.full_name)));",
      "",
    ].join("\n"),
  );

  function runDiscover(extra: Record<string, string>) {
    const proc = Bun.spawnSync(["bun", discoverEntry], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  }

  function repoEntry(full_name: string, overrides: Record<string, unknown> = {}) {
    return {
      full_name,
      archived: false,
      private: true,
      owner: { login: full_name.split("/")[0] },
      permissions: { push: true },
      ...overrides,
    };
  }

  test("keeps writable non-archived repos across pages and owners, drops the rest", () => {
    const payload = join(root, "pages.json");
    writeFileSync(
      payload,
      JSON.stringify([
        [
          repoEntry("Vivswan/keep"),
          repoEntry("Vivswan/archived-out", { archived: true }),
          repoEntry("Vivswan/read-only", { permissions: { push: false } }),
          repoEntry("Vivswan/no-permissions", { permissions: undefined }),
        ],
        [repoEntry("Other/cross-owner"), repoEntry("Vivswan/pub", { private: false })],
      ]),
    );
    const r = runDiscover({ STUB_PAYLOAD: payload });
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["Vivswan/keep", "Other/cross-owner", "Vivswan/pub"]);
  });

  test("a failed listing exits with gh's code and passes its stderr through", () => {
    const r = runDiscover({ STUB_FAIL: "1", STUB_PAYLOAD: "/dev/null" });
    expect(r.exitCode).toBe(7);
    expect(r.stderr).toContain("gh: discovery boom");
    expect(r.stdout).toBe("");
  });

  test("a malformed payload fails loudly with the caller's label, never a value", () => {
    const payload = join(root, "malformed.json");
    writeFileSync(payload, JSON.stringify([[{ full_name: "Vivswan/shapeless" }]]));
    const r = runDiscover({ STUB_PAYLOAD: payload });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("::error::discovery.test: user/repos response: unexpected shape");
    expect(r.stdout + r.stderr).not.toContain("shapeless");
  });

  test("an unparseable listing fails with a value-free diagnostic (no SyntaxError echo)", () => {
    // A truncated gh response still carries slugs; a raw JSON.parse
    // SyntaxError would echo a fragment of the offending text.
    const payload = join(root, "truncated.json");
    writeFileSync(payload, '[[{"full_name": "Vivswan/hidden-serv');
    const r = runDiscover({ STUB_PAYLOAD: payload });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("::error::discovery.test: user/repos response: not valid JSON");
    expect(r.stdout + r.stderr).not.toContain("hidden-serv");
  });

  const stageEntry = join(root, "stage_entry.ts");
  writeFileSync(
    stageEntry,
    [
      `import { runStage } from ${JSON.stringify(discoveryPath)};`,
      'runStage(JSON.parse(process.env.STAGE_CMD ?? "[]"), process.env.STAGE_OUT ?? "");',
      'console.log("after-stage");',
      "",
    ].join("\n"),
  );

  function runStageEntry(command: string[], outFile: string) {
    const proc = Bun.spawnSync(["bun", stageEntry], {
      env: { ...process.env, STAGE_CMD: JSON.stringify(command), STAGE_OUT: outFile },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  }

  test("runStage tees the stage's stdout to the out file and continues", () => {
    const outFile = join(root, "stage-ok.json");
    const r = runStageEntry(["bun", "-e", "console.log('stage-out')"], outFile);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(outFile, "utf-8")).toBe("stage-out\n");
    expect(r.stdout).toContain("after-stage");
  });

  test("a failing stage forwards its captured stdout and exits with the stage's code", () => {
    // The runner only parses workflow commands from stdout, so a failing
    // stage's ::error:: lines must be written through before exiting.
    const outFile = join(root, "stage-fail.json");
    writeFileSync(outFile, "");
    const r = runStageEntry(
      [
        "bun",
        "-e",
        "console.log('::error::stage-failed'); console.error('stage-diagnostic'); process.exit(3)",
      ],
      outFile,
    );
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain("::error::stage-failed");
    expect(r.stderr).toContain("stage-diagnostic");
    expect(r.stdout).not.toContain("after-stage");
    expect(readFileSync(outFile, "utf-8")).toBe("");
  });
});

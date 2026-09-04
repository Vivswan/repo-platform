import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureNetwork,
  NETWORK_TIMEOUT_MS,
  notAdoptedNotice,
  pushProbeSkipNotice,
  readDispatchRepo,
  scrubSlug,
} from "../../.github/scripts/fleet/discovery.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

// captureNetwork is the fleet's hang backstop: every gh/curl subprocess in
// the plan jobs goes through it, so a stalled network fails the run at the
// deadline instead of blocking until the runner's own job timeout.
describe("captureNetwork", () => {
  test("passes the deadline through to the proc layer: a hung command dies at expiry", () => {
    const started = Date.now();
    const result = captureNetwork(["sleep", "31337"], 250);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    // The SIGKILLed child prints nothing, so the synthesized stderr line
    // is the only trace of the deadline. It must name the program but
    // never the argv tail: real tails carry private slugs and, for the
    // curl push probe, the PAT itself.
    expect(result.stderr).toContain("sleep timed out after 250ms (stalled network?)");
    expect(result.stderr).not.toContain("31337");
  });

  test("a command that answers in time is untouched by the deadline", () => {
    const result = captureNetwork(["echo", "ok"]);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).toBe("");
  });

  test("the production deadline is two minutes (guards against a ms/s unit slip)", () => {
    expect(NETWORK_TIMEOUT_MS).toBe(120_000);
  });

  test("every fleet gh/curl subprocess goes through captureNetwork (class sweep)", () => {
    // A bare capture/spawnSync around a gh or curl argv reintroduces the
    // unbounded-hang class this helper closed; new network calls must
    // carry the deadline too.
    const BARE = /\b(?:capture|mustCapture|spawnSync)\(\s*\[\s*"(?:gh|curl)"/g;
    // The sweep's own controls: an empty offender list is evidence only
    // if the pattern catches the offender shapes and the scan reaches the
    // real call sites.
    const catches = (line: string) => new RegExp(BARE.source).test(line);
    expect(catches('capture(["gh", "api", "user"])')).toBe(true);
    expect(catches('mustCapture(["gh", "api"])')).toBe(true);
    expect(catches('spawnSync([ "curl", "-sS"])')).toBe(true);
    expect(catches('captureNetwork(["gh", "api"])')).toBe(false);

    const dir = join(import.meta.dir, "../../.github/scripts/fleet");
    const offenders: string[] = [];
    let bounded = 0;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".ts")) continue;
      const source = readFileSync(join(dir, entry), "utf-8");
      bounded += source.match(/\bcaptureNetwork\(\s*\[\s*"(?:gh|curl)"/g)?.length ?? 0;
      const bare = source.match(BARE);
      for (const match of bare ?? []) offenders.push(`${entry}: ${match.replace(/\s+/g, " ")}`);
    }
    expect(offenders).toEqual([]);
    // The scan read the scripts that make network calls, not an empty or
    // misaddressed directory.
    expect(bounded).toBeGreaterThan(0);
  });
});

// scrubSlug is the redaction-critical piece: it keeps a private repo's
// slug and bare name out of captured error text that both selectors print
// into publicly readable logs. Its tests are adversarial on purpose.
describe("scrubSlug", () => {
  const SLUG = "Vivswan/hidden-server";
  const HINT = "h**-s**r";

  test.each([
    {
      reason: "a slug embedded in a URL is scrubbed to the hint",
      detail: "fatal: repository 'https://github.com/Vivswan/hidden-server.git/' not found",
      slug: SLUG,
      hint: HINT,
      expected: "fatal: repository 'https://github.com/h**-s**r.git/' not found",
    },
    {
      reason: "a bare name inside a git error is scrubbed",
      detail: "error: failed to push some refs to hidden-server",
      slug: SLUG,
      hint: HINT,
      expected: "error: failed to push some refs to h**-s**r",
    },
    {
      reason: "every occurrence goes: repeated slugs and bare names alike",
      detail:
        "Vivswan/hidden-server: fetch of hidden-server failed; retrying hidden-server, then Vivswan/hidden-server again",
      slug: SLUG,
      hint: HINT,
      expected: "h**-s**r: fetch of h**-s**r failed; retrying h**-s**r, then h**-s**r again",
    },
    {
      reason: "a name embedded in a longer token is still masked (substring semantics)",
      detail: "branch hidden-server-backup rejected",
      slug: SLUG,
      hint: HINT,
      expected: "branch h**-s**r-backup rejected",
    },
    {
      // GitHub identity is case-insensitive: error text may echo a casing
      // other than discovery's canonical full_name (a redirect, a tool that
      // lowercases URLs), and each variant is as private as the original.
      reason: "every casing of the slug and bare name is scrubbed",
      detail:
        "GET https://api.github.com/repos/other/shared-private: 502; SHARED-PRIVATE is unreachable, Shared-Private retried",
      slug: "Other/Shared-Private",
      hint: "S**-P**e",
      expected:
        "GET https://api.github.com/repos/S**-P**e: 502; S**-P**e is unreachable, S**-P**e retried",
    },
    {
      reason: "regex metacharacters in a slug are treated literally",
      detail: "cannot read Vivswan/dotted.repo today",
      slug: "Vivswan/dotted.repo",
      hint: "d**.r**",
      expected: "cannot read d**.r** today",
    },
    {
      // The control for the row above: the "." must not match arbitrary
      // characters, so an unrelated name one character apart stays untouched.
      reason: "a near-miss of a metacharacter slug is left alone",
      detail: "cannot read Vivswan/dottedXrepo today",
      slug: "Vivswan/dotted.repo",
      hint: "d**.r**",
      expected: "cannot read Vivswan/dottedXrepo today",
    },
    {
      reason: "a no-op when the display IS the slug: the bare name must not expand into the slug",
      detail: "push to hidden-server rejected",
      slug: SLUG,
      hint: SLUG,
      expected: "push to hidden-server rejected",
    },
    {
      reason: "a slug without an owner segment scrubs as its own bare name",
      detail: "cloning monorepo into monorepo",
      slug: "monorepo",
      hint: "m**o",
      expected: "cloning m**o into m**o",
    },
  ])("$reason", ({ detail, slug, hint, expected }) => {
    expect(scrubSlug(detail, slug, hint)).toBe(expected);
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

  test.each([
    {
      reason: "ONLY_REPO is trimmed and case-folded",
      onlyRepo: "  Vivswan/Steady  ",
      eventBody: undefined,
      owner: undefined,
      expected: "vivswan/steady",
    },
    {
      reason: "a bare name gets the owner prefixed before folding",
      onlyRepo: "Central-Home",
      eventBody: undefined,
      owner: "Vivswan",
      expected: "vivswan/central-home",
    },
    {
      reason: "without an owner a bare name stays bare (the sync selector's contract)",
      onlyRepo: "Central-Home",
      eventBody: undefined,
      owner: undefined,
      expected: "central-home",
    },
    {
      reason: "a slug input is never owner-prefixed",
      onlyRepo: "Other/Shared-Private",
      eventBody: undefined,
      owner: "Vivswan",
      expected: "other/shared-private",
    },
    {
      reason:
        "a comma list is trimmed and owner-prefixed per entry; empties survive for the registry to reject",
      onlyRepo: " Central-Home, Other/Shared ,,Vivswan/Third, ",
      eventBody: undefined,
      owner: "Vivswan",
      expected: "vivswan/central-home,other/shared,,vivswan/third,",
    },
    {
      reason: "a lone comma is not an empty scope",
      onlyRepo: ",",
      eventBody: undefined,
      owner: "Vivswan",
      expected: ",",
    },
    {
      reason: "a list from the event payload folds the same way",
      onlyRepo: "",
      eventBody: JSON.stringify({ inputs: { repo: "Vivswan/A,Vivswan/B" } }),
      owner: undefined,
      expected: "vivswan/a,vivswan/b",
    },
    {
      reason: "an empty ONLY_REPO falls back to the event payload's repo input",
      onlyRepo: "",
      eventBody: JSON.stringify({ inputs: { repo: "Vivswan/Hidden-Server" } }),
      owner: undefined,
      expected: "vivswan/hidden-server",
    },
    {
      reason: "a non-empty ONLY_REPO overrides the event payload",
      onlyRepo: "Vivswan/from-env",
      eventBody: JSON.stringify({ inputs: { repo: "Vivswan/from-event" } }),
      owner: undefined,
      expected: "vivswan/from-env",
    },
    {
      reason: "an event payload without a repo input reads as empty",
      onlyRepo: "",
      eventBody: JSON.stringify({ inputs: {} }),
      owner: undefined,
      expected: "",
    },
    {
      reason: "a null inputs key reads as empty (an inputs-less API dispatch)",
      onlyRepo: "",
      eventBody: JSON.stringify({ inputs: null }),
      owner: undefined,
      expected: "",
    },
    {
      reason: "a payload without an inputs key reads as empty (schedule and release events)",
      onlyRepo: "",
      eventBody: JSON.stringify({ action: "published" }),
      owner: undefined,
      expected: "",
    },
    {
      reason: "nothing set reads as empty, and an owner never prefixes an empty input",
      onlyRepo: "",
      eventBody: undefined,
      owner: "Vivswan",
      expected: "",
    },
  ])("$reason", ({ onlyRepo, eventBody, owner, expected }) => {
    let eventPath = "";
    if (eventBody !== undefined) {
      eventPath = join(root, `event-${Bun.hash(eventBody).toString(16)}.json`);
      writeFileSync(eventPath, eventBody);
    }
    withEnv({ ONLY_REPO: onlyRepo, GITHUB_EVENT_PATH: eventPath }, () => {
      expect(readDispatchRepo(owner)).toBe(expected);
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
    const proc = boundedSpawnSync(["bun", dispatchEntry], {
      env: { ...process.env, ONLY_REPO: "", GITHUB_EVENT_PATH: eventFile },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout,
      stderr: proc.stderr,
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
    // A bare identifier is the leaking form: Bun's raw JSON.parse error
    // echoes it ('Unexpected identifier "hiddenserver"'), so this pins
    // that parseJsonWith's fixed diagnostic replaces it.
    const r = runDispatch('{"inputs": {"repo": hiddenserver}}', "unparseable");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("::error::readDispatchRepo: event payload: not valid JSON");
    expect(r.stdout + r.stderr).not.toContain("hiddenserver");
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
    const proc = boundedSpawnSync(["bun", discoverEntry], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout,
      stderr: proc.stderr,
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
    // A bare identifier is the leaking form: Bun's raw JSON.parse error
    // echoes it ('Unexpected identifier "hiddenserver"'), so this pins
    // that parseJsonWith's fixed diagnostic replaces it.
    const payload = join(root, "unparseable.json");
    writeFileSync(payload, '[[{"full_name": hiddenserver}]]');
    const r = runDiscover({ STUB_PAYLOAD: payload });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("::error::discovery.test: user/repos response: not valid JSON");
    expect(r.stdout + r.stderr).not.toContain("hiddenserver");
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
    const proc = boundedSpawnSync(["bun", stageEntry], {
      env: { ...process.env, STAGE_CMD: JSON.stringify(command), STAGE_OUT: outFile },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout,
      stderr: proc.stderr,
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

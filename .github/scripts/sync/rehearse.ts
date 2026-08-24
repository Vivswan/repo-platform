#!/usr/bin/env bun
// Local rehearsal of one managed repo's sync PR: clones the target shallow
// into /tmp, assembles a build tree from THIS working tree (uncommitted
// template changes included), commits it as a synthetic templates/v99.99.99
// release chained onto the target's recorded _commit, and runs the legs
// reusable-template-sync.yml runs - module selection, copier update (which
// executes due migrations via copier.yml's _migrations; the synthetic
// release version gives them a parseable target even for staging-channel
// repos), conflict resolution, retired-file cleanup, the repo-owned
// preserve step, the manifest license check, and validation - then prints
// the resulting diff and the would-be PR-body sections.
//
// READ-ONLY against the remote: the only network operations are the target
// clone and the build-ref fetch. The target clone's push URL is pointed at
// an unroutable value right after cloning, so a push attempt anywhere in
// reused code fails loudly; nothing here opens PRs or writes to any remote.
// The workspace under /tmp is left in place for inspection.
//
// Known parity gaps vs the workflow (this is an operator convenience, not
// a second pipeline): live visibility/description come from the recorded
// copier answers instead of the GitHub API, so out-of-band settings drift
// is not rehearsed; token-scope workflow withholding, hide-details
// redaction, and the PR/auto-merge machinery do not apply locally; and
// validation uses this working tree's validator, not a version-aligned
// release checkout - which is the point when rehearsing unreleased changes.
//
// Usage:
//   bun .github/scripts/sync/rehearse.ts <owner>/<repo>

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { capture, must, mustCapture, passthrough } from "../shared/proc.ts";
import { AnswersFileError, readAnswersFile } from "./answers_file.ts";
import { resolveChannel } from "./resolve_channel.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const REHEARSAL_TAG = "templates/v99.99.99";
// Fresh clones have no committer identity configured.
const GIT_IDENT = ["-c", "user.name=rehearsal", "-c", "user.email=rehearsal@localhost"];

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// Raw stdout, not mustCapture: the copier.yml snapshots must stay
// byte-for-byte, trailing newline included (resolve_refs.ts does the same).
function gitShow(repo: string, revPath: string): string {
  const show = capture(["git", "-C", repo, "show", revPath]);
  if (show.exitCode !== 0) {
    process.stderr.write(show.stderr);
    process.exit(show.exitCode);
  }
  return show.stdout;
}

function main(): number {
  const slug = process.argv[2];
  if (
    slug === undefined ||
    process.argv.length > 3 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)
  ) {
    fail("usage: bun .github/scripts/sync/rehearse.ts <owner>/<repo>");
  }
  if (Bun.which("copier") === null) {
    fail("copier is not on PATH (pipx install copier); the rehearsal runs real copier updates");
  }

  const work = mkdtempSync(`/tmp/rehearse-${slug.replace("/", "-")}-`);
  const targetDir = join(work, "target");
  const platformDir = join(work, "platform");
  const buildDir = join(work, "build-tree");
  const temp = join(work, "temp");
  mkdirSync(temp);

  section(`cloning ${slug} (shallow, read-only)`);
  must(["git", "clone", "--quiet", "--depth", "1", `https://github.com/${slug}.git`, targetDir]);
  // The read-only assertion: any push through this remote fails on the
  // unroutable URL instead of reaching GitHub.
  must([
    "git",
    "-C",
    targetDir,
    "remote",
    "set-url",
    "--push",
    "origin",
    "read-only-rehearsal://never-push",
  ]);
  const origHead = mustCapture(["git", "-C", targetDir, "rev-parse", "HEAD"]);

  for (const file of [".repo-platform.yml", ".copier-answers.yml"]) {
    if (!existsSync(join(targetDir, file))) {
      fail(`${slug} is not managed by repo-platform: ${file} is missing from its default branch`);
    }
  }
  let answers: ReturnType<typeof readAnswersFile>;
  try {
    answers = readAnswersFile(join(targetDir, ".copier-answers.yml"));
  } catch (err) {
    if (!(err instanceof AnswersFileError)) throw err;
    fail(`${slug}'s .copier-answers.yml: ${err.message}`);
  }
  const channel = resolveChannel("", answers);
  if (typeof channel !== "string") {
    fail(`${slug} records an unknown channel '${channel.invalid}'; fix .copier-answers.yml`);
  }
  if (answers.commit === "") {
    fail(`${slug}'s .copier-answers.yml records no _commit; there is no base to update from`);
  }
  // Recorded answers stand in for the workflow's live API read (parity gap
  // in the header): the render still gets real per-repo values.
  const privateAnswer = answers.fields.private === true ? "true" : "false";
  const description =
    typeof answers.fields.description === "string" ? answers.fields.description : "";

  section("fetching build refs and assembling the rehearsal release");
  must(["git", "init", "--quiet", platformDir]);
  const originUrl = mustCapture(["git", "-C", REPO_ROOT, "remote", "get-url", "origin"]);
  // The build branches and templates/v* tags live only on origin, never in
  // this checkout. Best-effort per ref: a fleet missing one of them (no
  // release yet, say) can still rehearse as long as _commit resolves.
  for (const refspec of [
    "+refs/heads/staging:refs/heads/staging",
    "+refs/heads/latest:refs/heads/latest",
    "+refs/tags/templates/*:refs/tags/templates/*",
  ]) {
    capture(["git", "-C", platformDir, "fetch", "--quiet", originUrl, refspec]);
  }
  const oldShaProbe = capture([
    "git",
    "-C",
    platformDir,
    "rev-parse",
    "--verify",
    "--quiet",
    `${answers.commit}^{commit}`,
  ]);
  if (oldShaProbe.exitCode !== 0) {
    fail(
      `${slug}'s recorded _commit '${answers.commit}' does not resolve on ${originUrl}'s build refs; ` +
        "the real sync would need recover=recopy, which this rehearsal does not model",
    );
  }
  const oldSha = oldShaProbe.stdout.trim();

  must(
    [
      "bun",
      ".github/scripts/build-branches/branch_tree.ts",
      "--dest",
      buildDir,
      "--channel",
      "latest",
      "--version",
      "v99.99.99",
    ],
    { cwd: REPO_ROOT },
  );
  // Chain the rehearsal build onto the recorded base, mirroring the real
  // append-only build branches (ci/upgrade_path_test.sh does the same):
  // copier's downgrade check orders unparseable refs by dunamai's
  // commit-count fallback, so the new commit must descend from the old.
  capture(["git", "-C", platformDir, "tag", "-d", REHEARSAL_TAG]);
  must(["git", "-C", platformDir, "checkout", "--quiet", "--detach", oldSha]);
  for (const entry of readdirSync(platformDir)) {
    if (entry !== ".git") rmSync(join(platformDir, entry), { recursive: true, force: true });
  }
  cpSync(buildDir, platformDir, { recursive: true });
  must(["git", "-C", platformDir, "add", "-A"]);
  must([
    "git",
    "-C",
    platformDir,
    ...GIT_IDENT,
    "commit",
    "--quiet",
    "-m",
    `build(rehearsal): ${REHEARSAL_TAG}`,
  ]);
  must(["git", "-C", platformDir, "tag", REHEARSAL_TAG]);

  // The sync's own normalization step, pointed at the local build instead
  // of the canonical source; committed because copier update needs a clean
  // tree (the real sync commits its normalization too).
  must(
    [
      "bun",
      ".github/scripts/sync/normalize_src_path.ts",
      "--answers",
      join(targetDir, ".copier-answers.yml"),
      "--canonical",
      platformDir,
    ],
    { cwd: REPO_ROOT },
  );
  must([
    "git",
    "-C",
    targetDir,
    ...GIT_IDENT,
    "commit",
    "--quiet",
    "-am",
    "rehearsal: point _src_path at the local build",
  ]);

  section("selecting modules");
  const modules = mustCapture(
    [
      "bun",
      ".github/scripts/sync/modules.ts",
      "--repo-file",
      join(targetDir, ".repo-platform.yml"),
      "--template-copier",
      join(buildDir, "copier.yml"),
      "--retired-summary",
      join(temp, "retired-modules.txt"),
    ],
    { cwd: REPO_ROOT },
  );
  console.log(`selected modules: ${modules}`);

  const legEnv = {
    TARGET_DIR: targetDir,
    TARGET_REF: REHEARSAL_TAG,
    MODULES: modules,
    CHANNEL: channel,
    PRIVATE: privateAnswer,
    DESCRIPTION: description,
    RUNNER_TEMP: temp,
    SRC_PATH: platformDir,
    OLD_SHA: oldSha,
    RECOVER: "",
  };

  section("copier update (due migrations run inside, via copier.yml's _migrations)");
  must(["bun", ".github/scripts/sync/apply_update.ts"], { cwd: REPO_ROOT, env: legEnv });
  must(
    [
      "bun",
      ".github/scripts/sync/resolve_copier_conflicts.ts",
      "--summary",
      join(temp, "dropped-local-hunks.md"),
      "--root",
      targetDir,
    ],
    { cwd: REPO_ROOT },
  );

  section("retired-file cleanup");
  writeFileSync(join(temp, "copier-old.yml"), gitShow(platformDir, `${oldSha}:copier.yml`));
  writeFileSync(join(temp, "copier-new.yml"), gitShow(platformDir, `${REHEARSAL_TAG}:copier.yml`));
  must(["bun", ".github/scripts/sync/retired_cleanup.ts"], { cwd: REPO_ROOT, env: legEnv });

  // cwd is the platform repo: the preserve step's fleet-license re-seed
  // resolves TARGET_REF in the cwd's git repository, and the rehearsal tag
  // exists only there.
  must(["bun", join(import.meta.dir, "preserve_repo_owned.ts")], {
    cwd: platformDir,
    env: legEnv,
  });
  must(["bun", join(import.meta.dir, "manifest_license_check.ts")], {
    cwd: REPO_ROOT,
    env: legEnv,
  });

  section("validating the updated tree");
  must(["bun", "install", "--frozen-lockfile", "--silent"], {
    cwd: join(REPO_ROOT, "actions/validate-template"),
  });
  // A failure prints its diagnostics but does not stop the rehearsal: the
  // sync opens the PR on failed validation too, and the diff below is what
  // the operator came for. The exit code carries the verdict at the end.
  const validation = passthrough([
    "bun",
    join(REPO_ROOT, "actions/validate-template/validate_generated_files.ts"),
    targetDir,
  ]);

  section("resulting diff (the would-be sync PR)");
  must(["git", "-C", targetDir, "add", "-A"]);
  if (capture(["git", "-C", targetDir, "diff", "--cached", "--quiet", origHead]).exitCode === 0) {
    console.log("no changes: the target already matches the rehearsal build");
  } else {
    passthrough(["git", "-C", targetDir, "diff", "--cached", "--stat", origHead]);
    passthrough(["git", "-C", targetDir, "diff", "--cached", origHead]);
  }

  section("would-be PR-body sections");
  const prSections: [string, string][] = [
    ["retired-modules.txt", "Retired modules dropped from the selection"],
    ["removed-paths.txt", "The template retired these files; this update deletes them"],
    [
      "dropped-local-hunks.md",
      "Merge conflicts resolved toward the template (review the dropped local lines)",
    ],
    [
      "license-transition.txt",
      "License files this update deletes (the PR would stay manual-review)",
    ],
    ["manifest-license-warnings.md", "Registry metadata conflicting with the fleet license"],
  ];
  let anySection = false;
  for (const [file, title] of prSections) {
    const path = join(temp, file);
    if (existsSync(path) && statSync(path).size > 0) {
      anySection = true;
      console.log(`\n--- ${title} ---`);
      console.log(readFileSync(path, "utf-8").replace(/\n$/, ""));
    }
  }
  if (!anySection) console.log("(none - nothing here would hold the PR for review)");

  section("rehearsal summary");
  console.log(`validation: ${validation === 0 ? "ok" : "FAILED (diagnostics above)"}`);
  console.log(`workspace kept for inspection: ${work}`);
  console.log(
    "note: the diff's _src_path points at the rehearsal build (the real sync writes the " +
      "canonical source), and live visibility/description came from the recorded answers, " +
      "so out-of-band settings drift is not rehearsed.",
  );
  return validation === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}

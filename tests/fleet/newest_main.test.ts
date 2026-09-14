import { describe, expect, test } from "bun:test";
import { MAIN_REF, supersededBy } from "../../.github/scripts/fleet/newest_main.ts";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

/** A one-commit checkout, like the plan job's, whose origin is a bare repository holding main at the run's commit. */
function fixture(): { work: string; origin: string; sha: string } {
  const origin = temp.dir("newest-main-origin-");
  fixtureGit(origin, ["init", "--quiet", "--bare", "-b", "main"]);
  const work = temp.dir("newest-main-work-");
  fixtureGit(work, ["init", "--quiet", "-b", "main"]);
  fixtureGit(work, ["config", "user.name", "t"]);
  fixtureGit(work, ["config", "user.email", "t@t.test"]);
  fixtureGit(work, ["commit", "--quiet", "--allow-empty", "-m", "judged"]);
  fixtureGit(work, ["remote", "add", "origin", origin]);
  fixtureGit(work, ["push", "--quiet", "origin", "main"]);
  return { work, origin, sha: fixtureGit(work, ["rev-parse", "HEAD"]) };
}

describe("supersededBy", () => {
  test("main's tip decides: the run's own commit is newest, a moved main supersedes it", () => {
    const { work, sha } = fixture();
    const options = { cwd: work, env: fixtureGitEnv() };
    expect(supersededBy(sha, options)).toBe(null);

    fixtureGit(work, ["commit", "--quiet", "--allow-empty", "-m", "newer"]);
    fixtureGit(work, ["push", "--quiet", "origin", "main"]);
    expect(supersededBy(sha, options)).toBe(fixtureGit(work, ["rev-parse", "HEAD"]));
  });

  test("an absent main and a failed look throw, never 'newest' or 'superseded'", () => {
    const { work, origin, sha } = fixture();
    const options = { cwd: work, env: fixtureGitEnv() };
    fixtureGit(origin, ["update-ref", "-d", MAIN_REF]);
    expect(() => supersededBy(sha, options)).toThrow(
      `origin holds no ${MAIN_REF}; refusing to guess which run is newest`,
    );

    fixtureGit(work, ["remote", "set-url", "origin", `${work}/missing.git`]);
    expect(() => supersededBy(sha, options)).toThrow(
      "git ls-remote could not answer (exit 128); refusing to guess: fatal: ",
    );
  });
});

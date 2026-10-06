// GitHub's answers are GitHub's: a ref read is 200 with `object.sha`, 404 for none; a compare `status` is ahead, behind,
// identical, or diverged, 404 for a base commit the repository no longer holds; a ref write is 201 (create), 200
// (update), or 422 when GitHub refuses it (a fast-forward that is not one, a ref that already exists, an invalid name).
// Nothing in-house holds those shapes, and the pages leg gates on `proceed == 'true'` while the job's color reads the
// exit: a run behind the record must leave `false` at exit 0 (a green stand-down), a run ahead, equal, or first must
// leave `true`, a lost record race must write nothing, and an unreadable answer must leave no verdict and a red step.
// The script is executed against a GitHub stand-in answering each way, with the requests it sends pinned beside the
// whole outcome.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { type Reply as Served, spawnGithubStub } from "../../shared/github_stub";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/apply-forward/apply_forward.ts");
const TOKEN = "stub-token";
// Synthetic commits: this run's, the one the record names, and one a racing newer run records.
const SHA = "5e".repeat(20);
const RECORDED = "d0".repeat(20);
const NEWER = "a1".repeat(20);
const SHORT = (sha: string) => sha.slice(0, 12);
const REF = "refs/platform/applied/pages";

const REF_PATH = "/repos/o/r/git/ref/platform/applied/pages";
const REFS_PATH = "/repos/o/r/git/refs";
const READ = ["GET", REF_PATH];
const compareOf = (base: string) => ["GET", `/repos/o/r/compare/${base}...${SHA}`];
const COMPARE = compareOf(RECORDED);
const CREATE = ["POST", REFS_PATH, `{"ref":"${REF}","sha":"${SHA}"}`];
const update = (force: boolean) => [
  "PATCH",
  `${REFS_PATH}/platform/applied/pages`,
  `{"sha":"${SHA}","force":${force}}`,
];
const SERVER_ERROR = '{"message":"Server Error","status":"500"}';
const NOT_FOUND = '{"message":"Not Found","status":"404"}';
const NOT_FAST_FORWARD = '{"message":"Update is not a fast forward","status":"422"}';

/** One request kind's answer: the first call's, and optionally a different one from the second call on. */
interface Reply {
  status?: number;
  body?: string;
  againStatus?: number;
  again?: string;
}

interface Answers {
  mode: "check" | "record";
  ref?: Reply;
  compare?: Reply;
  write?: Reply;
}

const replies = (given: Reply | undefined, status: number, body: string): [Served, ...Served[]] => {
  const first = { status: given?.status ?? status, body: given?.body ?? body };
  return given?.againStatus === undefined
    ? [first]
    : [first, { status: given.againStatus, body: given.again ?? "" }];
};

const judged = async (answers: Answers) => {
  const root = temp.dir("apply-forward-");
  // The create and the update share one reply sequence: the re-write after a refused create is an update.
  const github = await spawnGithubStub(root, [
    { requests: [`GET ${REF_PATH}`], replies: replies(answers.ref, 404, NOT_FOUND) },
    { requests: ["GET /repos/o/r/compare/"], replies: replies(answers.compare, 200, "") },
    {
      requests: [`POST ${REFS_PATH}`, `PATCH ${REFS_PATH}/platform/applied/pages`],
      replies: replies(answers.write, answers.ref?.body === undefined ? 201 : 200, ""),
    },
  ]);
  const output = join(root, "output");
  writeFileSync(output, "");
  let run: ReturnType<typeof boundedSpawnSync>;
  try {
    run = boundedSpawnSync([process.execPath, SCRIPT], {
      env: {
        GITHUB_API_URL: github.host,
        GH_TOKEN: TOKEN,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "o/r",
        MODE: answers.mode,
        LEG: "pages",
        SHA,
      },
    });
  } finally {
    github.stop();
  }
  const calls = github.calls();
  for (const call of calls) {
    expect([call.authorization, call.accept, call.contentType]).toEqual([
      `Bearer ${TOKEN}`,
      "application/vnd.github+json",
      call.method === "GET" ? null : "application/json",
    ]);
  }
  return {
    exitCode: run.exitCode,
    stdout: run.stdout,
    output: readFileSync(output, "utf8"),
    calls: calls.map(({ method, path, body }) =>
      body === "" ? [method, path] : [method, path, body],
    ),
  };
};

const names = (sha: string): Reply => ({
  status: 200,
  body: `{"ref":"${REF}","object":{"sha":"${sha}","type":"commit"}}`,
});
const compared = (status: string): Reply => ({
  body: `{"status":"${status}","ahead_by":2,"behind_by":0}`,
});
const green = (proceed: boolean, recorded: string, notice: string | null, calls: string[][]) => ({
  exitCode: 0,
  stdout: notice === null ? "" : `::notice::${notice}\n`,
  output: `proceed=${proceed}\nrecorded=${recorded}\n`,
  calls,
});
const red = (message: string, calls: string[][]) => ({
  exitCode: 1,
  stdout: `::error::${message}\n`,
  output: "",
  calls,
});
const SUPERSEDED = `a newer run recorded ${SHORT(NEWER)} ahead of this run's ${SHORT(SHA)}; the record stands`;

describe("apply_forward.ts", () => {
  test.each<{ reason: string; answers: Answers; outcome: Awaited<ReturnType<typeof judged>> }>([
    {
      reason: "check: no record yet proceeds, one request",
      answers: { mode: "check" },
      outcome: green(true, "", null, [READ]),
    },
    {
      reason: "check: the record is this commit (a rebuild) proceeds, no compare",
      answers: { mode: "check", ref: names(SHA) },
      outcome: green(true, SHA, null, [READ]),
    },
    {
      reason: "check: a record behind this commit (an ancestor) proceeds",
      answers: { mode: "check", ref: names(RECORDED), compare: compared("ahead") },
      outcome: green(true, RECORDED, null, [READ, COMPARE]),
    },
    {
      reason: "check: a record ahead of this commit stands down green, naming both",
      answers: { mode: "check", ref: names(RECORDED), compare: compared("behind") },
      outcome: green(
        false,
        RECORDED,
        `superseded: pages last applied ${SHORT(RECORDED)}, which is ahead of this run's ${SHORT(SHA)}; nothing to apply here`,
        [READ, COMPARE],
      ),
    },
    {
      reason: "check: a record off this history (diverged) proceeds with a notice",
      answers: { mode: "check", ref: names(RECORDED), compare: compared("diverged") },
      outcome: green(
        true,
        RECORDED,
        `pages last applied ${SHORT(RECORDED)}, which is off this history; applying ${SHORT(SHA)}`,
        [READ, COMPARE],
      ),
    },
    {
      reason:
        "check: a recorded commit the repository no longer holds (compare 404) proceeds with a notice",
      answers: {
        mode: "check",
        ref: names(RECORDED),
        compare: { status: 404, body: NOT_FOUND },
      },
      outcome: green(
        true,
        RECORDED,
        `pages last applied ${SHORT(RECORDED)}, which is off this history; applying ${SHORT(SHA)}`,
        [READ, COMPARE],
      ),
    },
    {
      reason: "check: an unreadable record leaves no verdict and a red step",
      answers: { mode: "check", ref: { status: 500, body: SERVER_ERROR } },
      outcome: red(`reading the record answered HTTP 500: ${SERVER_ERROR}`, [READ]),
    },
    {
      reason: "check: a record naming no commit is an error, not a proceed",
      answers: {
        mode: "check",
        ref: { status: 200, body: `{"ref":"${REF}","object":{"type":"commit"}}` },
      },
      outcome: red(`the record names no commit: {"ref":"${REF}","object":{"type":"commit"}}`, [
        READ,
      ]),
    },
    {
      reason: "record: no record yet creates it",
      answers: { mode: "record" },
      outcome: green(true, SHA, null, [READ, CREATE]),
    },
    {
      reason: "record: the record already names this commit writes nothing",
      answers: { mode: "record", ref: names(SHA) },
      outcome: green(true, SHA, null, [READ]),
    },
    {
      reason: "record: a record behind this commit fast-forwards (force false)",
      answers: { mode: "record", ref: names(RECORDED), compare: compared("ahead") },
      outcome: green(true, SHA, null, [READ, COMPARE, update(false)]),
    },
    {
      reason: "record: the race lost before the write (a newer run recorded first) writes nothing",
      answers: { mode: "record", ref: names(NEWER), compare: compared("behind") },
      outcome: green(false, NEWER, SUPERSEDED, [READ, compareOf(NEWER)]),
    },
    {
      reason: "record: a record off this history is moved onto it (force true) with a notice",
      answers: { mode: "record", ref: names(RECORDED), compare: compared("diverged") },
      outcome: green(
        true,
        SHA,
        `pages's record ${SHORT(RECORDED)} is off this history; moving it to ${SHORT(SHA)}`,
        [READ, COMPARE, update(true)],
      ),
    },
    {
      reason:
        "record: the race lost after the read (the fast-forward refused, a newer run's record stands) stands down",
      answers: {
        mode: "record",
        ref: { ...names(RECORDED), againStatus: 200, again: names(NEWER).body },
        compare: { ...compared("ahead"), againStatus: 200, again: compared("behind").body },
        write: { status: 422, body: NOT_FAST_FORWARD },
      },
      outcome: green(false, NEWER, SUPERSEDED, [
        READ,
        COMPARE,
        update(false),
        READ,
        compareOf(NEWER),
      ]),
    },
    {
      reason: "record: a refused create whose record an older run made meanwhile is fast-forwarded",
      answers: {
        mode: "record",
        ref: { againStatus: 200, again: names(RECORDED).body },
        compare: compared("ahead"),
        write: {
          status: 422,
          body: '{"message":"Reference already exists","status":"422"}',
          againStatus: 200,
          again: names(SHA).body,
        },
      },
      outcome: green(true, SHA, null, [READ, CREATE, READ, COMPARE, update(false)]),
    },
    {
      reason:
        "record: a write refused twice with the record unmoved (an invalid write) is red, not a lost race",
      answers: {
        mode: "record",
        ref: names(RECORDED),
        compare: compared("ahead"),
        write: {
          status: 422,
          body: '{"message":"Reference name is invalid","status":"422"}',
        },
      },
      outcome: red(
        'writing the record answered HTTP 422: {"message":"Reference name is invalid","status":"422"}',
        [READ, COMPARE, update(false), READ, COMPARE, update(false)],
      ),
    },
    {
      reason: "record: a write that errors leaves no verdict and a red step",
      answers: {
        mode: "record",
        ref: names(RECORDED),
        compare: compared("ahead"),
        write: { status: 500, body: SERVER_ERROR },
      },
      outcome: red(`writing the record answered HTTP 500: ${SERVER_ERROR}`, [
        READ,
        COMPARE,
        update(false),
      ]),
    },
  ])("$reason", async ({ answers, outcome }) => {
    expect(await judged(answers)).toEqual(outcome);
  });
});

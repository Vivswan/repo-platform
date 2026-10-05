// GitHub's answers are GitHub's: a ref read is 200 with `object.sha`, 404 for none; a compare `status` is ahead, behind,
// identical, or diverged, 404 for a base commit the repository no longer holds; a ref write is 201 (create), 200
// (update), or 422 when GitHub refuses it (a fast-forward that is not one, a ref that already exists, an invalid name).
// Nothing in-house holds those shapes, and the pages leg gates on `proceed == 'true'` while the job's color reads the
// exit: a run behind the record must leave `false` at exit 0 (a green stand-down), a run ahead, equal, or first must
// leave `true`, a lost record race must write nothing, and an unreadable answer must leave no verdict and a red step.
// The script is executed against a gh stub answering each way, with the requests it sends pinned beside the whole outcome.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argvStub } from "../../shared/argv_stub";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/apply-forward/apply_forward.ts");
// Synthetic commits: this run's, the one the record names, and one a racing newer run records.
const SHA = "5e".repeat(20);
const RECORDED = "d0".repeat(20);
const NEWER = "a1".repeat(20);
const SHORT = (sha: string) => sha.slice(0, 12);
const REF = "refs/platform/applied/pages";

const READ = ["gh", "api", "--include", "repos/o/r/git/ref/platform/applied/pages"];
const compareOf = (base: string) => [
  "gh",
  "api",
  "--include",
  `repos/o/r/compare/${base}...${SHA}`,
];
const COMPARE = compareOf(RECORDED);
const CREATE = [
  "gh",
  "api",
  "--include",
  "-X",
  "POST",
  "repos/o/r/git/refs",
  "-f",
  `ref=${REF}`,
  "-f",
  `sha=${SHA}`,
];
const update = (force: boolean) => [
  "gh",
  "api",
  "--include",
  "-X",
  "PATCH",
  "repos/o/r/git/refs/platform/applied/pages",
  "-f",
  `sha=${SHA}`,
  "-F",
  `force=${force}`,
];
const SERVER_ERROR = '{"message":"Server Error","status":"500"}';
const NOT_FOUND = '{"message":"Not Found","status":"404"}';
const NOT_FAST_FORWARD = '{"message":"Update is not a fast forward","status":"422"}';

/** One request kind's answer: the first call's, and optionally a different one from the second call on. */
interface Reply {
  status?: string;
  body?: string;
  againStatus?: string;
  again?: string;
}

interface Answers {
  mode: "check" | "record";
  ref?: Reply;
  compare?: Reply;
  write?: Reply;
}

const judged = (answers: Answers) => {
  const root = temp.dir("apply-forward-");
  // One stub serves every request, telling them apart by method and path; each kind counts its calls so the second
  // call on (the re-read and re-write after a refused write) can answer differently.
  const gh = argvStub(root, "gh", [
    'method=GET; path=""',
    'for a in "$@"; do case "$a" in repos/*) path="$a" ;; PATCH|POST) method="$a" ;; esac; done',
    'case "$method $path" in',
    '  "GET repos/o/r/git/ref/platform/applied/pages") kind=REF ;;',
    '  "GET repos/o/r/compare/"*) kind=COMPARE ;;',
    '  "PATCH repos/o/r/git/refs/platform/applied/pages"|"POST repos/o/r/git/refs") kind=WRITE ;;',
    '  *) echo "stub gh: unexpected $method $path" >&2; exit 64 ;;',
    "esac",
    'n=$(( $(cat "$COUNTS/$kind" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$COUNTS/$kind"',
    'again="${kind}_AGAIN"; again_status="${kind}_AGAIN_STATUS"; first="${kind}_BODY"; first_status="${kind}_STATUS"',
    'if [ "$n" -ge 2 ] && [ -n "${!again_status}" ]; then status="${!again_status}"; body="${!again}"; else status="${!first_status}"; body="${!first}"; fi',
    'printf \'HTTP/2.0 %s\\r\\nContent-Type: application/json; charset=utf-8\\r\\n\\r\\n%s\' "$status" "$body"',
    'case "$status" in 2*) ;; *) exit 1 ;; esac',
  ]);
  const output = join(root, "output");
  writeFileSync(output, "");
  const reply = (kind: string, given: Reply | undefined, status: string, body: string) => ({
    [`${kind}_STATUS`]: given?.status ?? status,
    [`${kind}_BODY`]: given?.body ?? body,
    [`${kind}_AGAIN_STATUS`]: given?.againStatus ?? "",
    [`${kind}_AGAIN`]: given?.again ?? "",
  });
  const run = boundedSpawnSync([process.execPath, SCRIPT], {
    env: {
      PATH: `${gh.bin}:${process.env.PATH ?? ""}`,
      COUNTS: root,
      ...reply("REF", answers.ref, "404 Not Found", NOT_FOUND),
      ...reply("COMPARE", answers.compare, "200 OK", ""),
      ...reply(
        "WRITE",
        answers.write,
        answers.ref?.body === undefined ? "201 Created" : "200 OK",
        "",
      ),
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "o/r",
      MODE: answers.mode,
      LEG: "pages",
      SHA,
    },
  });
  return {
    exitCode: run.exitCode,
    stdout: run.stdout,
    output: readFileSync(output, "utf8"),
    calls: gh.calls(),
  };
};

const names = (sha: string): Reply => ({
  status: "200 OK",
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
  test.each<{ reason: string; answers: Answers; outcome: ReturnType<typeof judged> }>([
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
        compare: { status: "404 Not Found", body: NOT_FOUND },
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
      answers: { mode: "check", ref: { status: "500 Internal Server Error", body: SERVER_ERROR } },
      outcome: red(`reading the record answered HTTP 500: ${SERVER_ERROR}`, [READ]),
    },
    {
      reason: "check: a record naming no commit is an error, not a proceed",
      answers: {
        mode: "check",
        ref: { status: "200 OK", body: `{"ref":"${REF}","object":{"type":"commit"}}` },
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
        ref: { ...names(RECORDED), againStatus: "200 OK", again: names(NEWER).body },
        compare: { ...compared("ahead"), againStatus: "200 OK", again: compared("behind").body },
        write: { status: "422 Unprocessable Entity", body: NOT_FAST_FORWARD },
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
        ref: { againStatus: "200 OK", again: names(RECORDED).body },
        compare: compared("ahead"),
        write: {
          status: "422 Unprocessable Entity",
          body: '{"message":"Reference already exists","status":"422"}',
          againStatus: "200 OK",
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
          status: "422 Unprocessable Entity",
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
        write: { status: "500 Internal Server Error", body: SERVER_ERROR },
      },
      outcome: red(`writing the record answered HTTP 500: ${SERVER_ERROR}`, [
        READ,
        COMPARE,
        update(false),
      ]),
    },
  ])("$reason", ({ answers, outcome }) => {
    expect(judged(answers)).toEqual(outcome);
  });
});

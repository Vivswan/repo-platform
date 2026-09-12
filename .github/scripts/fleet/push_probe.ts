// git's push-service advertisement answers 200 only with push permission; fine-grained PATs read every public repo and user/repos
// reports the USER's permissions, so this is the only honest enrollment signal. curl stays a subprocess, not fetch, so the test
// harnesses can stub it on PATH.

import { captureNetwork } from "./discovery.ts";

/** 0 for a transport failure, like curl's 000; a status printed by a FAILING curl is not trusted. */
export function pushProbeStatus(slug: string, pat: string): number {
  const proc = captureNetwork([
    "curl",
    "-s",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "-u",
    `x-access-token:${pat}`,
    `https://github.com/${slug}.git/info/refs?service=git-receive-pack`,
  ]);
  if (proc.exitCode !== 0) return 0;
  const code = Number.parseInt(proc.stdout, 10);
  return Number.isNaN(code) ? 0 : code;
}

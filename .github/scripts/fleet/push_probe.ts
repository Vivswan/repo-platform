// The fleet token's ACTUAL write grant on a repo, probed via git's
// push-service advertisement: 200 only with push permission. Fine-grained
// PATs read every public repo and user/repos reports the USER's
// permissions, so this is the only honest enrollment signal. Read-only,
// no side effects. curl stays a subprocess (not fetch) so the test
// harnesses can stub it on PATH.

/** HTTP status of the push probe; 0 for a transport failure (DNS, TLS,
 * timeout), like curl's 000. A status printed by a FAILING curl is not
 * trusted: only exit 0 output counts as an answer. */
export function pushProbeStatus(slug: string, pat: string): number {
  const proc = Bun.spawnSync(
    [
      "curl",
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-u",
      `x-access-token:${pat}`,
      `https://github.com/${slug}.git/info/refs?service=git-receive-pack`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (proc.exitCode !== 0) return 0;
  const code = Number.parseInt(proc.stdout.toString(), 10);
  return Number.isNaN(code) ? 0 : code;
}

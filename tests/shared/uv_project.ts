// A tool an action brings through its uv project (pyproject.toml and uv.lock beside action.yml), for the tests that
// run the action's own step: uv installs what the lock names, so the tool that judges here is the one the fleet runs.

/** A bound on a first run, which downloads the locked wheels and uv's own python. */
export const UV_TIMEOUT_MS = 300_000;

/** Whether a step that calls `uv` can run here. Without uv its tests are skipped loudly, except under UV_REQUIRED=1
 *  (ci.yml's script-tests job, after its setup-uv), where a missing uv is an error.
 *
 * @throws {Error} UV_REQUIRED=1 and no uv on PATH
 */
export function uvOnPath(): boolean {
  if (Bun.which("uv") !== null) return true;

  if (process.env.UV_REQUIRED === "1") throw new Error("UV_REQUIRED=1 and no uv is on PATH");

  console.warn(
    "uv is not on PATH: the tests that run a tool through its action's uv project are skipped",
  );
  return false;
}

/** The environment a step that calls `uv` needs beyond the step's own: uv keeps its cache and its python under HOME. */
export function uvEnv(): Record<string, string> {
  return { HOME: process.env.HOME ?? "" };
}

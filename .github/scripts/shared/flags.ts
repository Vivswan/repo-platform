// Typed `--flag value` CLI parsing shared by the fleet and sync scripts.
// Unknown or valueless flags and missing required flags fail as ::error::
// workflow commands with a nonzero exit; the returned record carries the
// required flags as guaranteed keys, so call sites never re-check presence.

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function isAllowed<K extends string>(flag: string, allowed: readonly K[]): flag is K {
  return allowed.some((candidate) => candidate === flag);
}

function hasRequired<R extends string, O extends string>(
  flags: Partial<Record<R | O, string>>,
  required: readonly R[],
): flags is Record<R, string> & Partial<Record<O, string>> {
  // Own-property check: an inherited key like "toString" must not count.
  return required.every((flag) => Object.hasOwn(flags, flag));
}

export function parseFlags<R extends string, O extends string = never>(
  argv: string[],
  required: readonly R[],
  optional: readonly O[] = [],
): Record<R, string> & Partial<Record<O, string>> {
  const allowed: readonly (R | O)[] = [...required, ...optional];
  const flags: Partial<Record<R | O, string>> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!isAllowed(flag, allowed) || value === undefined) {
      fail(`unknown or valueless argument "${flag}" - allowed flags: ${allowed.join(", ")}`);
    }
    flags[flag] = value;
  }
  if (!hasRequired(flags, required)) {
    const missing = required.filter((flag) => !Object.hasOwn(flags, flag));
    fail(`missing required flags: ${missing.join(", ")}`);
  }
  return flags;
}

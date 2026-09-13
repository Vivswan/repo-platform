// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

/** The shape of every tracking-stream label: safe as a gh flag value (no leading dash), within GitHub's 50-character label limit.
 *  The plan admits registration labels by it and release-health reads TRACKING_LABELS by it. */
export const LABEL_RE = /^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}$/;

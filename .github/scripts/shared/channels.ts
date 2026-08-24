// The build-branch channel enum: the single TypeScript owner of the
// channel names. Non-TypeScript copies (copier.yml's channel choices, the
// build/protect workflows, the branch ruleset, plan.ts's per-channel legs)
// cannot import this, so scripts/check_ssot.ts's `channels` rule holds
// them to it.

export const CHANNELS = ["staging", "latest"] as const;

export type Channel = (typeof CHANNELS)[number];

export function isChannel(value: unknown): value is Channel {
  return CHANNELS.some((channel) => channel === value);
}

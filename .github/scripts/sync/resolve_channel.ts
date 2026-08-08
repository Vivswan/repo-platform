// Channel precedence for the push sync: an explicit channel input (fleet
// config from repos.yml, routed through sync-repos) wins, the target's
// recorded copier answer is the fallback, and latest is the default when
// neither is set. resolve_refs.ts and its test share this.

import { readFileSync } from "node:fs";

/** Resolve the channel name (unvalidated - the caller rejects anything
 * other than staging or latest). */
export function resolveChannel(channelInput: string, answersFile: string): string {
  if (channelInput !== "") return channelInput;
  for (const line of readFileSync(answersFile, "utf-8").split("\n")) {
    const fields = line.split(/\s+/).filter((field) => field !== "");
    if (fields[0] === "channel:" && fields[1] !== undefined) return fields[1];
  }
  return "latest";
}

// Channel precedence for the push sync: an explicit channel input (fleet
// config from repos.yml, routed through sync-repos) wins, the target's
// recorded copier answer is the fallback, and latest is the default when
// neither is set. resolve_refs.ts and its test share this.

import { type Channel, isChannel } from "../shared/channels.ts";
import type { CopierAnswers } from "./answers_file.ts";

/** The resolved channel, or the raw text of an unusable value (from the
 * input or the recorded answer) for the caller's error message. */
export function resolveChannel(
  channelInput: string,
  answers: CopierAnswers,
): Channel | { invalid: string } {
  if (channelInput !== "") {
    return isChannel(channelInput) ? channelInput : { invalid: channelInput };
  }
  return answers.channel ?? "latest";
}

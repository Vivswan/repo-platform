# shellcheck shell=bash
# Channel precedence for the push sync: an explicit channel input (fleet
# config from repos.yml, routed through sync-repos) wins, the target's
# recorded copier answer is the fallback, and latest is the default when
# neither is set. Source this file; resolve_refs.sh and its test share it.
#
#   resolve_channel <channel-input> <answers-file>
#     Print the resolved channel name (unvalidated - the caller rejects
#     anything other than staging or latest).

resolve_channel() {
  local channel
  channel="$1"
  if [ -z "$channel" ]; then
    channel="$(awk '$1 == "channel:" { print $2 }' "$2")"
  fi
  printf '%s\n' "${channel:-latest}"
}

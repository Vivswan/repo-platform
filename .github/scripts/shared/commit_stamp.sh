# shellcheck shell=bash
# Source-commit stamp on build-branch commits. publish.sh writes the stamp
# into every build commit message; publish.sh (re-stamp check) and
# sync/resolve_refs.sh (staging validator ref) both parse it back, so the
# exact line shape lives here alone. Source this file; it defines:
#
#   commit_stamp_write <server-url> <repository> <sha>
#     Print the stamp line for a build commit message.
#   commit_stamp_parse
#     Read a commit message on stdin and print the stamped sha (empty
#     output when the message carries no stamp).

commit_stamp_write() {
  printf 'source: %s/%s/commit/%s\n' "$1" "$2" "$3"
}

commit_stamp_parse() {
  sed -n 's|^source: .*/commit/||p' | head -1
}

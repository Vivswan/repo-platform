# shellcheck shell=bash
# Provenance stamp lines on build-branch commits. publish.sh writes both
# lines into every build commit message; publish.sh (re-stamp check) and
# sync/resolve_refs.sh + sync/verify_staging_provenance.sh parse them back,
# so the exact line shapes live here alone. Source this file; it defines:
#
#   commit_stamp_write <server-url> <repository> <sha>
#     Print the source-stamp line for a build commit message.
#   commit_stamp_parse
#     Read a commit message on stdin and print the stamped sha (empty
#     output when the message carries no stamp).
#   commit_stamp_parse_all
#     Like commit_stamp_parse, but print every stamped sha on stdin, in
#     order (for walking a branch's stamp history).
#   commit_run_write <run-url>
#     Print the run-stamp line for a build commit message.
#   commit_run_parse
#     Read a commit message on stdin and print the stamped run id (empty
#     output when the message carries no run line).

commit_stamp_write() {
  printf 'source: %s/%s/commit/%s\n' "$1" "$2" "$3"
}

commit_stamp_parse_all() {
  sed -n 's|^source: .*/commit/||p'
}

# awk consumes all input where `head -1` would close the pipe early and
# turn a many-stamp (hostile) message into a SIGPIPE failure under
# pipefail.
commit_stamp_parse() {
  commit_stamp_parse_all | awk 'NR == 1'
}

commit_run_write() {
  printf 'run: %s\n' "$1"
}

commit_run_parse() {
  sed -n 's|^run: .*/actions/runs/||p' | awk 'NR == 1'
}

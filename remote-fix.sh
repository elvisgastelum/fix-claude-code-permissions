#!/usr/bin/env bash
# Run fix-claude-code.sh on the remote Mac over SSH.
#
# Usage: ./remote-fix.sh [diagnose|fix]
#   HOST           ssh alias of the Mac (default: personal)
#   PASSWORD_FILE  file holding the admin password; if unset and mode is fix, you are prompted
#
# The password travels over ssh stdin only, never in a command line.
set -eu

HOST="${HOST:-personal}"
REMOTE_DIR='~/Projects/github.com/elvisgastelum/fix-claude-code-permissions'
mode="${1:-diagnose}"

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=15)

if [ "$mode" = "diagnose" ]; then
  exec ssh "${ssh_opts[@]}" "$HOST" "$REMOTE_DIR/fix-claude-code.sh diagnose"
fi

if [ -n "${PASSWORD_FILE:-}" ]; then
  exec ssh "${ssh_opts[@]}" "$HOST" "$REMOTE_DIR/fix-claude-code.sh fix --password-stdin" < "$PASSWORD_FILE"
fi

read -rsp "Admin password for $HOST: " password; echo >&2
printf '%s\n' "$password" | ssh "${ssh_opts[@]}" "$HOST" "$REMOTE_DIR/fix-claude-code.sh fix --password-stdin"

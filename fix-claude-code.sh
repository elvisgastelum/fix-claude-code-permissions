#!/usr/bin/env bash
# Diagnose and fix a Claude Code binary that macOS refuses to launch, without a GUI.
#
# Symptom: `claude --version` hangs forever (stuck at _dyld_start) and the kernel logs
# "AppleSystemPolicy: Security policy would not allow process: .../claude" while a
# Gatekeeper prompt waits on a screen nobody is looking at.
#
# Usage: fix-claude-code.sh [diagnose|fix] [--binary PATH] [--password-stdin]
#   diagnose   read-only report (default)
#   fix        remove the quarantine flag, then restart syspolicyd if the launch still hangs
#
# Exit codes: 0 launches fine, 1 still failing, 2 refused or bad usage.
set -u

ANTHROPIC_TEAM_ID="Q6L2SF6YDW"
TEST_TIMEOUT="${TEST_TIMEOUT:-20}"

mode="diagnose"
binary=""
password_stdin=0
password=""

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
bad()  { printf '  FAIL %s\n' "$*"; }
info() { printf '  ..   %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 2; }

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    diagnose|fix) mode="$1" ;;
    --binary) shift; [ $# -gt 0 ] || die "--binary needs a path"; binary="$1" ;;
    --password-stdin) password_stdin=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

find_binary() {
  local candidate="$binary" p
  if [ -z "$candidate" ]; then
    candidate=$(zsh -lc 'command -v claude' 2>/dev/null | tail -1)
    if [ ! -f "$candidate" ]; then
      candidate=""
      for p in /opt/homebrew/bin/claude "$HOME/.local/bin/claude" /usr/local/bin/claude; do
        if [ -f "$p" ]; then candidate="$p"; break; fi
      done
    fi
  fi
  [ -f "$candidate" ] || return 1
  realpath "$candidate"
}

signature_ok() {
  local b="$1" team
  if codesign --verify --strict "$b" >/dev/null 2>&1; then ok "code signature valid"
  else bad "code signature invalid"; return 1; fi
  team=$(codesign -dv "$b" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  if [ "$team" = "$ANTHROPIC_TEAM_ID" ]; then ok "signed by Anthropic PBC (Team $team)"
  else bad "unexpected Team ID '$team' (want $ANTHROPIC_TEAM_ID)"; return 1; fi
  if codesign --verify -R="notarized" --check-notarization "$b" >/dev/null 2>&1; then ok "notarized"
  else bad "not notarized"; return 1; fi
}

has_quarantine() { xattr "$1" 2>/dev/null | grep -q '^com.apple.quarantine$'; }

launch_test() {
  local out rc
  out=$(perl -e 'alarm shift; exec @ARGV' "$TEST_TIMEOUT" "$1" --version 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then ok "launches: $out"; return 0; fi
  if [ "$rc" -eq 142 ]; then bad "launch hung for ${TEST_TIMEOUT}s and was killed"
  else bad "launch exited $rc: $out"; fi
  return 1
}

run_sudo() {
  if [ "$password_stdin" -eq 1 ]; then
    printf '%s\n' "$password" | sudo -S -p "" "$@"
  else
    sudo -n "$@"
  fi
}

b=$(find_binary) || die "could not find a claude binary (use --binary PATH)"
say "binary: $b"
say "macOS:  $(sw_vers -productVersion) ($(uname -m)); syspolicyd up $(ps -o etime= -p "$(pgrep -x syspolicyd | head -1)" 2>/dev/null | tr -d ' ')"

say "signature"
signature_ok "$b" || { say "refusing to touch a binary that is not Anthropic-signed and notarized"; exit 2; }

say "quarantine"
if has_quarantine "$b"; then info "com.apple.quarantine is set"; else ok "not quarantined"; fi

say "launch"
if launch_test "$b"; then exit 0; fi
[ "$mode" = "fix" ] || { say "run again with 'fix' to repair"; exit 1; }

say "fix"
if has_quarantine "$b"; then
  xattr -d com.apple.quarantine "$b" && ok "removed quarantine flag"
  launch_test "$b" && exit 0
fi

if [ "$password_stdin" -eq 1 ]; then IFS= read -r password; fi
info "restarting syspolicyd (launchd respawns it)"
if run_sudo killall syspolicyd; then
  sleep 4
  ok "syspolicyd restarted"
else
  bad "sudo failed (wrong password, or none given: pipe it with --password-stdin)"
  exit 1
fi
launch_test "$b" && exit 0

say "still failing: open System Settings > Privacy & Security > Open Anyway on the machine, or reboot"
exit 1

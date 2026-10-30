# fix-claude-code-permissions

Unblock a Claude Code binary that macOS refuses to launch, over SSH, with no GUI session.

## Symptom

`claude --version` hangs forever. The process never gets past `_dyld_start`, and the kernel logs:

```
AppleSystemPolicy: Security policy would not allow process: .../claude
```

The binary itself is fine: Anthropic PBC Developer ID (Team `Q6L2SF6YDW`), valid signature, notarized.
The launch is held by `syspolicyd` (often wedged after days of uptime, logging
`Unable to initialize qtn_proc`), or by a Gatekeeper prompt on a screen nobody can see.

## What the fix does

1. Refuses to touch anything unless the binary is validly signed by Anthropic's Team ID and notarized.
2. Removes `com.apple.quarantine` from that one binary.
3. If the launch still hangs, runs `sudo killall syspolicyd`. launchd respawns it.
4. Re-tests `claude --version` after each step and stops as soon as it works.

It never reboots, never edits other binaries, and does not use `spctl --add` (unsupported on recent macOS).

## Usage

On the Mac:

```sh
./fix-claude-code.sh diagnose            # read-only report
./fix-claude-code.sh fix                 # needs passwordless sudo, or:
echo "$PASSWORD" | ./fix-claude-code.sh fix --password-stdin
```

From another machine (default host alias `personal`):

```sh
./remote-fix.sh diagnose
./remote-fix.sh fix                      # prompts for the admin password
PASSWORD_FILE=/path/to/secret ./remote-fix.sh fix
```

`--binary PATH` targets a specific binary; otherwise `claude` is resolved from a login shell, then
`/opt/homebrew/bin`, `~/.local/bin` and `/usr/local/bin`. `TEST_TIMEOUT` (seconds, default 20) bounds each launch test.

Exit codes: `0` launches fine, `1` still failing, `2` refused or bad usage.

## If it still fails

Approve the binary on the machine (System Settings > Privacy & Security > Open Anyway), or reboot it.
Check that remote login survives a reboot first (FileVault pre-boot login blocks SSH).

# fix-claude-code-permissions

Unblock a Claude Code binary that macOS refuses to launch, locally or over SSH, with no GUI session.

## Symptom

`claude --version` hangs forever. The process never gets past `_dyld_start`, and the kernel logs:

```
AppleSystemPolicy: Security policy would not allow process: .../claude
```

The binary itself is fine: Anthropic PBC Developer ID (Team `Q6L2SF6YDW`), valid signature, notarized.
The launch is held by `syspolicyd` (often wedged after days of uptime, logging
`Unable to initialize qtn_proc`), or by a Gatekeeper prompt on a screen nobody can see.

## Install

Needs only `git` and `node` on the Mac. No `pnpm install`: the built `dist/` is committed.

```sh
curl -fsSL https://raw.githubusercontent.com/elvisgastelum/fix-claude-code-permissions/main/install.sh | bash
```

It clones into `${FIX_CLAUDE_CODE_HOME:-$HOME/.local/share/fix-claude-code}` and writes a launcher at
`${FIX_CLAUDE_CODE_BIN_DIR:-$HOME/.local/bin}/fix-claude-code`. Re-run it to update. Remove it with:

```sh
curl -fsSL https://raw.githubusercontent.com/elvisgastelum/fix-claude-code-permissions/main/install.sh | bash -s -- --uninstall
```

`FIX_CLAUDE_CODE_REPO` and `FIX_CLAUDE_CODE_REF` override the repository URL and branch.

## Use

On the Mac:

```sh
fix-claude-code diagnose                       # read-only report
fix-claude-code fix --password-stdin < file    # repair; sudo password from the first line of stdin
```

From another machine, over SSH (the Mac must have it installed; `<host>` is any ssh alias or `user@host`):

```sh
fix-claude-code remote <host> diagnose
fix-claude-code remote <host> fix              # prompts for the admin password without echo
fix-claude-code remote <host> fix --password-file ./pw
```

`remote` runs the launcher that `install.sh` wrote on the Mac, so install it there first. The machine you
run `remote` from needs `node` (and a copy of this tool) plus `ssh`; the macOS tools are used only on the Mac.

| Option                 | Meaning                                               |
| ---------------------- | ----------------------------------------------------- |
| `--binary PATH`        | target this binary instead of finding `claude`        |
| `--timeout SECONDS`    | bound each launch test (default 20)                   |
| `--password-stdin`     | read the admin password from the first line of stdin  |
| `--password-file PATH` | read the admin password from the first line of a file |

Exit codes: `0` launches fine, `1` still failing, `2` refused or bad usage, `130` cancelled.

## What `fix` does

1. Refuses to touch anything unless the binary is validly signed by Anthropic's Team ID and notarized.
2. Removes `com.apple.quarantine` from that one binary and re-tests.
3. If the launch still hangs, runs `sudo killall syspolicyd` (launchd respawns it) and re-tests.
4. Stops as soon as `claude --version` works.

It never reboots, never edits other binaries, and does not use `spctl --add` (unsupported on recent macOS).
`diagnose` changes nothing.

## Secrets

The admin password is only ever read from a prompt, a file you name, or stdin, and sent to `sudo -S` and
over `ssh` through stdin. It is never a command-line argument, never written to disk by this tool, and
never printed. Do not commit password files.

## If it still fails

Approve the binary on the machine (System Settings > Privacy & Security > Open Anyway), or reboot it.
Check that remote login survives a reboot first (FileVault pre-boot login blocks SSH).

## Development

Vite+ is the development stack only; users never install pnpm, `vp` or dependencies.

```sh
pnpm install
vp check      # format, lint, type-check
vp test
vp pack       # rebuild dist/cli.mjs, then commit dist/
```

A test fails if the committed `dist/cli.mjs` differs from a fresh build, or if it imports anything that
is not a `node:` module.

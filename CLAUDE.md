# fix-claude-code-permissions

Node CLI (`fix-claude-code`) that unblocks a Claude Code binary macOS refuses to launch, locally or over ssh.

- `src/fix.ts` holds the repair sequence behind an injected `System`; tests drive it with a fake Mac (`tests/helpers.ts`).
- The admin password only travels through stdin (`sudoInvocation`, `runRemote`). Never put it in an argument, a log line or a file in the repo.
- The repo is public: no secrets and no machine- or user-specific absolute paths. Derive paths from `$HOME`/`os.homedir()` and env. `tests/hygiene.test.ts` enforces it.
- `dist/cli.mjs` is committed so installs need no `pnpm install`. After changing `src/` or dependencies, run `vp pack` and commit `dist/`. `tests/dist.test.ts` fails when it is stale.
- Vite+ is the development stack only; never make users install pnpm, vp or dependencies.

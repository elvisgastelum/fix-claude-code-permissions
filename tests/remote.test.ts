import { expect, test } from "vite-plus/test";
import { isSafeHost, remoteCommand, runRemote, shellQuote, sshArgs } from "../src/remote.ts";

test("the remote command locates the launcher through $HOME, with no machine-specific path", () => {
  const cmd = remoteCommand({ mode: "fix", stdinPassword: true });
  expect(cmd).toBe(
    '"${FIX_CLAUDE_CODE_BIN_DIR:-$HOME/.local/bin}/fix-claude-code" fix --password-stdin',
  );
  expect(cmd).not.toMatch(/\/Users\/|\/home\//);
});

test("diagnose never asks the remote to read a password", () => {
  expect(remoteCommand({ mode: "diagnose", stdinPassword: false })).not.toContain("--password");
});

test("binary and timeout are forwarded, with the binary shell-quoted", () => {
  const cmd = remoteCommand({
    mode: "diagnose",
    stdinPassword: false,
    binary: "it's here/claude",
    launchTimeoutSec: 30,
  });
  expect(cmd).toContain("--binary 'it'\\''s here/claude'");
  expect(cmd).toContain("--timeout 30");
});

test("shellQuote survives a quote injection attempt", () => {
  expect(shellQuote("a'; rm -rf ~; echo '")).toBe("'a'\\''; rm -rf ~; echo '\\'''");
});

test("hosts that ssh would read as options are rejected", () => {
  expect(isSafeHost("personal")).toBe(true);
  expect(isSafeHost("dev@personal.local")).toBe(true);
  expect(isSafeHost("-oProxyCommand=evil")).toBe(false);
  expect(isSafeHost("host name")).toBe(false);
  expect(isSafeHost("")).toBe(false);
  expect(() => runRemote({ host: "-oProxyCommand=evil", mode: "diagnose" })).toThrow(
    "invalid host",
  );
});

test("ssh runs non-interactively and ends option parsing before the host", () => {
  const args = sshArgs("personal", "cmd");
  expect(args).toContain("BatchMode=yes");
  expect(args.slice(-3)).toEqual(["--", "personal", "cmd"]);
});

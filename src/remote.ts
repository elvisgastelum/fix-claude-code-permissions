import { spawnSync } from "node:child_process";
import type { Mode } from "./fix.ts";

export interface RemoteOptions {
  host: string;
  mode: Mode;
  binary?: string;
  launchTimeoutSec?: number;
  password?: string;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** An ssh alias or user@host. Anything starting with '-' would be parsed as an ssh option. */
export function isSafeHost(host: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.@:%-]*$/.test(host);
}

/**
 * The command run on the remote Mac. It calls the launcher install.sh wrote, located through
 * $HOME on the remote side, so no machine-specific path lives in this repo. The password is
 * never part of it: the remote reads it from stdin.
 */
export function remoteCommand(
  o: Pick<RemoteOptions, "mode" | "binary" | "launchTimeoutSec"> & { stdinPassword: boolean },
): string {
  const launcher = '"${FIX_CLAUDE_CODE_BIN_DIR:-$HOME/.local/bin}/fix-claude-code"';
  const parts = [launcher, o.mode];
  if (o.binary) parts.push("--binary", shellQuote(o.binary));
  if (o.launchTimeoutSec !== undefined) parts.push("--timeout", String(o.launchTimeoutSec));
  if (o.stdinPassword) parts.push("--password-stdin");
  return parts.join(" ");
}

export function sshArgs(host: string, command: string): string[] {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--", host, command];
}

/** Returns the remote command's exit code (255 when ssh itself fails). */
export function runRemote(o: RemoteOptions): number {
  if (!isSafeHost(o.host)) throw new Error(`invalid host '${o.host}'`);
  const stdinPassword = o.mode === "fix" && o.password !== undefined;
  const command = remoteCommand({ ...o, stdinPassword });
  const r = spawnSync("ssh", sshArgs(o.host, command), {
    input: stdinPassword ? `${o.password}\n` : undefined,
    stdio: [stdinPassword ? "pipe" : "ignore", "inherit", "inherit"],
  });
  if (r.error) throw r.error;
  return r.status ?? 255;
}

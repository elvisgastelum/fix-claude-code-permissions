import { spawnSync } from "node:child_process";
import { statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  /** Written to the child's stdin. Never put a secret in `args`; pass it here. */
  input?: string;
  timeoutMs?: number;
}

/** Every side effect the fixer needs, so the repair sequence can be tested with a fake. */
export interface System {
  run(cmd: string, args: string[], opts?: RunOptions): RunResult;
  isFile(path: string): boolean;
  realpath(path: string): string;
  home(): string;
  env(name: string): string | undefined;
  sleep(ms: number): void;
}

export const realSystem: System = {
  run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      input: opts.input,
      timeout: opts.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    };
  },
  isFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  realpath: (path) => realpathSync(path),
  home: () => homedir(),
  env: (name) => process.env[name],
  sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

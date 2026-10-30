import type { Reporter } from "../src/fix.ts";
import type { RunOptions, RunResult, System } from "../src/system.ts";

export interface Call {
  cmd: string;
  args: string[];
  input?: string;
}

export type FakeSystem = System & { calls: Call[] };

export interface MacScenario {
  /** What the signature check reports. */
  team?: string;
  quarantined?: boolean;
  /** Which action makes the launch work again; "already" means it never hung. */
  healedBy: "already" | "xattr" | "killall" | "never";
  sudoOk?: boolean;
}

const FAKE_BINARY = "fake/bin/claude";

/** A scripted Mac: launching hangs until the action named in `healedBy` happens. */
export function fakeMac(s: MacScenario): FakeSystem {
  const calls: Call[] = [];
  let quarantined = s.quarantined ?? false;
  let healed = s.healedBy === "already";

  const run = (cmd: string, args: string[], opts: RunOptions = {}): RunResult => {
    calls.push({ cmd, args, input: opts.input });
    const result = (r: Partial<RunResult> = {}): RunResult => ({
      status: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      ...r,
    });
    if (cmd === "zsh") return result({ stdout: `${FAKE_BINARY}\n` });
    if (cmd === "codesign" && args[0] === "-dv") {
      return result({
        stderr: `Identifier=com.anthropic.claude-code\nTeamIdentifier=${s.team ?? "Q6L2SF6YDW"}\n`,
      });
    }
    if (cmd === "codesign") return result();
    if (cmd === "pgrep") return result({ stdout: "505\n" });
    if (cmd === "ps") return result({ stdout: " 03-15:00:23\n" });
    if (cmd === "xattr" && args[0] === "-d") {
      quarantined = false;
      if (s.healedBy === "xattr") healed = true;
      return result();
    }
    if (cmd === "xattr") {
      return result({
        stdout: quarantined
          ? "com.apple.provenance\ncom.apple.quarantine\n"
          : "com.apple.provenance\n",
      });
    }
    if (cmd === "sudo") {
      if (!s.sudoOk) return result({ status: 1, stderr: "sudo: a password is required" });
      if (s.healedBy === "killall") healed = true;
      return result();
    }
    if (cmd === FAKE_BINARY) {
      return healed
        ? result({ stdout: "2.1.314 (Claude Code)\n" })
        : result({ status: null, timedOut: true });
    }
    return result({ status: 127, stderr: `unexpected command ${cmd}` });
  };

  return {
    calls,
    run,
    isFile: (path) => path === FAKE_BINARY,
    realpath: (path) => path,
    home: () => "home/user",
    env: () => undefined,
    sleep: () => {},
  };
}

export function recorder(): Reporter & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    section: (t) => lines.push(`# ${t}`),
    ok: (t) => lines.push(`ok ${t}`),
    fail: (t) => lines.push(`fail ${t}`),
    info: (t) => lines.push(`info ${t}`),
  };
}

export const mutations = (sys: FakeSystem): Call[] =>
  sys.calls.filter((c) => (c.cmd === "xattr" && c.args[0] === "-d") || c.cmd === "sudo");

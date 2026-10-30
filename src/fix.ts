import { join } from "node:path";
import type { System } from "./system.ts";

/** Anthropic PBC's public Apple Developer Team ID. Not a secret: it is in every signed build. */
export const ANTHROPIC_TEAM_ID = "Q6L2SF6YDW";
export const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;
const SYSPOLICYD_RESTART_WAIT_MS = 4_000;

export type Mode = "diagnose" | "fix";

export interface FixOptions {
  mode: Mode;
  binary?: string;
  launchTimeoutMs?: number;
  /** Admin password for sudo. Without it, sudo runs with -n and fails unless passwordless. */
  password?: string;
}

export interface Reporter {
  section(title: string): void;
  ok(text: string): void;
  fail(text: string): void;
  info(text: string): void;
}

export const EXIT_HEALTHY = 0;
export const EXIT_FAILING = 1;
export const EXIT_REFUSED = 2;

export function listsQuarantine(xattrOutput: string): boolean {
  return xattrOutput.split("\n").some((line) => line.trim() === "com.apple.quarantine");
}

export function parseTeamId(codesignOutput: string): string | undefined {
  return /^TeamIdentifier=(.+)$/m.exec(codesignOutput)?.[1]?.trim();
}

/** The password goes through stdin only, so it never shows up in a process listing. */
export function sudoInvocation(
  password: string | undefined,
  command: string[],
): { args: string[]; input?: string } {
  if (password === undefined) return { args: ["-n", ...command] };
  return { args: ["-S", "-p", "", ...command], input: `${password}\n` };
}

export function findBinary(sys: System, explicit?: string): string | undefined {
  const candidates: string[] = [];
  if (explicit) {
    candidates.push(explicit);
  } else {
    // A non-interactive SSH shell has a bare PATH; the login shell knows where claude lives.
    const login = sys.run(sys.env("SHELL") ?? "zsh", ["-lic", "command -v claude"], {
      timeoutMs: 15_000,
    });
    const found = login.stdout.trim().split("\n").pop();
    if (found) candidates.push(found);
    const brew = sys.env("HOMEBREW_PREFIX");
    if (brew) candidates.push(join(brew, "bin", "claude"));
    candidates.push(join(sys.home(), ".local", "bin", "claude"));
    candidates.push(join(sys.home(), ".claude", "local", "claude"));
  }
  const hit = candidates.find((c) => sys.isFile(c));
  return hit === undefined ? undefined : sys.realpath(hit);
}

function checkSignature(sys: System, bin: string, say: Reporter): boolean {
  if (sys.run("codesign", ["--verify", "--strict", bin]).status === 0)
    say.ok("code signature valid");
  else {
    say.fail("code signature invalid");
    return false;
  }
  const team = parseTeamId(sys.run("codesign", ["-dv", bin]).stderr);
  if (team === ANTHROPIC_TEAM_ID) say.ok(`signed by Anthropic PBC (Team ${team})`);
  else {
    say.fail(`unexpected Team ID '${team ?? "none"}' (want ${ANTHROPIC_TEAM_ID})`);
    return false;
  }
  const notarized = sys.run("codesign", ["--verify", "-R=notarized", "--check-notarization", bin]);
  if (notarized.status === 0) say.ok("notarized");
  else {
    say.fail("not notarized");
    return false;
  }
  return true;
}

function launchTest(sys: System, bin: string, timeoutMs: number, say: Reporter): boolean {
  const r = sys.run(bin, ["--version"], { timeoutMs });
  if (r.status === 0) {
    say.ok(`launches: ${r.stdout.trim()}`);
    return true;
  }
  if (r.timedOut) say.fail(`launch hung for ${timeoutMs / 1000}s and was killed`);
  else say.fail(`launch exited ${r.status}: ${(r.stderr || r.stdout).trim()}`);
  return false;
}

function syspolicydUptime(sys: System): string {
  const pid = sys.run("pgrep", ["-x", "syspolicyd"]).stdout.trim().split("\n")[0];
  if (!pid) return "not running";
  return sys.run("ps", ["-o", "etime=", "-p", pid]).stdout.trim() || "unknown";
}

/** Returns a process exit code: 0 launches fine, 1 still failing, 2 refused. */
export function runFix(sys: System, opts: FixOptions, say: Reporter): number {
  const timeoutMs = opts.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const bin = findBinary(sys, opts.binary);
  if (bin === undefined) {
    say.fail("could not find a claude binary (use --binary PATH)");
    return EXIT_REFUSED;
  }
  say.info(`binary: ${bin}`);
  say.info(`syspolicyd uptime: ${syspolicydUptime(sys)}`);

  say.section("signature");
  if (!checkSignature(sys, bin, say)) {
    say.fail("refusing to touch a binary that is not Anthropic-signed and notarized");
    return EXIT_REFUSED;
  }

  say.section("quarantine");
  let quarantined = listsQuarantine(sys.run("xattr", [bin]).stdout);
  if (quarantined) say.info("com.apple.quarantine is set");
  else say.ok("not quarantined");

  say.section("launch");
  if (launchTest(sys, bin, timeoutMs, say)) return EXIT_HEALTHY;
  if (opts.mode === "diagnose") {
    say.info("run again with 'fix' to repair");
    return EXIT_FAILING;
  }

  say.section("fix");
  if (quarantined) {
    if (sys.run("xattr", ["-d", "com.apple.quarantine", bin]).status === 0) {
      say.ok("removed quarantine flag");
      quarantined = false;
      if (launchTest(sys, bin, timeoutMs, say)) return EXIT_HEALTHY;
    } else {
      say.fail("could not remove the quarantine flag");
    }
  }

  say.info("restarting syspolicyd (launchd respawns it)");
  const sudo = sudoInvocation(opts.password, ["killall", "syspolicyd"]);
  if (sys.run("sudo", sudo.args, { input: sudo.input }).status !== 0) {
    say.fail(
      "sudo failed: wrong password, or none given (pass --password-stdin / --password-file)",
    );
    return EXIT_FAILING;
  }
  sys.sleep(SYSPOLICYD_RESTART_WAIT_MS);
  say.ok("syspolicyd restarted");
  if (launchTest(sys, bin, timeoutMs, say)) return EXIT_HEALTHY;

  say.info(
    "still failing: approve it on the machine (System Settings > Privacy & Security > Open Anyway) or reboot",
  );
  return EXIT_FAILING;
}

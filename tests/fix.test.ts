import { expect, test } from "vite-plus/test";
import {
  EXIT_FAILING,
  EXIT_HEALTHY,
  EXIT_REFUSED,
  listsQuarantine,
  parseTeamId,
  runFix,
  sudoInvocation,
} from "../src/fix.ts";
import { fakeMac, mutations, recorder } from "./helpers.ts";

test("a healthy binary is reported and nothing is changed, even in fix mode", () => {
  const sys = fakeMac({ healedBy: "already", quarantined: true });
  const say = recorder();
  expect(runFix(sys, { mode: "fix" }, say)).toBe(EXIT_HEALTHY);
  expect(mutations(sys)).toEqual([]);
  expect(say.lines).toContain("ok launches: 2.1.314 (Claude Code)");
});

test("diagnose never changes anything, even when the launch hangs", () => {
  const sys = fakeMac({ healedBy: "killall", quarantined: true, sudoOk: true });
  const say = recorder();
  expect(runFix(sys, { mode: "diagnose", password: "pw" }, say)).toBe(EXIT_FAILING);
  expect(mutations(sys)).toEqual([]);
  expect(say.lines).toContain("info run again with 'fix' to repair");
});

test("removing the quarantine flag is enough when that heals the launch, so sudo is not used", () => {
  const sys = fakeMac({ healedBy: "xattr", quarantined: true, sudoOk: true });
  expect(runFix(sys, { mode: "fix", password: "pw" }, recorder())).toBe(EXIT_HEALTHY);
  const [only] = mutations(sys);
  expect(mutations(sys)).toHaveLength(1);
  expect(only?.cmd).toBe("xattr");
  expect(only?.args.slice(0, 2)).toEqual(["-d", "com.apple.quarantine"]);
});

test("a hung launch without quarantine restarts syspolicyd, sending the password through stdin only", () => {
  const sys = fakeMac({ healedBy: "killall", quarantined: false, sudoOk: true });
  expect(runFix(sys, { mode: "fix", password: "hunter2" }, recorder())).toBe(EXIT_HEALTHY);
  const sudo = sys.calls.filter((c) => c.cmd === "sudo");
  expect(sudo).toHaveLength(1);
  expect(sudo[0]?.args).toEqual(["-S", "-p", "", "killall", "syspolicyd"]);
  expect(sudo[0]?.input).toBe("hunter2\n");
  expect(JSON.stringify(sys.calls.map((c) => [c.cmd, c.args]))).not.toContain("hunter2");
});

test("quarantine removal that does not heal falls through to the syspolicyd restart", () => {
  const sys = fakeMac({ healedBy: "killall", quarantined: true, sudoOk: true });
  expect(runFix(sys, { mode: "fix", password: "pw" }, recorder())).toBe(EXIT_HEALTHY);
  expect(mutations(sys).map((c) => c.cmd)).toEqual(["xattr", "sudo"]);
});

test("without a password sudo runs non-interactively and a refusal is reported as failing", () => {
  const sys = fakeMac({ healedBy: "killall", sudoOk: false });
  const say = recorder();
  expect(runFix(sys, { mode: "fix" }, say)).toBe(EXIT_FAILING);
  expect(sys.calls.find((c) => c.cmd === "sudo")?.args).toEqual(["-n", "killall", "syspolicyd"]);
  expect(say.lines.some((l) => l.startsWith("fail sudo failed"))).toBe(true);
});

test("when nothing heals the launch the result is failing with manual guidance", () => {
  const sys = fakeMac({ healedBy: "never", sudoOk: true });
  const say = recorder();
  expect(runFix(sys, { mode: "fix", password: "pw" }, say)).toBe(EXIT_FAILING);
  expect(say.lines.some((l) => l.includes("Open Anyway"))).toBe(true);
});

test("a binary not signed by Anthropic's team is refused and left untouched", () => {
  const sys = fakeMac({ healedBy: "killall", team: "AAAAAAAAAA", quarantined: true, sudoOk: true });
  const say = recorder();
  expect(runFix(sys, { mode: "fix", password: "pw" }, say)).toBe(EXIT_REFUSED);
  expect(mutations(sys)).toEqual([]);
  expect(say.lines.some((l) => l.includes("unexpected Team ID 'AAAAAAAAAA'"))).toBe(true);
});

test("a missing binary is refused", () => {
  const sys = fakeMac({ healedBy: "already" });
  expect(runFix(sys, { mode: "fix", binary: "does/not/exist" }, recorder())).toBe(EXIT_REFUSED);
});

test("parsers read quarantine and Team ID", () => {
  expect(listsQuarantine("com.apple.provenance\ncom.apple.quarantine\n")).toBe(true);
  expect(listsQuarantine("com.apple.provenance\n")).toBe(false);
  expect(parseTeamId("Identifier=x\nTeamIdentifier=Q6L2SF6YDW\n")).toBe("Q6L2SF6YDW");
  expect(parseTeamId("TeamIdentifier=not set")).toBe("not set");
  expect(parseTeamId("nothing here")).toBeUndefined();
});

test("sudoInvocation keeps the password out of the arguments", () => {
  expect(sudoInvocation(undefined, ["true"])).toEqual({ args: ["-n", "true"] });
  const withPw = sudoInvocation("s3cret", ["true"]);
  expect(withPw.args).toEqual(["-S", "-p", "", "true"]);
  expect(withPw.input).toBe("s3cret\n");
});

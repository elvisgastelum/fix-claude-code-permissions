#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
//#region src/fix.ts
/** Anthropic PBC's public Apple Developer Team ID. Not a secret: it is in every signed build. */
const ANTHROPIC_TEAM_ID = "Q6L2SF6YDW";
const SYSPOLICYD_RESTART_WAIT_MS = 4e3;
function listsQuarantine(xattrOutput) {
	return xattrOutput.split("\n").some((line) => line.trim() === "com.apple.quarantine");
}
function parseTeamId(codesignOutput) {
	return /^TeamIdentifier=(.+)$/m.exec(codesignOutput)?.[1]?.trim();
}
/** The password goes through stdin only, so it never shows up in a process listing. */
function sudoInvocation(password, command) {
	if (password === void 0) return { args: ["-n", ...command] };
	return {
		args: [
			"-S",
			"-p",
			"",
			...command
		],
		input: `${password}\n`
	};
}
function findBinary(sys, explicit) {
	const candidates = [];
	if (explicit) candidates.push(explicit);
	else {
		const found = sys.run(sys.env("SHELL") ?? "zsh", ["-lic", "command -v claude"], { timeoutMs: 15e3 }).stdout.trim().split("\n").pop();
		if (found) candidates.push(found);
		const brew = sys.env("HOMEBREW_PREFIX");
		if (brew) candidates.push(join(brew, "bin", "claude"));
		candidates.push(join(sys.home(), ".local", "bin", "claude"));
		candidates.push(join(sys.home(), ".claude", "local", "claude"));
	}
	const hit = candidates.find((c) => sys.isFile(c));
	return hit === void 0 ? void 0 : sys.realpath(hit);
}
function checkSignature(sys, bin, say) {
	if (sys.run("codesign", [
		"--verify",
		"--strict",
		bin
	]).status === 0) say.ok("code signature valid");
	else {
		say.fail("code signature invalid");
		return false;
	}
	const team = parseTeamId(sys.run("codesign", ["-dv", bin]).stderr);
	if (team === "Q6L2SF6YDW") say.ok(`signed by Anthropic PBC (Team ${team})`);
	else {
		say.fail(`unexpected Team ID '${team ?? "none"}' (want ${ANTHROPIC_TEAM_ID})`);
		return false;
	}
	if (sys.run("codesign", [
		"--verify",
		"-R=notarized",
		"--check-notarization",
		bin
	]).status === 0) say.ok("notarized");
	else {
		say.fail("not notarized");
		return false;
	}
	return true;
}
function launchTest(sys, bin, timeoutMs, say) {
	const r = sys.run(bin, ["--version"], { timeoutMs });
	if (r.status === 0) {
		say.ok(`launches: ${r.stdout.trim()}`);
		return true;
	}
	if (r.timedOut) say.fail(`launch hung for ${timeoutMs / 1e3}s and was killed`);
	else say.fail(`launch exited ${r.status}: ${(r.stderr || r.stdout).trim()}`);
	return false;
}
function syspolicydUptime(sys) {
	const pid = sys.run("pgrep", ["-x", "syspolicyd"]).stdout.trim().split("\n")[0];
	if (!pid) return "not running";
	return sys.run("ps", [
		"-o",
		"etime=",
		"-p",
		pid
	]).stdout.trim() || "unknown";
}
/** Returns a process exit code: 0 launches fine, 1 still failing, 2 refused. */
function runFix(sys, opts, say) {
	const timeoutMs = opts.launchTimeoutMs ?? 2e4;
	const bin = findBinary(sys, opts.binary);
	if (bin === void 0) {
		say.fail("could not find a claude binary (use --binary PATH)");
		return 2;
	}
	say.info(`binary: ${bin}`);
	say.info(`syspolicyd uptime: ${syspolicydUptime(sys)}`);
	say.section("signature");
	if (!checkSignature(sys, bin, say)) {
		say.fail("refusing to touch a binary that is not Anthropic-signed and notarized");
		return 2;
	}
	say.section("quarantine");
	let quarantined = listsQuarantine(sys.run("xattr", [bin]).stdout);
	if (quarantined) say.info("com.apple.quarantine is set");
	else say.ok("not quarantined");
	say.section("launch");
	if (launchTest(sys, bin, timeoutMs, say)) return 0;
	if (opts.mode === "diagnose") {
		say.info("run again with 'fix' to repair");
		return 1;
	}
	say.section("fix");
	if (quarantined) {
		if (sys.run("xattr", [
			"-d",
			"com.apple.quarantine",
			bin
		]).status === 0) {
			say.ok("removed quarantine flag");
			quarantined = false;
			if (launchTest(sys, bin, timeoutMs, say)) return 0;
		} else say.fail("could not remove the quarantine flag");
	}
	say.info("restarting syspolicyd (launchd respawns it)");
	const sudo = sudoInvocation(opts.password, ["killall", "syspolicyd"]);
	if (sys.run("sudo", sudo.args, { input: sudo.input }).status !== 0) {
		say.fail("sudo failed: wrong password, or none given (pass --password-stdin / --password-file)");
		return 1;
	}
	sys.sleep(SYSPOLICYD_RESTART_WAIT_MS);
	say.ok("syspolicyd restarted");
	if (launchTest(sys, bin, timeoutMs, say)) return 0;
	say.info("still failing: approve it on the machine (System Settings > Privacy & Security > Open Anyway) or reboot");
	return 1;
}
//#endregion
//#region src/prompt.ts
var Cancelled = class extends Error {};
function firstLine(text) {
	const line = text.split("\n")[0]?.replace(/\r$/, "") ?? "";
	if (line === "") throw new Error("the password is empty");
	return line;
}
const passwordFromFile = (path) => firstLine(readFileSync(path, "utf8"));
/** Reads one line from piped stdin. File descriptor 0 is stdin. */
const passwordFromStdin = () => firstLine(readFileSync(0, "utf8"));
/** Prompts on the terminal without echoing what is typed. */
function promptHidden(question) {
	const stdin = process.stdin;
	if (!stdin.isTTY) return Promise.reject(/* @__PURE__ */ new Error("no terminal to prompt on: use --password-file or --password-stdin"));
	process.stderr.write(question);
	stdin.setRawMode(true);
	stdin.setEncoding("utf8");
	stdin.resume();
	return new Promise((resolve, reject) => {
		let typed = "";
		const finish = (settle) => {
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
			process.stderr.write("\n");
			settle();
		};
		const onData = (chunk) => {
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n" || ch === "") {
					finish(() => typed === "" ? reject(/* @__PURE__ */ new Error("the password is empty")) : resolve(typed));
					return;
				}
				if (ch === "") {
					finish(() => reject(new Cancelled("cancelled")));
					return;
				}
				typed = ch === "" || ch === "\b" ? typed.slice(0, -1) : typed + ch;
			}
		};
		stdin.on("data", onData);
	});
}
//#endregion
//#region src/remote.ts
function shellQuote(value) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
/** An ssh alias or user@host. Anything starting with '-' would be parsed as an ssh option. */
function isSafeHost(host) {
	return /^[A-Za-z0-9_][A-Za-z0-9_.@:%-]*$/.test(host);
}
/**
* The command run on the remote Mac. It calls the launcher install.sh wrote, located through
* $HOME on the remote side, so no machine-specific path lives in this repo. The password is
* never part of it: the remote reads it from stdin.
*/
function remoteCommand(o) {
	const parts = ["\"${FIX_CLAUDE_CODE_BIN_DIR:-$HOME/.local/bin}/fix-claude-code\"", o.mode];
	if (o.binary) parts.push("--binary", shellQuote(o.binary));
	if (o.launchTimeoutSec !== void 0) parts.push("--timeout", String(o.launchTimeoutSec));
	if (o.stdinPassword) parts.push("--password-stdin");
	return parts.join(" ");
}
function sshArgs(host, command) {
	return [
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=15",
		"--",
		host,
		command
	];
}
/** Returns the remote command's exit code (255 when ssh itself fails). */
function runRemote(o) {
	if (!isSafeHost(o.host)) throw new Error(`invalid host '${o.host}'`);
	const stdinPassword = o.mode === "fix" && o.password !== void 0;
	const command = remoteCommand({
		...o,
		stdinPassword
	});
	const r = spawnSync("ssh", sshArgs(o.host, command), {
		input: stdinPassword ? `${o.password}\n` : void 0,
		stdio: [
			stdinPassword ? "pipe" : "ignore",
			"inherit",
			"inherit"
		]
	});
	if (r.error) throw r.error;
	return r.status ?? 255;
}
//#endregion
//#region src/system.ts
const realSystem = {
	run(cmd, args, opts = {}) {
		const r = spawnSync(cmd, args, {
			encoding: "utf8",
			input: opts.input,
			timeout: opts.timeoutMs,
			killSignal: "SIGKILL",
			maxBuffer: 8388608,
			stdio: [
				opts.input === void 0 ? "ignore" : "pipe",
				"pipe",
				"pipe"
			]
		});
		return {
			status: r.status,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
			timedOut: r.error?.code === "ETIMEDOUT"
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
	}
};
//#endregion
//#region src/version.ts
const VERSION = "0.1.0";
//#endregion
//#region src/cli.ts
const HELP = `fix-claude-code ${VERSION}
Unblock a Claude Code binary that macOS refuses to launch, with no GUI session.

Usage:
  fix-claude-code diagnose [options]            read-only report
  fix-claude-code fix [options]                 repair this Mac
  fix-claude-code remote <host> [diagnose|fix]  run it on another Mac over ssh

Options:
  --binary PATH         target this claude binary instead of finding it
  --timeout SECONDS     bound each launch test (default 20)
  --password-stdin      read the admin password from the first line of stdin
  --password-file PATH  read the admin password from the first line of a file
  -v, --version         print the version
  -h, --help            show this help

Without a password, 'fix' runs sudo non-interactively and only works if sudo is passwordless.
'remote <host> fix' prompts for the password without echo unless one of the flags above is given.
The password is sent through stdin only, never as an argument.

Exit codes: 0 launches fine, 1 still failing, 2 refused or bad usage, 130 cancelled.
`;
const plain = {
	section: (t) => console.log(t),
	ok: (t) => console.log(`  ok   ${t}`),
	fail: (t) => console.log(`  FAIL ${t}`),
	info: (t) => console.log(`  ..   ${t}`)
};
var UsageError = class extends Error {};
const isMode = (v) => v === "diagnose" || v === "fix";
async function resolvePassword(values, mode, canPrompt) {
	if (mode !== "fix") return void 0;
	if (values["password-file"]) return passwordFromFile(values["password-file"]);
	if (values["password-stdin"]) return passwordFromStdin();
	return canPrompt ? promptHidden("Admin password: ") : void 0;
}
async function main(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			binary: { type: "string" },
			timeout: { type: "string" },
			"password-stdin": { type: "boolean" },
			"password-file": { type: "string" },
			version: {
				type: "boolean",
				short: "v"
			},
			help: {
				type: "boolean",
				short: "h"
			}
		}
	});
	if (values.version) {
		console.log(VERSION);
		return 0;
	}
	const [command, ...rest] = positionals;
	if (values.help || command === void 0) {
		process.stdout.write(HELP);
		return values.help ? 0 : 2;
	}
	if (values["password-stdin"] && values["password-file"]) throw new UsageError("use either --password-stdin or --password-file, not both");
	const timeoutSec = values.timeout === void 0 ? void 0 : Number(values.timeout);
	if (timeoutSec !== void 0 && !(timeoutSec > 0)) throw new UsageError("--timeout must be a positive number");
	if (command === "diagnose" || command === "fix") {
		if (rest.length > 0) throw new UsageError(`unexpected argument '${rest[0]}'`);
		const password = await resolvePassword(values, command, false);
		return runFix(realSystem, {
			mode: command,
			binary: values.binary,
			launchTimeoutMs: timeoutSec === void 0 ? void 0 : timeoutSec * 1e3,
			password
		}, plain);
	}
	if (command === "remote") {
		const [host, mode = "diagnose", ...extra] = rest;
		if (host === void 0) throw new UsageError("remote needs a host (an ssh alias or user@host)");
		if (!isMode(mode) || extra.length > 0) throw new UsageError("remote <host> takes 'diagnose' or 'fix'");
		const password = await resolvePassword(values, mode, true);
		return runRemote({
			host,
			mode,
			binary: values.binary,
			launchTimeoutSec: timeoutSec,
			password
		});
	}
	throw new UsageError(`unknown command '${command}'`);
}
main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
	if (err instanceof Cancelled) process.exit(130);
	const code = err.code;
	const usage = err instanceof UsageError || typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
	console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(usage ? 2 : 1);
});
//#endregion
export {};

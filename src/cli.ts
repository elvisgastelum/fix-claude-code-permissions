#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runFix, type Mode, type Reporter } from "./fix.ts";
import { Cancelled, passwordFromFile, passwordFromStdin, promptHidden } from "./prompt.ts";
import { runRemote } from "./remote.ts";
import { realSystem } from "./system.ts";
import { VERSION } from "./version.ts";

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

const plain: Reporter = {
  section: (t) => console.log(t),
  ok: (t) => console.log(`  ok   ${t}`),
  fail: (t) => console.log(`  FAIL ${t}`),
  info: (t) => console.log(`  ..   ${t}`),
};

class UsageError extends Error {}

const isMode = (v: string | undefined): v is Mode => v === "diagnose" || v === "fix";

async function resolvePassword(
  values: { "password-stdin"?: boolean; "password-file"?: string },
  mode: Mode,
  canPrompt: boolean,
): Promise<string | undefined> {
  if (mode !== "fix") return undefined;
  if (values["password-file"]) return passwordFromFile(values["password-file"]);
  if (values["password-stdin"]) return passwordFromStdin();
  return canPrompt ? promptHidden("Admin password: ") : undefined;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      binary: { type: "string" },
      timeout: { type: "string" },
      "password-stdin": { type: "boolean" },
      "password-file": { type: "string" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(HELP);
    return values.help ? 0 : 2;
  }
  if (values["password-stdin"] && values["password-file"]) {
    throw new UsageError("use either --password-stdin or --password-file, not both");
  }
  const timeoutSec = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeoutSec !== undefined && !(timeoutSec > 0))
    throw new UsageError("--timeout must be a positive number");

  if (command === "diagnose" || command === "fix") {
    if (rest.length > 0) throw new UsageError(`unexpected argument '${rest[0]}'`);
    // Locally the terminal belongs to sudo's own checks, so we never prompt: use the flags.
    const password = await resolvePassword(values, command, false);
    return runFix(
      realSystem,
      {
        mode: command,
        binary: values.binary,
        launchTimeoutMs: timeoutSec === undefined ? undefined : timeoutSec * 1000,
        password,
      },
      plain,
    );
  }

  if (command === "remote") {
    const [host, mode = "diagnose", ...extra] = rest;
    if (host === undefined) throw new UsageError("remote needs a host (an ssh alias or user@host)");
    if (!isMode(mode) || extra.length > 0)
      throw new UsageError("remote <host> takes 'diagnose' or 'fix'");
    const password = await resolvePassword(values, mode, true);
    return runRemote({ host, mode, binary: values.binary, launchTimeoutSec: timeoutSec, password });
  }

  throw new UsageError(`unknown command '${command}'`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof Cancelled) process.exit(130);
    const code = (err as NodeJS.ErrnoException).code;
    const usage =
      err instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"));
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(usage ? 2 : 1);
  },
);

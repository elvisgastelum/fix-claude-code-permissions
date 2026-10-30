import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };

const dist = join(import.meta.dirname, "..", "dist", "cli.mjs");
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [dist, ...args], { encoding: "utf8" });

test("--version prints the package version", () => {
  const r = cli("--version");
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe(pkg.version);
});

test("--help documents every command and exits 0", () => {
  const r = cli("--help");
  expect(r.status).toBe(0);
  for (const word of [
    "diagnose",
    "fix",
    "remote",
    "--password-stdin",
    "--password-file",
    "Exit codes",
  ]) {
    expect(r.stdout).toContain(word);
  }
});

test("no command prints usage and exits 2", () => {
  expect(cli().status).toBe(2);
});

test("an unknown command is a usage error", () => {
  const r = cli("explode");
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("unknown command 'explode'");
});

test("an unknown option is a usage error", () => {
  expect(cli("diagnose", "--nope").status).toBe(2);
});

test("remote rejects a host that looks like an ssh option, before any ssh runs", () => {
  const r = cli("remote", "-oProxyCommand=evil", "diagnose");
  expect(r.status).not.toBe(0);
});

test("remote without a host is a usage error", () => {
  expect(cli("remote").status).toBe(2);
});

test("a non-positive timeout is a usage error", () => {
  expect(cli("diagnose", "--timeout", "0").status).toBe(2);
});

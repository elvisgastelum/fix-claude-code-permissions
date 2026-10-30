import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

const root = join(import.meta.dirname, "..");

// The repo is public: it must hold no secret and no machine- or user-specific path.
const shipped = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => f !== "" && !f.startsWith("tests/") && f !== "LICENSE" && f !== "pnpm-lock.yaml");

const forbidden: [string, RegExp][] = [
  ["a user home path", /\/(Users|home)\/[A-Za-z0-9_.-]+/],
  ["a Homebrew prefix", /\/opt\/homebrew/],
  [
    "a quoted credential assignment",
    /(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*["'][^"'\s]{6,}["']/i,
  ],
  ["a private key", /BEGIN [A-Z ]*PRIVATE KEY/],
  ["an AWS access key", /AKIA[0-9A-Z]{16}/],
  ["a GitHub token", /gh[pousr]_[A-Za-z0-9]{30,}/],
];

test("there are files to scan", () => {
  expect(shipped).toContain("src/fix.ts");
  expect(shipped).toContain("install.sh");
});

for (const [what, pattern] of forbidden) {
  test(`no shipped file contains ${what}`, () => {
    const hits = shipped.filter((f) => pattern.test(readFileSync(join(root, f), "utf8")));
    expect(hits).toEqual([]);
  });
}

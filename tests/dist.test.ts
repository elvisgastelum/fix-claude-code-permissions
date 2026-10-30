import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist", "cli.mjs");

test("the committed bundle runs on Node alone: it imports only node: modules", () => {
  const source = readFileSync(dist, "utf8");
  expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
  const specifiers = [...source.matchAll(/^import .*? from "([^"]+)";?$/gm)].map((m) => m[1]);
  expect(specifiers.length).toBeGreaterThan(0);
  expect(specifiers.filter((s) => !s?.startsWith("node:"))).toEqual([]);
});

test("the committed bundle is up to date with src/ (run `vp pack` and commit dist/)", () => {
  const out = mkdtempSync(join(tmpdir(), "fcc-dist-"));
  try {
    execFileSync(join(root, "node_modules", ".bin", "vp"), ["pack", "--out-dir", out], {
      cwd: root,
      stdio: "pipe",
    });
    expect(readFileSync(join(out, "cli.mjs"), "utf8")).toBe(readFileSync(dist, "utf8"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);

import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/cli.ts"],
    format: ["esm"],
    platform: "node",
    dts: false,
    // dist/cli.mjs is committed and must run with Node alone: bundle every dependency.
    deps: { alwaysBundle: [/.*/] },
  },
  test: { include: ["tests/**/*.test.ts"] },
  lint: { ignorePatterns: ["dist/**"], options: { typeAware: true, typeCheck: true } },
  fmt: { ignorePatterns: ["dist/**"] },
});

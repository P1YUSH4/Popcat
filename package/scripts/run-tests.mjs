// Compile the TS tests with esbuild (already a dep) and run them through
// Node's built-in test runner — no test framework needed.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";

rmSync("dist-test", { recursive: true, force: true });
mkdirSync("dist-test", { recursive: true });

await build({
  entryPoints: ["tests/timers.test.ts", "tests/stateMachine.test.ts", "tests/affect.test.ts"],
  outdir: "dist-test",
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node20"],
  outExtension: { ".js": ".mjs" },   // so Node loads them as ES modules
  logLevel: "warning",
});

execFileSync("node", ["--test", "dist-test/timers.test.mjs", "dist-test/stateMachine.test.mjs", "dist-test/affect.test.mjs"],
  { stdio: "inherit" });

// Bundles the three entry points with esbuild.
// - main + preload: node platform, electron kept external (loaded at runtime)
// - renderer: browser platform, bundled for the BrowserWindow
import { build, context } from "esbuild";
import { cpSync, mkdirSync, existsSync } from "node:fs";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  target: ["es2020"],
};

const targets = [
  { entryPoints: ["src/main/main.ts"], outfile: "dist/main.js", platform: "node", external: ["electron", "uiohook-napi"] },
  { entryPoints: ["src/preload/preload.ts"], outfile: "dist/preload.js", platform: "node", external: ["electron"] },
  { entryPoints: ["src/renderer/index.ts"], outfile: "dist/renderer.js", platform: "browser" },
  { entryPoints: ["src/renderer/settings.ts"], outfile: "dist/settings.js", platform: "browser" },
];

function copyStatic() {
  mkdirSync("dist/assets/sprites", { recursive: true });
  cpSync("src/renderer/index.html", "dist/index.html");
  cpSync("src/renderer/settings.html", "dist/settings.html");
  cpSync("assets/sprites/pao.png", "dist/assets/sprites/pao.png");
  cpSync("assets/sprites/pao.json", "dist/assets/sprites/pao.json");
  cpSync("assets/sprites/tray.png", "dist/assets/sprites/tray.png");
  // optional illustrated-cat images (only if prepared)
  for (const f of ["cat_idle.png", "cat_blink.png", "cat_happy.png", "cat_sleep.png"]) {
    const src = `assets/sprites/${f}`;
    if (existsSync(src)) cpSync(src, `dist/assets/sprites/${f}`);
  }
}

if (watch) {
  for (const t of targets) {
    const ctx = await context({ ...common, ...t });
    await ctx.watch();
  }
  copyStatic();
  console.log("watching…");
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t })));
  copyStatic();
  console.log("build complete");
}

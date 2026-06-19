#!/usr/bin/env node
// pao — tiny CLI that makes the Pao desktop cat react to your dev workflow.
// It just pings the running app's local control server; if the cat isn't
// running, every call fails silently so it never blocks your tooling.
//
//   pao celebrate "Tests passed"      one-off reaction (+ optional bubble msg)
//   pao worried   "Build failed"
//   pao run npm test                  think while it runs; celebrate/worried on exit
//   pao hooks install                 wire git events (commit/push/merge/checkout)
//   pao hooks uninstall
//
// Reaction types: celebrate | worried | alert | think | confused | angry
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const PORT = process.env.PAO_PORT || 39127;
const BASE = `http://127.0.0.1:${PORT}`;
const MARK = "# pao-hook";

async function ping(type, msg) {
  const u = new URL(BASE + "/react");
  u.searchParams.set("type", type);
  if (msg) u.searchParams.set("msg", msg);
  try { await fetch(u, { signal: AbortSignal.timeout(1500) }); } catch { /* cat not running */ }
}

function help() {
  console.log(`pao — make the Pao desktop cat react to your dev workflow

  pao <type> [message]     react now: celebrate | worried | frustrated | alert | think | confused
  pao run <command...>     think while it runs, then celebrate (exit 0) or frustrated (non-zero)
  pao git <args...>        transparent git proxy: push/commit/merge -> celebrate, failure -> frustrated
                           (tip: alias git='pao git' to make every push celebrate)
  pao bug [message]        the cat gets frustrated about a bug
  pao hooks install        install git hooks (commit/push/merge/branch-switch) in this repo
  pao hooks uninstall      remove pao git hooks
  pao claude-hooks         Claude Code: prompt -> think, answer -> alert (~/.claude/settings.json)

Examples
  pao run npm test
  pao celebrate "Deployed 🎉"
  pao hooks install`);
}

const HOOKS = {
  "post-commit": `type=celebrate&msg=Committed%20%E2%9C%85`,
  "pre-push":    `type=alert&msg=Pushing%E2%80%A6`,
  "post-merge":  `type=celebrate&msg=Merged`,
  // post-checkout only reacts on a branch switch ($3 == 1)
  "post-checkout": null,
};

function hooksDir() {
  const dir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).trim();
  return dir;
}

function installHooks() {
  let dir;
  try { dir = hooksDir(); } catch { console.error("Not a git repository."); process.exit(1); }
  for (const [name, query] of Object.entries(HOOKS)) {
    const file = join(dir, name);
    if (existsSync(file) && !readFileSync(file, "utf8").includes(MARK)) {
      console.warn(`skip ${name}: a non-pao hook already exists (left untouched)`);
      continue;
    }
    const body = name === "post-checkout"
      ? `#!/bin/sh\n${MARK}\n[ "$3" = "1" ] && curl -s --max-time 1 "${BASE}/react?type=confused&msg=Switched%20branch" >/dev/null 2>&1\nexit 0\n`
      : `#!/bin/sh\n${MARK}\ncurl -s --max-time 1 "${BASE}/react?${query}" >/dev/null 2>&1\nexit 0\n`;
    writeFileSync(file, body);
    try { chmodSync(file, 0o755); } catch { /* windows */ }
    console.log(`installed ${name}`);
  }
  console.log("Done. Commit/push/merge/branch-switch will now nudge Pao.");
}

function uninstallHooks() {
  let dir;
  try { dir = hooksDir(); } catch { console.error("Not a git repository."); process.exit(1); }
  for (const name of Object.keys(HOOKS)) {
    const file = join(dir, name);
    if (existsSync(file) && readFileSync(file, "utf8").includes(MARK)) {
      rmSync(file); console.log(`removed ${name}`);
    }
  }
}

// Install/remove Claude Code hooks so a prompt -> think and a finished answer
// -> alert. Edits the user's ~/.claude/settings.json (their explicit action).
function claudeHooks(action) {
  const p = join(homedir(), ".claude", "settings.json");
  let cfg = {};
  if (existsSync(p)) { try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { console.error("Could not parse " + p); process.exit(1); } }
  cfg.hooks = cfg.hooks || {};
  const want = { UserPromptSubmit: "type=think&msg=Thinking%E2%80%A6", Stop: "type=alert&msg=Answer%20ready" };
  if (action === "uninstall") {
    for (const ev of Object.keys(want)) {
      if (Array.isArray(cfg.hooks[ev])) cfg.hooks[ev] = cfg.hooks[ev].filter((g) => !JSON.stringify(g).includes("/react?type="));
      if (cfg.hooks[ev] && cfg.hooks[ev].length === 0) delete cfg.hooks[ev];
    }
    writeFileSync(p, JSON.stringify(cfg, null, 2));
    console.log(`Removed Pao hooks from ${p}. Restart Claude Code.`);
    return;
  }
  for (const [ev, q] of Object.entries(want)) {
    cfg.hooks[ev] = cfg.hooks[ev] || [];
    if (!JSON.stringify(cfg.hooks[ev]).includes("/react?type="))
      cfg.hooks[ev].push({ hooks: [{ type: "command", command: `curl -s --max-time 2 "${BASE}/react?${q}"` }] });
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  console.log(`Installed Pao hooks in ${p}:\n  UserPromptSubmit → think,  Stop → alert\nRestart your Claude Code session to activate.`);
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  help();
} else if (cmd === "run") {
  const command = rest.join(" ");
  if (!command) { console.error("usage: pao run <command...>"); process.exit(1); }
  await ping("think", `Running: ${rest[0]}…`);
  const t0 = Date.now();
  const child = spawn(command, { stdio: "inherit", shell: true });
  child.on("exit", async (code) => {
    const secs = Math.round((Date.now() - t0) / 1000);
    if (code === 0) await ping("celebrate", `✓ ${rest[0]} passed (${secs}s)`);
    else await ping("frustrated", `✗ ${rest[0]} failed (exit ${code}) 🐛`);   // hit a bug
    process.exit(code ?? 0);
  });
} else if (cmd === "git") {
  // transparent git proxy that reacts to the outcome (alias git='pao git').
  const sub = rest[0] || "";
  const child = spawn("git", rest, { stdio: "inherit" });   // real git binary, no alias recursion
  child.on("exit", async (code) => {
    if (code === 0) {
      if (sub === "push") await ping("celebrate", "Pushed successfully! 🚀");
      else if (sub === "commit") await ping("celebrate", "Committed ✅");
      else if (sub === "merge") await ping("celebrate", "Merged ✅");
      // other git commands: stay quiet on success
    } else {
      if (sub === "push") await ping("frustrated", "Push rejected 🐛");
      else await ping("frustrated", `git ${sub} failed 🐛`);
    }
    process.exit(code ?? 0);
  });
} else if (cmd === "bug") {
  await ping("frustrated", rest.join(" "));   // optional message; cat adds a quip if empty
} else if (cmd === "hooks") {
  if (rest[0] === "install") installHooks();
  else if (rest[0] === "uninstall") uninstallHooks();
  else console.error("usage: pao hooks <install|uninstall>");
} else if (cmd === "claude-hooks") {
  claudeHooks(rest[0] === "uninstall" ? "uninstall" : "install");
} else {
  await ping(cmd, rest.join(" "));
}

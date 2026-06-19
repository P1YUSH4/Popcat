import { app, BrowserWindow, screen, ipcMain, Tray, Menu, protocol, net, nativeImage } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Allow timer-triggered WebAudio (reminder chimes) to play without a click.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Local control port for external tools (e.g. Claude Code hooks) to drive the
// cat: GET /think -> pondering loop, /alert -> "answer ready", /idle -> settle.
const CONTROL_PORT = 39127;

// A privileged custom scheme so the renderer can fetch() its JSON metadata
// (Chromium blocks fetch() over file://). Must be registered before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let tray: Tray | null = null;

// Cat hitbox in screen coordinates, kept in sync by the renderer so we can
// make the transparent overlay click-through everywhere EXCEPT over the cat.
let hitbox: { x: number; y: number; w: number; h: number } | null = null;
let interacting = false; // true while the cursor is over the cat (mouse captured)
let draggingActive = false; // true while the cat is being dragged (keep capture)

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  win = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL("app://bundle/index.html");

  // Tell the renderer where the overlay sits on the virtual screen.
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("display-info", { originX: x, originY: y, width, height });
  });

  // stop the cursor timer and drop the reference when the window goes away
  win.on("closed", () => {
    if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null; }
    win = null;
  });

  startCursorLoop();
  startKeyboardHook();
  startWindowWatch();
}

// ---- optional foreground-window watcher (ambient perception) -------------
// Pao reads your *rhythm*, not your screen: this reports only the active
// window's title (for app-switch frequency), never its contents. Windows-only,
// dependency-free (a single long-lived PowerShell calling Win32). If it can't
// start, perception simply runs without the app signal.
let fgProc: ChildProcess | null = null;
function startWindowWatch() {
  let cmd: string, args: string[];
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "Add-Type @\"",
      "using System;using System.Runtime.InteropServices;using System.Text;",
      "public class Fg{",
      " [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
      " [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);}",
      "\"@",
      "$last=''",
      "while($true){",
      " $h=[Fg]::GetForegroundWindow();$sb=New-Object System.Text.StringBuilder 512;",
      " [void][Fg]::GetWindowText($h,$sb,512);$t=$sb.ToString();",
      " if($t -ne $last){$last=$t;[Console]::Out.WriteLine($t)}",
      " Start-Sleep -Milliseconds 2000}",
    ].join("\n");
    try {
      const file = join(tmpdir(), "pao-fgwatch.ps1");
      writeFileSync(file, script, "utf8");
    } catch (e) { console.warn("[pao] window watcher failed:", (e as Error).message); return; }
    cmd = "powershell";
    args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(tmpdir(), "pao-fgwatch.ps1")];
  } else if (process.platform === "darwin") {
    // macOS: poll the frontmost app name (needs Automation permission for
    // System Events on first run). App name only — never window content.
    const osa = "tell application \"System Events\" to get name of first application process whose frontmost is true";
    cmd = "/bin/sh";
    args = ["-c", `while true; do osascript -e '${osa}' 2>/dev/null; sleep 2; done`];
  } else {
    return;   // linux: no active-window watcher yet
  }
  try {
    fgProc = spawn(cmd, args, { windowsHide: true });
    let last = "";
    fgProc.stdout?.setEncoding("utf8");
    fgProc.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const t = line.trim();
        if (t && t !== last) { last = t; win?.webContents.send("app-focus", t); }
      }
    });
    fgProc.on("error", (e) => console.warn("[pao] window watcher unavailable:", e.message));
    console.log(`[pao] foreground-window watcher active (${process.platform}; app/title only, never content)`);
  } catch (e) {
    console.warn("[pao] window watcher failed:", (e as Error).message);
  }
}

// ---- global cursor polling (no native deps) -----------------------------
let cursorTimer: NodeJS.Timeout | null = null;
function startCursorLoop() {
  cursorTimer = setInterval(() => {
    // bail if the window is gone or being torn down (avoids
    // "Object has been destroyed" when the timer outlives the window)
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    win.webContents.send("cursor", { x: p.x, y: p.y });

    // while dragging, keep the mouse captured even if the cat lags behind the
    // cursor (spring follow) — otherwise the window would go click-through and
    // the drag would drop mid-swing.
    if (draggingActive) {
      if (!interacting) { interacting = true; win.setIgnoreMouseEvents(false); }
      return;
    }

    // toggle click-through based on whether the cursor is over the cat
    const over =
      !!hitbox &&
      p.x >= hitbox.x && p.x <= hitbox.x + hitbox.w &&
      p.y >= hitbox.y && p.y <= hitbox.y + hitbox.h;

    if (over && !interacting) {
      interacting = true;
      win.setIgnoreMouseEvents(false);
    } else if (!over && interacting) {
      interacting = false;
      win.setIgnoreMouseEvents(true, { forward: true });
    }
  }, 1000 / 60);
}

// ---- optional global keyboard hook --------------------------------------
let keyboardHookActive = false;
function startKeyboardHook() {
  try {
    // optionalDependency: only present if it installed/compiled successfully
    const { uIOhook } = require("uiohook-napi");
    uIOhook.on("keydown", () => win?.webContents.send("key-activity"));
    uIOhook.on("wheel", (e: { rotation?: number }) =>
      win?.webContents.send("scroll-activity", e?.rotation ?? 0));
    uIOhook.start();
    keyboardHookActive = true;
    app.on("before-quit", () => { try { uIOhook.stop(); } catch { /* noop */ } });
    console.log("[pao] global keyboard hook active");
  } catch (e) {
    keyboardHookActive = false;
    console.warn("[pao] uiohook-napi unavailable — typing/scroll reactions are OFF "
      + "(drag, hover, pet, sleep still work). Reinstall with: npm i uiohook-napi", (e as Error).message);
  }
}

// renderer pushes the cat hitbox every frame (throttled on its side)
ipcMain.on("hitbox", (_e, box) => { hitbox = box; });
ipcMain.on("dragging", (_e, v: boolean) => { draggingActive = v; });
// renderer pushes its mood/perception snapshot; served on GET /state
let latestState: unknown = null;
ipcMain.on("affect-state", (_e, s) => { latestState = s; });
// settings window -> overlay (custom pomodoro / meeting)
ipcMain.on("set-pomodoro", (_e, cfg) => win?.webContents.send("set-pomodoro", cfg));
ipcMain.on("set-meeting", (_e, cfg) => win?.webContents.send("set-meeting", cfg));
ipcMain.on("ui-name", (_e, name: string) => win?.webContents.send("apply-name", name));
ipcMain.on("ui-coat", (_e, name: string) => win?.webContents.send("do", `coat:${name}`));
ipcMain.on("ui-accessory", (_e, name: string) => win?.webContents.send("do", `acc:${name}`));
ipcMain.handle("get-status", () => latestState ?? {});

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 340, height: 680, resizable: true, title: "Pao — Settings",
    skipTaskbar: false, alwaysOnTop: true, fullscreenable: false, minimizable: false,
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadURL("app://bundle/settings.html");
  settingsWin.on("closed", () => { settingsWin = null; });
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(join(__dirname, "assets/sprites/tray.png"));
    tray = new Tray(icon.isEmpty() ? join(__dirname, "assets/sprites/tray.png") : icon);
    const menu = Menu.buildFromTemplate([
      { label: "Pao is here 🐾", enabled: false },
      { label: keyboardHookActive ? "⌨ typing/scroll: on" : "⌨ typing/scroll: OFF (no hook)", enabled: false },
      { type: "separator" },
      { label: "Stretch now", click: () => win?.webContents.send("do", "stretch") },
      { label: "Jump", click: () => win?.webContents.send("do", "jump") },
      { label: "Confused", click: () => win?.webContents.send("do", "confused") },
      { label: "Angry", click: () => win?.webContents.send("do", "angry") },
      { type: "separator" },
      { label: "Thinking… (demo)", click: () => win?.webContents.send("do", "thinking") },
      { label: "Answer ready! (demo)", click: () => win?.webContents.send("do", "answerready") },
      { label: "Celebrate (demo)", click: () => win?.webContents.send("do", "celebrate") },
      { label: "Worried (demo)", click: () => win?.webContents.send("do", "worried") },
      { label: "Hydration nudge", click: () => win?.webContents.send("do", "hydrate") },
      { type: "separator" },
      {
        label: "Coat colour",
        submenu: [
          { label: "Midnight (Jiji)", click: () => win?.webContents.send("do", "coat:default") },
          { label: "Ash Grey", click: () => win?.webContents.send("do", "coat:ash") },
          { label: "Warm Grey", click: () => win?.webContents.send("do", "coat:warmgrey") },
          { label: "Caramel", click: () => win?.webContents.send("do", "coat:caramel") },
          { label: "Slate Blue", click: () => win?.webContents.send("do", "coat:slate") },
          { label: "Chocolate", click: () => win?.webContents.send("do", "coat:chocolate") },
          { label: "Moss", click: () => win?.webContents.send("do", "coat:moss") },
          { label: "Plum", click: () => win?.webContents.send("do", "coat:plum") },
        ],
      },
      {
        label: "Accessory",
        submenu: [
          { label: "None", click: () => win?.webContents.send("do", "acc:none") },
          { label: "Pink Bow", click: () => win?.webContents.send("do", "acc:bow") },
          { label: "Cozy Scarf", click: () => win?.webContents.send("do", "acc:scarf") },
          { label: "Party Hat", click: () => win?.webContents.send("do", "acc:hat") },
          { label: "Gold Crown", click: () => win?.webContents.send("do", "acc:crown") },
        ],
      },
      { type: "separator" },
      { label: "Custom timers…", click: () => openSettings() },
      { label: "Start Pomodoro (25/5)", click: () => win?.webContents.send("do", "pomo:start") },
      { label: "Stop Pomodoro", click: () => win?.webContents.send("do", "pomo:stop") },
      {
        label: "Meeting reminder",
        submenu: [
          { label: "In 5 min", click: () => win?.webContents.send("do", "meeting:5") },
          { label: "In 10 min", click: () => win?.webContents.send("do", "meeting:10") },
          { label: "In 15 min", click: () => win?.webContents.send("do", "meeting:15") },
          { label: "In 30 min", click: () => win?.webContents.send("do", "meeting:30") },
          { type: "separator" },
          { label: "Ring now (demo)", click: () => win?.webContents.send("do", "meeting:0") },
        ],
      },
      { label: "Back-to-focus (demo)", click: () => win?.webContents.send("do", "focus") },
      { type: "separator" },
      { label: "Wander mode (walk around)", type: "checkbox", checked: false,
        click: (mi) => win?.webContents.send("do", `autonomous:${mi.checked ? "on" : "off"}`) },
      { label: "Peek at screen edge", type: "checkbox", checked: false,
        click: (mi) => win?.webContents.send("do", `peek:${mi.checked ? "on" : "off"}`) },
      { label: "Mute sounds", type: "checkbox", checked: false,
        click: (mi) => win?.webContents.send("do", `mute:${mi.checked ? "on" : "off"}`) },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]);
    tray.setToolTip("Pao");
    tray.setContextMenu(menu);
  } catch { /* tray icon optional */ }
}

// ---- local control server (Claude Code hooks etc.) ----------------------
let ctrl: Server | null = null;
function startControlServer() {
  try {
    ctrl = createServer((req, res) => {
      const path = (req.url || "").split("?")[0];
      if (path.startsWith("/state")) {                 // live mood/perception JSON
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(latestState ?? {}));
        return;
      }
      if (path.startsWith("/coat")) {                  // /coat?name=ginger
        const name = new URL(req.url || "", "http://x").searchParams.get("name") || "default";
        win?.webContents.send("do", `coat:${name}`);
      }
      else if (path.startsWith("/name")) {             // /name?value=Mochi
        const v = new URL(req.url || "", "http://x").searchParams.get("value") || "";
        win?.webContents.send("apply-name", v);
      }
      else if (path.startsWith("/accessory")) {        // /accessory?name=bow
        const name = new URL(req.url || "", "http://x").searchParams.get("name") || "none";
        win?.webContents.send("do", `acc:${name}`);
      }
      else if (path.startsWith("/throw")) win?.webContents.send("do", "throw");
      else if (path.startsWith("/think")) win?.webContents.send("do", "thinking");
      else if (path.startsWith("/alert")) win?.webContents.send("do", "answerready");
      else if (path.startsWith("/celebrate")) win?.webContents.send("do", "celebrate");
      else if (path.startsWith("/oops")) win?.webContents.send("do", "worried");
      else if (path.startsWith("/hydrate")) win?.webContents.send("do", "hydrate");
      else if (path.startsWith("/pomodoro")) win?.webContents.send("do", "pomo:start");
      else if (path.startsWith("/meeting")) {
        const m = parseInt(new URL(req.url || "", "http://x").searchParams.get("mins") || "0", 10);
        win?.webContents.send("do", `meeting:${isNaN(m) ? 0 : m}`);
      }
      else if (path.startsWith("/settings")) openSettings();
      else if (path.startsWith("/idle")) win?.webContents.send("do", "idle");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    ctrl.on("error", (e) => console.warn("[pao] control server unavailable:", (e as Error).message));
    ctrl.listen(CONTROL_PORT, "127.0.0.1", () =>
      console.log(`[pao] control server on http://127.0.0.1:${CONTROL_PORT} (/state /think /alert /celebrate /oops /hydrate /idle)`));
  } catch (e) {
    console.warn("[pao] control server failed:", (e as Error).message);
  }
}

app.whenReady().then(() => {
  // Serve bundled files (dist/) over app://bundle/...
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    const filePath = join(__dirname, pathname);
    return net.fetch(pathToFileURL(filePath).toString());
  });

  if (process.platform === "darwin") app.dock?.hide();
  createWindow();
  createTray();
  startControlServer();
});

app.on("before-quit", () => {
  try { ctrl?.close(); } catch { /* noop */ }
  try { fgProc?.kill(); } catch { /* noop */ }
});
app.on("window-all-closed", () => app.quit());

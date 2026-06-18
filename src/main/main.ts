import { app, BrowserWindow, screen, ipcMain, Tray, Menu, protocol, net, nativeImage } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type Server } from "node:http";

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
// settings window -> overlay (custom pomodoro / meeting)
ipcMain.on("set-pomodoro", (_e, cfg) => win?.webContents.send("set-pomodoro", cfg));
ipcMain.on("set-meeting", (_e, cfg) => win?.webContents.send("set-meeting", cfg));

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 320, height: 430, resizable: false, title: "Pao — Timers",
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
      if (path.startsWith("/think")) win?.webContents.send("do", "thinking");
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
      console.log(`[pao] control server on http://127.0.0.1:${CONTROL_PORT} (/think /alert /celebrate /oops /hydrate /idle)`));
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

app.on("before-quit", () => { try { ctrl?.close(); } catch { /* noop */ } });
app.on("window-all-closed", () => app.quit());

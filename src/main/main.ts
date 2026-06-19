import { app, BrowserWindow, screen, ipcMain, Tray, Menu, protocol, net, nativeImage } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

// Allow timer-triggered WebAudio (reminder chimes) to play without a click.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// --- keep the footprint small (this is an always-on dev companion) ---
// Cap the JS heaps and drop Chromium features we never use. (Hardware accel is
// kept ON: for a transparent full-screen overlay, software compositing costs
// MORE CPU; the win comes from the adaptive frame-rate instead.)
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=96 --max-semi-space-size=2");
app.commandLine.appendSwitch("disable-features",
  "Translate,MediaRouter,DialMediaRouteProvider,OptimizationHints,CalculateNativeWinOcclusion");
// run GPU work in the browser process instead of a separate GPU process (one
// fewer Chromium process for this tiny overlay).
app.commandLine.appendSwitch("in-process-gpu");

// Local control port for external tools (e.g. Claude Code hooks) to drive the
// cat: GET /think -> pondering loop, /alert -> "answer ready", /idle -> settle.
const CONTROL_PORT = 39127;

// ---- persisted config (userData/pao-config.json) ------------------------
interface PaoConfig {
  name: string;
  furId: string;                                 // appearance: fur preset id
  bellColor: string;                             // appearance: bell color id (or "hide")
  sound: { muted: boolean; volume: number };   // volume 0..1
  sleepMin: number;                              // idle -> sleep, minutes
  hydrationMin: number;                          // 0 = off
  leisureNudge: boolean;
  contextEnabled: boolean;                       // privacy: read the focused window?
  contextRules: { pattern: string; mode: string }[];   // user rules (checked first)
  autostart: boolean;
  firstRunDone: boolean;
}
const DEFAULT_CONFIG: PaoConfig = {
  name: "Pao", furId: "classic", bellColor: "gold",
  sound: { muted: false, volume: 1 }, sleepMin: 1, hydrationMin: 15,
  leisureNudge: true, contextEnabled: true, contextRules: [], autostart: false, firstRunDone: false,
};
let config: PaoConfig = { ...DEFAULT_CONFIG };
const configPath = () => join(app.getPath("userData"), "pao-config.json");
function loadConfig() {
  try { config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath(), "utf8")) }; }
  catch { config = { ...DEFAULT_CONFIG }; }
}
function saveConfig() { try { writeFileSync(configPath(), JSON.stringify(config, null, 2)); } catch { /* noop */ } }
function broadcastConfig() {
  win?.webContents.send("config", config);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("config", config);
  if (onboardingWin && !onboardingWin.isDestroyed()) onboardingWin.webContents.send("config", config);
}
function applyConfigMain() {
  try { app.setLoginItemSettings({ openAtLogin: config.autostart }); } catch { /* noop */ }
  if (tray && !tray.isDestroyed()) tray.setToolTip(config.name || "Pao");
  ensureActiveWindow();
}

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
let onboardingWin: BrowserWindow | null = null;
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
      spellcheck: false,
      backgroundThrottling: false,   // never focused; keep the cat animating
      v8CacheOptions: "none",
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL("app://bundle/index.html");

  // Tell the renderer where the overlay sits on the virtual screen + its config.
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("display-info", { originX: x, originY: y, width, height });
    win?.webContents.send("config", config);
  });

  // stop the cursor timer and drop the reference when the window goes away
  win.on("closed", () => {
    if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null; }
    if (awTimer) { clearInterval(awTimer); awTimer = null; }
    win = null;
  });

  startCursorLoop();
  startKeyboardHook();
  ensureActiveWindow();
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

    // While the user is scrolling, stay click-through even over the cat so the
    // wheel reaches the app underneath (the cat still reacts to scroll via the
    // global hook — capturing the wheel here would only block the user's work).
    const scrolling = Date.now() < wheelPassUntil;

    if (over && !interacting && !scrolling) {
      interacting = true;
      win.setIgnoreMouseEvents(false);
    } else if ((!over || scrolling) && interacting) {
      interacting = false;
      win.setIgnoreMouseEvents(true, { forward: true });
    }
  }, 1000 / 60);
}

// Set by the wheel hook: keep the overlay click-through until this time so the
// user can scroll the app even with the cursor over the cat.
let wheelPassUntil = 0;

// ---- optional global keyboard hook --------------------------------------
let keyboardHookActive = false;
function startKeyboardHook() {
  try {
    // optionalDependency: only present if it installed/compiled successfully
    const { uIOhook } = require("uiohook-napi");
    uIOhook.on("keydown", () => win?.webContents.send("key-activity"));
    uIOhook.on("wheel", (e: { rotation?: number }) => {
      win?.webContents.send("scroll-activity", e?.rotation ?? 0);
      // Hand the wheel back to the app: drop capture now (and keep it dropped
      // briefly) so scrolling works even with the cursor over the cat.
      wheelPassUntil = Date.now() + 500;
      if (interacting && !draggingActive && win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        interacting = false;
        win.setIgnoreMouseEvents(true, { forward: true });
      }
    });
    // Safety net for the drag/capture state: a real button release ALWAYS fires
    // on this global hook even if the overlay went click-through and the window
    // never saw the mouseup — so capture can never get stuck "on" (which froze
    // scrolling/input until the next click).
    uIOhook.on("mouseup", () => {
      if (draggingActive) {
        draggingActive = false;
        win?.webContents.send("drag-cancel");   // make the renderer drop its drag too
      }
    });
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

// ---- optional active-window awareness (what app/site is focused) ---------
// get-windows is ESM-only; load it via a runtime dynamic import so the CJS
// bundler can't rewrite it to require(). Falls back to off if unavailable.
let awTimer: NodeJS.Timeout | null = null;
let awStarting = false;
function ensureActiveWindow() {
  if (!config.contextEnabled) { if (awTimer) { clearInterval(awTimer); awTimer = null; } return; }
  if (awTimer || awStarting) return;
  startActiveWindowLoop();
}
async function startActiveWindowLoop() {
  awStarting = true;
  let activeWindow: (() => Promise<{ title?: string; owner?: { name?: string } } | undefined>) | null = null;
  try {
    const dynImport = new Function("s", "return import(s)") as (s: string) => Promise<{ activeWindow: typeof activeWindow }>;
    activeWindow = (await dynImport("get-windows")).activeWindow;
  } catch {
    awStarting = false;
    console.warn("[pao] get-windows unavailable — context awareness off (npm i get-windows)");
    return;
  }
  awStarting = false;
  console.log("[pao] active-window context awareness on");
  let busy = false, lastSig = "";
  awTimer = setInterval(async () => {
    if (busy || !win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    busy = true;
    try {
      const w = await activeWindow!();
      const app = w?.owner?.name || "", title = w?.title || "";
      const sig = `${app}|${title}`;
      if (sig !== lastSig) { lastSig = sig; win.webContents.send("active-window", { app, title }); }
    } catch { /* ignore transient errors */ }
    busy = false;
  }, 1500);
}

// renderer pushes the cat hitbox every frame (throttled on its side)
ipcMain.on("hitbox", (_e, box) => { hitbox = box; });
ipcMain.on("dragging", (_e, v: boolean) => { draggingActive = v; });
// settings window -> overlay (custom pomodoro / meeting)
ipcMain.on("set-pomodoro", (_e, cfg) => win?.webContents.send("set-pomodoro", cfg));
ipcMain.on("set-meeting", (_e, cfg) => win?.webContents.send("set-meeting", cfg));
ipcMain.on("pomo-state", (_e, s) => { pomoState = s; refreshTray(); });
// persisted settings: settings window reads/writes; both windows get broadcasts
ipcMain.handle("get-config", () => config);
ipcMain.on("set-config", (_e, patch: Partial<PaoConfig>) => {
  config = { ...config, ...patch };
  if (patch.sound) config.sound = { ...config.sound, ...patch.sound };
  saveConfig(); applyConfigMain(); broadcastConfig();
});

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 360, height: 620, resizable: true, title: "Pao — Settings",
    skipTaskbar: false, alwaysOnTop: true, fullscreenable: false, minimizable: false,
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadURL("app://bundle/settings.html");
  settingsWin.webContents.on("did-finish-load", () => settingsWin?.webContents.send("config", config));
  settingsWin.on("closed", () => { settingsWin = null; });
}

// First-run (and re-openable) "adopt your cat": pick fur color, bell, and name.
function openOnboarding() {
  if (onboardingWin && !onboardingWin.isDestroyed()) { onboardingWin.focus(); return; }
  onboardingWin = new BrowserWindow({
    width: 440, height: 620, resizable: true, title: "Welcome to Pao",
    skipTaskbar: false, alwaysOnTop: true, fullscreenable: false, minimizable: false,
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  onboardingWin.setMenuBarVisibility(false);
  onboardingWin.loadURL("app://bundle/onboarding.html");
  onboardingWin.webContents.on("did-finish-load", () => {
    onboardingWin?.webContents.send("config", config);
    onboardingWin?.show();   // ensure it surfaces above the always-on-top overlay
    onboardingWin?.focus();
  });
  onboardingWin.on("closed", () => { onboardingWin = null; });
}
// renderer finished onboarding -> close the window and have the cat say hi
ipcMain.on("onboarding-done", () => {
  if (onboardingWin && !onboardingWin.isDestroyed()) onboardingWin.close();
  win?.webContents.send("react", { type: "celebrate", msg: `Hi! I'm ${config.name || "Pao"} 🐾` });
});

// Pomodoro state mirrored from the renderer so the tray can reflect it.
let pomoState = { on: false, paused: false, phase: "" };
const sendDo = (action: string) => win?.webContents.send("do", action);

function buildTrayMenu(): Electron.MenuItemConstructorOptions[] {
  const pomo: Electron.MenuItemConstructorOptions[] = !pomoState.on
    ? [{ label: "Start Pomodoro (25/5)", click: () => sendDo("pomo:start") }]
    : [
        { label: `▸ ${pomoState.paused ? "Paused — " : ""}${pomoState.phase}`, enabled: false },
        pomoState.paused
          ? { label: "Resume Pomodoro", click: () => sendDo("pomo:resume") }
          : { label: "Pause Pomodoro", click: () => sendDo("pomo:pause") },
        { label: "Skip phase", click: () => sendDo("pomo:skip") },
        { label: "Stop Pomodoro", click: () => sendDo("pomo:stop") },
      ];
  return [
    { label: "Pao is here 🐾", enabled: false },
    { label: keyboardHookActive ? "⌨ typing/scroll: on" : "⌨ typing/scroll: OFF (no hook)", enabled: false },
    { type: "separator" },
    { label: "Stretch now", click: () => sendDo("stretch") },
    { label: "Jump", click: () => sendDo("jump") },
    { label: "Confused", click: () => sendDo("confused") },
    { label: "Angry", click: () => sendDo("angry") },
    { type: "separator" },
    { label: "Thinking… (demo)", click: () => sendDo("thinking") },
    { label: "Answer ready! (demo)", click: () => sendDo("answerready") },
    { label: "Celebrate (demo)", click: () => sendDo("celebrate") },
    { label: "Worried (demo)", click: () => sendDo("worried") },
    { label: "Hydration nudge", click: () => sendDo("hydrate") },
    { type: "separator" },
    { label: "Customize Pao…", click: () => openOnboarding() },
    { label: "Custom timers…", click: () => openSettings() },
    ...pomo,
    {
      label: "Meeting reminder",
      submenu: [
        { label: "In 5 min", click: () => sendDo("meeting:5") },
        { label: "In 10 min", click: () => sendDo("meeting:10") },
        { label: "In 15 min", click: () => sendDo("meeting:15") },
        { label: "In 30 min", click: () => sendDo("meeting:30") },
        { type: "separator" },
        { label: "Ring now (demo)", click: () => sendDo("meeting:0") },
      ],
    },
    { label: "Back-to-focus (demo)", click: () => sendDo("focus") },
    { type: "separator" },
    { label: "Mute sounds", type: "checkbox", checked: false,
      click: (mi) => sendDo(`mute:${mi.checked ? "on" : "off"}`) },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ];
}

function refreshTray() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu()));
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(join(__dirname, "assets/sprites/tray.png"));
    tray = new Tray(icon.isEmpty() ? join(__dirname, "assets/sprites/tray.png") : icon);
    tray.setToolTip(config.name || "Pao");
    refreshTray();
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
      else if (path.startsWith("/react")) {
        const u = new URL(req.url || "", "http://x");
        win?.webContents.send("react", { type: u.searchParams.get("type") || "alert", msg: u.searchParams.get("msg") || "" });
      }
      else if (path.startsWith("/settings")) openSettings();
      else if (path.startsWith("/customize")) openOnboarding();
      else if (path.startsWith("/idle")) win?.webContents.send("do", "idle");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    ctrl.on("error", (e) => console.warn("[pao] control server unavailable:", (e as Error).message));
    ctrl.listen(CONTROL_PORT, "127.0.0.1", () =>
      console.log(`[pao] control server on http://127.0.0.1:${CONTROL_PORT} (/react /think /alert /celebrate /oops /hydrate /pomodoro /meeting /idle)`));
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
  loadConfig();
  createWindow();
  createTray();
  startControlServer();
  applyConfigMain();   // autostart + context-poll honor the saved config
  if (!config.firstRunDone) openOnboarding();   // first launch: adopt your cat
});

app.on("before-quit", () => { try { ctrl?.close(); } catch { /* noop */ } });
app.on("window-all-closed", () => app.quit());

import { app, BrowserWindow, screen, ipcMain, Tray, Menu, protocol, nativeImage } from "electron";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
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

/** Union bounding box of ALL displays (the full virtual desktop), so the overlay
 *  spans every monitor and the cat can roam across them. Cursor coords from
 *  screen.getCursorScreenPoint() are already in this global space; the renderer
 *  subtracts the origin we send it. */
function virtualBounds() {
  const ds = screen.getAllDisplays();
  const minX = Math.min(...ds.map((d) => d.bounds.x));
  const minY = Math.min(...ds.map((d) => d.bounds.y));
  const maxX = Math.max(...ds.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...ds.map((d) => d.bounds.y + d.bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

async function createWindow() {
  const { x, y, width, height } = virtualBounds();

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

  // a monitor was added/removed/rearranged -> resize the overlay to the new
  // virtual desktop and tell the renderer its new origin/size.
  // display-metrics-changed fires rapidly (e.g. during DPI transitions), so
  // debounce with a short timer to coalesce the burst into one reflow.
  let reflowTimer: NodeJS.Timeout | null = null;
  const reflow = () => {
    if (reflowTimer) clearTimeout(reflowTimer);
    reflowTimer = setTimeout(() => {
      reflowTimer = null;
      if (!win || win.isDestroyed()) return;
      const b = virtualBounds();
      win.setBounds(b);
      win.webContents.send("display-info", { originX: b.x, originY: b.y, width: b.width, height: b.height });
    }, 60);
  };
  screen.on("display-added", reflow);
  screen.on("display-removed", reflow);
  screen.on("display-metrics-changed", reflow);

  startCursorLoop();
  startKeyboardHook();
  await startWindowWatch();
  await startWheelWatch();
}

// ---- optional foreground-window watcher (ambient perception) -------------
// Pao reads your *rhythm*, not your screen: this reports only the active
// window's title (for app-switch frequency), never its contents. Windows-only,
// dependency-free (a single long-lived PowerShell calling Win32). If it can't
// start, perception simply runs without the app signal.
let fgProc: ChildProcess | null = null;
async function startWindowWatch(): Promise<void> {
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
      // self-terminate if the parent (Electron) died, so we never orphan
      " if($env:PAO_PARENT -and -not (Get-Process -Id $env:PAO_PARENT -ErrorAction SilentlyContinue)){break}",
      " $h=[Fg]::GetForegroundWindow();$sb=New-Object System.Text.StringBuilder 512;",
      " [void][Fg]::GetWindowText($h,$sb,512);$t=$sb.ToString();",
      " if($t -ne $last){$last=$t;[Console]::Out.WriteLine($t)}",
      " Start-Sleep -Milliseconds 2000}",
    ].join("\n");
    const file = join(tmpdir(), "pao-fgwatch.ps1");
    try { await writeFile(file, script, "utf8"); }
    catch (e) { console.warn("[pao] window watcher failed:", (e as Error).message); return; }
    cmd = "powershell";
    args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file];
  } else if (process.platform === "darwin") {
    // macOS: poll the frontmost app name (needs Automation permission for
    // System Events on first run). App name only — never window content.
    const osa = "tell application \"System Events\" to get name of first application process whose frontmost is true";
    cmd = "/bin/sh";
    args = ["-c", `while true; do [ -n "$PAO_PARENT" ] && ! kill -0 "$PAO_PARENT" 2>/dev/null && exit 0; osascript -e '${osa}' 2>/dev/null; sleep 2; done`];
  } else {
    return;   // linux: no active-window watcher yet
  }
  try {
    fgProc = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PAO_PARENT: String(process.pid) } });
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

// ---- global scroll watcher (Windows, Raw Input) --------------------------
// uiohook-napi delivers mouse-move but NOT wheel on this class of Windows
// setup, and low-level mouse hooks (WH_MOUSE_LL) can't see PRECISION TRACKPAD
// scrolling at all (Windows routes it through DirectManipulation). So we use the
// Raw Input API (RIDEV_INPUTSINK on the mouse usage page) in a tiny C#/PowerShell
// helper with a message-only window — it sees BOTH a mouse wheel and two-finger
// trackpad scroll. It prints the signed wheel delta per scroll; main forwards it
// to the renderer on the same "scroll-activity" channel. Reads scroll deltas
// only — never window content. (Trackpads emit a flood of tiny inertial deltas,
// so forwarding is throttled below.)
let wheelProc: ChildProcess | null = null;
async function startWheelWatch(): Promise<void> {
  if (process.platform !== "win32") return;   // uiohook covers wheel on mac/linux
  const cs = `
using System;
using System.Runtime.InteropServices;
public class WheelRaw {
  const int WM_INPUT = 0x00FF;
  const uint RID_INPUT = 0x10000003;
  const uint RIDEV_INPUTSINK = 0x00000100;
  const ushort RI_MOUSE_WHEEL = 0x0400;
  static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);
  delegate IntPtr WndProc(IntPtr h, uint msg, IntPtr w, IntPtr l);
  static WndProc _proc = Proc;
  [StructLayout(LayoutKind.Sequential)] struct RAWINPUTDEVICE { public ushort usUsagePage; public ushort usUsage; public uint dwFlags; public IntPtr hwndTarget; }
  [StructLayout(LayoutKind.Sequential)] struct RAWINPUTHEADER { public uint dwType; public uint dwSize; public IntPtr hDevice; public IntPtr wParam; }
  [StructLayout(LayoutKind.Sequential)] struct RAWMOUSE { public ushort usFlags; public ushort _pad; public ushort usButtonFlags; public ushort usButtonData; public uint ulRawButtons; public int lLastX; public int lLastY; public uint ulExtraInformation; }
  [StructLayout(LayoutKind.Sequential)] struct RAWKEYBOARD { public ushort MakeCode; public ushort Flags; public ushort Reserved; public ushort VKey; public uint Message; public uint ExtraInformation; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct WNDCLASS { public uint style; public WndProc lpfnWndProc; public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground; public string lpszMenuName; public string lpszClassName; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptx; public int pty; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern ushort RegisterClassW(ref WNDCLASS c);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr p);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] d, uint num, uint size);
  [DllImport("user32.dll")] static extern uint GetRawInputData(IntPtr hRawInput, uint cmd, IntPtr data, ref uint size, uint hdrSize);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetMessageW(out MSG msg, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr DispatchMessageW(ref MSG m);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string n);
  [DllImport("user32.dll")] static extern uint GetRawInputDeviceInfoW(IntPtr h, uint cmd, IntPtr data, ref uint size);
  [DllImport("hid.dll")] static extern int HidP_GetUsageValue(int type, ushort page, ushort coll, ushort usage, out uint val, IntPtr pp, IntPtr report, uint len);
  static System.Collections.Generic.Dictionary<IntPtr,IntPtr> _pp = new System.Collections.Generic.Dictionary<IntPtr,IntPtr>();
  static IntPtr Pre(IntPtr h){ if(_pp.ContainsKey(h)) return _pp[h]; uint s=0; GetRawInputDeviceInfoW(h,0x20000005,IntPtr.Zero,ref s); IntPtr p=Marshal.AllocHGlobal((int)s); GetRawInputDeviceInfoW(h,0x20000005,p,ref s); _pp[h]=p; return p; }
  static IntPtr Proc(IntPtr h, uint msg, IntPtr w, IntPtr l) {
    if (msg == WM_INPUT) {
      uint size = 0; uint hsz = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));
      GetRawInputData(l, RID_INPUT, IntPtr.Zero, ref size, hsz);
      IntPtr buf = Marshal.AllocHGlobal((int)size);
      try {
        if (GetRawInputData(l, RID_INPUT, buf, ref size, hsz) == size) {
          RAWINPUTHEADER hdr = (RAWINPUTHEADER)Marshal.PtrToStructure(buf, typeof(RAWINPUTHEADER));
          if (hdr.dwType == 0) {
            RAWMOUSE m = (RAWMOUSE)Marshal.PtrToStructure((IntPtr)(buf.ToInt64()+(int)hsz), typeof(RAWMOUSE));
            if ((m.usButtonFlags & RI_MOUSE_WHEEL) != 0) { short d=(short)m.usButtonData; Console.Out.WriteLine("WHEEL "+d); Console.Out.Flush(); }
          } else if (hdr.dwType == 1) {
            RAWKEYBOARD k = (RAWKEYBOARD)Marshal.PtrToStructure((IntPtr)(buf.ToInt64()+(int)hsz), typeof(RAWKEYBOARD));
            if ((k.Flags & 1) == 0) { Console.Out.WriteLine("KEY"); Console.Out.Flush(); }   // keydown only; no key identity
          } else if (hdr.dwType == 2) {
            // precision-touchpad HID report. Read the Contact Count (HID usage
            // page 0x0D, usage 0x54): >=2 fingers = a scroll/zoom gesture; 1
            // finger = a cursor move/rest. Only 2+ fingers means "scrolling".
            long bp = buf.ToInt64() + (int)hsz;
            uint sizeHid = (uint)Marshal.ReadInt32((IntPtr)bp);
            IntPtr report = (IntPtr)(bp + 8);
            uint contacts = 0;
            HidP_GetUsageValue(0, 0x0D, 0, 0x54, out contacts, Pre(hdr.hDevice), report, sizeHid);
            // 2+ fingers = a scroll/zoom gesture. (A failed read leaves contacts
            // at 0, so we only emit on a real multi-finger gesture — no spam.)
            if (contacts >= 2) { Console.Out.WriteLine("SCROLL2"); Console.Out.Flush(); }
          }
        }
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return DefWindowProcW(h, msg, w, l);
  }
  public static void Run(int ppid) {
    // self-terminate if the parent (Electron) dies, so we never orphan a stuck
    // process holding a global Raw Input registration (even on a force-kill).
    if (ppid > 0) {
      System.Threading.Thread t = new System.Threading.Thread(delegate() {
        try { System.Diagnostics.Process.GetProcessById(ppid).WaitForExit(); } catch {}
        Environment.Exit(0);
      });
      t.IsBackground = true; t.Start();
    }
    WNDCLASS c = new WNDCLASS(); c.lpfnWndProc=_proc; c.hInstance=GetModuleHandleW(null); c.lpszClassName="PaoWheelRaw";
    RegisterClassW(ref c);
    IntPtr hwnd = CreateWindowExW(0,"PaoWheelRaw","",0,0,0,0,0,HWND_MESSAGE,IntPtr.Zero,c.hInstance,IntPtr.Zero);
    RAWINPUTDEVICE[] rid = new RAWINPUTDEVICE[3];
    rid[0].usUsagePage=0x01; rid[0].usUsage=0x02; rid[0].dwFlags=RIDEV_INPUTSINK; rid[0].hwndTarget=hwnd; // mouse (wheel)
    rid[1].usUsagePage=0x01; rid[1].usUsage=0x06; rid[1].dwFlags=RIDEV_INPUTSINK; rid[1].hwndTarget=hwnd; // keyboard
    rid[2].usUsagePage=0x0D; rid[2].usUsage=0x05; rid[2].dwFlags=RIDEV_INPUTSINK; rid[2].hwndTarget=hwnd; // precision touchpad
    RegisterRawInputDevices(rid,3,(uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
    MSG msg; while (GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessageW(ref msg); }
  }
}`;
  const script = ["$ErrorActionPreference='SilentlyContinue'", "Add-Type @'", cs, "'@",
    "[WheelRaw]::Run([int]($env:PAO_PARENT))"].join("\n");
  const file = join(tmpdir(), "pao-wheel.ps1");
  try { await writeFile(file, script, "utf8"); }
  catch (e) { console.warn("[pao] scroll watcher failed:", (e as Error).message); return; }
  try {
    wheelProc = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
      { windowsHide: true, env: { ...process.env, PAO_PARENT: String(process.pid) } });
    wheelProc.stdout?.setEncoding("utf8");
    let lastFwd = 0, lastDir = 0, lastTouchFwd = 0;
    wheelProc.stdout?.on("data", (chunk: string) => {
      const now = Date.now();
      for (const raw of chunk.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === "KEY") {                       // a keystroke pulse (no identity)
          if (win && !win.isDestroyed()) win.webContents.send("key-activity");
          continue;
        }
        if (line === "SCROLL2") {                    // 2+ fingers on the touchpad = scroll/zoom gesture
          if (now - lastTouchFwd >= 50) {            // throttle the report flood
            lastTouchFwd = now;
            if (win && !win.isDestroyed()) win.webContents.send("scroll-activity", 1);
          }
          continue;
        }
        const mm = line.match(/^WHEEL\s+(-?\d+)/);
        if (!mm) continue;
        const delta = parseInt(mm[1], 10);
        const dir = Math.sign(delta);
        // throttle the trackpad's inertial flood: forward at most ~30/s, but
        // always forward immediately on a direction change so it stays snappy.
        if (now - lastFwd < 33 && dir === lastDir) continue;
        lastFwd = now; lastDir = dir;
        if (win && !win.isDestroyed()) win.webContents.send("scroll-activity", delta);
      }
    });
    wheelProc.on("error", (e) => console.warn("[pao] input watcher unavailable:", e.message));
    console.log("[pao] input watcher active (win32 Raw Input — wheel + trackpad + keystrokes)");
  } catch (e) {
    console.warn("[pao] scroll watcher failed:", (e as Error).message);
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
  // On Windows the Raw Input watcher (startWheelWatch) already delivers BOTH
  // keystrokes and wheel/trackpad reliably; uiohook delivers neither here, so
  // skip it to avoid wasted hooks and any double-counting.
  if (process.platform === "win32") { keyboardHookActive = true; return; }
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
ipcMain.on("ui-do", (_e, action: string) => win?.webContents.send("do", action));
ipcMain.handle("get-status", () => latestState ?? {});

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 340, height: 680, resizable: true, title: "Pao — Settings",
    skipTaskbar: false, alwaysOnTop: true, fullscreenable: false, minimizable: false,
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.setMenuBarVisibility(false);
  // The transparent overlay is always-on-top at "screen-saver" level, and the
  // user's foreground app can sit above a plain window — so the settings window
  // was opening UNREACHABLE behind them (clicks landed on the app in front).
  // Put it at the same top level and bring it to the front + focus on load.
  settingsWin.setAlwaysOnTop(true, "screen-saver");
  settingsWin.webContents.on("did-finish-load", () => {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.moveTop(); settingsWin.focus(); }
  });
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
      { label: "Give treat", click: () => win?.webContents.send("do", "treat") },
      { type: "separator" },
      {
        label: "Coat colour",
        submenu: [
          { label: "Midnight (Jiji)", click: () => win?.webContents.send("do", "coat:default") },
          { label: "Classic Pao", click: () => win?.webContents.send("do", "coat:classic") },
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
      else if (path.startsWith("/treat")) win?.webContents.send("do", "treat");
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
      else if (path.startsWith("/peek")) {
        // GET /peek or /peek?on=1 -> on; /peek?on=0 or /peek?on=off -> off
        const on = new URL(req.url || "", "http://x").searchParams.get("on");
        const val = (on === null || on === "1" || on === "on") ? "on" : "off";
        win?.webContents.send("do", `peek:${val}`);
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

// A desktop pet should never vanish on a stray error — log and keep going
// instead of letting the main process die (which would drop the overlay).
process.on("uncaughtException", (e) => console.error("[pao] uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("[pao] unhandledRejection:", e));

// Single-instance: a second launch must NOT spawn a duplicate overlay cat.
// If we can't get the lock, another Pao already owns the screen — quit quietly.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { /* already running; nothing to focus (overlay is unfocusable) */ });

  app.whenReady().then(async () => {
    // Serve bundled files (dist/) over app://bundle/...
    protocol.registerFileProtocol("app", (request, callback) => {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/" || pathname === "") pathname = "/index.html";
      const filePath = join(__dirname, pathname.replace(/^\//, ""));
      callback({ path: filePath });
    });

    if (process.platform === "darwin") app.dock?.hide();
    await createWindow();
    createTray();
    startControlServer();
  });
}

app.on("before-quit", () => {
  try { ctrl?.close(); } catch { /* noop */ }
  try { fgProc?.kill(); } catch { /* noop */ }
  try { wheelProc?.kill(); } catch { /* noop */ }
});
app.on("window-all-closed", () => app.quit());

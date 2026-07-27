import { contextBridge, ipcRenderer } from "electron";

export interface DisplayInfo { originX: number; originY: number; width: number; height: number; }
export interface CursorMsg { x: number; y: number; }

// Safe, minimal bridge between the privileged main process and the renderer.
contextBridge.exposeInMainWorld("bridge", {
  onDisplayInfo: (cb: (info: DisplayInfo) => void) =>
    ipcRenderer.on("display-info", (_e, info) => cb(info)),
  onCursor: (cb: (c: CursorMsg) => void) =>
    ipcRenderer.on("cursor", (_e, c) => cb(c)),
  onKeyActivity: (cb: () => void) =>
    ipcRenderer.on("key-activity", () => cb()),
  onScrollActivity: (cb: (rot: number) => void) =>
    ipcRenderer.on("scroll-activity", (_e, rot: number) => cb(rot)),
  // foreground-window title changes (ambient perception; optional)
  onAppFocus: (cb: (title: string) => void) =>
    ipcRenderer.on("app-focus", (_e, title: string) => cb(title)),
  // mood/perception snapshot -> main (served on the local control port)
  reportState: (s: unknown) => ipcRenderer.send("affect-state", s),
  setHitbox: (box: { x: number; y: number; w: number; h: number }) =>
    ipcRenderer.send("hitbox", box),
  setDragging: (v: boolean) => ipcRenderer.send("dragging", v),
  onSetAutonomous: (cb: (v: boolean) => void) =>
    ipcRenderer.on("set-autonomous", (_e, v: boolean) => cb(v)),
  onDo: (cb: (action: string) => void) =>
    ipcRenderer.on("do", (_e, action: string) => cb(action)),
  // settings window -> main -> overlay (custom pomodoro / meeting)
  setPomodoro: (cfg: unknown) => ipcRenderer.send("set-pomodoro", cfg),
  setMeeting: (cfg: unknown) => ipcRenderer.send("set-meeting", cfg),
  setPomoState: (s: { on: boolean; paused: boolean; phase: string }) => ipcRenderer.send("pomo-state", s),
  onReact: (cb: (d: { type: string; msg: string }) => void) =>
    ipcRenderer.on("react", (_e, d: { type: string; msg: string }) => cb(d)),
  onSetPomodoro: (cb: (cfg: PomodoroCfg) => void) =>
    ipcRenderer.on("set-pomodoro", (_e, cfg: PomodoroCfg) => cb(cfg)),
  onSetMeeting: (cb: (cfg: MeetingCfg) => void) =>
    ipcRenderer.on("set-meeting", (_e, cfg: MeetingCfg) => cb(cfg)),
  // settings window -> main -> overlay: name the pet
  setName: (name: string) => ipcRenderer.send("ui-name", name),
  onSetName: (cb: (name: string) => void) =>
    ipcRenderer.on("apply-name", (_e, name: string) => cb(name)),
  // settings window: choose a coat + read live status (coats, mood, trophies)
  setCoat: (name: string) => ipcRenderer.send("ui-coat", name),
  setAccessory: (name: string) => ipcRenderer.send("ui-accessory", name),
  getStatus: () => ipcRenderer.invoke("get-status"),
  // settings window: daily treat action
  giveTreat: () => ipcRenderer.send("ui-do", "treat"),
});

export interface PomodoroCfg { focus: number; brk: number; long: number; every: number; start?: boolean; }
export interface MeetingCfg { mins: number; label: string; }
export interface PaoConfig {
  name: string;
  furId: string;
  bellColor: string;
  sound: { muted: boolean; volume: number };
  sleepMin: number;
  hydrationMin: number;
  leisureNudge: boolean;
  contextEnabled: boolean;
  contextRules: { pattern: string; mode: string }[];
  autostart: boolean;
  firstRunDone: boolean;
}

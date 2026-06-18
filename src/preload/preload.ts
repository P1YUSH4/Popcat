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
  onSetPomodoro: (cb: (cfg: PomodoroCfg) => void) =>
    ipcRenderer.on("set-pomodoro", (_e, cfg: PomodoroCfg) => cb(cfg)),
  onSetMeeting: (cb: (cfg: MeetingCfg) => void) =>
    ipcRenderer.on("set-meeting", (_e, cfg: MeetingCfg) => cb(cfg)),
});

export interface PomodoroCfg { focus: number; brk: number; long: number; every: number; start?: boolean; }
export interface MeetingCfg { mins: number; label: string; }

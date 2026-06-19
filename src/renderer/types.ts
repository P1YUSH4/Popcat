// Shared types mirroring the generator's metadata (pao.json) and the
// preload bridge surface.

export interface Vec2 { x: number; y: number; }

export interface EyeAnchor { x: number; y: number; open: boolean; }

export interface FrameMeta {
  index: number;
  rect: { x: number; y: number; w: number; h: number };
  duration: number;          // ms
  eyes: EyeAnchor[];         // [left, right] in cell-local pixel coords (64x64)
}

export interface AnimMeta {
  frames: FrameMeta[];
  loop: boolean;
}

export interface SpriteMeta {
  name: string;
  image: string;
  cell: { w: number; h: number };
  sprite: { w: number; h: number };
  renderScale: number;
  palette: string[];
  pupil: { color: string; radius: number; maxOffset: number };
  frameTags: { name: string; from: number; to: number }[];
  animations: Record<string, AnimMeta>;
}

export type AnimName =
  | "idle" | "walk" | "run" | "sit" | "sleep" | "stretch"
  | "knead" | "think" | "jump" | "drag" | "overheat"
  | "wiggle" | "purr" | "scroll" | "typing" | "meow"
  | "fall" | "confused" | "angry" | "yawn" | "lie_down" | "alert"
  | "celebrate" | "worried" | "meeting" | "focus";

export interface DisplayInfo { originX: number; originY: number; width: number; height: number; }

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

declare global {
  interface Window {
    bridge: {
      onDisplayInfo: (cb: (info: DisplayInfo) => void) => void;
      onCursor: (cb: (c: Vec2) => void) => void;
      onKeyActivity: (cb: () => void) => void;
      onScrollActivity: (cb: (rot: number) => void) => void;
      onActiveWindow: (cb: (d: { app: string; title: string }) => void) => void;
      setHitbox: (box: { x: number; y: number; w: number; h: number }) => void;
      setDragging: (v: boolean) => void;
      onSetAutonomous: (cb: (v: boolean) => void) => void;
      onDo: (cb: (action: string) => void) => void;
      setPomodoro: (cfg: { focus: number; brk: number; long: number; every: number; start?: boolean }) => void;
      setMeeting: (cfg: { mins?: number; atMs?: number; label: string; preMin?: number }) => void;
      setPomoState: (s: { on: boolean; paused: boolean; phase: string }) => void;
      onReact: (cb: (d: { type: string; msg: string }) => void) => void;
      getConfig: () => Promise<PaoConfig>;
      setConfig: (patch: Partial<PaoConfig>) => void;
      onConfig: (cb: (cfg: PaoConfig) => void) => void;
      onboardingDone: () => void;
      onDragCancel: (cb: () => void) => void;
      onSetPomodoro: (cb: (cfg: { focus: number; brk: number; long: number; every: number; start?: boolean }) => void) => void;
      onSetMeeting: (cb: (cfg: { mins?: number; atMs?: number; label: string; preMin?: number }) => void) => void;
    };
    cat: import("./Cat").Cat; // public API: cat.startThinking() / cat.finishThinking()
  }
}

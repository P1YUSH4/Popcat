import { classifyContext, type Mode } from "./context";
import type { DisplayInfo, Vec2 } from "./types";

/**
 * Consumes global input from the main process (via the preload bridge):
 *  - cursor position (screen coords -> canvas coords)
 *  - cursor speed (for HUNT triggering)
 *  - keyboard activity pulses (for TYPE/knead reactions)
 *
 * It is read-only state that the BehaviorController polls each frame.
 */
export class InputController {
  cursor: Vec2 = { x: 0, y: 0 };          // canvas-space cursor
  cursorScreen: Vec2 = { x: 0, y: 0 };    // raw screen-space cursor
  cursorSpeed = 0;                        // px/s
  private lastCursor: Vec2 | null = null;
  private lastCursorT = 0;

  private origin: Vec2 = { x: 0, y: 0 };
  private keyEnergy = 0;                   // decays over time; >threshold => typing
  private keyTimes: number[] = [];        // recent keystroke timestamps (for rate)
  private scrollEnergy = 0;               // decays; >threshold => scrolling
  private fastSince = -1;                 // when cursorSpeed first exceeded HUNT threshold
  private lastMoveT = performance.now();  // last time the cursor actually moved
  scrollDir = 1;                          // last wheel direction (+1 down / -1 up)
  activeApp = ""; activeTitle = "";       // focused window (context awareness)
  userRules: { pattern: string; mode: string }[] = [];   // user context rules (from config)

  constructor() {
    window.bridge.onDisplayInfo((info: DisplayInfo) => {
      this.origin = { x: info.originX, y: info.originY };
    });
    window.bridge.onCursor((c) => this.onCursor(c));
    window.bridge.onKeyActivity(() => {
      this.keyEnergy = Math.min(1.5, this.keyEnergy + 0.5);
      this.keyTimes.push(performance.now());
    });
    window.bridge.onScrollActivity((rot: number) => {
      if (rot) this.scrollDir = rot > 0 ? 1 : -1;   // +1 = down, -1 = up
      // one notch gives a clear reaction, but cap low so the cat settles soon
      // after you STOP (the trackpad streams events, so a high cap would linger
      // ~2.4s). With the decay below this settles ~0.45s after the last event.
      this.scrollEnergy = Math.min(1.0, this.scrollEnergy + 0.8);
    });
    window.bridge.onActiveWindow(({ app, title }) => { this.activeApp = app; this.activeTitle = title; });
  }

  private onCursor(screen: Vec2): void {
    this.cursorScreen = screen;
    const canvas = { x: screen.x - this.origin.x, y: screen.y - this.origin.y };
    const now = performance.now();
    if (this.lastCursor) {
      const dt = Math.max(1, now - this.lastCursorT) / 1000;
      const d = Math.hypot(canvas.x - this.lastCursor.x, canvas.y - this.lastCursor.y);
      // exponential smoothing so the speed signal isn't jittery
      this.cursorSpeed = this.cursorSpeed * 0.6 + (d / dt) * 0.4;
      if (d > 1) this.lastMoveT = now;     // cursor actually moved
    }
    this.lastCursor = canvas;
    this.lastCursorT = now;
    this.cursor = canvas;
  }

  /** Call once per frame to decay transient signals. */
  update(dt: number): void {
    this.keyEnergy = Math.max(0, this.keyEnergy - dt * 1.2);
    this.scrollEnergy = Math.max(0, this.scrollEnergy - dt * 1.6);
    // cursor speed decays if no movement events arrive
    this.cursorSpeed *= Math.max(0, 1 - dt * 4);
    // drop keystroke timestamps older than 1s
    const cut = performance.now() - 1000;
    while (this.keyTimes.length && this.keyTimes[0] < cut) this.keyTimes.shift();
    // track how long the cursor has been "fast" (for sustained-hunt trigger)
    if (this.cursorSpeed > 400) { if (this.fastSince < 0) this.fastSince = performance.now(); }
    else this.fastSince = -1;
  }

  isTyping(): boolean { return this.keyEnergy > 0.4; }
  /** keystrokes counted in the last ~1s (typing cadence for the affect engine). */
  keysPerSec(): number { return this.keyTimes.length; }
  /** Sustained burst of keystrokes -> overheat. */
  isTypingFast(threshold = 7): boolean { return this.keyTimes.length >= threshold; }
  isCursorFast(threshold = 700): boolean { return this.cursorSpeed > threshold; }
  /** velocity > 400px/s sustained for >200ms -> hunt */
  isHuntReady(): boolean { return this.fastSince > 0 && performance.now() - this.fastSince > 200; }
  /** ms since the cursor last actually moved (for the hunt give-up timer) */
  cursorIdleMs(): number { return performance.now() - this.lastMoveT; }
  isCursorSlow(threshold = 100): boolean { return this.cursorSpeed < threshold; }
  isScrolling(): boolean { return this.scrollEnergy > 0.25; }
  /** current scroll intensity 0..1.4 (for the spinning yarn-ball speed). */
  scrollPower(): number { return this.scrollEnergy; }
  /** behavior mode derived from the focused window (focus/coding/ai/leisure/neutral). */
  contextMode(): Mode { return classifyContext(this.activeApp, this.activeTitle, this.userRules); }
}

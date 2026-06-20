import type { InputController } from "./InputController";
import { type Features } from "./Affect";

/**
 * Ambient perception — Pao's senses.
 *
 * It reads your *rhythm*, never your *screen*: no screenshots, no pixel reads,
 * no content. Just cheap behavioural signals (typing cadence, idle gaps, cursor
 * energy, window-switch frequency, time of day, session length) aggregated into
 * a small feature vector that the AffectController reasons over. 100% local.
 *
 * Most signals are reused from InputController (already hooked); the active-app
 * title arrives over IPC from the main process and is optional — if it's
 * unavailable the rest of perception still works.
 */
export class Perception {
  private lastActivityT = performance.now();
  private focusStreakMs = 0;
  private sessionStart = performance.now();

  // window-switch tracking (optional signal)
  activeApp: string | null = null;
  private appSwitchTimes: number[] = [];

  constructor(private input: InputController) {}

  /** Called from the main process (via bridge) when the foreground window changes. */
  setActiveApp(title: string): void {
    const app = shortAppName(title);
    if (app && app !== this.activeApp) {
      this.activeApp = app;
      this.appSwitchTimes.push(performance.now());
    }
  }

  update(dtSec: number): void {
    const now = performance.now();
    const working = this.input.isTyping() || this.input.isScrolling() || this.input.cursorIdleMs() < 800;
    if (working) this.lastActivityT = now;

    // focus streak: continuous keyboard-centric work; a long pause resets it
    const idleMs = now - this.lastActivityT;
    if (this.input.isTyping()) this.focusStreakMs += dtSec * 1000;
    else if (idleMs > 20_000) this.focusStreakMs = 0;

    // forget window switches older than 60s
    const cut = now - 60_000;
    while (this.appSwitchTimes.length && this.appSwitchTimes[0] < cut) this.appSwitchTimes.shift();
  }

  /** Coarse category of the active app, for app-aware mood flavour. */
  category(): AppCategory { return appCategory(this.activeApp); }

  /** Snapshot of the feature vector the affect engine reasons over. */
  features(hour: number): Features {
    const now = performance.now();
    return {
      idleMs: now - this.lastActivityT,
      typingActive: this.input.isTyping(),
      typingRate: this.input.keysPerSec(),
      scrolling: this.input.isScrolling(),
      cursorSpeed: this.input.cursorSpeed,
      appSwitchRate: this.appSwitchTimes.length,   // switches in the last 60s
      focusStreakMs: this.focusStreakMs,
      sessionMs: now - this.sessionStart,
      hour,
    };
  }
}

export type AppCategory =
  | "editor" | "terminal" | "browser" | "chat" | "design" | "media" | "game" | "office" | "other";

const CATEGORY_KEYWORDS: [AppCategory, string[]][] = [
  ["editor",   ["visual studio code", "code", "vscode", "intellij", "pycharm", "webstorm", "sublime", "neovim", "vim", "cursor", "rider", "xcode", "android studio"]],
  ["terminal", ["terminal", "powershell", "command prompt", "cmd", "bash", "wsl", "conhost", "iterm", "alacritty", "kitty"]],
  ["browser",  ["chrome", "firefox", "edge", "brave", "opera", "safari", "vivaldi", "browser"]],
  ["chat",     ["discord", "slack", "teams", "telegram", "whatsapp", "messenger", "signal", "zoom"]],
  ["design",   ["figma", "photoshop", "illustrator", "blender", "gimp", "krita", "inkscape", "affinity"]],
  ["media",    ["youtube", "vlc", "spotify", "netflix", "music", "video", "media player", "twitch"]],
  ["game",     ["steam", "epic games", "game", "minecraft", "league of"]],
  ["office",   ["word", "excel", "powerpoint", "outlook", "onenote", "notion", "obsidian", "docs", "sheets", "acrobat", "pdf"]],
];

/** Pure: classify an app label (or window title) into a coarse activity category. */
export function appCategory(label: string | null): AppCategory {
  if (!label) return "other";
  const t = label.toLowerCase();
  for (const [cat, words] of CATEGORY_KEYWORDS) if (words.some((w) => t.includes(w))) return cat;
  return "other";
}

/** Reduce a raw window title to a short, human app label for display. */
export function shortAppName(title: string): string | null {
  if (!title) return null;
  const t = title.trim();
  if (!t) return null;
  // many titles look like "document — App" or "App - document"; keep the app-ish end
  const parts = t.split(/\s[—\-|]\s/);          // em-dash, hyphen, or pipe
  const tail = parts[parts.length - 1].trim();
  const label = (tail.length >= 2 && tail.length <= 40) ? tail : parts[0].trim();
  return label.slice(0, 40);
}

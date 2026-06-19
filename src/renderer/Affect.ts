import type { BehaviorController } from "./BehaviorController";
import type { AppCategory, Perception } from "./Perception";
import { Patterns } from "./Patterns";

/**
 * Affect engine — Pao's "mood brain".
 *
 * Turns the ambient feature vector from Perception into (1) a continuous energy
 * level, (2) a discrete *rhythm state* describing what your work session looks
 * like right now, and (3) occasional creature-like expressions. The point is
 * that Pao *behaves* like it understands your day — it does NOT advise, chat,
 * or read your content. It's a pet, not a copilot.
 *
 * The classifier and the energy stepper are pure functions (no time, no
 * randomness, no I/O) so they're unit-testable; the controller wires them to
 * the cat's existing behaviour API and only ever acts when Pao is calmly idle,
 * so it never interrupts a real reaction (drag, hunt, pet, typing, …).
 */

export type RhythmState =
  | "AWAY"          // you've stepped away
  | "IDLE"          // present but not doing much
  | "FOCUSED"       // actively working
  | "FLOW"          // long uninterrupted focus streak
  | "SCATTERED"     // rapid window-hopping / restless cursor, little typing
  | "FATIGUED"      // very long session
  | "WINDING_DOWN"; // late night, low activity

export interface Features {
  idleMs: number;
  typingActive: boolean;
  typingRate: number;     // keystrokes/sec
  scrolling: boolean;
  cursorSpeed: number;    // px/s
  appSwitchRate: number;  // window switches in the last 60s
  focusStreakMs: number;  // continuous focused work
  sessionMs: number;      // since app launch
  hour: number;           // local hour 0..23
}

const MIN = 60_000;
const isNight = (h: number) => h >= 23 || h < 6;
const isEvening = (h: number) => h >= 21 && h < 23;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Pure: classify the current work rhythm from the feature vector. */
export function classifyRhythm(f: Features): RhythmState {
  if (f.idleMs > 30_000) return "AWAY";

  // restless: lots of window-hopping or a fast erratic cursor with little typing
  if (!f.typingActive && (f.appSwitchRate >= 6 || (f.cursorSpeed > 600 && f.appSwitchRate >= 3)))
    return "SCATTERED";

  if (isNight(f.hour) && f.idleMs > 8_000) return "WINDING_DOWN";

  if (f.sessionMs > 150 * MIN) return "FATIGUED";          // 2.5h marathon
  if (f.focusStreakMs > 20 * MIN) return "FLOW";
  if (f.typingActive || f.focusStreakMs > 30_000) return "FOCUSED";

  if (isNight(f.hour)) return "WINDING_DOWN";
  return "IDLE";
}

/** Pure: ease energy toward a target derived from activity + time of day. */
export function stepEnergy(prev: number, f: Features, dtSec: number): number {
  let target = 0.5;
  if (f.typingActive || f.scrolling) target = 0.85;
  else if (f.idleMs < 3_000) target = 0.6;
  else if (f.idleMs > 30_000) target = 0.22;
  if (isEvening(f.hour)) target -= 0.15;
  if (isNight(f.hour)) target -= 0.32;
  if (f.sessionMs > 120 * MIN) target -= 0.1;             // marathon fatigue
  target = clamp01(target);
  const k = 1 - Math.exp(-dtSec / 8);                      // ~8s time constant
  return clamp01(prev + (target - prev) * k);
}

/** Pure: a short human mood label for display / tray. */
export function moodLabel(state: RhythmState, energy: number): string {
  switch (state) {
    case "AWAY": return "waiting for you";
    case "FLOW": return "in the zone";
    case "FOCUSED": return "focused";
    case "SCATTERED": return "a little restless";
    case "FATIGUED": return "tired";
    case "WINDING_DOWN": return "sleepy";
    default: return energy > 0.55 ? "content" : "drowsy";
  }
}

export interface AffectSnapshot {
  rhythm: RhythmState;
  mood: string;
  energy: number;          // 0..1
  activeApp: string | null;
  context: AppCategory;
  sessionMin: number;
  idleSec: number;
  focusStreakMin: number;
  typing: boolean;
  appSwitchesPerMin: number;
  hour: number;
}

export class AffectController {
  energy = 0.6;
  rhythm: RhythmState = "IDLE";
  private awaySince = -1;
  private lastGreet = -Infinity;
  private lastNudge = -Infinity;
  private lastAntsy = -Infinity;
  private flowNudgedAt = -Infinity;
  private scatteredSince = -1;
  private lastQuip = -Infinity;
  private patterns = new Patterns();

  constructor(private perception: Perception, private behavior: BehaviorController) {}

  /** Per-frame brain tick. dt in seconds; `now` from performance.now(). */
  update(dtSec: number, now: number): void {
    const hour = new Date().getHours();
    const f = this.perception.features(hour);
    this.energy = stepEnergy(this.energy, f, dtSec);
    this.rhythm = classifyRhythm(f);
    this.behavior.contextCategory = this.perception.category();   // app-aware fidget flavour
    // deep focus -> go quiet (don't interrupt); also learn your focus hours
    this.behavior.quietMode = this.rhythm === "FLOW" || this.rhythm === "FOCUSED";
    if (f.typingActive || this.behavior.quietMode) this.patterns.recordFocus(hour, dtSec, now);

    // Energy steers how readily Pao drifts to sleep: low energy (idle / late /
    // marathon) -> dozes off sooner; high energy -> stays up. Visible, gentle.
    this.behavior.sleepMs = Math.round(20_000 + this.energy * 70_000);   // 20s..90s

    this.maybeExpress(now);
  }

  /** Occasional, throttled, creature-like reactions — never interrupts. */
  private maybeExpress(now: number): void {
    // welcome back after a real absence
    if (this.rhythm === "AWAY") { if (this.awaySince < 0) this.awaySince = now; }
    else if (this.awaySince > 0) {
      const gone = now - this.awaySince;
      this.awaySince = -1;
      if (gone > 60_000 && now - this.lastGreet > 30_000) {
        this.lastGreet = now;
        const nm = this.behavior.petName;
        const who = nm ? `, ${nm}` : "";
        // if this is one of your historically-focused hours, nudge toward it
        if (this.patterns.isPeakHour(new Date().getHours())) {
          this.behavior.affectGreet(pick([`back${who}? this is usually your focus time 🐾`, `welcome back${who} — let's get in the zone`]));
        } else {
          this.behavior.affectGreet(nm
            ? pick([`Mrr? welcome back, ${nm} 🐾`, `Oh — hi again, ${nm}!`, `*perks up* you're back!`])
            : pick(["Mrr? welcome back 🐾", "Oh — hi again!", "*perks up* you're back"]));
        }
        return;
      }
    }

    // entered FLOW and hasn't been nudged this streak -> one gentle stretch cue
    if (this.rhythm === "FLOW" && now - this.flowNudgedAt > 25 * MIN) {
      this.flowNudgedAt = now;
      this.behavior.affectNudge("In the zone 🐾 — quick stretch?");
      return;
    }

    // sustained restlessness -> a brief antsy look-around (heavily throttled)
    if (this.rhythm === "SCATTERED") {
      if (this.scatteredSince < 0) this.scatteredSince = now;
      if (now - this.scatteredSince > 8_000 && now - this.lastAntsy > 120_000) {
        this.lastAntsy = now;
        this.behavior.affectAntsy();
      }
    } else this.scatteredSince = -1;

    // long marathon -> a kind hydration/stretch nudge, rarely
    if (this.rhythm === "FATIGUED" && now - this.lastNudge > 20 * MIN) {
      this.lastNudge = now;
      this.behavior.affectNudge("Long session — water + stretch? 💧");
    }

    // calm idle -> an occasional app-aware "thought" (never during focus/flow)
    if (this.rhythm === "IDLE" && now - this.lastQuip > 12 * MIN) {
      this.lastQuip = now;
      this.behavior.affectGreet(this.idleQuip());   // idle-gated; won't interrupt
    }
  }

  /** a rule-based, app-aware idle line (no AI). */
  private idleQuip(): string {
    const byCat: Record<string, string[]> = {
      editor: ["coding hard? *purr*", "your code looks cozy from here", "psst… water break? 💧"],
      terminal: ["beep boop 🐾", "the matrix~", "*watches the logs scroll*"],
      browser: ["ooh, what are we reading?", "*follows the cursor*", "nice tab collection"],
      media: ["movie time? *curls up*", "this looks comfy", "*settles in to watch*"],
      chat: ["say hi for me 🐾", "*perks ears*", "who's that?"],
      design: ["pretty~ *tilts head*", "ooh, colours", "*admires your work*"],
      office: ["deep in the docs, huh", "*tidy paws*", "almost done?"],
      other: ["mrrp~", "*stretches a little*", "just vibing with you", "*slow blink*"],
    };
    return pick(byCat[this.behavior.contextCategory] ?? byCat.other);
  }

  snapshot(): AffectSnapshot {
    const hour = new Date().getHours();
    const f = this.perception.features(hour);
    return {
      rhythm: this.rhythm,
      mood: moodLabel(this.rhythm, this.energy),
      energy: Math.round(this.energy * 100) / 100,
      activeApp: this.perception.activeApp,
      context: this.perception.category(),
      sessionMin: Math.round(f.sessionMs / MIN),
      idleSec: Math.round(f.idleMs / 1000),
      focusStreakMin: Math.round(f.focusStreakMs / MIN),
      typing: f.typingActive,
      appSwitchesPerMin: f.appSwitchRate,
      hour,
    };
  }
}

function pick<T>(xs: T[]): T { return xs[Math.floor(Math.random() * xs.length)]; }

// Pure, side-effect-free timer logic — extracted so it can be unit-tested
// without the browser/Electron runtime.

export type PomoPhase = "work" | "break" | "long";
export type PomoAlert = "break" | "longbreak" | "focus";

export interface PomoStep {
  phase: PomoPhase;       // the phase we move INTO
  sessions: number;       // updated completed-focus-session count
  alert: PomoAlert;       // which alert to fire on the transition
}

/**
 * Given the current phase, advance to the next one. A finished focus session
 * goes to a break (or a long break every `longEvery` sessions); a finished
 * break goes back to focus. `longEvery` is clamped to >= 1.
 */
export function advancePomo(phase: PomoPhase, sessions: number, longEvery: number): PomoStep {
  const every = Math.max(1, Math.round(longEvery));
  if (phase === "work") {
    const next = sessions + 1;
    const long = next % every === 0;
    return { phase: long ? "long" : "break", sessions: next, alert: long ? "longbreak" : "break" };
  }
  return { phase: "work", sessions, alert: "focus" };
}

/** a timestamp-based timer is due when its end time has passed (and is set). */
export function isDue(now: number, at: number): boolean {
  return at > 0 && now >= at;
}

/** an interval reminder is due when `interval` ms have elapsed since `last`. */
export function reminderDue(now: number, last: number, interval: number): boolean {
  return interval > 0 && now - last > interval;
}

/** mm:ss for a remaining-millisecond count (clamped at 0). */
export function mmss(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

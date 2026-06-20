import type { AffectSnapshot } from "./Affect";

/**
 * Streaks & achievements — a deterministic reward loop (no AI) built on the
 * ambient rhythm engine. Focus streaks, daily returns, marathons and time-of-day
 * milestones unlock little celebrations; progress persists in localStorage.
 */

export interface AchState {
  unlocked: string[];
  dateKey: string;          // today's YYYY-MM-DD (resets daily stats)
  lastActiveDate: string;   // last day Pao saw activity (for the streak)
  dailyStreak: number;
  focusMinToday: number;
  categoriesSeen: string[];
}

export interface AchDef { id: string; title: string; test: (s: AffectSnapshot, st: AchState, prevRhythm: string) => boolean; }

export const ACHIEVEMENTS: AchDef[] = [
  { id: "first_paw",  title: "Hello, Pao 🐾",     test: () => true },
  { id: "first_focus", title: "First focus 🎯",    test: (s) => s.focusStreakMin >= 1 },
  { id: "flow",       title: "In the zone 🌊",     test: (s) => s.rhythm === "FLOW" },
  { id: "marathon",   title: "Marathon cat 🏃",    test: (s) => s.sessionMin >= 120 },
  { id: "night_owl",  title: "Night owl 🦉",       test: (s) => s.hour >= 1 && s.hour < 5 && s.idleSec < 60 },
  { id: "early_bird", title: "Early bird 🐦",      test: (s) => s.hour >= 5 && s.hour < 7 && s.idleSec < 60 },
  { id: "comeback",   title: "Welcome back 👋",    test: (s, _st, prev) => prev === "AWAY" && s.rhythm !== "AWAY" },
  { id: "multitask",  title: "Multitasker 🗂️",     test: (_s, st) => st.categoriesSeen.length >= 5 },
  { id: "focus_60",   title: "An hour deep 💪",    test: (_s, st) => st.focusMinToday >= 60 },
];

const STREAK_MILESTONES = [3, 7, 14, 30];

/** Local calendar day key, YYYY-MM-DD. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Pure: the day before a YYYY-MM-DD key (UTC arithmetic on the calendar date). */
export function yesterdayOf(key: string): string {
  const t = Date.parse(key + "T00:00:00Z") - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Pure: next streak value given the last active day, today, and prior streak. */
export function nextStreak(lastActiveDate: string, today: string, prevStreak: number): number {
  if (lastActiveDate === today) return prevStreak || 1;
  if (lastActiveDate === yesterdayOf(today)) return (prevStreak || 0) + 1;
  return 1;   // gap (or first ever) -> fresh streak
}

const KEY = "pao.achievements.v1";

export class AchievementsController {
  private st: AchState;
  private prevRhythm = "IDLE";
  private queue: { title: string; id: string }[] = [];
  private lastNotify = -Infinity;

  constructor(
    private onUnlock: (title: string, id: string) => void,
    private now: () => number = () => performance.now(),
  ) {
    this.st = this.load();
  }

  private load(): AchState {
    const def: AchState = { unlocked: [], dateKey: "", lastActiveDate: "", dailyStreak: 0, focusMinToday: 0, categoriesSeen: [] };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { ...def, ...(JSON.parse(raw) as Partial<AchState>) };
    } catch { /* ignore */ }
    return def;
  }
  private save(): void { try { localStorage.setItem(KEY, JSON.stringify(this.st)); } catch { /* ignore */ } }

  /** Called ~1Hz with the current mood snapshot. */
  update(s: AffectSnapshot, dtSec: number): void {
    const today = dayKey(new Date());
    const active = s.idleSec < 60;

    if (this.st.dateKey !== today) { this.st.dateKey = today; this.st.focusMinToday = 0; }
    if (active && this.st.lastActiveDate !== today) {
      this.st.dailyStreak = nextStreak(this.st.lastActiveDate, today, this.st.dailyStreak);
      this.st.lastActiveDate = today;
    }
    if (s.typing || s.rhythm === "FOCUSED" || s.rhythm === "FLOW") this.st.focusMinToday += dtSec / 60;
    if (s.context !== "other" && !this.st.categoriesSeen.includes(s.context)) this.st.categoriesSeen.push(s.context);

    for (const a of ACHIEVEMENTS) {
      if (!this.st.unlocked.includes(a.id) && a.test(s, this.st, this.prevRhythm)) this.unlock(a.id, a.title);
    }
    for (const m of STREAK_MILESTONES) {
      const id = `streak_${m}`;
      if (this.st.dailyStreak >= m && !this.st.unlocked.includes(id)) this.unlock(id, `${m}-day streak 🔥`);
    }

    this.prevRhythm = s.rhythm;
    this.drainQueue();
    this.save();
  }

  private unlock(id: string, title: string): void {
    this.st.unlocked.push(id);
    this.queue.push({ title, id });
    this.save();
  }

  /** ids of every achievement unlocked so far (drives coat unlocks etc.). */
  unlockedIds(): string[] { return this.st.unlocked.slice(); }

  /** full achievement roster with unlocked flags (for the settings trophy case). */
  list(): { id: string; title: string; unlocked: boolean }[] {
    const u = new Set(this.st.unlocked);
    return [
      ...ACHIEVEMENTS.map((a) => ({ id: a.id, title: a.title, unlocked: u.has(a.id) })),
      ...STREAK_MILESTONES.map((m) => ({ id: `streak_${m}`, title: `${m}-day streak 🔥`, unlocked: u.has(`streak_${m}`) })),
    ];
  }

  /** Fire one celebration at a time so simultaneous unlocks don't stomp. */
  private drainQueue(): void {
    if (!this.queue.length) return;
    const now = this.now();
    if (now - this.lastNotify < 3500) return;
    this.lastNotify = now;
    const { title, id } = this.queue.shift()!;
    this.onUnlock(title, id);
  }

  summary(): { unlocked: number; total: number; dailyStreak: number; focusMinToday: number; recent: string } {
    return {
      unlocked: this.st.unlocked.length,
      total: ACHIEVEMENTS.length + STREAK_MILESTONES.length,
      dailyStreak: this.st.dailyStreak,
      focusMinToday: Math.round(this.st.focusMinToday),
      recent: this.st.unlocked[this.st.unlocked.length - 1] ?? "",
    };
  }
}

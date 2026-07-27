/**
 * Pattern memory — the cat quietly learns *your* daily rhythm (no AI, no
 * screenshots). It accumulates focus minutes per hour-of-day across sessions in
 * localStorage; over days, your peak focus hours emerge and the cat can time
 * its encouragement to them.
 */
const KEY = "pao.patterns.v1";

export interface PatternState { focusByHour: number[]; }  // 24 buckets, minutes

/** Pure: the hours (0..23) with the most accumulated focus, needing real data. */
export function peakHours(focusByHour: number[], k = 3, minMinutes = 20): number[] {
  return focusByHour
    .map((v, i) => [v, i] as [number, number])
    .filter(([v]) => v >= minMinutes)
    .sort((a, b) => b[0] - a[0])
    .slice(0, k)
    .map(([, i]) => i);
}

export class Patterns {
  private st: PatternState;
  private pending = 0;          // unsaved focus seconds (batched to avoid per-frame writes)
  private lastFlush = 0;

  constructor() { this.st = this.load(); }

  private load(): PatternState {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { const s = JSON.parse(raw) as PatternState; if (Array.isArray(s.focusByHour) && s.focusByHour.length === 24) return s; }
    } catch { /* ignore */ }
    return { focusByHour: new Array(24).fill(0) };
  }
  private save(): void { try { localStorage.setItem(KEY, JSON.stringify(this.st)); } catch { /* ignore */ } }

  /** Accumulate focus time; writes are batched (call with dt each frame). */
  recordFocus(hour: number, seconds: number, now: number): void {
    this.pending += seconds;
    if (now - this.lastFlush > 15_000 && this.pending > 0) {
      this.st.focusByHour[hour] = (this.st.focusByHour[hour] || 0) + this.pending / 60;
      this.pending = 0; this.lastFlush = now; this.save();
    }
  }

  isPeakHour(hour: number): boolean { return peakHours(this.st.focusByHour).includes(hour); }
  totalFocusMin(): number { return Math.round(this.st.focusByHour.reduce((a, b) => a + b, 0)); }
}

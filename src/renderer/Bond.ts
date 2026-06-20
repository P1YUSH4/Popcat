import type { AffectSnapshot } from "./Affect";

export interface BondState {
  xp: number;
  level: number;
  lastTreatDate: string;
  lastSeenDate: string;
  dailyCareStreak: number;
}

export interface BondSummary {
  xp: number;
  level: number;
  levelName: string;
  nextXp: number;
  dailyCareStreak: number;
  treatAvailable: boolean;
}

const KEY = "pao.bond.v1";
const LEVELS = [
  { xp: 0, name: "Shy" },
  { xp: 25, name: "Curious" },
  { xp: 75, name: "Playful" },
  { xp: 150, name: "Attached" },
  { xp: 300, name: "Loyal" },
];

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yesterdayOf(key: string): string {
  const t = Date.parse(key + "T00:00:00Z") - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function levelFor(xp: number): number {
  let level = 1;
  for (let i = 0; i < LEVELS.length; i++) if (xp >= LEVELS[i].xp) level = i + 1;
  return level;
}

export class BondController {
  private st: BondState;
  private focusCreditMin = 0;

  constructor(private onLevelUp: (level: number, name: string) => void) {
    this.st = this.load();
    this.recalc();
  }

  private load(): BondState {
    const def: BondState = { xp: 0, level: 1, lastTreatDate: "", lastSeenDate: "", dailyCareStreak: 0 };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { ...def, ...(JSON.parse(raw) as Partial<BondState>) };
    } catch { /* ignore */ }
    return def;
  }

  private save(): void { try { localStorage.setItem(KEY, JSON.stringify(this.st)); } catch { /* ignore */ } }

  private addXp(amount: number): void {
    if (amount <= 0) return;
    const before = this.st.level;
    this.st.xp = Math.min(9999, this.st.xp + amount);
    this.recalc();
    this.save();
    if (this.st.level > before) this.onLevelUp(this.st.level, this.levelName());
  }

  private recalc(): void { this.st.level = levelFor(this.st.xp); }

  /** Passive bond: returning daily and staying focused together slowly builds trust. */
  update(s: AffectSnapshot, dtSec: number): void {
    const today = dayKey(new Date());
    if (s.idleSec < 60 && this.st.lastSeenDate !== today) {
      if (this.st.lastSeenDate === yesterdayOf(today)) this.st.dailyCareStreak += 1;
      else this.st.dailyCareStreak = 1;
      this.st.lastSeenDate = today;
      this.addXp(4);
    }

    if (s.rhythm === "FOCUSED" || s.rhythm === "FLOW") {
      this.focusCreditMin += dtSec / 60;
      while (this.focusCreditMin >= 10) {
        this.focusCreditMin -= 10;
        this.addXp(2);
      }
    }
  }

  giveTreat(): { ok: boolean; message: string } {
    const today = dayKey(new Date());
    if (this.st.lastTreatDate === today) return { ok: false, message: "Already had a treat today." };
    this.st.lastTreatDate = today;
    this.addXp(10);
    this.save();
    return { ok: true, message: "+10 bond" };
  }

  levelName(): string { return LEVELS[this.st.level - 1]?.name ?? "Loyal"; }

  summary(): BondSummary {
    const next = LEVELS[this.st.level]?.xp ?? LEVELS[LEVELS.length - 1].xp;
    return {
      xp: Math.round(this.st.xp),
      level: this.st.level,
      levelName: this.levelName(),
      nextXp: next,
      dailyCareStreak: this.st.dailyCareStreak,
      treatAvailable: this.st.lastTreatDate !== dayKey(new Date()),
    };
  }
}

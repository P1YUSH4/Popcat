// Tiny WebAudio SFX — synthesized (no asset files), so the reminders can chime.
// Muteable. The AudioContext is created lazily and resumed on first use (the
// main process sets autoplay-policy=no-user-gesture-required so timer-triggered
// sounds are allowed without a click).
class SoundFX {
  private ctx: AudioContext | null = null;
  muted = false;

  private ac(): AudioContext {
    if (!this.ctx) {
      try { this.ctx = new AudioContext(); }
      catch { return null as unknown as AudioContext; }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** one enveloped tone (fast attack, exponential decay). */
  private tone(freq: number, start: number, dur: number, gain = 0.18, type: OscillatorType = "sine"): void {
    const ctx = this.ac();
    if (!ctx) return;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.start(t0); osc.stop(t0 + dur + 0.03);
  }

  /** meeting: a bright two-strike bell (fundamental + inharmonic partial). */
  bell(): void {
    if (this.muted) return;
    for (const s of [0, 0.19]) {
      this.tone(1318, s, 0.55, 0.20, "triangle");   // E6 strike
      this.tone(2637, s, 0.40, 0.07, "sine");        // shimmer partial
    }
  }

  /** meeting reminder: an insistent "ring-ring … ring-ring … ring-ring" alarm
   *  (louder + repeated so it actually grabs your attention). */
  meetingAlarm(): void {
    if (this.muted) return;
    for (const s of [0, 0.15, 0.45, 0.60, 0.90, 1.05]) {   // 3 ring-ring pairs
      this.tone(1318, s, 0.30, 0.26, "triangle");          // E6 strike (louder)
      this.tone(2637, s, 0.22, 0.10, "sine");              // shimmer partial
    }
  }

  /** pomodoro break: gentle rising two-note "you earned a rest" chime. */
  breakChime(): void {
    if (this.muted) return;
    this.tone(659, 0.00, 0.50, 0.16, "sine");   // E5
    this.tone(988, 0.17, 0.62, 0.16, "sine");   // B5
  }

  /** back to work: firmer low->high double cue. */
  focusCue(): void {
    if (this.muted) return;
    this.tone(523, 0.00, 0.20, 0.17, "triangle");  // C5
    this.tone(784, 0.16, 0.34, 0.16, "triangle");  // G5
  }

  /** pomodoro started: quick ascending "go" blip. */
  startPomo(): void {
    if (this.muted) return;
    this.tone(587, 0.00, 0.10, 0.15, "triangle");  // D5
    this.tone(880, 0.09, 0.16, 0.15, "triangle");  // A5
  }

  /** pomodoro stopped: gentle descending blip. */
  stopPomo(): void {
    if (this.muted) return;
    this.tone(659, 0.00, 0.12, 0.14, "sine");      // E5
    this.tone(440, 0.11, 0.22, 0.14, "sine");      // A4
  }
}

export const sound = new SoundFX();

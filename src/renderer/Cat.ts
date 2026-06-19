import { AnimationController } from "./AnimationController";
import { BehaviorController } from "./BehaviorController";
import { InputController } from "./InputController";
import { Particles } from "./Particles";
import { PhysicsController } from "./PhysicsController";
import { SpriteRenderer, type DrawOpts } from "./SpriteRenderer";
import { sound } from "./Sound";
import { recolorSheet } from "./recolor";
import type { SpriteMeta } from "./types";

type Rect = { x: number; y: number; w: number; h: number };
/** Smallest rect covering both inputs (used to grow the per-frame clear region). */
function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Top-level orchestrator. Owns every controller, runs the delta-time update +
 * render each frame, and exposes the public thinking API.
 *
 *   window.cat.startThinking()  -> enters the thinking animation
 *   window.cat.finishThinking() -> happy jump, then back to idle
 */
export class Cat {
  readonly anim: AnimationController;
  readonly phys = new PhysicsController();
  readonly input = new InputController();
  readonly behavior: BehaviorController;
  private renderer: SpriteRenderer;
  private srcSheet: HTMLImageElement;   // original art, recolored on config change
  name = "Pao";

  private dragging = false;
  private lastHitboxSent = 0;
  // shake detection while dragging
  private dragLastX = 0;
  private dragDir = 0;
  private dragReversals: number[] = [];
  private lastMoveT = 0;
  // visual/particle bookkeeping
  private particles = new Particles();
  private prevState = "";
  private shakeT0 = 0;
  private celebrateBurstDone = false;
  private bubbleEl: HTMLDivElement | null = null;
  // countdown timer chips above the head (pomodoro + meeting), each with an ✕
  private pomoChip: HTMLDivElement | null = null;
  private meetingChip: HTMLDivElement | null = null;
  private timersVisible = false;
  private timerRows = 0;
  private lastPomoSig = "";
  private lastClear: { x: number; y: number; w: number; h: number } | null = null;
  // yarn ball the cat plays with while scrolling (runtime physics)
  private yarnAngle = 0;   // current spin
  private yarnSpin = 0;    // extra spin from bats (decays)
  private yarnVis = 0;     // fade in/out
  private yox = 0; private yoy = 0;   // ball offset from rest (px)
  private yvx = 0; private yvy = 0;   // ball velocity
  private ySquash = 0;     // impact squash
  private lastPawFrame = -1;

  constructor(canvas: HTMLCanvasElement, sheet: HTMLImageElement, meta: SpriteMeta) {
    this.anim = new AnimationController(meta);
    this.srcSheet = sheet;
    this.renderer = new SpriteRenderer(canvas, sheet, meta);
    this.behavior = new BehaviorController(this.anim, this.phys, this.input);

    this.fitToWindow();
    this.phys.teleportTo({ x: this.phys.bounds.maxX * 0.5, y: this.phys.bounds.maxY * 0.8 });

    window.addEventListener("resize", () => this.fitToWindow());
    this.installDragHandlers(canvas);
  }

  private fitToWindow(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.resize(w, h, dpr);
    this.phys.setBounds(w, h);
    this.behavior.setBounds(w, h);
    this.behavior.headDy = (52 - 22) * this.renderer.scale; // foot->head in screen px
    this.behavior.headR = 12 * this.renderer.scale;         // head-only petting radius
    this.behavior.hoverHalfW = 18 * this.renderer.scale;    // body hover box (screen px)
    this.behavior.hoverHeight = 56 * this.renderer.scale;

  }

  // ---- public API -------------------------------------------------------
  startThinking(): void { this.behavior.startThinking(); }
  finishThinking(): void { this.behavior.finishThinking(); }
  /** work-aware loop: thinking() while a prompt generates, answerReady() on done. */
  thinking(): void { this.behavior.startThinking(); }
  answerReady(): void { this.behavior.answerReady(); }
  rest(): void { this.behavior.rest(); }
  celebrate(): void { this.behavior.doCelebrate(); }
  worried(): void { this.behavior.doWorried(); }
  private static BUG_QUIPS = ["Ugh, a bug! 🐛", "Not again… 💢", "Who wrote this?! 😾",
    "Squash it! 🐛", "Hisss… 🐛", "Seriously?! 💢", "It worked yesterday 🐛"];

  /** dev-event reaction: play an animation for `type` and show an optional message. */
  react(type: string, msg?: string): void {
    let m = (msg || "").trim();
    switch ((type || "").toLowerCase()) {
      case "celebrate": case "pass": case "passed": case "success": case "green": case "pushed":
        this.behavior.doCelebrate(); break;
      case "frustrated": case "bug": case "annoyed": case "fail": case "failed": case "error": case "angry":
        this.behavior.doAngry();
        if (!m) m = Cat.BUG_QUIPS[Math.floor(Math.random() * Cat.BUG_QUIPS.length)];
        break;
      case "worried": case "concerned": case "red":
        this.behavior.doWorried(); break;
      case "think": case "thinking": case "working": case "run":
        this.behavior.startThinking(); break;
      case "confused": case "switch":
        this.behavior.doConfused(); break;
      default: this.behavior.answerReady(); break;   // alert / done
    }
    if (m) this.behavior.say(m, 5000);
  }
  hydrate(): void { this.behavior.doHydration(); }
  startPomodoro(): void { this.behavior.startPomodoro(); }
  stopPomodoro(): void { this.behavior.stopPomodoro(); }
  scheduleMeeting(mins: number, label?: string, preMin?: number): void { this.behavior.scheduleMeeting(mins, label, preMin); }
  scheduleMeetingAt(atMs: number, label?: string, preMin?: number): void { this.behavior.scheduleMeetingAt(atMs, label, preMin); }
  focusAlert(): void { this.behavior.doFocusAlert(); }   // demo
  configurePomodoro(cfg: { focus: number; brk: number; long: number; every: number; start?: boolean }): void {
    this.behavior.configurePomodoro(cfg.focus, cfg.brk, cfg.long, cfg.every);
    if (cfg.start) this.behavior.startPomodoro();
  }
  /** apply persisted settings (from main's config). */
  applyConfig(cfg: import("./types").PaoConfig): void {
    this.behavior.sleepMs = Math.max(10_000, cfg.sleepMin * 60_000);
    this.behavior.hydrationMs = Math.max(0, cfg.hydrationMin) * 60_000;
    this.behavior.leisureNudge = cfg.leisureNudge;
    this.input.userRules = cfg.contextRules || [];
    sound.muted = cfg.sound.muted;
    sound.volume = cfg.sound.volume;
    this.name = cfg.name || "Pao";
    // repaint fur + bell from the original art (idempotent across changes)
    this.renderer.setSheet(recolorSheet(this.srcSheet, cfg.furId || "classic", cfg.bellColor || "gold"));
  }
  pausePomodoro(): void { this.behavior.pausePomodoro(); }
  resumePomodoro(): void { this.behavior.resumePomodoro(); }
  skipPomodoro(): void { this.behavior.skipPomodoro(); }
  /** Force-end any in-progress drag (called when main detects a global mouseup). */
  cancelDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.dragReversals.length = 0;
    this.behavior.setShaking(false);
    this.behavior.endDrag();
  }
  stretch(): void { this.behavior.doStretch(); }
  meow(msg?: string): void { this.behavior.doMeow(msg); }
  fall(): void { this.behavior.doFall(); }
  confused(): void { this.behavior.doConfused(); }
  angry(): void { this.behavior.doAngry(); }
  setPeek(on: boolean): void { this.behavior.setPeek(on); }

  // ---- frame loop -------------------------------------------------------
  update(dt: number): void {
    // stop "shaking" if the cursor has gone still mid-drag
    if (this.dragging && performance.now() - this.lastMoveT > 200) {
      this.dragReversals.length = 0;
      this.behavior.setShaking(false);
    }
    this.behavior.update(dt);
    this.phys.update(dt);
    this.anim.update(dt * 1000);
    this.particles.update(dt);
    this.emitParticles();
    this.updateYarn(dt);
    this.syncHitbox();
    this.syncPomoState();
  }

  /** tell main about Pomodoro state changes so the tray menu can reflect them. */
  private syncPomoState(): void {
    const b = this.behavior;
    const on = b.isPomoActive(), paused = b.isPomoPaused();
    const sig = `${on ? 1 : 0}|${paused ? 1 : 0}|${b.pomoLabel()}`;
    if (sig === this.lastPomoSig) return;
    this.lastPomoSig = sig;
    window.bridge.setPomoState({ on, paused, phase: b.pomoLabel() });
  }

  /**
   * The cat plays with the yarn ball while scrolling. Each paw-strike frame
   * knocks the ball (hop + sideways nudge + spin kick); the ball then falls
   * under gravity, bounces with a squash, and springs back to rest — so it
   * reads as a real ball being batted around. Spin also tracks scroll dir/speed.
   */
  private updateYarn(dt: number): void {
    const s = this.renderer.scale;
    if (this.state() === "PAPER") {
      this.yarnVis = Math.min(1, this.yarnVis + dt * 6);
      const power = this.input.scrollPower();
      // a paw lands on the "down" frames (1,3,5,7) -> knock the ball
      const fi = this.anim.frameIndex();
      if (fi !== this.lastPawFrame) {
        this.lastPawFrame = fi;
        if (fi === 1 || fi === 3 || fi === 5 || fi === 7) {
          const dir = (fi === 1 || fi === 5) ? 1 : -1;   // left paw +x, right paw -x
          this.yvy = -150 * s;                            // pop up
          this.yvx += dir * 80 * s;                       // batted sideways
          this.yarnSpin += dir * 6 + this.input.scrollDir * 2;
        }
      }
      this.yarnAngle += (this.input.scrollDir * (3 + power * 9) + this.yarnSpin) * dt;
    } else {
      this.yarnVis = Math.max(0, this.yarnVis - dt * 5);
    }
    this.yarnSpin *= Math.max(0, 1 - dt * 3);

    // --- ball physics (offset from its rest point) ---
    const g = 1500 * s;
    this.yvy += g * dt;
    this.yoy += this.yvy * dt;
    if (this.yoy > 0) {                       // hit the ground (rest line)
      this.yoy = 0;
      if (this.yvy > 60 * s) this.ySquash = Math.min(0.45, this.yvy / (1100 * s));
      this.yvy *= -0.45;                      // bounce
      if (Math.abs(this.yvy) < 25 * s) this.yvy = 0;
    }
    this.yox += this.yvx * dt;
    this.yvx += -this.yox * 16 * dt;          // spring back toward rest x
    this.yvx *= Math.max(0, 1 - dt * 3);      // rolling friction
    this.yox = Math.max(-24 * s, Math.min(24 * s, this.yox));
    this.ySquash *= Math.max(0, 1 - dt * 9);  // squash recovers
  }

  /** head height above the foot point, in screen px (tracks renderScale). */
  private get headOff(): number { return 34 * this.renderer.scale; }
  private state(): string { return this.behavior.sm.state; }

  /** true when nothing dynamic is happening, so the loop can drop to a low fps
   *  (the cat just sitting/sleeping) — big idle-CPU saving for an always-on app. */
  lowActivity(): boolean {
    if (this.dragging || this.behavior.sm.locked) return false;     // drag / one-shot anim
    const s = this.state();
    if (s !== "SIT" && s !== "SLEEP" && s !== "IDLE" && s !== "PEEK") return false;
    return !this.particles.active() && this.yarnVis <= 0.01 && !this.bubbleEl;
  }

  /** Emit particles based on the current state (logic only, no new frames). */
  private emitParticles(): void {
    const s = this.state();
    if (s !== this.prevState) { // transition bookkeeping
      if (s === "SHAKE") this.shakeT0 = performance.now();
      if (s !== "CELEBRATE") this.celebrateBurstDone = false;
      this.prevState = s;
    }
    const head = { x: this.phys.pos.x, y: this.phys.pos.y - this.headOff };
    if (s === "OVERHEAT") this.particles.steam(head, performance.now());
    if (s === "PET") this.particles.heart(head, performance.now());
    if (s === "CELEBRATE" && !this.celebrateBurstDone && this.anim.progress() >= 0.25) {
      this.celebrateBurstDone = true;
      this.particles.burst({ x: this.phys.pos.x, y: this.phys.pos.y - this.headOff });
      this.particles.heart(head, performance.now());
    }
  }

  render(): void {
    // Clear only the area around the cat (union of last + current), not the
    // whole full-screen canvas — big idle-CPU win. Generous margin covers the
    // sprite cell, particles, the yarn ball, and squash/stretch overshoot.
    const p = this.phys.pos;
    // Base rect around the cat (covers the sprite cell + squash/stretch overshoot).
    let cur = { x: p.x - 150, y: p.y - 215, w: 300, h: 265 };
    // Particles & the yarn ball are anchored in world space — if the cat is moved
    // away while they're alive they'd strand (e.g. a pink heart/confetti spot), so
    // union their actual bounds into the cleared region rather than just widening
    // around the (now-distant) cat.
    const pb = this.particles.bounds();
    if (pb) cur = unionRect(cur, pb);
    if (this.yarnVis > 0.01) {
      const s = this.renderer.scale;
      const yc = { x: p.x + 16 * s + this.yox, y: p.y - 6 * s + this.yoy };
      cur = unionRect(cur, { x: yc.x - 16 * s, y: yc.y - 16 * s, w: 32 * s, h: 32 * s });
    }
    if (this.lastClear) {
      const x0 = Math.min(cur.x, this.lastClear.x), y0 = Math.min(cur.y, this.lastClear.y);
      const x1 = Math.max(cur.x + cur.w, this.lastClear.x + this.lastClear.w);
      const y1 = Math.max(cur.y + cur.h, this.lastClear.y + this.lastClear.h);
      this.renderer.clearRegion(x0, y0, x1 - x0, y1 - y0);
    } else {
      this.renderer.clearRegion(cur.x, cur.y, cur.w, cur.h);
    }
    this.lastClear = cur;
    const frame = this.anim.frame();
    const faceLeft = this.behavior.facingLeft();
    const opts = this.visualOpts();
    this.renderer.draw(frame, this.phys.pos, faceLeft, opts);
    // eyes track the cursor ONLY in follow mode; otherwise they stay forward
    // (so a drag-only cat doesn't "follow" you with its eyes either)
    const track = this.behavior.autonomous;
    this.renderer.drawPupils(frame, this.phys.pos, faceLeft, opts, this.input.cursor, track);
    this.particles.draw(this.renderer.context, this.renderer.scale);
    if (this.yarnVis > 0.01) {
      const s = this.renderer.scale;
      const center = { x: this.phys.pos.x + 16 * s + this.yox, y: this.phys.pos.y - 6 * s + this.yoy };
      const paw = { x: this.phys.pos.x + 7 * s, y: this.phys.pos.y - 11 * s };
      this.renderer.drawYarn(center, this.yarnAngle, this.yarnVis, 6.5 * s, paw, this.ySquash);
    }
    this.updateBubble();
    this.updateTimers();
  }

  /** Per-state visual transform (crouch/stretch/bob/rotation/tint/clip). */
  private visualOpts(): DrawOpts {
    const s = this.state();
    const now = performance.now();
    const o: DrawOpts = {};
    if (s === "HUNT") { o.sy = 0.85; o.sx = 1.06; }
    if (s === "WALK") o.bob = Math.sin(now * 0.012) * 2;
    if (s === "OVERHEAT") o.tint = true;
    if (s === "PEEK") o.clipTopHalf = true;
    // (no DRAG stretch — the cat keeps its normal proportions while dragged)
    if (s === "SHAKE") {
      const decay = this.dragging ? 1 : Math.max(0, 1 - (now - this.shakeT0) / 400);
      o.rot = Math.sin(now * 0.04) * (15 * Math.PI / 180) * decay;
    }
    return o;
  }

  /** Speech bubble for MEOW (think "…" is baked into the sprite). */
  private updateBubble(): void {
    const now = performance.now();
    const meowing = this.state() === "MEOW";
    // meow bubble (persists until dismissed) OR a timed message (stretch/hydration)
    const text = meowing ? (this.behavior.meowMsg || "Meow!")
               : (now < this.behavior.bubbleUntil ? this.behavior.bubbleMsg : "");
    if (text) {
      if (!this.bubbleEl) {
        const el = document.createElement("div");
        el.className = "bubble";
        el.addEventListener("mousedown", (e) => {
          e.stopPropagation();
          if (this.state() === "MEOW") this.behavior.dismissMeow();
        });
        document.body.appendChild(el); this.bubbleEl = el;
      }
      this.bubbleEl.textContent = text;
      this.bubbleEl.style.left = this.phys.pos.x + "px";
      // sit the bubble above any timer chips so they don't overlap
      this.bubbleEl.style.top = (this.phys.pos.y - this.headOff - 30 - this.timerRows * 24) + "px";
    } else if (this.bubbleEl) { this.bubbleEl.remove(); this.bubbleEl = null; }
  }

  private syncHitbox(): void {
    const now = performance.now();
    if (now - this.lastHitboxSent < 60) return; // ~16fps throttle
    this.lastHitboxSent = now;
    let box = this.renderer.hitbox(this.phys.pos);
    // when timer chips are shown, widen the interactive region upward to cover
    // them so their ✕ buttons are clickable (window isn't click-through there)
    if (this.timersVisible) {
      const p = this.phys.pos;
      const top = p.y - this.headOff - 64, left = p.x - 85, right = p.x + 85;
      const x = Math.min(box.x, left), y = Math.min(box.y, top);
      box = { x, y, w: Math.max(box.x + box.w, right) - x, h: box.y + box.h - y };
    }
    // convert canvas coords -> screen coords using the display origin held in InputController
    const ox = this.input.cursorScreen.x - this.input.cursor.x;
    const oy = this.input.cursorScreen.y - this.input.cursor.y;
    window.bridge.setHitbox({ x: box.x + ox, y: box.y + oy, w: box.w, h: box.h });
  }

  /** small mm:ss timer chips above the head; ✕ cancels that timer. */
  private updateTimers(): void {
    const b = this.behavior;
    const pomo = b.isPomoActive(), meet = b.isMeetingPending();
    this.timersVisible = pomo || meet;
    this.timerRows = (pomo ? 1 : 0) + (meet ? 1 : 0);
    const base = this.phys.pos.y - this.headOff - 22;
    let row = 0;
    if (pomo) {
      if (!this.pomoChip) this.pomoChip = this.makeChip(() => this.behavior.stopPomodoro());
      this.setChip(this.pomoChip, this.pomoChipText(), base - row * 24);
      row++;
    } else if (this.pomoChip) this.pomoChip.style.display = "none";
    if (meet) {
      if (!this.meetingChip) this.meetingChip = this.makeMeetingChip();
      const snooze = this.meetingChip.querySelector(".snooze") as HTMLElement;
      snooze.style.display = b.isRinging() ? "inline" : "none";   // snooze only while ringing
      this.setChip(this.meetingChip, b.meetingChipText(), base - row * 24);
    } else if (this.meetingChip) this.meetingChip.style.display = "none";
  }

  private makeChip(onClose: () => void): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "timer-chip";
    const label = document.createElement("span");
    const x = document.createElement("span");
    x.className = "x"; x.textContent = "✕";
    x.addEventListener("mousedown", (e) => { e.stopPropagation(); onClose(); });
    el.appendChild(label); el.appendChild(x);
    document.body.appendChild(el);
    return el;
  }

  private setChip(el: HTMLDivElement, text: string, topPx: number): void {
    (el.firstChild as HTMLElement).textContent = text;
    el.style.left = this.phys.pos.x + "px";
    el.style.top = topPx + "px";
    el.style.display = "flex";
  }

  /** meeting chip has a 💤 snooze (while ringing) and an ✕ dismiss/cancel. */
  private makeMeetingChip(): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "timer-chip";
    const label = document.createElement("span");
    const snooze = document.createElement("span");
    snooze.className = "x snooze"; snooze.textContent = "💤"; snooze.title = "Snooze 5 min";
    snooze.addEventListener("mousedown", (e) => { e.stopPropagation(); this.behavior.snoozeMeeting(5); });
    const x = document.createElement("span");
    x.className = "x"; x.textContent = "✕";
    x.addEventListener("mousedown", (e) => { e.stopPropagation(); this.behavior.cancelMeeting(); });
    el.appendChild(label); el.appendChild(snooze); el.appendChild(x);
    document.body.appendChild(el);
    return el;
  }

  private mmss(ms: number): string {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  private pomoChipText(): string {
    const b = this.behavior;
    const t = this.mmss(b.pomoRemainingMs());
    const pause = b.isPomoPaused() ? "⏸ " : "";
    if (b.pomoPhaseKind() === "work") {
      const r = b.pomoRound();
      return `${pause}🍅 Focus ${t} · ${r.done + 1}/${r.total}`;
    }
    const emoji = b.pomoPhaseKind() === "long" ? "😴" : "☕";
    return `${pause}${emoji} ${b.pomoLabel()} ${t}`;
  }

  private installDragHandlers(canvas: HTMLCanvasElement): void {
    const overCat = (e: MouseEvent): boolean => {
      const hb = this.renderer.hitbox(this.phys.pos);
      return e.clientX >= hb.x && e.clientX <= hb.x + hb.w &&
             e.clientY >= hb.y && e.clientY <= hb.y + hb.h;
    };
    const HOLD = 70; // cat hangs this far below the cursor (held by the scruff)
    canvas.addEventListener("mousedown", (e) => {
      if (!overCat(e)) return;
      // click the cat to acknowledge a ringing meeting alarm
      if (this.behavior.isRinging()) { this.behavior.ackMeeting(); return; }
      // click cat to dismiss a meow bubble or to bring it out of peek mode
      if (this.state() === "MEOW") { this.behavior.dismissMeow(); return; }
      if (this.behavior.peekMode) { this.behavior.revealFromPeek(); return; }
      this.dragging = true;
      this.dragLastX = e.clientX;
      this.dragDir = 0;
      this.dragReversals.length = 0;
      this.lastMoveT = performance.now();
      window.bridge.setDragging(true);   // keep mouse captured during spring lag
      this.behavior.beginDrag();
      this.behavior.dragTo({ x: e.clientX, y: e.clientY + HOLD });
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.dragging) return;
      this.behavior.dragTo({ x: e.clientX, y: e.clientY + HOLD }); // spring target

      // shake detection: count rapid horizontal direction reversals
      const now = performance.now();
      this.lastMoveT = now;
      const dx = e.clientX - this.dragLastX;
      this.dragLastX = e.clientX;
      if (Math.abs(dx) > 3) {
        const dir = Math.sign(dx);
        if (this.dragDir !== 0 && dir !== this.dragDir) this.dragReversals.push(now);
        this.dragDir = dir;
      }
      this.dragReversals = this.dragReversals.filter((t) => now - t < 450);
      this.behavior.setShaking(this.dragReversals.length >= 3);
    });
    window.addEventListener("mouseup", () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.dragReversals.length = 0;
      window.bridge.setDragging(false);
      this.behavior.endDrag();
    });
    // Safety net from main's global mouse-up hook: if the window never received
    // the mouseup (overlay went click-through mid-interaction), drop the drag
    // here so it can't get stuck (which would freeze input/scroll).
    window.bridge.onDragCancel(() => this.cancelDrag());
    // double-click the cat -> dizzy (NOT on single click or drag)
    canvas.addEventListener("dblclick", (e) => {
      if (!overCat(e)) return;
      this.dragging = false;
      this.dragReversals.length = 0;
      window.bridge.setDragging(false);
      this.behavior.doConfused();
    });
  }
}

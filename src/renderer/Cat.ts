import { AchievementsController } from "./Achievements";
import { AffectController, type AffectSnapshot } from "./Affect";
import { accessoryLabel, ACCESSORIES, ACCESSORY_UNLOCKS, accessoryRequirement, unlockedAccessories } from "./Accessories";
import { BondController } from "./Bond";
import { coatLabel, coatRequirement, COATS, COAT_UNLOCKS, unlockedCoats } from "./Coats";
import { AnimationController } from "./AnimationController";
import { BehaviorController } from "./BehaviorController";
import { InputController } from "./InputController";
import { Particles } from "./Particles";
import { Perception } from "./Perception";
import { PhysicsController } from "./PhysicsController";
import { sound } from "./Sound";
import { SpriteRenderer, type DrawOpts } from "./SpriteRenderer";
import type { SpriteMeta, Vec2 } from "./types";

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
  readonly perception: Perception;
  readonly affectEngine: AffectController;
  private achv: AchievementsController;
  private bond: BondController;
  private renderer: SpriteRenderer;
  private lastStateSent = 0;

  private dragging = false;
  private lastHitboxSent = 0;
  // shake detection while dragging
  private dragLastX = 0;
  private dragDir = 0;
  private dragReversals: number[] = [];
  private lastMoveT = 0;
  // throw: pointer velocity during a drag (px/s) -> fling on release
  private dragVel = { x: 0, y: 0 };
  private dragPrev = { x: 0, y: 0 };
  private dragPrevT = 0;
  private bounceSquash = 0;   // transient squash on a wall bounce
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
    this.renderer = new SpriteRenderer(canvas, sheet, meta);
    this.behavior = new BehaviorController(this.anim, this.phys, this.input);
    this.perception = new Perception(this.input);
    this.affectEngine = new AffectController(this.perception, this.behavior);
    // deterministic reward loop on top of the rhythm engine (no AI)
    this.achv = new AchievementsController((title, id) => {
      this.behavior.doCelebrate();
      this.behavior.say(`🏆 ${title}`, 3200);
      sound.achievement();
      // does this achievement unlock a coat / accessory? announce it (the loop)
      const coat = Object.keys(COAT_UNLOCKS).find((c) => COAT_UNLOCKS[c] === id);
      if (coat) setTimeout(() => this.behavior.say(`🎨 New coat unlocked: ${coatLabel(coat)}!`, 3000), 1700);
      const acc = Object.keys(ACCESSORY_UNLOCKS).find((a) => ACCESSORY_UNLOCKS[a] === id);
      if (acc) setTimeout(() => this.behavior.say(`🎀 New accessory: ${accessoryLabel(acc)}!`, 3000), coat ? 3400 : 1700);
    });
    this.bond = new BondController((level, name) => {
      this.behavior.doCelebrate();
      this.behavior.say(`Bond level ${level}: ${name}`, 3200);
      sound.achievement();
    });
    // foreground-window changes (optional signal) feed ambient perception
    window.bridge.onAppFocus?.((title: string) => this.perception.setActiveApp(title));
    // wall bounce while thrown -> squash + thud
    this.phys.onBounce = (strength: number) => {
      this.bounceSquash = Math.min(0.5, 0.22 + strength * 0.4);
      sound.thud(strength);
    };
    // restore the saved coat colour + pet name
    const savedCoat = localStorage.getItem("pao.coat");
    if (savedCoat) this.renderer.setCoat(savedCoat);
    const savedName = localStorage.getItem("pao.name");
    if (savedName) this.behavior.petName = savedName;
    const savedAcc = localStorage.getItem("pao.accessory");
    if (savedAcc) this.renderer.setAccessory(savedAcc);

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
  hydrate(): void { this.behavior.doHydration(); }
  startPomodoro(): void { this.behavior.startPomodoro(); }
  stopPomodoro(): void { this.behavior.stopPomodoro(); }
  scheduleMeeting(mins: number, label?: string): void { this.behavior.scheduleMeeting(mins, label); }
  focusAlert(): void { this.behavior.doFocusAlert(); }   // demo
  configurePomodoro(cfg: { focus: number; brk: number; long: number; every: number; start?: boolean }): void {
    this.behavior.configurePomodoro(cfg.focus, cfg.brk, cfg.long, cfg.every);
    if (cfg.start) this.behavior.startPomodoro();
  }
  stretch(): void { this.behavior.doStretch(); }
  meow(msg?: string): void { this.behavior.doMeow(msg); }
  fall(): void { this.behavior.doFall(); }
  confused(): void { this.behavior.doConfused(); }
  angry(): void { this.behavior.doAngry(); }
  setPeek(on: boolean): void { this.behavior.setPeek(on); }
  /** wander mode: full reactive set (walks/hunts/eyes follow) vs drag-only. */
  setAutonomous(on: boolean): void { this.behavior.setAutonomous(on); }
  /** current ambient-perception + mood snapshot (for the control server / devtools). */
  affect(): AffectSnapshot { return this.affectEngine.snapshot(); }
  /** unlocked achievements + streak summary. */
  achievements() { return this.achv.summary(); }
  /** swap the cat's coat colour — only if it's been unlocked (the earn loop). */
  setCoat(name: string): void {
    if (!unlockedCoats(this.achv.unlockedIds()).has(name)) {
      this.behavior.say("🔒 Earn this coat first!", 2200);
      return;
    }
    this.renderer.setCoat(name);
    try { localStorage.setItem("pao.coat", name); } catch { /* ignore */ }
  }
  /** coats unlocked so far (for the settings picker / control server). */
  unlockedCoatNames(): string[] { return [...unlockedCoats(this.achv.unlockedIds())]; }
  /** put on / take off an accessory — only if it's been unlocked. */
  setAccessory(name: string): void {
    if (!unlockedAccessories(this.achv.unlockedIds()).has(name)) {
      this.behavior.say("🔒 Earn this accessory first!", 2200);
      return;
    }
    this.renderer.setAccessory(name);
    try { localStorage.setItem("pao.accessory", name); } catch { /* ignore */ }
  }
  /** name the pet; persisted, used in greetings. */
  setName(name: string): void {
    const n = name.trim().slice(0, 20);
    this.behavior.petName = n;
    try { localStorage.setItem("pao.name", n); } catch { /* ignore */ }
    this.behavior.say(n ? `I'm ${n}! 🐾` : "Meow~", 2200);
  }
  petName(): string { return this.behavior.petName; }
  /** daily care action: one treat per day builds bond and gives a cute reaction. */
  giveTreat(): void {
    const r = this.bond.giveTreat();
    if (r.ok) {
      this.behavior.say(`Yum! ${r.message}`, 2400);
      this.behavior.doCelebrate();
      this.particles.heart({ x: this.phys.pos.x, y: this.phys.pos.y - this.headOff }, performance.now());
    } else {
      this.behavior.say("Already had a treat today. Pet me instead?", 2400);
    }
  }
  /** first-run greeting: a happy hop + a friendly tip bubble. */
  welcome(): void {
    this.behavior.say("Hi! I'm Pao 🐾 right-click my tray icon to name me & dress me up", 6000);
    this.behavior.finishThinking();   // happy jump
  }
  /** use a hi-res painted image instead of the pixel sprite (illustrated mode). */
  setIllustrated(img: HTMLImageElement): void { this.renderer.setIllustrated(img, 64 * this.renderer.scale * 0.85); }
  /** current interactive hitbox (illustrated or pixel). */
  private catHitbox(pos: Vec2): { x: number; y: number; w: number; h: number } {
    return this.renderer.isIllustrated ? this.renderer.illuHitbox(pos) : this.renderer.hitbox(pos);
  }
  private visibleHitbox(): { x: number; y: number; w: number; h: number } {
    let box = this.catHitbox(this.phys.pos);
    if (this.timersVisible) {
      const p = this.phys.pos;
      const top = p.y - this.headOff - 64, left = p.x - 85, right = p.x + 85;
      const x = Math.min(box.x, left), y = Math.min(box.y, top);
      box = { x, y, w: Math.max(box.x + box.w, right) - x, h: box.y + box.h - y };
    }
    if (this.behavior.peekMode) {
      // peeking past the RIGHT edge: clamp the hitbox to the visible (on-screen)
      // left sliver so the cursor still registers over the peeking head.
      const W = window.innerWidth;
      const x0 = Math.max(0, box.x), x1 = Math.min(box.x + box.w, W);
      const visW = x1 - x0;
      if (visW < 10) {
        const strip = 32;
        box = { x: W - strip, y: box.y, w: strip, h: box.h };
      } else {
        box = { x: x0, y: box.y, w: Math.max(10, visW), h: box.h };
      }
    }
    return box;
  }
  /** demo: toss the cat with a random upward velocity (used by /throw). */
  tossDemo(): void { this.behavior.throwCat({ x: (Math.random() * 2 - 1) * 700, y: -1100 - Math.random() * 400 }); }

  // ---- frame loop -------------------------------------------------------
  update(dt: number): void {
    // stop "shaking" if the cursor has gone still mid-drag
    if (this.dragging && performance.now() - this.lastMoveT > 200) {
      this.dragReversals.length = 0;
      this.behavior.setShaking(false);
    }
    this.behavior.update(dt);
    // ambient perception + mood: read your rhythm, gently steer baseline behaviour
    this.perception.update(dt);
    this.affectEngine.update(dt, performance.now());
    this.phys.update(dt);
    this.anim.update(dt * 1000);
    this.particles.update(dt);
    this.emitParticles();
    this.updateYarn(dt);
    this.bounceSquash *= Math.max(0, 1 - dt * 8);   // bounce squash recovers
    this.syncHitbox();
    this.syncAffectState();
  }

  /** True when the cat needs full 60fps (motion, drag, effects). False when it's
   *  calmly looping (sit / idle / sleep with no movement) so the frame loop can
   *  drop to ~30fps and save CPU/GPU during focus work or while you're away. */
  busy(): boolean {
    const s = this.state();
    const calm = s === "SIT" || s === "IDLE" || s === "LOOK_AROUND" || s === "SLEEP" || s === "LIE_DOWN";
    if (!calm || this.dragging) return true;
    if (this.yarnVis > 0.01) return true;
    if (this.particles.bounds() !== null) return true;
    return Math.hypot(this.phys.vel.x, this.phys.vel.y) > 4;
  }

  /** push the mood snapshot to the main process (~1Hz) so the local control
   *  server can serve it on GET /state — no screenshots, just rhythm + mood. */
  private syncAffectState(): void {
    const now = performance.now();
    if (now - this.lastStateSent < 1000) return;
    const dtSec = Math.min(2, (now - this.lastStateSent) / 1000);   // clamp first tick / stalls
    this.lastStateSent = now;
    const snap = this.affectEngine.snapshot();
    this.achv.update(snap, dtSec);
    this.bond.update(snap, dtSec);
    const ids = this.achv.unlockedIds();
    const unlocked = unlockedCoats(ids);
    const unlockedAcc = unlockedAccessories(ids);
    window.bridge.reportState?.({
      ...snap,
      name: this.behavior.petName,
      coat: this.renderer.coat,
      coats: COATS.map((c) => ({
        name: c.name, label: c.label, unlocked: unlocked.has(c.name),
        need: coatRequirement(c.name) ?? null,
        color: Object.values(c.map)[0] ?? "#2E2B3C",
      })),
      accessory: this.renderer.accessory,
      accessories: ACCESSORIES.map((a) => ({
        name: a.name, label: a.label, unlocked: unlockedAcc.has(a.name),
        need: accessoryRequirement(a.name) ?? null,
      })),
      achievements: this.achv.summary(),
      achList: this.achv.list(),
      bond: this.bond.summary(),
    });
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
    // Full-frame clear. A region-only clear is a micro-optimisation that can
    // leave "trails" — a stray accessory / yarn ball / particle drawn just
    // outside the moving clear window stays on the canvas (e.g. a detached hat
    // floating away from the cat). Clearing the whole transparent canvas each
    // frame is cheap (one GPU clear; we still only draw a single small sprite)
    // and makes trails impossible.
    this.renderer.clear();
    const frame = this.anim.frame();
    const faceLeft = this.behavior.facingLeft();
    const opts = this.visualOpts();
    if (this.renderer.isIllustrated) {
      // painted single-image cat: engine transforms drive the motion; the
      // painting has its own eyes, so no runtime pupils.
      this.renderer.drawIllustrated(this.phys.pos, faceLeft, opts);
    } else {
      // grounded contact shadow first (faint while held/airborne, wider when
      // the body squashes low) so the cat sits ON the desktop, not floating.
      const s = this.state();
      let shadow = 1;
      if (this.dragging) shadow = 0.32;
      else if (s === "FALL" || s === "JUMP" || s === "PEEK") shadow = 0.5;
      const wide = 1 + Math.max(0, 1 - (opts.sy ?? 1)) * 2.2;   // squash spreads it
      this.renderer.drawShadow(this.phys.pos, shadow, wide);
      this.renderer.draw(frame, this.phys.pos, faceLeft, opts);
      // eyes track the cursor ONLY in follow mode; otherwise they stay forward
      const track = this.behavior.autonomous;
      this.renderer.drawPupils(frame, this.phys.pos, faceLeft, opts, this.input.cursor, track);
      this.renderer.drawAccessory(this.phys.pos, faceLeft, opts);
    }
    this.particles.draw(this.renderer.context, this.renderer.scale);
    if (!this.renderer.isIllustrated && this.yarnVis > 0.01) {
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
    // illustrated cat has no frame-based breathing, so add a gentle idle breath
    if (this.renderer.isIllustrated && (s === "SIT" || s === "IDLE" || s === "LOOK_AROUND" || s === "SLEEP")) {
      const b = Math.sin(now * 0.0019);
      o.sy = 1 + 0.018 * b; o.sx = 1 - 0.012 * b; o.bob = -1.5 * (b + 1);
      if (s !== "SLEEP") {   // gentle idle sway + lean toward the cursor ("watching you")
        const sway = Math.sin(now * 0.0011) * 0.03;
        const dx = this.input.cursor.x - this.phys.pos.x;
        const lean = Math.max(-0.12, Math.min(0.12, dx * 0.0006));
        o.rot = sway + lean;
      }
    }
    if (s === "HUNT") { o.sy = 0.85; o.sx = 1.06; }
    if (s === "WALK") o.bob = Math.sin(now * 0.012) * 2;
    if (s === "OVERHEAT") o.tint = true;
    // PEEK no longer clips — the cat sits past the right edge and is clipped by
    // the screen edge naturally, so it reads as peeking in from the side.
    // (no DRAG stretch — the cat keeps its normal proportions while dragged)
    if (s === "SHAKE") {
      const decay = this.dragging ? 1 : Math.max(0, 1 - (now - this.shakeT0) / 400);
      o.rot = Math.sin(now * 0.04) * (15 * Math.PI / 180) * decay;
    }
    if (this.bounceSquash > 0.01) {   // splat against the wall on impact
      o.sx = (o.sx ?? 1) * (1 + this.bounceSquash * 0.4);
      o.sy = (o.sy ?? 1) * (1 - this.bounceSquash * 0.4);
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
      this.bubbleEl.style.top = (this.phys.pos.y - this.headOff - 30) + "px";
    } else if (this.bubbleEl) { this.bubbleEl.remove(); this.bubbleEl = null; }
  }

  private syncHitbox(): void {
    const now = performance.now();
    if (now - this.lastHitboxSent < 60) return; // ~16fps throttle
    this.lastHitboxSent = now;
    const box = this.visibleHitbox();
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
    const base = this.phys.pos.y - this.headOff - 22;
    let row = 0;
    if (pomo) {
      if (!this.pomoChip) this.pomoChip = this.makeChip(() => this.behavior.stopPomodoro());
      this.setChip(this.pomoChip, `🍅 ${b.pomoLabel()} ${this.mmss(b.pomoRemainingMs())}`, base - row * 24);
      row++;
    } else if (this.pomoChip) this.pomoChip.style.display = "none";
    if (meet) {
      if (!this.meetingChip) this.meetingChip = this.makeChip(() => this.behavior.cancelMeeting());
      this.setChip(this.meetingChip, `📅 ${b.meetingName} ${this.mmss(b.meetingRemainingMs())}`, base - row * 24);
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

  private mmss(ms: number): string {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  private installDragHandlers(canvas: HTMLCanvasElement): void {
    const overCat = (e: MouseEvent): boolean => {
      const hb = this.visibleHitbox();
      return e.clientX >= hb.x && e.clientX <= hb.x + hb.w &&
             e.clientY >= hb.y && e.clientY <= hb.y + hb.h;
    };
    const HOLD = 70; // cat hangs this far below the cursor (held by the scruff)
    canvas.addEventListener("mousedown", (e) => {
      if (!overCat(e)) return;
      // click cat to dismiss a meow bubble or to bring it out of peek mode
      if (this.state() === "MEOW") { this.behavior.dismissMeow(); return; }
      // grabbing the cat while it's peeking pulls it out AND stops peeking, so
      // it can always be picked up and repositioned (no "stuck at the edge").
      if (this.behavior.peekMode) this.behavior.setPeek(false);
      this.dragging = true;
      this.dragLastX = e.clientX;
      this.dragDir = 0;
      this.dragReversals.length = 0;
      this.lastMoveT = performance.now();
      this.dragVel = { x: 0, y: 0 };
      this.dragPrev = { x: e.clientX, y: e.clientY };
      this.dragPrevT = this.lastMoveT;
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
      // smoothed pointer velocity (px/s) for the throw-on-release
      const dtv = Math.max(0.008, (now - this.dragPrevT) / 1000);
      this.dragVel.x = this.dragVel.x * 0.4 + ((e.clientX - this.dragPrev.x) / dtv) * 0.6;
      this.dragVel.y = this.dragVel.y * 0.4 + ((e.clientY - this.dragPrev.y) / dtv) * 0.6;
      this.dragPrev = { x: e.clientX, y: e.clientY };
      this.dragPrevT = now;
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
      // flung hard enough -> throw it (arc + bounce); otherwise gently settle
      if (Math.hypot(this.dragVel.x, this.dragVel.y) > 700) this.behavior.throwCat({ ...this.dragVel });
      else this.behavior.endDrag();
    });
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

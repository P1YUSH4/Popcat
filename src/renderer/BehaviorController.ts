import type { AnimationController } from "./AnimationController";
import type { InputController } from "./InputController";
import type { PhysicsController } from "./PhysicsController";
import { StateMachine, type State } from "./StateMachine";
import { sound } from "./Sound";
import { advancePomo, isDue, reminderDue } from "./timers";
import type { AnimName, Vec2 } from "./types";

const STATE_ANIM: Record<State, AnimName> = {
  IDLE: "idle", SIT: "sit", LOOK_AROUND: "idle", WALK: "walk", RUN: "run", HUNT: "run",
  HOVER: "walk",                                  // hover the cat -> walk in place
  TYPE: "typing", THINK: "think", JUMP: "jump", STRETCH: "stretch",
  SLEEP: "sleep", DRAG: "walk", SHAKE: "wiggle", PET: "purr",  // drag -> walking legs
  OVERHEAT: "overheat", PAPER: "scroll", PEEK: "idle", MEOW: "meow",
  FALL: "fall", CONFUSED: "confused", ANGRY: "angry",
  YAWN: "yawn", LIE_DOWN: "lie_down", ALERT: "alert",
  CELEBRATE: "celebrate", WORRIED: "worried", MEETING: "meeting", FOCUS: "focus",
};

export class BehaviorController {
  readonly sm = new StateMachine();
  private bounds: Vec2 = { x: 1920, y: 1080 };
  private dragging = false;
  private now = 0;

  /** false = drag-and-drop only (no cursor following). Flip with
   *  cat.setAutonomous(true) for the full reactive set (walk/hunt/eyes/etc.). */
  autonomous = false;

  // timers / dwell
  private petStart = -1;
  private overheatUntil = 0;
  private lastStretch = 0; stretchMs = 5 * 60_000;     // stretch reminder interval
  private lastMeow = 0; meowMs = 0;                    // 0 = meow reminder off
  meowMsg = "";
  private lastHydration = 0; hydrationMs = 15 * 60_000; // hydration nudge every 15 min
  // timed speech bubble shown above the head (stretch / hydration messages)
  bubbleMsg = ""; bubbleUntil = 0;
  // pomodoro (classic 25/5, long 15-min break every 4 sessions)
  private pomoOn = false;
  private pomoPhase: "work" | "break" | "long" = "work";
  private pomoEndsAt = 0; private pomoSessions = 0;
  pomoWorkMs = 25 * 60_000; pomoBreakMs = 5 * 60_000; pomoLongMs = 15 * 60_000;
  pomoLongEvery = 4;        // long break after this many focus sessions
  // meeting reminder (set via tray presets)
  private meetingAt = 0; private meetingLabel = "Meeting";
  // peek
  peekMode = false; private peekRevealUntil = 0;
  headDy = 90;   // foot->head distance in screen px (set from renderScale by Cat)
  headR = 36;    // head radius in screen px for the petting zone (set by Cat)
  hoverHalfW = 36;   // body hover-box half-width in screen px (set by Cat)
  hoverHeight = 110; // body hover-box height above the feet in screen px (set by Cat)

  // auto-behaviors: sleep on long inactivity + occasional idle fidgets
  private sleeping = false;
  private lastActive = 0;
  sleepMs = 60_000;                 // inactivity before the cat drifts to sleep
  private nextFidgetAt = 0;
  private fidgetIdleUntil = 0;      // brief "stand & look" fidget window

  constructor(
    private anim: AnimationController,
    private phys: PhysicsController,
    private input: InputController,
  ) {
    this.registerStates();
    this.sm.transition("SIT");          // cat sits at rest by default
    this.anim.play("sit");
    this.lastActive = performance.now();
    this.nextFidgetAt = this.lastActive + 12_000 + Math.random() * 16_000;
  }

  setBounds(w: number, h: number): void { this.bounds = { x: w, y: h }; }

  // ---- external API ----------------------------------------------------
  startThinking(): void {
    this.phys.spring(); this.phys.setTarget(this.phys.pos);
    this.sm.transition("THINK", { lock: true });
    this.anim.play("think", { force: true });
  }
  finishThinking(): void { this.oneShot("JUMP", "jump"); }
  /** answer is ready -> drop thinking and play the attention-grabbing alert. */
  answerReady(): void { this.sleeping = false; this.sm.unlock(); this.oneShot("ALERT", "alert"); }
  /** settle back to rest (e.g. cancel thinking without an alert). */
  rest(): void { this.sleeping = false; this.sm.unlock(); this.toIdle(); }
  /** dev-event reactions. */
  doCelebrate(): void { this.sleeping = false; this.sm.unlock(); this.oneShot("CELEBRATE", "celebrate"); }
  doWorried(): void { this.sleeping = false; this.sm.unlock(); this.oneShot("WORRIED", "worried"); }
  doStretch(): void {
    const msgs = ["Big stretch~ 🐾", "Mrrrn… so good", "Nyaa~ *stretch*", "Ahh, that's better"];
    this.say(msgs[Math.floor(Math.random() * msgs.length)], 2200);
    this.oneShot("STRETCH", "stretch");
  }
  /** hydration nudge: a little reminder bubble pops over the cat's head. */
  doHydration(): void { this.say("💧 Time to hydrate!", 5000); }
  /** show a timed speech bubble above the head. */
  say(msg: string, ms = 2500): void { this.bubbleMsg = msg; this.bubbleUntil = performance.now() + ms; }

  // ---- pomodoro + meeting ----------------------------------------------
  startPomodoro(): void {
    this.pomoOn = true; this.pomoPhase = "work"; this.pomoSessions = 0;
    this.pomoEndsAt = performance.now() + this.pomoWorkMs;
    sound.startPomo();
    this.say("🍅 Focus! 25 min", 2600);
  }
  stopPomodoro(): void { if (this.pomoOn) sound.stopPomo(); this.pomoOn = false; this.say("Pomodoro off", 1600); }
  scheduleMeeting(mins: number, label = "Meeting"): void {
    this.meetingLabel = label || "Meeting";
    this.meetingAt = performance.now() + Math.max(0, mins) * 60_000;
    this.say(mins > 0 ? `⏰ ${this.meetingLabel} in ${mins} min` : `⏰ ${this.meetingLabel} now`, 2600);
  }
  cancelMeeting(): void { this.meetingAt = 0; this.say("Meeting reminder cleared", 1600); }
  /** apply custom Pomodoro durations (minutes). */
  configurePomodoro(focusMin: number, breakMin: number, longMin: number, longEvery: number): void {
    this.pomoWorkMs = Math.max(1, focusMin) * 60_000;
    this.pomoBreakMs = Math.max(1, breakMin) * 60_000;
    this.pomoLongMs = Math.max(1, longMin) * 60_000;
    this.pomoLongEvery = Math.max(1, Math.round(longEvery));
  }

  // timer-chip getters (for the countdown shown above the head)
  isPomoActive(): boolean { return this.pomoOn; }
  pomoRemainingMs(): number { return Math.max(0, this.pomoEndsAt - performance.now()); }
  pomoLabel(): string { return this.pomoPhase === "work" ? "Focus" : this.pomoPhase === "long" ? "Long break" : "Break"; }
  isMeetingPending(): boolean { return this.meetingAt > 0; }
  meetingRemainingMs(): number { return Math.max(0, this.meetingAt - performance.now()); }
  get meetingName(): string { return this.meetingLabel; }
  /** alerts (interrupt whatever, then settle to sit). */
  doMeetingAlert(label: string): void {
    this.sleeping = false; this.sm.unlock();
    sound.meetingAlarm();
    this.say(`📅 ${label}!`, 6000); this.oneShot("MEETING", "meeting");
  }
  doBreakAlert(long: boolean): void {
    this.sleeping = false; this.sm.unlock();
    sound.breakChime();
    this.say(long ? "☕ Long break — 15 min" : "☕ Break time — 5 min", 6000);
    this.oneShot("STRETCH", "stretch");
  }
  doFocusAlert(): void {
    this.sleeping = false; this.sm.unlock();
    sound.focusCue();
    this.say("💪 Back to focus!", 5000); this.oneShot("FOCUS", "focus");
  }

  /** fire pomodoro phase changes + the meeting reminder when their time is up. */
  private tickTimers(): void {
    if (this.dragging) return;                 // don't interrupt an active drag
    const now = this.now;
    if (isDue(now, this.meetingAt)) {
      this.meetingAt = 0; this.doMeetingAlert(this.meetingLabel); return;
    }
    if (this.pomoOn && isDue(now, this.pomoEndsAt)) {
      const step = advancePomo(this.pomoPhase, this.pomoSessions, this.pomoLongEvery);
      this.pomoPhase = step.phase; this.pomoSessions = step.sessions;
      const dur = step.phase === "work" ? this.pomoWorkMs
                : step.phase === "long" ? this.pomoLongMs : this.pomoBreakMs;
      this.pomoEndsAt = now + dur;
      if (step.alert === "focus") this.doFocusAlert();
      else this.doBreakAlert(step.alert === "longbreak");
    }
  }
  doFall(): void { this.oneShot("FALL", "fall"); }
  doConfused(): void { this.oneShot("CONFUSED", "confused"); }
  doAngry(): void { this.oneShot("ANGRY", "angry"); }
  doMeow(msg?: string): void {
    this.meowMsg = msg || "Meow!";
    this.phys.spring(); this.phys.setTarget(this.phys.pos);
    this.sm.transition("MEOW", { lock: true });
    this.anim.play("meow", { force: true });
  }
  dismissMeow(): void { if (this.sm.state === "MEOW") { this.sm.unlock(); this.toIdle(); } }
  setPeek(on: boolean): void { this.peekMode = on; if (!on && !this.sm.locked) this.toIdle(); }
  revealFromPeek(): void {
    this.peekRevealUntil = performance.now() + 4000;
    this.phys.follow(0.1);
    this.phys.setTarget({ x: this.phys.pos.x, y: this.bounds.y * 0.6 });
  }
  setAutonomous(on: boolean): void { this.autonomous = on; if (!on && !this.sm.locked) this.toIdle(); }

  // ---- drag + shake ----------------------------------------------------
  beginDrag(): void {
    this.dragging = true;
    this.phys.tune(170, 13); this.phys.spring();
    this.sm.transition("DRAG", { lock: true });
    this.anim.play("walk", { force: true });   // legs walk/paddle while carried
  }
  dragTo(p: Vec2): void { if (this.dragging) this.phys.setTarget(p); }
  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.phys.tune(120, 12);
    // settle straight to idle on release (no dizzy-eyed wiggle on click/drop;
    // the dizzy is reserved for an explicit double-click).
    this.sm.unlock();
    this.toIdle();
  }
  setShaking(on: boolean): void {
    if (!this.dragging) return;
    if (on && this.sm.state !== "SHAKE") { this.sm.transition("SHAKE", { lock: true }); this.anim.play("wiggle", { force: true }); }
    else if (!on && this.sm.state !== "DRAG") { this.sm.transition("DRAG", { lock: true }); this.anim.play("walk", { force: true }); }
  }

  // ---- per-frame brain --------------------------------------------------
  update(dt: number): void {
    this.now = performance.now();
    this.input.update(dt);

    // auto-behaviors: track interaction, wake from sleep, drift to sleep
    const interacting = this.isInteracting();
    if (interacting) this.lastActive = this.now;
    if (this.sleeping && interacting) this.wake();

    this.tickTimers();      // pomodoro phase changes + meeting reminder (may interrupt)
    this.tickReminders();

    if (this.sm.locked) { this.sm.update(dt); this.syncAnim(); return; }

    // peek mode parks the cat at the bottom edge (unless temporarily revealed)
    if (this.peekMode && this.now > this.peekRevealUntil) {
      this.phys.follow(0.06);
      this.phys.setTarget({ x: this.phys.pos.x, y: this.bounds.y + 40 });
      this.sm.transition("PEEK");
      this.sm.update(dt); this.syncAnim(); return;
    }

    // long inactivity -> yawn -> lie down -> sleep
    if (!this.sleeping && this.now - this.lastActive > this.sleepMs) {
      this.doDrowse();
      this.sm.update(dt); this.syncAnim(); return;
    }

    this.tickFidget();   // occasional idle fidget while sitting

    const s = this.autonomous ? this.decideReactive() : this.decideDragOnly();
    this.applyState(s);

    this.sm.update(dt);
    this.syncAnim();
  }

  /** "working" = any computer activity keeps the cat awake: typing, scrolling,
   *  moving the mouse, or interacting with the cat directly. Only true idle
   *  (no activity at all) for `sleepMs` lets it drift to sleep. */
  private isInteracting(): boolean {
    return this.dragging
        || this.input.isTyping()
        || this.input.isScrolling()
        || this.input.cursorIdleMs() < 1000   // mouse moved within the last 1s
        || this.isHoveringBody() || this.isPettingRaw();
  }

  /** inactivity -> sleepy chain: yawn -> lie down -> sleep loop (wakeable). */
  private doDrowse(): void {
    this.sleeping = true;
    this.phys.spring(); this.phys.setTarget(this.phys.pos);
    this.sm.transition("YAWN", { lock: true });
    this.anim.play("yawn", { force: true, onComplete: () => {
      this.sm.transition("SLEEP", { lock: true });
      this.anim.play("sleep", { force: true });   // curls up, loops until woken
    } });
  }

  /** interaction during sleep/drowse -> wake with a stretch, back to sit. */
  private wake(): void {
    this.sleeping = false;
    this.lastActive = this.now;
    this.nextFidgetAt = this.now + 12_000 + Math.random() * 16_000;
    this.sm.unlock();
    this.oneShot("STRETCH", "stretch");   // wake-up stretch -> SIT
  }

  /** occasional small fidget so a sitting cat isn't perfectly static. */
  private tickFidget(): void {
    if (this.sm.state !== "SIT" || this.now < this.nextFidgetAt) return;
    this.nextFidgetAt = this.now + 12_000 + Math.random() * 16_000;
    if (Math.random() < 0.5) this.fidgetIdleUntil = this.now + 2000;  // stand & look
    else this.doStretch();                                            // quick stretch
  }

  private syncAnim(): void { this.anim.play(STATE_ANIM[this.sm.state]); }
  facingLeft(): boolean { return !this.dragging && this.phys.vel.x < -8; }
  isCrouching(): boolean { return this.sm.state === "HUNT"; }

  // ---- decision (priority per spec) ------------------------------------
  private decideReactive(): State {
    // OVERHEAT: fast typing sets a 2s window (+cooldown)
    if (this.input.isTypingFast()) this.overheatUntil = this.now + 2000;
    if (this.now < this.overheatUntil) return "OVERHEAT";

    if (this.input.isScrolling()) return "PAPER";
    if (this.input.isHuntReady()) return "HUNT";
    if (this.farFromCursor() > 80) return "WALK";
    if (this.input.isTyping()) return "TYPE";
    if (this.isPettingDwell()) return "PET";
    return "IDLE";
  }
  private decideDragOnly(): State {
    // drag-and-drop only: NO cursor following/hunting at all. Just stationary
    // in-place reactions that don't move the cat toward the cursor.
    if (this.input.isScrolling()) return "PAPER";   // scroll -> unspool paper
    if (this.input.isTyping()) return "TYPE";
    if (this.isPettingDwell()) return "PET";         // head hover >500ms -> purr
    if (this.isHoveringBody()) return "HOVER";       // hover the cat -> stand & walk
    if (this.now < this.fidgetIdleUntil) return "IDLE";  // brief stand & look fidget
    return "SIT";                                    // resting default: sit
  }

  /** cursor hovering over the cat's body (not the head petting zone). */
  private isHoveringBody(): boolean {
    if (this.dragging || this.isPettingRaw()) return false;
    const c = this.input.cursor;
    const dx = Math.abs(c.x - this.phys.pos.x);
    const dy = c.y - this.phys.pos.y;                // feet at pos.y; body extends up
    return dx < this.hoverHalfW && dy < 8 && dy > -this.hoverHeight;
  }

  private applyState(s: State): void {
    if (s === "WALK") {
      if (this.farFromCursor() <= 20) { this.toIdle(); return; }
      this.phys.follow(0.08); this.phys.setTarget(this.input.cursor);
      this.sm.transition("WALK"); return;
    }
    if (s === "HUNT") {
      this.phys.follow(0.18);
      this.phys.setTarget({ x: this.input.cursor.x, y: this.input.cursor.y + 10 });
      this.sm.transition("HUNT"); return;
    }
    // stationary states
    if (this.phys.mode !== "spring") { this.phys.spring(); this.phys.setTarget(this.phys.pos); }
    if (s === "OVERHEAT") this.phys.setTarget(this.phys.pos);
    this.sm.transition(s);
  }

  private farFromCursor(): number {
    return Math.hypot(this.input.cursor.x - this.phys.pos.x, this.input.cursor.y - this.phys.pos.y);
  }
  /** cursor is over the cat's face AND actively stroking (moving). */
  private isPettingRaw(): boolean {
    if (this.dragging) return false;
    const c = this.input.cursor;
    const d = Math.hypot(c.x - this.phys.pos.x, c.y - (this.phys.pos.y - this.headDy));
    const overFace = d < this.headR;                   // head only (not body/legs)
    const stroking = this.input.cursorSpeed > 30 && this.input.cursorSpeed < 700;
    return overFace && stroking;
  }
  /** purr while stroking the face; lingers briefly so it doesn't flicker when
   *  the stroke pauses between motions. */
  private isPettingDwell(): boolean {
    if (this.isPettingRaw()) { this.petStart = this.now; return true; }
    if (this.petStart > 0 && this.now - this.petStart < 450) return true;  // linger
    this.petStart = -1; return false;
  }

  private tickReminders(): void {
    if (this.sm.locked || this.dragging) return;
    if (reminderDue(this.now, this.lastStretch, this.stretchMs)) { this.lastStretch = this.now; this.doStretch(); }
    if (reminderDue(this.now, this.lastMeow, this.meowMs)) { this.lastMeow = this.now; this.doMeow(this.meowMsg || "Meow!"); }
    if (reminderDue(this.now, this.lastHydration, this.hydrationMs)) { this.lastHydration = this.now; this.doHydration(); }
  }

  // ---- helpers ---------------------------------------------------------
  private toIdle(): void { this.phys.spring(); this.phys.tune(80, 14); this.phys.setTarget(this.phys.pos); this.sm.transition("SIT"); }
  private oneShot(state: State, anim: AnimName): void {
    // cancel any in-progress drag so the one-shot isn't cut short
    this.dragging = false;
    this.sm.unlock();
    this.phys.spring(); this.phys.setTarget(this.phys.pos);
    this.sm.transition(state, { lock: true });
    this.anim.play(anim, { force: true, onComplete: () => { this.sm.unlock(); this.toIdle(); } });
  }
  private registerStates(): void { /* follow/lerp handled in applyState; no per-state hooks needed */ }
}

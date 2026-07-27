import type { AnimationController } from "./AnimationController";
import type { InputController } from "./InputController";
import type { PhysicsController } from "./PhysicsController";
import type { AppCategory } from "./Perception";
import { StateMachine, type State } from "./StateMachine";
import { sound } from "./Sound";
import { advancePomo, isDue, reminderDue, mmss } from "./timers";
import { isWorkMode, type Mode } from "./context";
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
  private lastStretch = 0; stretchMs = 30 * 60_000;    // posture/stretch nudge (gentle)
  private lastMeow = 0; meowMs = 0;                    // 0 = meow reminder off
  meowMsg = "";
  private lastHydration = 0; hydrationMs = 15 * 60_000; // hydration nudge every 15 min
  // timed speech bubble shown above the head (stretch / hydration messages)
  bubbleMsg = ""; bubbleUntil = 0;
  // pomodoro (classic 25/5, long 15-min break every 4 sessions)
  private pomoOn = false;
  private pomoPhase: "work" | "break" | "long" = "work";
  private pomoEndsAt = 0; private pomoSessions = 0;
  private pomoPaused = false; private pomoRemainingAtPause = 0;
  pomoWorkMs = 25 * 60_000; pomoBreakMs = 5 * 60_000; pomoLongMs = 15 * 60_000;
  pomoLongEvery = 4;        // long break after this many focus sessions
  // meeting reminders: multiple, absolute wall-clock (Date.now) times, with a
  // pre-alert and a repeating "ring until acknowledged" alarm.
  private meetings: { at: number; label: string; preAt: number; preDone: boolean }[] = [];
  private ringing: { at: number; label: string } | null = null;
  private ringNextAt = 0; private ringCount = 0;
  ringMax = 5; ringEveryMs = 2500;
  // context-awareness mode (from the focused window)
  mode: Mode = "neutral";
  leisureNudge = true;                  // gentle "back to it?" on leisure sites
  private leisureSince = -1; private lastLeisureNudge = 0;
  // peek
  peekMode = false; private peekRevealUntil = 0;
  headDy = 90;   // foot->head distance in screen px (set from renderScale by Cat)
  headR = 36;    // head radius in screen px for the petting zone (set by Cat)
  hoverHalfW = 36;   // body hover-box half-width in screen px (set by Cat)
  hoverHeight = 110; // body hover-box height above the feet in screen px (set by Cat)

  // app-aware mood: set by the AffectController from the active window category
  contextCategory: AppCategory = "other";
  // optional user-given name, used in greetings
  petName = "";
  // set true by the affect engine during deep focus/flow -> the cat stays calm
  // and doesn't fidget, so it never interrupts your concentration
  quietMode = false;
  // throw/fling: true while the cat is airborne after being thrown
  private thrown = false;

  // auto-behaviors: sleep on long inactivity + occasional idle fidgets
  private sleeping = false;
  private lastActive = 0;
  sleepMs = 60_000;                 // inactivity before the cat drifts to sleep
  private nextFidgetAt = 0;
  private fidgetIdleUntil = 0;      // brief "stand & look" fidget window
  private ponderUntil = 0;          // auto-exit time for a natural "thinking" pause

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
  /** a natural, self-limiting "thinking" pause: the cat ponders for a moment,
   *  then settles back to idle on its own. Triggered by the idle brain when
   *  you're present (cursor alive) but not typing — a shared little beat of
   *  thought. Distinct from startThinking(), the command-driven loop that holds
   *  until answerReady()/rest(); only this one sets ponderUntil to auto-end. */
  ponder(ms = 2400): void {
    if (!this.affectIdle()) return;
    this.phys.spring(); this.phys.setTarget(this.phys.pos);
    this.sm.transition("THINK", { lock: true });
    this.anim.play("think", { force: true });
    this.ponderUntil = this.now + ms;
  }
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
    this.pomoOn = true; this.pomoPaused = false; this.pomoPhase = "work"; this.pomoSessions = 0;
    this.pomoEndsAt = performance.now() + this.pomoWorkMs;
    sound.startPomo();
    this.say(`🍅 Focus! ${Math.round(this.pomoWorkMs / 60_000)} min`, 2600);
  }
  stopPomodoro(): void { if (this.pomoOn) sound.stopPomo(); this.pomoOn = false; this.pomoPaused = false; this.say("Pomodoro off", 1600); }
  pausePomodoro(): void {
    if (!this.pomoOn || this.pomoPaused) return;
    this.pomoPaused = true;
    this.pomoRemainingAtPause = Math.max(0, this.pomoEndsAt - performance.now());
    sound.stopPomo();
    this.say("⏸ Paused", 1800);
  }
  resumePomodoro(): void {
    if (!this.pomoOn || !this.pomoPaused) return;
    this.pomoEndsAt = performance.now() + this.pomoRemainingAtPause;
    this.pomoPaused = false;
    sound.startPomo();
    this.say("▶ Resumed", 1600);
  }
  /** end the current phase now (jump straight to the next break/focus). */
  skipPomodoro(): void {
    if (!this.pomoOn) return;
    this.pomoPaused = false;
    this.pomoEndsAt = performance.now();   // due immediately -> tickTimers advances
  }
  scheduleMeeting(mins: number, label = "Meeting", preMin = 5): void {
    const at = Date.now() + Math.max(0, mins) * 60_000;
    this.addMeeting(at, label, preMin);
    this.say(mins > 0 ? `⏰ ${label || "Meeting"} in ${mins} min` : `⏰ ${label || "Meeting"} now`, 2600);
  }
  scheduleMeetingAt(atMs: number, label = "Meeting", preMin = 5): void {
    this.addMeeting(atMs, label, preMin);
    const d = new Date(atMs);
    this.say(`⏰ ${label || "Meeting"} at ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, 2600);
  }
  private addMeeting(at: number, label: string, preMin: number): void {
    const preAt = at - Math.max(0, preMin) * 60_000;
    this.meetings.push({ at, label: label || "Meeting", preAt, preDone: preAt <= Date.now() });
    this.meetings.sort((a, b) => a.at - b.at);
  }
  /** ✕ on the chip: dismiss a ringing alarm, else clear the soonest pending. */
  cancelMeeting(): void {
    if (this.ringing) { this.ackMeeting(); return; }
    if (this.meetings.length) { this.meetings.shift(); this.say("Meeting reminder cleared", 1600); }
  }
  /** click the cat (or ✕) to acknowledge a ringing alarm. */
  ackMeeting(): void {
    if (!this.ringing) return;
    this.ringing = null; this.ringCount = 0; this.bubbleUntil = 0;
    if (this.sm.state === "MEETING") { this.sm.unlock(); this.toIdle(); }
  }
  /** 💤 snooze a ringing alarm. */
  snoozeMeeting(min = 5): void {
    if (!this.ringing) return;
    const label = this.ringing.label;
    this.ringing = null; this.ringCount = 0;
    if (this.sm.state === "MEETING") { this.sm.unlock(); this.toIdle(); }
    this.addMeeting(Date.now() + Math.max(1, min) * 60_000, label, 0);
    this.say(`💤 Snoozed ${min} min`, 1800);
  }
  /** apply custom Pomodoro durations (minutes). */
  configurePomodoro(focusMin: number, breakMin: number, longMin: number, longEvery: number): void {
    this.pomoWorkMs = Math.max(1, focusMin) * 60_000;
    this.pomoBreakMs = Math.max(1, breakMin) * 60_000;
    this.pomoLongMs = Math.max(1, longMin) * 60_000;
    this.pomoLongEvery = Math.max(1, Math.round(longEvery));
  }

  // timer-chip getters (for the countdown shown above the head)
  isPomoActive(): boolean { return this.pomoOn; }
  isPomoPaused(): boolean { return this.pomoPaused; }
  pomoRemainingMs(): number {
    return this.pomoPaused ? this.pomoRemainingAtPause : Math.max(0, this.pomoEndsAt - performance.now());
  }
  pomoLabel(): string { return this.pomoPhase === "work" ? "Focus" : this.pomoPhase === "long" ? "Long break" : "Break"; }
  pomoPhaseKind(): "work" | "break" | "long" { return this.pomoPhase; }
  /** completed focus sessions toward the next long break, and the total. */
  pomoRound(): { done: number; total: number } {
    return { done: this.pomoSessions % this.pomoLongEvery, total: this.pomoLongEvery };
  }
  isMeetingPending(): boolean { return this.meetings.length > 0 || this.ringing !== null; }
  isRinging(): boolean { return this.ringing !== null; }
  meetingChipText(): string {
    if (this.ringing) return `📅 ${this.ringing.label} — now!`;
    const m = this.meetings[0];
    if (!m) return "";
    const more = this.meetings.length > 1 ? ` (+${this.meetings.length - 1})` : "";
    return `📅 ${m.label} ${mmss(m.at - Date.now())}${more}`;
  }
  /** alerts (interrupt whatever, then settle to sit). */
  doMeetingAlert(label: string): void {
    this.sleeping = false; this.sm.unlock();
    sound.meetingAlarm();
    this.say(`📅 ${label} — now! (click me)`, this.ringEveryMs + 1200);
    this.oneShot("MEETING", "meeting");
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
    const wall = Date.now();
    // pre-alerts: a gentle heads-up before each meeting
    for (const m of this.meetings) {
      if (!m.preDone && wall >= m.preAt && wall < m.at) {
        m.preDone = true;
        sound.breakChime();
        this.say(`📅 ${m.label} in ${Math.max(1, Math.round((m.at - wall) / 60_000))} min`, 4500);
      }
    }
    // a due meeting starts ringing (one alarm at a time)
    if (!this.ringing) {
      const idx = this.meetings.findIndex(m => wall >= m.at);
      if (idx >= 0) { this.ringing = this.meetings.splice(idx, 1)[0]; this.ringCount = 0; this.ringNextAt = 0; }
    }
    // repeat the ring until acknowledged (or ringMax rings)
    if (this.ringing) {
      if (wall >= this.ringNextAt) {
        if (this.ringCount < this.ringMax) {
          this.ringCount++; this.ringNextAt = wall + this.ringEveryMs;
          this.doMeetingAlert(this.ringing.label);
        } else { this.ringing = null; }
      }
      return;   // a ringing alarm takes priority this tick
    }
    if (this.pomoOn && !this.pomoPaused && isDue(now, this.pomoEndsAt)) {
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
  setPeek(on: boolean): void {
    this.peekMode = on;
    if (!on) {
      // leaving peek: restore the normal on-screen clamp and SNAP the cat back
      // into view immediately so its hitbox is reachable and it's draggable again.
      this.phys.setBounds(this.bounds.x, this.bounds.y);
      this.phys.pos.x = Math.min(this.phys.pos.x, this.bounds.x - 60);
      this.phys.pos.y = Math.max(60, Math.min(this.phys.pos.y, this.bounds.y - 60));
      if (!this.sm.locked) this.toIdle();
    }
  }
  revealFromPeek(): void {
    this.peekRevealUntil = performance.now() + 4000;
    this.phys.setBounds(this.bounds.x, this.bounds.y);   // clamp back on-screen while revealed
    this.phys.follow(0.1);
    this.phys.setTarget({ x: this.bounds.x * 0.82, y: this.bounds.y * 0.6 });
  }
  setAutonomous(on: boolean): void { this.autonomous = on; if (!on && !this.sm.locked) this.toIdle(); }

  // ---- affect-driven expressions ---------------------------------------
  // The AffectController calls these to give Pao gentle, mood-driven reactions.
  // They only act when the cat is calmly idle so they NEVER cut off a real
  // reaction (drag, hunt, pet, typing, a one-shot animation, sleep, …).
  private affectIdle(): boolean {
    return !this.sm.locked && !this.dragging && (this.sm.state === "SIT" || this.sm.state === "IDLE");
  }
  /** "welcome back" — a little stand-and-look plus a soft line. */
  affectGreet(msg: string): void {
    if (!this.affectIdle()) return;
    this.say(msg, 2200);
    this.fidgetIdleUntil = this.now + 1800;   // stand & look around briefly
    this.nextFidgetAt = this.now + 12_000 + Math.random() * 16_000;
  }
  /** a kind nudge (stretch + message), e.g. deep-focus or long-session care. */
  affectNudge(msg: string): void { if (this.affectIdle()) { this.doStretch(); this.say(msg, 2600); } }
  /** restless little look-around when you're window-hopping. */
  affectAntsy(): void { if (this.affectIdle()) this.oneShot("ALERT", "alert"); }

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

  /** Released a drag with speed -> throw the cat: it arcs under gravity and
   *  bounces off the screen edges, then settles. (Cat.ts decides the velocity.) */
  throwCat(vel: Vec2): void {
    this.dragging = false;
    this.thrown = true;
    this.sm.unlock();
    this.sm.transition("FALL", { lock: true });
    this.anim.play("fall", { force: true });
    this.phys.fling(vel, 2600);                 // gravity px/s^2
  }
  /** thrown cat has settled on the floor -> shake it off and sit. */
  private land(): void {
    this.phys.tune(120, 12);
    this.oneShot("STRETCH", "stretch");
  }

  // ---- per-frame brain --------------------------------------------------
  update(dt: number): void {
    this.now = performance.now();
    this.input.update(dt);

    // auto-behaviors: track interaction, wake from sleep, drift to sleep
    const interacting = this.isInteracting();
    if (interacting) this.lastActive = this.now;
    if (this.sleeping && interacting) this.wake();

    // Active scrolling/typing must ALWAYS get a prompt reaction. Passive
    // auto-behaviours (sleep chain, idle fidgets, ponder, reminder stretches)
    // lock the state machine and would otherwise swallow the input until they
    // finish — which made scrolling "react only at certain times". Preempt them:
    // unlock so this frame's reactive decision (PAPER/TYPE) runs. We never
    // interrupt the things you're deliberately doing TO the cat (drag, throw).
    if ((this.input.isScrolling() || this.input.isTyping())
        && this.sm.locked && !this.dragging && !this.thrown && !this.hardState()) {
      this.sleeping = false;
      this.sm.unlock();
    }

    this.tickTimers();      // pomodoro phase changes + meeting reminder (may interrupt)
    this.tickReminders();

    // a natural "thinking" pause ends on its own. (The command-driven
    // startThinking() leaves ponderUntil at 0, so it still holds indefinitely.)
    if (this.ponderUntil && this.now >= this.ponderUntil && this.sm.state === "THINK") {
      this.ponderUntil = 0; this.sm.unlock(); this.toIdle();
    }

    // thrown: stay in FALL (bouncing off walls) until it settles on the floor
    if (this.thrown) {
      if (this.phys.restingOnFloor()) { this.thrown = false; this.land(); }
      else { this.sm.update(dt); this.syncAnim(); return; }
    }

    if (this.sm.locked) { this.sm.update(dt); this.syncAnim(); return; }

    // peek mode parks the cat at the RIGHT screen edge, half hidden, peeking in
    // (unless temporarily revealed). Widen the right bound so it can hug/pass it.
    if (this.peekMode && this.now > this.peekRevealUntil) {
      this.phys.bounds.maxX = this.bounds.x + 56;
      this.phys.follow(0.06);
      this.phys.setTarget({ x: this.bounds.x + 8, y: this.phys.pos.y });
      this.sm.transition("PEEK");
      this.sm.update(dt); this.syncAnim(); return;
    }

    // long inactivity -> yawn -> lie down -> sleep. While actively in a work app
    // (focus/coding/ai) the cat waits longer before dozing (reading pauses are ok).
    const sleepDelay = isWorkMode(this.mode) ? Math.max(this.sleepMs, 5 * 60_000) : this.sleepMs;
    if (!this.sleeping && this.now - this.lastActive > sleepDelay) {
      this.doDrowse();
      this.sm.update(dt); this.syncAnim(); return;
    }

    this.tickFidget();   // occasional idle fidget while sitting
    // a fidget may have started a locked one-shot (ponder/stretch/jump/…) — let
    // it play instead of immediately clobbering it back to SIT via applyState.
    if (this.sm.locked) { this.sm.update(dt); this.syncAnim(); return; }

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
    // a sleepy cat sinks DOWN to rest on the floor (screen bottom) instead of
    // dozing off mid-air. Soft spring so it eases down gently while yawning.
    this.phys.spring(); this.phys.tune(42, 11);
    this.phys.setTarget({ x: this.phys.pos.x, y: this.bounds.y });
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

  /** occasional small fidget so a sitting cat isn't perfectly static — flavoured
   *  by what you're doing (app category), with zero AI: just a mood mapping. */
  private tickFidget(): void {
    if (this.sm.state !== "SIT" || this.now < this.nextFidgetAt) return;
    this.nextFidgetAt = this.now + 12_000 + Math.random() * 16_000;
    if (this.quietMode) return;   // deep focus: stay still, don't distract
    // present but not typing (cursor alive, hands off the keys) -> a natural
    // little "thinking" beat, as if pausing to ponder along with you.
    if (!this.input.isTyping() && this.input.cursorIdleMs() < 6000 && Math.random() < 0.35) {
      this.ponder(); return;
    }
    const look = () => { this.fidgetIdleUntil = this.now + 2000; };   // stand & look around
    const r = Math.random();
    switch (this.contextCategory) {
      case "editor":   r < 0.6 ? this.doStretch() : look(); break;            // heads-down: stretches
      case "terminal": r < 0.5 ? this.oneShot("ALERT", "alert") : look(); break; // curious/alert
      case "browser":  look(); break;                                         // watches along with you
      case "media":    r < 0.5 ? this.oneShot("YAWN", "yawn") : look(); break;   // relaxed
      case "game":     r < 0.5 ? this.oneShot("JUMP", "jump") : this.doStretch(); break; // excited
      case "chat":     r < 0.4 ? this.oneShot("ALERT", "alert") : look(); break;
      case "design":   this.doStretch(); break;
      default:         r < 0.5 ? look() : this.doStretch();
    }
  }

  /** states active scroll/type must NOT interrupt — you're holding the cat
   *  (drag/shake) or it's airborne (fall). Everything else (sleep, fidgets,
   *  ponder, reminder one-shots) yields to active input.
   *  Keep this set in sync with any new physical/drag states added to StateMachine. */
  private static readonly HARD_STATES = new Set(["DRAG", "SHAKE", "FALL"]);
  private hardState(): boolean { return BehaviorController.HARD_STATES.has(this.sm.state); }
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

  /** announce a mode change with a short bubble (focus/ai/leisure only). */
  private onModeChange(m: Mode): void {
    const msg = m === "focus" ? "🧠 Focus mode" : m === "ai" ? "🤖 AI mode" : m === "leisure" ? "👀 hmm…" : "";
    if (msg && !this.sm.locked && !this.dragging) this.say(msg, 1600);
  }

  /** gentle "back to it?" nudge after a sustained stretch on leisure sites. */
  private tickLeisure(mode: Mode): void {
    if (mode !== "leisure") { this.leisureSince = -1; return; }
    if (this.leisureSince < 0) this.leisureSince = this.now;
    if (this.leisureNudge && !this.sm.locked && !this.dragging
        && this.now - this.leisureSince > 8 * 60_000
        && this.now - this.lastLeisureNudge > 5 * 60_000) {
      this.lastLeisureNudge = this.now;
      this.say("👀 back to it?", 4000);
    }
  }

  private tickReminders(): void {
    if (this.sm.locked || this.dragging) return;
    if (this.mode === "focus") return;   // stay quiet during deep focus
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

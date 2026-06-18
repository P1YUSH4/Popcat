export type State =
  | "IDLE" | "SIT" | "LOOK_AROUND" | "WALK" | "RUN" | "HUNT" | "HOVER"
  | "TYPE" | "THINK" | "JUMP" | "STRETCH" | "SLEEP" | "DRAG"
  | "SHAKE" | "PET" | "OVERHEAT" | "PAPER" | "PEEK" | "MEOW"
  | "FALL" | "CONFUSED" | "ANGRY" | "YAWN" | "LIE_DOWN" | "ALERT"
  | "CELEBRATE" | "WORRIED" | "MEETING" | "FOCUS";

export interface StateHandler {
  enter?(prev: State): void;
  update?(dt: number): void;
  exit?(next: State): void;
}

/**
 * Minimal finite state machine. States register enter/update/exit hooks; the
 * BehaviorController decides transitions. `lock` prevents auto-behaviors from
 * interrupting a deliberate state (e.g. DRAG, THINK, JUMP).
 */
export class StateMachine {
  private handlers = new Map<State, StateHandler>();
  private _state: State = "IDLE";
  private _since = 0;     // seconds in current state
  locked = false;

  on(state: State, handler: StateHandler): void {
    this.handlers.set(state, handler);
  }

  get state(): State { return this._state; }
  get since(): number { return this._since; }

  can(next: State): boolean {
    return !this.locked || next === this._state;
  }

  transition(next: State, opts: { lock?: boolean } = {}): void {
    if (next === this._state) return;
    const prev = this._state;
    this.handlers.get(prev)?.exit?.(next);
    this._state = next;
    this._since = 0;
    this.locked = opts.lock ?? false;
    this.handlers.get(next)?.enter?.(prev);
  }

  /** Force-unlock (used when a one-shot animation completes). */
  unlock(): void { this.locked = false; }

  update(dt: number): void {
    this._since += dt;
    this.handlers.get(this._state)?.update?.(dt);
  }
}

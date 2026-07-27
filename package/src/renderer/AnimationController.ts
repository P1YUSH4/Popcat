import type { AnimMeta, AnimName, FrameMeta, SpriteMeta } from "./types";

/**
 * Steps through an animation's frames using per-frame durations and
 * delta-time accumulation (frame-rate independent). Supports looping and
 * one-shot animations with an onComplete callback.
 */
export class AnimationController {
  private meta: SpriteMeta;
  private current: AnimName = "idle";
  private anim: AnimMeta;
  private frameIdx = 0;
  private elapsed = 0;          // ms accumulated on the current frame
  private finished = false;
  private onComplete: (() => void) | null = null;

  constructor(meta: SpriteMeta) {
    this.meta = meta;
    this.anim = meta.animations.idle;
  }

  /** Switch animation. `force` restarts even if already playing it. */
  play(name: AnimName, opts: { force?: boolean; onComplete?: () => void } = {}): void {
    if (name === this.current && !opts.force) {
      this.onComplete = opts.onComplete ?? this.onComplete;
      return;
    }
    this.current = name;
    this.anim = this.meta.animations[name];
    this.frameIdx = 0;
    this.elapsed = 0;
    this.finished = false;
    this.onComplete = opts.onComplete ?? null;
  }

  update(dtMs: number): void {
    if (this.finished) return;
    this.elapsed += dtMs;
    let guard = 0;
    while (this.elapsed >= this.frame().duration && guard++ < 32) {
      this.elapsed -= this.frame().duration;
      const last = this.anim.frames.length - 1;
      if (this.frameIdx >= last) {
        if (this.anim.loop) {
          this.frameIdx = 0;
        } else {
          this.frameIdx = last;
          this.finished = true;
          const cb = this.onComplete;
          this.onComplete = null;
          cb?.();
          break;
        }
      } else {
        this.frameIdx++;
      }
    }
  }

  frame(): FrameMeta { return this.anim.frames[this.frameIdx]; }
  frameIndex(): number { return this.frameIdx; }
  name(): AnimName { return this.current; }
  isFinished(): boolean { return this.finished; }
  progress(): number { return this.frameIdx / (this.anim.frames.length - 1 || 1); }
}

import type { Vec2 } from "./types";

/**
 * Spring-damper motion toward a target with acceleration & friction.
 * Produces organic movement: the cat eases in/out, overshoots slightly, and
 * never teleports. Used for both wandering and cursor chasing.
 */
export class PhysicsController {
  pos: Vec2 = { x: 0, y: 0 };
  vel: Vec2 = { x: 0, y: 0 };
  target: Vec2 = { x: 0, y: 0 };

  // tunables
  stiffness = 90;     // spring constant (higher = snappier)
  damping = 14;       // velocity friction (higher = less overshoot)
  maxSpeed = 900;     // px/s clamp
  bounds = { minX: 0, minY: 0, maxX: 1920, maxY: 1080 };

  // motion mode: "spring" (drag/settle), "follow" (walk/hunt lerp), "ballistic" (throw)
  mode: "spring" | "follow" | "ballistic" = "spring";
  followK = 0.08;     // per-frame lerp factor at 60fps (walk 0.08 / hunt 0.18)

  // ballistic (throw) tunables + bounce notification
  private ballisticG = 0;          // gravity px/s^2 while thrown (0 = flat slide)
  restitution = 0.55;              // edge bounciness 0..1
  onBounce: ((strength: number) => void) | null = null;  // fired on each wall hit

  setBounds(w: number, h: number): void {
    this.bounds = { minX: 40, minY: 40, maxX: w - 40, maxY: h - 40 };
  }

  teleportTo(p: Vec2): void {
    this.pos = { ...p };
    this.target = { ...p };
    this.vel = { x: 0, y: 0 };
  }

  setTarget(p: Vec2): void {
    this.target = {
      x: clamp(p.x, this.bounds.minX, this.bounds.maxX),
      y: clamp(p.y, this.bounds.minY, this.bounds.maxY),
    };
  }

  /** Override the spring response (e.g. snappier for RUN/HUNT). */
  tune(stiffness: number, damping: number): void {
    this.stiffness = stiffness;
    this.damping = damping;
  }

  /** lerp-follow mode (walk/hunt). k = per-frame factor @60fps. */
  follow(k: number): void { this.mode = "follow"; this.followK = k; }
  spring(): void { this.mode = "spring"; }
  /** throw with an initial velocity; gravity>0 makes it arc + bounce off edges. */
  fling(vel: Vec2, gravity = 0): void { this.mode = "ballistic"; this.vel = { ...vel }; this.ballisticG = gravity; }

  update(dt: number): void {
    if (this.mode === "follow") {
      // frame-rate independent lerp toward target
      const k = 1 - Math.pow(1 - this.followK, dt * 60);
      this.pos.x = this.pos.x + (this.target.x - this.pos.x) * k;
      this.pos.y = this.pos.y + (this.target.y - this.pos.y) * k;
      this.vel.x = (this.target.x - this.pos.x); this.vel.y = (this.target.y - this.pos.y);
      this.clampBounds();
      return;
    }
    if (this.mode === "ballistic") {
      if (this.ballisticG) this.vel.y += this.ballisticG * dt;        // thrown: gravity
      this.pos.x += this.vel.x * dt; this.pos.y += this.vel.y * dt;
      // light air drag thrown (keep the arc); heavy drag for a flat slide
      const f = Math.pow(this.ballisticG ? 0.45 : 0.12, dt);
      this.vel.x *= f;
      if (!this.ballisticG) this.vel.y *= f;
      this.bounceBounds();
      return;
    }
    // critically-damped-ish spring: a = k*(target-pos) - c*vel
    const ax = this.stiffness * (this.target.x - this.pos.x) - this.damping * this.vel.x;
    const ay = this.stiffness * (this.target.y - this.pos.y) - this.damping * this.vel.y;

    this.vel.x += ax * dt;
    this.vel.y += ay * dt;

    const speed = Math.hypot(this.vel.x, this.vel.y);
    if (speed > this.maxSpeed) {
      const s = this.maxSpeed / speed;
      this.vel.x *= s; this.vel.y *= s;
    }

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.clampBounds();
  }

  private clampBounds(): void {
    if (this.pos.x < this.bounds.minX) { this.pos.x = this.bounds.minX; this.vel.x = Math.max(0, this.vel.x); }
    if (this.pos.x > this.bounds.maxX) { this.pos.x = this.bounds.maxX; this.vel.x = Math.min(0, this.vel.x); }
    if (this.pos.y < this.bounds.minY) { this.pos.y = this.bounds.minY; this.vel.y = Math.max(0, this.vel.y); }
    if (this.pos.y > this.bounds.maxY) { this.pos.y = this.bounds.maxY; this.vel.y = Math.min(0, this.vel.y); }
  }

  /** like clampBounds, but reflects velocity (with restitution) and reports the
   *  impact so the cat can squash + thud. Used in ballistic/throw mode. */
  private bounceBounds(): void {
    const R = this.restitution;
    let hit = 0;
    if (this.pos.x < this.bounds.minX && this.vel.x < 0) { this.pos.x = this.bounds.minX; hit = Math.max(hit, -this.vel.x); this.vel.x = -this.vel.x * R; }
    if (this.pos.x > this.bounds.maxX && this.vel.x > 0) { this.pos.x = this.bounds.maxX; hit = Math.max(hit, this.vel.x); this.vel.x = -this.vel.x * R; }
    if (this.pos.y < this.bounds.minY && this.vel.y < 0) { this.pos.y = this.bounds.minY; hit = Math.max(hit, -this.vel.y); this.vel.y = -this.vel.y * R; }
    if (this.pos.y > this.bounds.maxY && this.vel.y > 0) { this.pos.y = this.bounds.maxY; hit = Math.max(hit, this.vel.y); this.vel.y = -this.vel.y * R; }
    if (hit > 60 && this.onBounce) this.onBounce(Math.min(1, hit / 900));
  }

  speed(): number { return Math.hypot(this.vel.x, this.vel.y); }
  arrived(eps = 6): boolean {
    return Math.hypot(this.target.x - this.pos.x, this.target.y - this.pos.y) < eps;
  }
  /** thrown cat has settled: slow and resting on the floor (bottom edge). */
  restingOnFloor(): boolean {
    return this.speed() < 45 && this.pos.y >= this.bounds.maxY - 3;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

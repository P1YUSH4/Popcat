import type { Vec2 } from "./types";

type Kind = "steam" | "heart" | "star";
interface P { k: Kind; x: number; y: number; vx: number; vy: number; life: number; max: number; col?: string; grav?: boolean; }

/**
 * Lightweight pixel-particle layer drawn over the sprite (logic only — no new
 * frames). Steam (overheat), hearts (purr), stars/confetti (jump landing).
 * All timing in seconds via dt; capped counts per spec.
 */
export class Particles {
  private ps: P[] = [];
  private lastSteam = 0;
  private lastHeart = 0;

  /** steam: ~1/200ms, max 8, rise + fade over 1.2s */
  steam(head: Vec2, tNow: number): void {
    if (this.ps.filter(p => p.k === "steam").length >= 8) return;
    if (tNow - this.lastSteam < 200) return;
    this.lastSteam = tNow;
    this.ps.push({ k: "steam", x: head.x + (Math.random() - 0.5) * 24, y: head.y,
      vx: (Math.random() - 0.5) * 14, vy: -38, life: 0, max: 1.2 });
  }

  /** hearts: float up + sway, fade over 1.5s */
  heart(head: Vec2, tNow: number): void {
    if (tNow - this.lastHeart < 350) return;
    this.lastHeart = tNow;
    this.ps.push({ k: "heart", x: head.x + (Math.random() - 0.5) * 18, y: head.y,
      vx: (Math.random() - 0.5) * 16, vy: -30, life: 0, max: 1.5 });
  }

  /** confetti burst from feet on landing: gravity + fade over 0.8s */
  burst(feet: Vec2): void {
    const cols = ["#f7d36b", "#f0708c", "#7cc4d6", "#a6e3a1"];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.ps.push({ k: "star", x: feet.x, y: feet.y, vx: Math.cos(a) * 150,
        vy: Math.sin(a) * 150 - 80, life: 0, max: 0.8, col: cols[i % cols.length], grav: true });
    }
  }

  update(dt: number): void {
    for (let i = this.ps.length - 1; i >= 0; i--) {
      const p = this.ps[i];
      p.life += dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.grav) p.vy += 18 * 60 * dt;          // gravity ~0.3/frame @60fps
      else if (p.k === "steam") p.vx += Math.sin(p.life * 10) * 30 * dt; // drift
      else if (p.k === "heart") { p.vx *= 1 - dt; }
      if (p.life >= p.max) this.ps.splice(i, 1);
    }
  }

  draw(ctx: CanvasRenderingContext2D, scale: number): void {
    for (const p of this.ps) {
      const a = Math.max(0, 1 - p.life / p.max);
      ctx.globalAlpha = a;
      if (p.k === "steam") { ctx.fillStyle = "#dfe8ec"; const s = 2 * scale * 0.6; ctx.fillRect(p.x, p.y, s, s); }
      else if (p.k === "heart") { ctx.fillStyle = "#f0708c"; this.heartShape(ctx, p.x, p.y, scale * (0.5 + a * 0.4)); }
      else if (p.k === "star") { ctx.fillStyle = p.col!; this.starShape(ctx, p.x, p.y, scale * 0.7); }
    }
    ctx.globalAlpha = 1;
  }

  private heartShape(ctx: CanvasRenderingContext2D, x: number, y: number, u: number): void {
    ctx.fillRect(x, y, u, u); ctx.fillRect(x + u * 1.6, y, u, u);
    ctx.fillRect(x - u * 0.4, y + u, u * 3, u); ctx.fillRect(x + u * 0.3, y + u * 2, u * 1.6, u);
  }
  private starShape(ctx: CanvasRenderingContext2D, x: number, y: number, u: number): void {
    ctx.fillRect(x - u, y, u * 3, u); ctx.fillRect(x, y - u, u, u * 3);
  }
}

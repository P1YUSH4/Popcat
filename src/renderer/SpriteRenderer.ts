import type { FrameMeta, SpriteMeta, Vec2 } from "./types";

export interface DrawOpts {
  sx?: number; sy?: number;     // squash/stretch about the feet
  rot?: number;                 // radians (wiggle); pupils disabled when set
  tint?: boolean;               // red overheat tint (source-atop)
  clipTopHalf?: boolean;        // peek mode
  bob?: number;                 // vertical bob (walk)
}

const FOOT_Y = 52, FOOT_X = 32; // sprite-local foot anchor (64px cell)

/**
 * Draws a single sprite frame with strict nearest-neighbor scaling. Additive
 * transform options (scale/rotate/tint/clip) layer on top of the existing
 * drawImage — the render pipeline itself is unchanged. Pupils are drawn in
 * screen space so the eyes can track the cursor.
 */
export class SpriteRenderer {
  private ctx: CanvasRenderingContext2D;
  private sheet: CanvasImageSource;       // image OR a recolored offscreen canvas
  private meta: SpriteMeta;
  readonly scale: number;
  readonly cell: number;

  constructor(canvas: HTMLCanvasElement, sheet: CanvasImageSource, meta: SpriteMeta) {
    this.ctx = canvas.getContext("2d", { alpha: true })!;
    this.sheet = sheet;
    this.meta = meta;
    this.scale = meta.renderScale;
    this.cell = meta.cell.w;
  }

  get context(): CanvasRenderingContext2D { return this.ctx; }

  /** Swap the draw source (e.g. a recolored fur/bell canvas). */
  setSheet(sheet: CanvasImageSource): void { this.sheet = sheet; }

  resize(w: number, h: number, dpr: number): void {
    const c = this.ctx.canvas;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = `${w}px`; c.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  clear(): void {
    const { ctx } = this;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.restore();
  }

  /** Clear just a logical-space rect (the dpr transform stays active), so we
   *  don't repaint the whole full-screen canvas every frame. */
  clearRegion(x: number, y: number, w: number, h: number): void {
    this.ctx.clearRect(x, y, w, h);
  }

  drawnCell(): number { return this.cell * this.scale; }

  /** Draw `frame` with feet anchored at `pos`. */
  draw(frame: FrameMeta, pos: Vec2, faceLeft: boolean, o: DrawOpts = {}): void {
    const { ctx, scale, cell } = this;
    const size = cell * scale;
    const sx = o.sx ?? 1, sy = o.sy ?? 1, rot = o.rot ?? 0, bob = o.bob ?? 0;
    const ox = -FOOT_X * scale, oy = -FOOT_Y * scale;

    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(pos.x, pos.y + bob);
    if (rot) ctx.rotate(rot);
    ctx.scale((faceLeft ? -1 : 1) * sx, sy);
    if (o.clipTopHalf) { ctx.beginPath(); ctx.rect(ox, oy, size, FOOT_Y * scale * 0.55); ctx.clip(); }
    ctx.drawImage(this.sheet, frame.rect.x, frame.rect.y, cell, cell, ox, oy, size, size);
    if (o.tint) {
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = "rgba(255,70,55,0.34)";
      ctx.fillRect(ox, oy, size, size);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.restore();
  }

  /**
   * Screen-space tracking pupils. Each pupil computes its OWN direction to the
   * cursor (per spec: offset = normalize(cursor - eyeWorldPos) * maxOffset), so
   * both eyes accurately point at the cursor. Skipped if rotated or eye closed.
   */
  drawPupils(frame: FrameMeta, pos: Vec2, faceLeft: boolean, o: DrawOpts, cursor: Vec2, track = true): void {
    if (o.rot) return;
    const { ctx, scale } = this;
    const sx = o.sx ?? 1, sy = o.sy ?? 1, bob = o.bob ?? 0;
    const { color, radius, maxOffset } = this.meta.pupil;
    ctx.fillStyle = color;
    for (const eye of frame.eyes) {
      if (!eye.open) continue;
      // actual on-screen centre of THIS eye (accounts for facing + squash)
      const ewx = pos.x + (eye.x - FOOT_X) * scale * sx * (faceLeft ? -1 : 1);
      const ewy = pos.y + bob + (eye.y - FOOT_Y) * scale * sy;
      let px = ewx, py = ewy;                 // default: pupil centred (no tracking)
      if (track) {                            // point the pupil straight at the cursor
        const dx = cursor.x - ewx, dy = cursor.y - ewy;
        const len = Math.hypot(dx, dy) || 1;
        px = ewx + (dx / len) * maxOffset * scale;
        py = ewy + (dy / len) * maxOffset * scale;
      }
      const d = radius * 2 * scale;
      ctx.fillRect(Math.round(px - radius * scale), Math.round(py - radius * scale), d, d);
    }
  }

  /**
   * A spinning ball of yarn drawn in screen space (for the scroll reaction).
   * `angle` rotates the wound threads so it visibly spins; a loose thread trails
   * back to the cat's paw. Colors are palette-consistent (pink yarn).
   */
  drawYarn(center: Vec2, angle: number, alpha: number, r: number, paw: Vec2, squash = 0): void {
    const { ctx } = this;
    const rx = r * (1 + squash), ry = r * (1 - squash);   // squash on impact
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    // loose thread from the paw to the ball (sags toward the ball)
    ctx.strokeStyle = "#FA98B2";
    ctx.lineWidth = Math.max(1, r * 0.18);
    ctx.beginPath();
    ctx.moveTo(paw.x, paw.y);
    ctx.quadraticCurveTo((paw.x + center.x) / 2, Math.max(paw.y, center.y) + r * 0.6,
                         center.x - rx * 0.4, center.y - ry * 0.4);
    ctx.stroke();
    // ball body
    ctx.fillStyle = "#FA98B2";
    ctx.beginPath(); ctx.ellipse(center.x, center.y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    // wound threads (rotate with `angle` -> reads as spinning)
    ctx.strokeStyle = "#E07A9B";
    ctx.lineWidth = Math.max(1, r * 0.16);
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.ellipse(center.x, center.y, rx * 0.9, ry * 0.42, angle + k * (Math.PI / 3), 0, Math.PI * 2);
      ctx.stroke();
    }
    // dark outline
    ctx.strokeStyle = "#34304E";
    ctx.lineWidth = Math.max(1, r * 0.18);
    ctx.beginPath(); ctx.ellipse(center.x, center.y, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  /**
   * Interactive hitbox = just the cat's visible body (NOT the full 64px cell,
   * which is mostly transparent padding). Keeps almost the whole screen
   * click-through so scrolling/clicking underneath isn't blocked.
   * Cat art spans sprite-local x≈17..47, y≈2..52 in the 64px cell.
   */
  hitbox(pos: Vec2): { x: number; y: number; w: number; h: number } {
    const s = this.scale;
    return {
      x: pos.x - 15 * s,   // 30px-wide body, centred on the foot point
      y: pos.y - 50 * s,   // from just above the ears down to the feet
      w: 30 * s,
      h: 52 * s,
    };
  }
}

import { buildCoatSheet, findCoat } from "./Coats";
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
  private sheet: HTMLImageElement;          // original sprite sheet
  private active: CanvasImageSource;        // current draw source (sheet or recoloured coat)
  private coats = new Map<string, HTMLCanvasElement>();
  coat = "default";
  private meta: SpriteMeta;
  readonly scale: number;
  readonly cell: number;

  constructor(canvas: HTMLCanvasElement, sheet: HTMLImageElement, meta: SpriteMeta) {
    this.ctx = canvas.getContext("2d", { alpha: true })!;
    this.sheet = sheet;
    this.active = sheet;
    this.meta = meta;
    this.scale = meta.renderScale;
    this.cell = meta.cell.w;
  }

  get context(): CanvasRenderingContext2D { return this.ctx; }

  // ---- illustrated (hi-res painted) mode -------------------------------
  // An optional single painted image replaces the pixel sprite. It's drawn
  // SMOOTHED (not nearest) at a display height, anchored at the feet, and the
  // same squash/stretch/bob/rotation transforms drive its motion.
  private illu: HTMLImageElement | null = null;
  private illuH = 200;                 // display height in screen px
  setIllustrated(img: HTMLImageElement, displayH = 200): void { this.illu = img; this.illuH = displayH; }
  get isIllustrated(): boolean { return !!this.illu; }
  private illuSize(): { w: number; h: number } {
    const img = this.illu!;
    const aspect = img.naturalWidth / img.naturalHeight;
    return { w: this.illuH * aspect, h: this.illuH };
  }
  /** current painted draw size in screen px (for sizing the clear region). */
  illuDims(): { w: number; h: number } | null { return this.illu ? this.illuSize() : null; }

  drawIllustrated(pos: Vec2, faceLeft: boolean, o: DrawOpts = {}): void {
    const img = this.illu;
    if (!img) return;
    const { w, h } = this.illuSize();
    const sx = o.sx ?? 1, sy = o.sy ?? 1, rot = o.rot ?? 0, bob = o.bob ?? 0;
    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.translate(pos.x, pos.y + bob);
    if (rot) ctx.rotate(rot);
    ctx.scale((faceLeft ? -1 : 1) * sx, sy);
    ctx.drawImage(img, -w / 2, -h, w, h);   // feet at origin, centred horizontally
    if (o.tint) {                           // overheat: warm red wash, clipped to the cat
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = "rgba(255,70,55,0.30)";
      ctx.fillRect(-w / 2, -h, w, h);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.restore();
  }

  /** interactive hitbox for the illustrated cat (a bit inset from the image). */
  illuHitbox(pos: Vec2): { x: number; y: number; w: number; h: number } {
    const { w, h } = this.illuSize();
    return { x: pos.x - w * 0.42, y: pos.y - h * 0.96, w: w * 0.84, h: h * 0.92 };
  }

  // ---- accessories (pixel cosmetics drawn over the head/neck) ----------
  accessory = "none";
  setAccessory(name: string): void { this.accessory = name; }

  /** Draw the current accessory in the SAME transform as the body (so it
   *  squashes/bobs/flips with the cat). Cell-local coords (64px cell). */
  drawAccessory(pos: Vec2, faceLeft: boolean, o: DrawOpts = {}): void {
    if (this.accessory === "none") return;
    const { ctx, scale } = this;
    const sx = o.sx ?? 1, sy = o.sy ?? 1, rot = o.rot ?? 0, bob = o.bob ?? 0;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(pos.x, pos.y + bob);
    if (rot) ctx.rotate(rot);
    ctx.scale((faceLeft ? -1 : 1) * sx, sy);
    // cell-local rect fill (x0..x1, y0..y1 inclusive) in 64px cell space
    const R = (x0: number, y0: number, x1: number, y1: number, c: string): void => {
      ctx.fillStyle = c;
      ctx.fillRect((x0 - FOOT_X) * scale, (y0 - FOOT_Y) * scale, (x1 - x0 + 1) * scale, (y1 - y0 + 1) * scale);
    };
    const PINK = "#FA98B2", PINK_D = "#E07A9B", GOLD = "#FFD24D", GOLD_D = "#D9A93D",
          TEAL = "#7CC4D6", WHITE = "#FFF7F7", RED = "#E0556A", RED_D = "#B83E50", JEWEL = "#7EC8FF";
    switch (this.accessory) {
      case "bow": {
        // two loops tapering to a darker centre knot -> reads as a bow, not a blob
        const cx = 24, cy = 10;
        R(cx - 3, cy - 1, cx - 2, cy + 1, PINK);            // left loop (outer block)
        R(cx + 2, cy - 1, cx + 3, cy + 1, PINK);            // right loop
        R(cx - 1, cy, cx - 1, cy, PINK); R(cx + 1, cy, cx + 1, cy, PINK);  // taper to knot
        R(cx, cy - 1, cx, cy + 1, PINK_D);                  // centre knot (darker)
        R(cx - 3, cy - 1, cx - 3, cy - 1, WHITE); R(cx + 3, cy - 1, cx + 3, cy - 1, WHITE);  // tiny highlights
        break;
      }
      case "crown": {
        R(25, 9, 39, 10, GOLD); R(25, 10, 39, 10, GOLD_D);
        for (const px of [27, 32, 37]) R(px - 1, 7, px + 1, 8, GOLD);
        R(32, 9, 32, 9, JEWEL);
        break;
      }
      case "hat": {
        R(29, 10, 35, 10, TEAL); R(30, 8, 34, 9, TEAL); R(31, 6, 33, 7, TEAL); R(32, 4, 32, 5, TEAL);
        R(28, 11, 36, 11, WHITE); R(31, 2, 33, 3, GOLD);   // brim + pompom
        break;
      }
      case "scarf": {
        R(25, 30, 39, 32, RED); R(25, 32, 39, 32, RED_D);
        R(37, 32, 39, 38, RED); R(37, 38, 39, 38, RED_D);  // hanging tail
        break;
      }
    }
    ctx.restore();
  }

  /** Swap the cat's coat colour (palette remap). Falls back to default on miss. */
  setCoat(name: string): void {
    const c = findCoat(name);
    if (!c || name === "default") { this.coat = "default"; this.active = this.sheet; return; }
    let cv = this.coats.get(name);
    if (!cv) {
      try { cv = buildCoatSheet(this.sheet, c); this.coats.set(name, cv); }
      catch { this.coat = "default"; this.active = this.sheet; return; }   // tainted canvas etc.
    }
    this.coat = name; this.active = cv;
  }

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
    ctx.drawImage(this.active, frame.rect.x, frame.rect.y, cell, cell, ox, oy, size, size);
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

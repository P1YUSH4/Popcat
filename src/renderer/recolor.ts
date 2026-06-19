// Runtime sprite recoloring. The sheet is palette-snapped to a fixed set of
// exact RGBs (see tools/gen_companion.py), so we can repaint the cat's fur and
// bell by swapping those exact source colors on an offscreen canvas — no PNG
// regeneration, no shader. drawImage() accepts a canvas, so the recolored
// canvas drops straight into SpriteRenderer.
//
// Only fur (body/shadow/belly highlight) and the bell are touched; the outline,
// eyes and pink collar are left alone so the character stays readable.

export type RGB = [number, number, number];

// Exact source colors baked into pao.png (must match the generator palette).
const FUR_BODY: RGB = [255, 247, 247];     // #FFF7F7 main fur
const FUR_SHADOW: RGB = [208, 210, 218];   // #D0D2DA fur shading (ears, tail)
const FUR_BELLY: RGB = [255, 252, 252];    // #FFFCFC belly / highlight
const BELL_SRC: RGB = [255, 210, 77];      // #FFD24D collar bell

/** A curated fur preset. Each ships its own shadow + belly tone so shading and
 *  depth read correctly (this is why fur is swatch-based, not a free wheel). */
export interface FurPreset { id: string; label: string; body: RGB; shadow: RGB; belly: RGB; }

export const FUR_PRESETS: FurPreset[] = [
  { id: "classic",  label: "White",    body: [255, 247, 247], shadow: [208, 210, 218], belly: [255, 252, 252] },
  { id: "grey",     label: "Grey",     body: [201, 203, 211], shadow: [150, 153, 166], belly: [222, 224, 230] },
  { id: "ginger",   label: "Ginger",   body: [247, 176, 108], shadow: [214, 132, 70],  belly: [255, 208, 150] },
  { id: "cream",    label: "Cream",    body: [247, 231, 203], shadow: [210, 188, 150], belly: [255, 245, 224] },
  { id: "charcoal", label: "Charcoal", body: [97, 99, 117],   shadow: [64, 66, 86],    belly: [124, 126, 144] },
  { id: "mint",     label: "Mint",     body: [196, 232, 216], shadow: [145, 196, 176], belly: [222, 246, 236] },
  { id: "sky",      label: "Sky",      body: [183, 208, 230], shadow: [134, 162, 190], belly: [208, 228, 244] },
];

/** A bell color (or the `hide` sentinel that makes the bell pixels transparent). */
export interface BellColor { id: string; label: string; rgb: RGB | null; }

export const BELL_COLORS: BellColor[] = [
  { id: "gold",   label: "Gold",   rgb: [255, 210, 77] },
  { id: "pink",   label: "Pink",   rgb: [255, 123, 169] },
  { id: "red",    label: "Red",    rgb: [242, 80, 79] },
  { id: "blue",   label: "Blue",   rgb: [91, 183, 255] },
  { id: "green",  label: "Green",  rgb: [95, 201, 122] },
  { id: "silver", label: "Silver", rgb: [200, 204, 214] },
];

export interface SwapRule { from: RGB; to: RGB | null; }   // to === null -> make transparent

/** Build the exact-match swap rules for a given fur preset + bell choice. */
export function furBellRules(furId: string, bellId: string): SwapRule[] {
  const fur = FUR_PRESETS.find((p) => p.id === furId) ?? FUR_PRESETS[0];
  // "hide" is no longer offered in the UI, but stays understood so any older
  // saved config that picked it still renders bell-less.
  const bellRgb: RGB | null = bellId === "hide"
    ? null
    : (BELL_COLORS.find((b) => b.id === bellId)?.rgb ?? BELL_COLORS[0].rgb);
  return [
    { from: FUR_BODY, to: fur.body },
    { from: FUR_SHADOW, to: fur.shadow },
    { from: FUR_BELLY, to: fur.belly },
    { from: BELL_SRC, to: bellRgb },
  ];
}

/** Whether the given choice is the untouched original (lets callers skip work). */
export function isDefaultLook(furId: string, bellId: string): boolean {
  return (furId || "classic") === "classic" && (bellId || "gold") === "gold";
}

/** Pure in-place pixel swap (testable without a DOM): for each opaque pixel that
 *  exactly matches a rule's `from`, replace its RGB (or clear alpha to hide). */
export function swapPixels(data: Uint8ClampedArray, rules: SwapRule[]): void {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;                 // skip transparent padding
    const r = data[i], g = data[i + 1], b = data[i + 2];
    for (const rule of rules) {
      const f = rule.from;
      if (r === f[0] && g === f[1] && b === f[2]) {
        if (rule.to === null) data[i + 3] = 0;
        else { data[i] = rule.to[0]; data[i + 1] = rule.to[1]; data[i + 2] = rule.to[2]; }
        break;
      }
    }
  }
}

const OUTLINE: RGB = [52, 48, 78];   // #34304E global outline (also the bell "slit")

/** When the bell is hidden, the bell body/nub go transparent but the 1px "slit"
 *  detail is drawn in OUTLINE color, so it would linger as a dark dot on the
 *  collar. Clear any OUTLINE pixel enclosed by bell pixels (>=2 bell neighbors),
 *  which uniquely identifies the slit without touching the cat's body outline.
 *  Must run BEFORE the bell pixels themselves are cleared. */
export function clearBellSlits(data: Uint8ClampedArray, width: number): void {
  const isBell = (i: number) =>
    data[i + 3] !== 0 && data[i] === BELL_SRC[0] && data[i + 1] === BELL_SRC[1] && data[i + 2] === BELL_SRC[2];
  const n = data.length / 4;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (data[i + 3] === 0) continue;
    if (data[i] !== OUTLINE[0] || data[i + 1] !== OUTLINE[1] || data[i + 2] !== OUTLINE[2]) continue;
    const x = p % width, y = (p / width) | 0;
    let bellNeighbors = 0;
    if (x > 0 && isBell((p - 1) * 4)) bellNeighbors++;
    if (x < width - 1 && isBell((p + 1) * 4)) bellNeighbors++;
    if (y > 0 && isBell((p - width) * 4)) bellNeighbors++;
    if (p + width < n && isBell((p + width) * 4)) bellNeighbors++;
    if (bellNeighbors >= 2) data[i + 3] = 0;     // enclosed -> it's the slit
  }
}

/** Recolor the whole sheet into an offscreen canvas usable as a draw source.
 *  Always returns a canvas (a plain copy when the look is the default). */
export function recolorSheet(src: HTMLImageElement, furId: string, bellId: string): HTMLCanvasElement {
  const w = src.naturalWidth, h = src.naturalHeight;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0);
  if (isDefaultLook(furId, bellId)) return cv;       // plain copy, no pixel pass
  const img = ctx.getImageData(0, 0, w, h);
  if ((bellId || "gold") === "hide") clearBellSlits(img.data, w);   // drop the slit too
  swapPixels(img.data, furBellRules(furId, bellId));
  ctx.putImageData(img, 0, 0);
  return cv;
}

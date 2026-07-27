/**
 * Coat colours — palette swaps. Pao's art is a strict, alias-free palette, so a
 * different-coloured cat is just an exact colour remap of the fur pixels; the
 * bright eyes, rim outline, nose-pink and collar are left untouched. No new art.
 *
 * Fur palette in pao.png (Jiji black cat): base #2E2B3C, hi #4E4A64, shadow #181624.
 * These MUST match the BODY/BELLY/SHADOW constants in tools/gen_companion.py —
 * the remap is an exact colour match, so if the generator palette changes, update
 * these too or coats silently match zero pixels.
 * Variants stay DARK/MID-tone so the pale eyes keep reading against the fur.
 */
export interface Coat { name: string; label: string; map: Record<string, string>; }

const FUR = { base: "#2E2B3C", hi: "#4E4A64", lo: "#181624" };
const coat = (name: string, label: string, base: string, hi: string, lo: string): Coat => ({
  name, label, map: { [FUR.base]: base, [FUR.hi]: hi, [FUR.lo]: lo },
});

export const COATS: Coat[] = [
  { name: "default", label: "Midnight (Jiji)", map: {} },
  coat("classic", "Classic Pao", "#FFF7F7", "#D0D2DA", "#F1EEF5"),
  coat("ash", "Ash Grey", "#54525F", "#6A6877", "#3C3A45"),
  coat("warmgrey", "Warm Grey", "#8C8377", "#A99F90", "#6A6258"),   // the cozy tabby look
  coat("caramel", "Caramel", "#A88A6A", "#C8AD88", "#80684E"),
  coat("slate", "Slate Blue", "#34384C", "#484E66", "#242838"),
  coat("chocolate", "Chocolate", "#3A2E2A", "#50403A", "#281F1C"),
  coat("moss", "Moss", "#2E3A2E", "#42523F", "#202820"),
  coat("plum", "Plum", "#3A2C40", "#503E58", "#281E2C"),
];

/** Each non-default coat is EARNED by an achievement id (the unlock loop). */
export const COAT_UNLOCKS: Record<string, string> = {
  classic: "first_paw",
  ash: "first_focus",
  warmgrey: "flow",
  caramel: "focus_60",
  slate: "marathon",
  chocolate: "night_owl",
  moss: "multitask",
  plum: "streak_7",
};

export function findCoat(name: string): Coat | undefined { return COATS.find((c) => c.name === name); }
export function coatLabel(name: string): string { return findCoat(name)?.label ?? name; }
export function coatRequirement(name: string): string | undefined { return COAT_UNLOCKS[name]; }

/** Which coats are unlocked, given the set of unlocked achievement ids. */
export function unlockedCoats(achievementIds: string[]): Set<string> {
  const s = new Set<string>(["default"]);
  for (const c of COATS) {
    const req = COAT_UNLOCKS[c.name];
    if (!req || achievementIds.includes(req)) s.add(c.name);
  }
  return s;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Build a recoloured copy of the sprite sheet by exact-matching each source fur
 * colour and replacing it. Returns a canvas usable as a drawImage source.
 */
export function buildCoatSheet(img: HTMLImageElement, coat: Coat): HTMLCanvasElement {
  const w = img.naturalWidth, h = img.naturalHeight;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  const remap = Object.entries(coat.map).map(([from, to]) => ({ from: hexToRgb(from), to: hexToRgb(to) }));
  if (!remap.length) return cv;
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;                 // skip transparent
    for (const { from, to } of remap) {
      if (px[i] === from[0] && px[i + 1] === from[1] && px[i + 2] === from[2]) {
        px[i] = to[0]; px[i + 1] = to[1]; px[i + 2] = to[2];
        break;
      }
    }
  }
  ctx.putImageData(data, 0, 0);
  return cv;
}

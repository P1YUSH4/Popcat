"""
Prepare an AI-generated illustrated cat for use as a desktop-pet sprite:
  - key out the flat background to transparent (colour-distance + feathered edge)
  - clear the bottom-right watermark corner
  - trim to the cat + a small margin
  - save a clean transparent PNG into assets/sprites/ (copied into the app bundle)

Usage:  python tools/prep_illustrated.py            # processes any *_src.png
It reads  assets/illustrated/<name>_src.png  and writes  assets/sprites/<name>.png
for name in: cat_idle, cat_blink, cat_happy, cat_sleep (whichever exist).
"""
import os
from PIL import Image, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.normpath(os.path.join(HERE, "..", "assets", "illustrated"))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "assets", "sprites"))

VARIANTS = ["cat_idle", "cat_blink", "cat_happy", "cat_sleep"]
T_IN, T_OUT = 26, 80          # bg colour-distance: <T_IN -> transparent, >T_OUT -> opaque (feather between)
WATERMARK_CORNER = 96          # px square cleared from the bottom-right (Gemini sparkle)
MARGIN = 12                    # transparent margin kept around the trimmed cat


def remove_background(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    w, h = im.size
    rgb = im.convert("RGB")
    # sample the background colour from the four corners
    pts = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]
    cs = [rgb.getpixel(p) for p in pts]
    bg = tuple(sum(c[i] for c in cs) // len(cs) for i in range(3))

    # per-pixel distance to bg = sum of |channel diffs| (clipped at 255 by add)
    diff = ImageChops.difference(rgb, Image.new("RGB", im.size, bg))
    r, g, b = diff.split()
    dist = ImageChops.add(ImageChops.add(r, g), b)
    lut = [0 if v <= T_IN else (255 if v >= T_OUT else round((v - T_IN) / (T_OUT - T_IN) * 255))
           for v in range(256)]
    alpha = dist.point(lut)
    im.putalpha(alpha)

    # clear the watermark corner
    px = im.load()
    for y in range(h - WATERMARK_CORNER, h):
        for x in range(w - WATERMARK_CORNER, w):
            r0, g0, b0, _ = px[x, y]
            px[x, y] = (r0, g0, b0, 0)
    return im


def trim(im: Image.Image) -> Image.Image:
    bbox = im.getchannel("A").getbbox()
    if not bbox:
        return im
    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - MARGIN); y0 = max(0, y0 - MARGIN)
    x1 = min(im.width, x1 + MARGIN); y1 = min(im.height, y1 + MARGIN)
    return im.crop((x0, y0, x1, y1))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    done = 0
    for name in VARIANTS:
        src = os.path.join(SRC_DIR, f"{name}_src.png")
        if not os.path.exists(src):
            continue
        im = trim(remove_background(Image.open(src)))
        out = os.path.join(OUT_DIR, f"{name}.png")
        im.save(out)
        print(f"{name}: wrote {out}  ({im.width}x{im.height}, aspect {im.width / im.height:.3f})")
        done += 1
    if not done:
        print(f"No *_src.png found in {SRC_DIR}. Save the illustrated cat as cat_idle_src.png there.")


if __name__ == "__main__":
    main()

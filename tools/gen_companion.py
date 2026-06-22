"""
Generate the desktop companion sprite sheets + animation metadata.

Strict spec:
  - 48x48 logical sprite inside a 64x64 cell (padding for stretch/jump overshoot)
  - 6-color palette, NO anti-aliasing, NO gradients, NO blur
  - transparent PNG sheet, nearest-neighbor everything
  - squash/stretch via NEAREST resize about the feet (preserves the palette)

Character: "Pao" - an original cute pixel cat. Large head, small body, large
eyes, tiny paws, expressive tail. Eyes are baked as sclera ONLY; pupils are
drawn at runtime by the SpriteRenderer so they can track the cursor. Per-frame
eye anchors + open/closed flags are exported in the metadata for that.

Output:
  assets/sprites/pao.png   - sprite sheet (rows = animations, cols = frames)
  assets/sprites/pao.json  - palette, frame rects, per-frame eye anchors, tags
"""

import json
import math
import os
from PIL import Image, ImageDraw, ImageFilter

# ---- geometry -----------------------------------------------------------
CELL = 64
CX = 32
FOOT_Y = 52

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "assets", "sprites"))

# ---- palette: COMNYANG style (white cat, grey ears/tail, pink collar+bell) --
T       = (0, 0, 0, 0)
# Jiji-style black cat (Ghibli): near-black fur, big bright eyes, pink nose/collar.
OUTLINE   = (150, 148, 176, 255)  # softer cool-grey rim -> readable on dark AND light backgrounds, less "stickered"
BODY      = (46, 43, 60, 255)     # near-black fur (a touch warmer + deeper)
SHADOW    = (24, 22, 36, 255)     # deeper fur shadow -> stronger form
BELLY     = (78, 74, 100, 255)    # clearer lighter fur tone -> the black body reads ROUND, not flat
EYE       = (30, 28, 44, 255)     # dark pupil + on-sclera detail
SCLERA    = (228, 246, 232, 255)  # big bright eyes (pale mint) — Jiji's signature; visible on black fur
ACCENT    = (250, 152, 178, 255)  # pink: nose / inner ear / collar
BELL      = (255, 210, 77, 255)   # yellow collar bell (FFD24D)
HIGHLIGHT = (255, 255, 255, 255)  # tiny white eye sparkle
PALETTE = [OUTLINE, BODY, SHADOW, BELLY, EYE, SCLERA, ACCENT, BELL]
PUPIL_RADIUS = 1
PUPIL_MAX = 2.0                 # dark pupil travel toward the cursor (on the bright eye)

# greys used ONLY by prop overlays (toilet-paper tube / shading). Drawn after
# the cat is snapped to the 6-color palette, so the character stays on-palette.
GREY   = (176, 178, 186, 255)
GREY_D = (120, 122, 132, 255)
RED    = (240, 80, 80, 255)     # anger mark
BLUE   = (126, 200, 255, 255)   # reference: 7EC8FF (? mark, tears)
PURPLE = (203, 166, 255, 255)   # reference: CBA6FF (accent sparkle)


# ---- pixel helpers (native res, integer) --------------------------------
def new_cell():
    return Image.new("RGBA", (CELL, CELL), T)


def R(d, x0, y0, x1, y1, c):
    if x1 < x0 or y1 < y0:
        return
    d.rectangle([x0, y0, x1, y1], fill=c)


def P(d, x, y, c):
    d.point((x, y), fill=c)


def mx(x):
    return (2 * CX - 1) - x   # mirror across vertical centre


# ---- the base pose (no pupils; sclera only) -----------------------------
EYE_BASE = [(26, 25), (38, 25)]   # left, right sclera centres (pre-transform)


def draw_pose(ear=0, tail=0, eyestate="open", mouth="smile",
              paw=0, blush=False, body_dh=0, head_dy=0, eye_phase=0):
    """
    body_dh : extra body height (negative = squat) applied by lowering head.
    head_dy : vertical nudge of head+ears+face block.
    paw     : 0 both down | 1 left up | 2 right up | 3 both up (knead)
    """
    img = new_cell()
    d = ImageDraw.Draw(img)

    hdy = head_dy
    # ---------- ears ----------
    def ear_shape(cx_, t):
        # tall pointed ear (Jiji), black fur with a small pink inner
        P(d, cx_, t, BODY)
        R(d, cx_ - 1, t + 1, cx_ + 1, t + 1, BODY)
        R(d, cx_ - 1, t + 2, cx_ + 1, t + 2, BODY)
        R(d, cx_ - 2, t + 3, cx_ + 2, t + 4, BODY)
        P(d, cx_, t + 2, ACCENT)
        P(d, cx_, t + 3, ACCENT)
    et = 7 - ear + hdy
    ear_shape(23, et)
    ear_shape(mx(23), et)

    # ---------- head (big, rounded) ----------
    hy = hdy
    R(d, 23, 11 + hy, 40, 11 + hy, BODY)
    R(d, 21, 12 + hy, 42, 12 + hy, BODY)
    R(d, 20, 13 + hy, 43, 28 + hy, BODY)
    R(d, 21, 29 + hy, 42, 29 + hy, BODY)
    R(d, 23, 30 + hy, 40, 30 + hy, BODY)
    # cheek/jaw light
    R(d, 24, 24 + hy, 39, 29 + hy, BELLY)
    R(d, 23, 26 + hy, 40, 28 + hy, BELLY)
    # head shadow (right side)
    R(d, 41, 14 + hy, 42, 25 + hy, SHADOW)
    # upper-left rim light: a thin diagonal catch along the head curve so the
    # forehead reads ROUND (soft top-left key light), not a flat black disc
    P(d, 21, 15 + hy, BELLY); P(d, 22, 14 + hy, BELLY)
    P(d, 23, 13 + hy, BELLY); P(d, 24, 12 + hy, BELLY)

    # ---------- body (small) ----------
    by = 31 + hy
    bb = 49 + body_dh
    R(d, 27, by, 37, bb, BODY)
    R(d, 26, by + 2, 38, bb - 1, BODY)
    R(d, 29, by + 3, 35, bb - 2, BELLY)        # belly
    R(d, 37, by + 1, 38, bb - 2, SHADOW)       # body shadow

    # ---------- tail ----------
    draw_tail(d, tail, hy)

    # ---------- collar + bell ----------
    R(d, 26, by, 38, by + 1, ACCENT)             # pink collar band at the neck
    R(d, 31, by + 2, 33, by + 4, BELL)           # yellow bell on the chest
    R(d, 32, by + 1, 32, by + 1, BELL)           # bell top nub
    P(d, 32, by + 3, OUTLINE)                     # bell slit

    # ---------- front legs + paws ----------
    base = bb
    lift_l = 3 if paw in (1, 3) else 0
    lift_r = 3 if paw in (2, 3) else 0
    # Carve a centre notch up from the feet so the two legs/paws read as
    # SEPARATE rounded feet (the outline grows into the gap) instead of one
    # solid white column where the paws disappear.
    for ny_ in range(base - 5, base + 3):
        P(d, 31, ny_, T); P(d, 32, ny_, T)
    # left paw: rounded foot, grey sole shadow + pink bean
    R(d, 26, base - 2 - lift_l, 30, base + 1 - lift_l, BODY)
    R(d, 26, base + 1 - lift_l, 30, base + 2 - lift_l, BELLY)   # paw pad (light)
    R(d, 26, base + 2 - lift_l, 30, base + 2 - lift_l, SHADOW)  # sole shadow
    R(d, 28, base + 1 - lift_l, 29, base + 1 - lift_l, ACCENT)  # pink bean
    # right paw
    R(d, 33, base - 2 - lift_r, 37, base + 1 - lift_r, BODY)
    R(d, 33, base + 1 - lift_r, 37, base + 2 - lift_r, BELLY)
    R(d, 33, base + 2 - lift_r, 37, base + 2 - lift_r, SHADOW)
    R(d, 34, base + 1 - lift_r, 35, base + 1 - lift_r, ACCENT)
    # re-carve the notch over the paws so the inner edges stay separated
    for ny_ in range(base - 5, base + 3):
        P(d, 31, ny_, T); P(d, 32, ny_, T)

    # ---------- face: eyes ----------
    for (ex, ey0) in EYE_BASE:
        ey = ey0 + hy
        if eyestate == "open":
            # big bright Jiji eye: a tall PALE oval (sclera). The dark pupil is
            # the runtime "pupil" (tracks the cursor); we bake nothing here so the
            # eye stays bright. The app always draws the pupil each frame.
            R(d, ex - 1, ey - 3, ex + 1, ey - 3, SCLERA)  # top cap (3w)
            R(d, ex - 2, ey - 2, ex + 2, ey + 1, SCLERA)  # body (5w x 4h)
            R(d, ex - 1, ey + 2, ex + 1, ey + 2, SCLERA)  # bottom cap (3w)
        elif eyestate == "closed":
            R(d, ex - 3, ey, ex + 3, ey, SCLERA)          # pale so it shows on black fur
            P(d, ex - 3, ey - 1, SCLERA); P(d, ex + 3, ey - 1, SCLERA)
        elif eyestate == "happy":
            # bright upward ^_^ curve (2px thick) — pale so it reads on black
            P(d, ex - 2, ey + 1, SCLERA); P(d, ex - 2, ey, SCLERA)
            P(d, ex - 1, ey - 1, SCLERA); P(d, ex, ey - 2, SCLERA); P(d, ex + 1, ey - 1, SCLERA)
            P(d, ex + 2, ey, SCLERA); P(d, ex + 2, ey + 1, SCLERA)
            P(d, ex - 1, ey, SCLERA); P(d, ex + 1, ey, SCLERA)
        elif eyestate == "dizzy":
            R(d, ex - 2, ey - 2, ex + 2, ey + 2, SCLERA)
            P(d, ex, ey, EYE)
        elif eyestate == "swirl":
            # spinning spiral eye (classic dizzy). A pale disc with a dark
            # @-shaped spiral that rotates 90 deg per frame -> reads as spinning.
            R(d, ex - 1, ey - 2, ex + 1, ey - 2, SCLERA)  # pale disc
            R(d, ex - 2, ey - 1, ex + 2, ey + 1, SCLERA)
            R(d, ex - 1, ey + 2, ex + 1, ey + 2, SCLERA)
            spiral = [
                (-1, -2), (0, -2), (1, -2),
                (-2, -1), (1, -1),
                (-2, 0), (0, 0), (1, 0),
                (-2, 1),
                (-1, 2), (0, 2), (1, 2),
            ]
            for _ in range(eye_phase % 4):    # rotate 90 deg clockwise per frame
                spiral = [(-py_, px_) for (px_, py_) in spiral]
            for (sx_, sy_) in spiral:
                P(d, ex + sx_, ey + sy_, EYE)

    # ---------- nose + mouth ----------
    nx, ny = CX, 25 + hy
    P(d, nx - 1, ny, ACCENT); P(d, nx, ny, ACCENT)
    if mouth == "smile":
        P(d, nx - 2, ny + 2, OUTLINE); P(d, nx - 1, ny + 3, OUTLINE)
        P(d, nx, ny + 3, OUTLINE); P(d, nx + 1, ny + 3, OUTLINE); P(d, nx + 2, ny + 2, OUTLINE)
    elif mouth == "open":
        R(d, nx - 2, ny + 2, nx + 1, ny + 4, OUTLINE)
        R(d, nx - 1, ny + 3, nx, ny + 4, ACCENT)
    elif mouth == "grimace":
        R(d, nx - 3, ny + 2, nx + 2, ny + 3, OUTLINE)
        for gx in range(nx - 2, nx + 2, 2):
            P(d, gx, ny + 2, BELLY)
    # neutral -> nothing

    # ---------- blush (only when emotive; sleek Jiji has no permanent blush) ----------
    if blush:   # purr / overheat / drag / shy states
        R(d, 22, 27 + hy, 23, 28 + hy, ACCENT)
        R(d, mx(23), 27 + hy, mx(22), 28 + hy, ACCENT)
        P(d, 21, 28 + hy, ACCENT); P(d, mx(21), 28 + hy, ACCENT)

    return add_outline(img)


def draw_tail(d, tail, hy):
    # all-black expressive tail (Jiji), with a subtle lighter tip for form
    if tail == 0:        # resting curl to the right
        R(d, 38, 44, 40, 45, BODY); R(d, 40, 41, 42, 43, BODY); R(d, 41, 39, 43, 41, BODY)
        P(d, 42, 39, BELLY)
    elif tail == 1:      # raised
        R(d, 38, 42, 40, 44, BODY); R(d, 39, 37, 41, 42, BODY); R(d, 40, 33, 42, 37, BODY)
        P(d, 41, 33, BELLY)
    elif tail == 2:      # low wag left/back
        R(d, 38, 45, 41, 46, BODY); R(d, 41, 43, 43, 45, BODY); P(d, 42, 43, BELLY)
    elif tail == 3:      # flick high (excited)
        R(d, 38, 40, 40, 44, BODY); R(d, 40, 35, 42, 40, BODY); R(d, 41, 31, 43, 35, BODY)
        P(d, 42, 31, BELLY)
    elif tail == 4:      # wrapped (sit)
        R(d, 26, 47, 38, 49, BODY); R(d, 24, 46, 27, 48, BODY); P(d, 25, 45, BELLY)


def add_outline(img):
    """1px uniform outline grown from the silhouette (palette-safe)."""
    a = img.getchannel("A").point(lambda v: 255 if v > 0 else 0)
    grown = a.filter(ImageFilter.MaxFilter(3))
    out = new_cell()
    out.paste(Image.new("RGBA", img.size, OUTLINE), (0, 0), grown)
    out.alpha_composite(img)
    return out


# ---- transform (NEAREST squash/stretch about the feet) ------------------
def transform_point(x, y, sx, sy, dx, dy):
    return (CX + (x - CX) * sx + dx, FOOT_Y + (y - FOOT_Y) * sy + dy)


def compose(pose, sx=1.0, sy=1.0, dx=0, dy=0):
    nw, nh = max(1, round(CELL * sx)), max(1, round(CELL * sy))
    img = pose.resize((nw, nh), Image.NEAREST)
    fpx, fpy = CX * sx, FOOT_Y * sy
    cell = new_cell()
    px = round(CX + dx - fpx)
    py = round(FOOT_Y + dy - fpy)
    cell.paste(img, (px, py), img)
    return cell


def snap_palette(img):
    """Force exactly the 6 palette colors (+transparent). No stray colors."""
    px = img.load()
    for y in range(CELL):
        for x in range(CELL):
            r, g, b, a = px[x, y]
            if a < 128:
                px[x, y] = T
                continue
            best, bd = OUTLINE, 1 << 30
            for c in PALETTE:
                dd = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2
                if dd < bd:
                    bd, best = dd, c
            px[x, y] = best
    return img


# ---- screen-space overlays (drawn after transform) ----------------------
def overlay(cell, kind, i, n):
    d = ImageDraw.Draw(cell)
    if kind == "zzz":
        # two rising "Z"s above the head; blue with a dark drop-shadow so they
        # stay readable over any desktop background.
        base = 26 - (i % n) * 3
        for k, sz in ((0, 4), (1, 3)):          # bigger Z low, smaller Z higher
            zx = 40 + k * 3
            zy = base - k * 7
            if zy < 2:
                continue
            def _z(ox, oy, c):
                R(d, zx + ox, zy + oy, zx + sz + ox, zy + oy, c)            # top bar
                R(d, zx + ox, zy + sz + oy, zx + sz + ox, zy + sz + oy, c)  # bottom bar
                for t in range(sz + 1):
                    P(d, zx + sz - t + ox, zy + t + oy, c)                  # diagonal
            _z(1, 1, OUTLINE)   # drop-shadow for contrast
            _z(0, 0, BLUE)      # the letter
    elif kind == "think":
        seq = ["?", ".", "..", "...", "?", ".."][i % 6]
        bx, by = 44, 8
        R(d, bx - 1, by - 1, bx + len(seq) * 2, by + 4, BELLY)  # bubble
        for j, ch in enumerate(seq):
            P(d, bx + j * 2, by + 1, OUTLINE)
        if "?" in seq:
            P(d, bx, by, OUTLINE); P(d, bx + 1, by + 2, OUTLINE)
    elif kind == "spark":
        pts = [(12, 14), (50, 18), (16, 30), (48, 34)]
        for k, (sx, sy) in enumerate(pts):
            if (i + k) % 2 == 0:
                P(d, sx, sy, BELLY); P(d, sx - 1, sy, BELLY); P(d, sx + 1, sy, BELLY)
                P(d, sx, sy - 1, BELLY); P(d, sx, sy + 1, BELLY)
    elif kind == "lines":
        off = (i % 2) * 2
        for lx in (6 + off, 12 + off):
            R(d, lx, 34, lx + 3, 34, BELLY)
            R(d, lx, 42, lx + 3, 42, BELLY)
    elif kind == "sweat":
        drops = [(46, 16), (48, 24), (44, 20)]
        for k, (sx, sy) in enumerate(drops):
            if (i + k) % 3 != 2:
                yy = sy + (i % 3)
                P(d, sx, yy, BELLY); R(d, sx - 1, yy + 1, sx + 1, yy + 1, BELLY)
    elif kind == "heat":
        for k, hx in enumerate((24, 32, 40)):
            wy = 6 + ((i + k) % 2)
            P(d, hx, wy, ACCENT); P(d, hx + 1, wy - 1, ACCENT)
    elif kind == "hearts":
        for hx, b in ((45, 14), (17, 18)):
            hy = b - (i % 3) * 3
            if hy > 2:
                P(d, hx, hy, ACCENT); P(d, hx + 2, hy, ACCENT)
                R(d, hx - 1, hy + 1, hx + 3, hy + 1, ACCENT)
                R(d, hx, hy + 2, hx + 2, hy + 2, ACCENT)
                P(d, hx + 1, hy + 3, ACCENT)
    elif kind == "keyboard":
        # a little keyboard the cat taps on; one key presses down per frame
        R(d, 16, 50, 47, 54, OUTLINE)          # frame
        R(d, 17, 53, 46, 53, SHADOW)           # base lip
        pressed = 18 + (i % 9) * 3
        for kx in range(18, 45, 3):
            cap = BELLY
            ky = 51
            if kx == pressed:
                cap = ACCENT; ky = 52               # pressed key sinks + glows
            R(d, kx, ky, kx + 1, ky + 1, cap)
    elif kind == "qmark":
        # a "?" floating above the head (confused)
        bob = i % 2
        bx, by = 43, 7 - bob
        R(d, bx, by, bx + 2, by, OUTLINE)
        P(d, bx + 3, by + 1, OUTLINE); P(d, bx + 2, by + 2, OUTLINE)
        P(d, bx + 1, by + 3, OUTLINE); P(d, bx + 1, by + 5, OUTLINE)
    elif kind == "anger":
        # red anger mark (💢) by the head
        ax2, ay2 = 41, 7 + (i % 2)
        R(d, ax2, ay2, ax2 + 1, ay2 + 1, RED); R(d, ax2 + 4, ay2, ax2 + 5, ay2 + 1, RED)
        R(d, ax2 + 2, ay2 + 1, ax2 + 3, ay2 + 2, RED)
        R(d, ax2, ay2 + 3, ax2 + 1, ay2 + 4, RED); R(d, ax2 + 4, ay2 + 3, ax2 + 5, ay2 + 4, RED)
    elif kind == "dust":
        # little grey scuff puffs at the feet (run/land contacts)
        for k, (dx0, dy0) in enumerate(((20, 50), (43, 50), (16, 52), (47, 51))):
            if (i + k) % 2 == 0:
                P(d, dx0, dy0, GREY); P(d, dx0 + 1, dy0, GREY); P(d, dx0, dy0 - 1, GREY)
    elif kind == "stars":
        # yellow stars circling above the head (dizzy). 3 stars evenly spaced
        # around an ellipse, advancing one slot per frame so they orbit.
        orbit = [(-9, 6), (-5, 4), (0, 3), (5, 4), (9, 6), (5, 8), (0, 9), (-5, 8)]
        m = len(orbit)
        for k in range(3):
            ox, oy = orbit[(i * 2 + k * 3) % m]
            sx, sy = CX + ox, 6 + oy
            P(d, sx, sy, BELL)
            P(d, sx - 1, sy, BELL); P(d, sx + 1, sy, BELL)
            P(d, sx, sy - 1, BELL); P(d, sx, sy + 1, BELL)
    elif kind == "swipe":
        # bold pink claw-swipe crescent to the cat's right (reference attack)
        cx0, cy0 = 43, 26
        span = 10
        for a in range(-span, span + 1):
            bow = int((span * span - a * a) / span * 0.55)   # crescent curvature
            ax = cx0 + bow + 3
            ay = cy0 + a
            R(d, ax, ay, ax + 2, ay, ACCENT)                 # thick pink stroke
            P(d, ax + 1, ay, BELLY)                          # white core highlight
        # three claw streaks trailing the crescent
        for k in range(3):
            sxk = cx0 + 1 + k * 3
            R(d, sxk, cy0 - 7 + k * 5, sxk + 4, cy0 - 7 + k * 5, ACCENT)
    elif kind == "emote_heart":
        cx0, cy0 = CX, 6 + (i % 2)
        P(d, cx0 - 2, cy0, ACCENT); P(d, cx0 + 2, cy0, ACCENT)
        R(d, cx0 - 3, cy0 + 1, cx0 + 3, cy0 + 1, ACCENT)
        R(d, cx0 - 2, cy0 + 2, cx0 + 2, cy0 + 2, ACCENT)
        R(d, cx0 - 1, cy0 + 3, cx0 + 1, cy0 + 3, ACCENT)
        P(d, cx0, cy0 + 4, ACCENT)
    elif kind == "emote_q":
        cx0, cy0 = CX - 1, 5 + (i % 2)
        R(d, cx0, cy0, cx0 + 2, cy0, BLUE)
        P(d, cx0 + 3, cy0 + 1, BLUE); P(d, cx0 + 2, cy0 + 2, BLUE)
        P(d, cx0 + 1, cy0 + 3, BLUE); P(d, cx0 + 1, cy0 + 5, BLUE)
    elif kind == "emote_excl":
        cx0, cy0 = CX, 5 + (i % 2)
        R(d, cx0, cy0, cx0, cy0 + 3, BELL)
        P(d, cx0, cy0 + 5, BELL)
    elif kind == "emote_sparkle":
        for (sx0, sy0, c) in ((CX - 6, 8, BELL), (CX + 6, 6, PURPLE), (CX + 2, 12, BELL)):
            sy0 += (i % 2)
            P(d, sx0, sy0, c)
            P(d, sx0 - 1, sy0, c); P(d, sx0 + 1, sy0, c)
            P(d, sx0, sy0 - 1, c); P(d, sx0, sy0 + 1, c)
    elif kind == "emote_cry":
        # fat blue tear drops streaming down both cheeks
        ty = 30 + (i % 3)
        for ex0 in (23, 39):
            R(d, ex0, 26, ex0 + 1, ty, BLUE)     # 2px-wide streak
            R(d, ex0 - 1, ty, ex0 + 2, ty + 1, BLUE)  # droplet bulb
            P(d, ex0, ty + 2, BLUE)
    elif kind == "emote_angry":
        ax2, ay2 = CX + 6, 6 + (i % 2)
        R(d, ax2, ay2, ax2 + 1, ay2 + 1, RED); R(d, ax2 + 4, ay2, ax2 + 5, ay2 + 1, RED)
        R(d, ax2 + 2, ay2 + 1, ax2 + 3, ay2 + 2, RED)
        R(d, ax2, ay2 + 3, ax2 + 1, ay2 + 4, RED); R(d, ax2 + 4, ay2 + 3, ax2 + 5, ay2 + 4, RED)
    elif kind == "confetti":
        # multi-colour confetti bits drifting around the head (celebration)
        bits = [(13, 8, ACCENT), (50, 11, BELL), (20, 5, BLUE), (44, 7, PURPLE),
                (32, 3, BELL), (11, 18, PURPLE), (52, 20, ACCENT), (28, 9, BLUE)]
        for k, (bx, by, c) in enumerate(bits):
            if (i + k) % 5 == 4:
                continue
            yy = by + ((i + k) % 4) * 3
            R(d, bx, yy, bx + 1, yy, c)
            if (i + k) % 2 == 0:
                P(d, bx, yy + 1, c)
    elif kind == "bellring":
        # the collar bell is ringing: yellow sound-arcs radiate from the chest
        # bell (~x32,y34) and a couple of musical notes rise by the head
        by = 34
        big = (i % 2) == 0
        for s in (-1, 1):                       # arcs on both sides of the bell
            bx = 32 + s * 4
            P(d, bx, by, BELL); P(d, bx + s, by - 1, BELL); P(d, bx + s, by + 1, BELL)
            if big:
                P(d, bx + s * 2, by - 2, BELL); P(d, bx + s * 2, by, BELL); P(d, bx + s * 2, by + 2, BELL)
        for k, (nx, ny) in enumerate(((43, 11), (48, 7))):   # rising ♪ notes
            if (i + k) % 2 == 0:
                yy = ny - (i % 3)
                R(d, nx, yy, nx, yy + 2, PURPLE)             # stem
                R(d, nx - 1, yy + 2, nx, yy + 2, PURPLE)     # note head
    elif kind == "alert":
        # bold yellow "!" above the head + flanking attention sparks (with a
        # dark drop-shadow so it pops over any background)
        base = 3 - (i % 2)
        def _excl(ox, oy, c):
            R(d, 31 + ox, base + oy, 32 + ox, base + 6 + oy, c)        # bar (2px wide)
            R(d, 31 + ox, base + 8 + oy, 32 + ox, base + 9 + oy, c)    # dot
        _excl(1, 1, OUTLINE)        # drop-shadow
        _excl(0, 0, BELL)           # the mark
        for sx0 in (24, 40):        # sparks either side of the head
            sy0 = 7 + (i % 2)
            P(d, sx0, sy0, BELL); P(d, sx0 - 1, sy0, BELL); P(d, sx0 + 1, sy0, BELL)
            P(d, sx0, sy0 - 1, BELL); P(d, sx0, sy0 + 1, BELL)


# ---- animations: (pose_kwargs, transform_kwargs, overlay|None) ----------
def idle():
    # SMOOTH breathing: 16 frames on a continuous sine so the rise/fall reads
    # seamless (Comnyang-style) instead of stepping through a few held poses.
    # sx = 1/sy keeps the silhouette mass constant. One quick double-frame blink
    # and a slow tail sway add life without popping.
    N = 16
    fr, durs = [], []
    for i in range(N):
        ph = i / N * 2 * math.pi
        breath = (1 - math.cos(ph)) / 2            # 0..1..0, smooth at both ends
        sy = 1.0 + 0.035 * breath
        es = "closed" if i in (11, 12) else "open"  # one ~120ms blink per cycle
        ear = 1 if i in (6, 7) else 0               # tiny ear flick near the inhale top
        tail = 0 if i < 8 else 1                    # one slow sway per breath
        fr.append((dict(eyestate=es, tail=tail, ear=ear, blush=False),
                   dict(sy=sy, sx=1.0 / sy, dy=-(sy - 1) * 18), None))
        durs.append(60)                             # ~0.96s cycle at a smooth ~16fps
    return fr, durs


def walk():
    # SMOOTH bounce: 12 frames on a continuous sine. Two strides per cycle —
    # squash low at each contact, stretch up through the passing position. The
    # front paws alternate per stride and the tail counter-swings for follow-
    # through. Denser frames remove the old shuffly stepping.
    N = 12
    fr, durs = [], []
    for i in range(N):
        ph = i / N * 2 * math.pi
        bob = -round(2 * math.cos(2 * ph))         # 2 bounces/cycle: low at contact
        sy = 1.0 + 0.05 * math.cos(2 * ph)         # squash (sy<1) at contact, stretch at passing
        paw = 1 if (i % 6) < 3 else 2              # left paw lifts, then right
        tail = 1 if math.sin(2 * ph - 0.8) > 0 else 2   # lags the legs ~a frame
        fr.append((dict(paw=paw, tail=tail, eyestate="open", mouth="smile"),
                   dict(dy=bob, dx=0, sx=1.0 / sy, sy=sy), None))
        durs.append(62)
    return fr, durs


def run():
    # Two elongated motion-smear frames at full extension sell the speed; dust
    # puffs kick up on the contact frames.
    paw  = [3, 1, 0, 2, 3, 1, 0, 2]
    bob  = [0, -2, -3, -1, 0, -2, -3, -1]
    fr = []
    for i in range(8):
        contact = i in (0, 4)
        smear = i in (2, 6)
        if smear:      sx, sy = 1.20, 0.88   # stretched smear
        elif contact:  sx, sy = 1.08, 0.93   # contact squash
        else:          sx, sy = 0.95, 1.06   # gather
        fr.append((dict(paw=paw[i], tail=3, eyestate="open", mouth="open", ear=-1),
                   dict(dy=bob[i], dx=1, sx=sx, sy=sy),
                   "dust" if contact else "lines"))
    return fr, [60, 52, 48, 52, 60, 52, 48, 52]


def sit():
    # Now breathes gently and blinks instead of sitting frozen.
    sy   = [0.93, 0.95, 0.94, 0.93]
    tail = [4, 4, 2, 4]
    durs = [380, 300, 90, 360]
    fr = []
    for i in range(4):
        es = "closed" if i == 2 else "open"
        fr.append((dict(tail=tail[i], eyestate=es, mouth="smile", body_dh=-3),
                   dict(sx=1.05, sy=sy[i], dy=0), None))
    return fr, durs


def sleep():
    # curled sleeping ball with a slow breath (top lifts 1px) + rising zzz
    fr = []
    breathe = [0, 1, 1, 0]
    for i in range(4):
        fr.append((dict(_pose="sleep", breathe=breathe[i], eyestate="closed"),
                   dict(sx=1.0, sy=1.0, dy=0), "zzz"))
    return fr, [520, 460, 520, 460]


def stretch():   # real cat pandiculation (downward-dog bow): gather -> head/front
                 # drop LOW with the tail raised HIGH -> long held quiver ->
                 # shake-off -> settle. Stays grounded (no tall pop = not a jump).
                 # The head dip (head_dy) + raised tail are what sell the bow.
    keys = [
        # pose-extra (eyes/mouth/tail/head_dy)             transform
        (dict(eyestate="open",   mouth="smile", tail=1, head_dy=0), dict(sx=1.00, sy=1.00, dx=0,  dy=0)),  # ready
        (dict(eyestate="open",   mouth="open",  tail=1, head_dy=1), dict(sx=1.06, sy=0.93, dx=1,  dy=1)),  # gather
        (dict(eyestate="closed", mouth="open",  tail=2, head_dy=3), dict(sx=1.20, sy=0.82, dx=4,  dy=2)),  # bow begins (head drops)
        (dict(eyestate="closed", mouth="open",  tail=3, head_dy=5), dict(sx=1.36, sy=0.70, dx=7,  dy=3)),  # DEEP bow: front low, tail high (hold)
        (dict(eyestate="closed", mouth="open",  tail=3, head_dy=5), dict(sx=1.33, sy=0.72, dx=6,  dy=3)),  # quiver at full extension
        (dict(eyestate="open",   mouth="open",  tail=1, head_dy=0), dict(sx=1.04, sy=1.00, dx=-3, dy=0)),  # release / shake-off L
        (dict(eyestate="open",   mouth="smile", tail=2, head_dy=0), dict(sx=0.98, sy=1.02, dx=2,  dy=0)),  # shake-off R
        (dict(eyestate="open",   mouth="smile", tail=0, head_dy=0), dict(sx=1.00, sy=1.00, dx=0,  dy=0)),  # settle
    ]
    return [(k[0], k[1], None) for k in keys], \
           [150, 140, 160, 340, 170, 110, 100, 190]


def knead():   # typing / kneading
    fr = []
    for i in range(6):
        paw = [1, 3, 2, 3, 1, 0][i]
        tail = [1, 1, 2, 2, 1, 1][i]
        fr.append((dict(paw=paw, tail=tail, eyestate="happy", mouth="smile"),
                   dict(dy=-1 if i % 2 else 0, sy=1.0), None))
    return fr, 110


def think():    # pondering while an answer generates: paw-to-chin, head tilt,
                # ear flicks, cycling thought bubble (? . .. ...)
    fr = []
    ear  = [1, 1, 0, 0, 1, 1]
    tilt = [-1, -1, 0, 1, 1, 0]      # slow contemplative head tilt
    bob  = [0, -1, -1, 0, -1, -1]
    for i in range(6):
        fr.append((dict(eyestate="open", tail=0, mouth="neutral", ear=ear[i], paw=1),
                   dict(dy=bob[i], dx=tilt[i], sx=1.0), "think"))
    return fr, 220


def jump():
    # Anticipation crouch -> stretched launch -> held hang at the peak -> land
    # squash -> a rebound overshoot before the settle (the missing bounce).
    keys = [
        (dict(eyestate="open"),   dict(sx=1.18, sy=0.80, dy=2)),     # crouch (anticipation)
        (dict(eyestate="open"),   dict(sx=1.08, sy=0.90, dy=1)),     # load
        (dict(eyestate="happy"),  dict(sx=0.79, sy=1.26, dy=-9)),    # launch (stretch)
        (dict(eyestate="happy"),  dict(sx=0.83, sy=1.20, dy=-15)),   # rise
        (dict(eyestate="happy"),  dict(sx=0.91, sy=1.10, dy=-13)),   # hang (peak)
        (dict(eyestate="open"),   dict(sx=0.96, sy=1.05, dy=-5)),    # fall
        (dict(eyestate="closed"), dict(sx=1.20, sy=0.78, dy=2)),     # land squash
        (dict(eyestate="open"),   dict(sx=0.95, sy=1.07, dy=-1)),    # rebound (overshoot)
        (dict(eyestate="open"),   dict(sx=1.0,  sy=1.0)),            # settle
    ]
    ov = [None, None, "spark", "spark", "spark", None, "dust", None, None]
    return [(dict(tail=3, mouth="open", paw=3, **k[0]), k[1], ov[i]) for i, k in enumerate(keys)], \
           [110, 70, 80, 110, 150, 90, 90, 80, 150]


def drag():    # held up like mochi: gently stretched, paws dangling, ears kept
               # upright + in frame (the side-to-side swing comes from physics)
    fr = []
    bob = [0, -1, -1, 0, -1, -1]
    sway = [-1, 0, 1, 0, -1, 1]
    for i in range(6):
        es = "happy" if i % 2 == 0 else "dizzy"
        # modest stretch + downward nudge so the ears never clip the cell top
        fr.append((dict(eyestate=es, tail=1, mouth="open", paw=3, ear=0),
                   dict(sx=1.0 / 1.12, sy=1.12, dy=3 + bob[i], dx=sway[i]), None))
    return fr, 110


def overheat():
    fr = []
    sway = [-1, 1, -1, 1, 0, 0]
    for i in range(6):
        mouth = "open" if i % 2 == 0 else "grimace"
        es = "dizzy" if i in (4, 5) else "open"
        fr.append((dict(eyestate=es, tail=2, mouth=mouth, blush=True),
                   dict(sx=1.02, sy=0.98, dx=sway[i]),
                   "sweat" if i % 2 else "heat"))
    return fr, 130


def wiggle():   # shake while held -> dizzy horizontal sway
    fr, sway = [], [-4, 5, -5, 4, -3, 3]
    for i in range(6):
        es = "dizzy" if i >= 2 else "happy"
        fr.append((dict(eyestate=es, tail=1, mouth="open", paw=3),
                   dict(sx=1.0 / 1.26, sy=1.26, dy=-4, dx=sway[i]), None))
    return fr, 70


def purr():     # pet the head -> content, hearts, blush
    fr = []
    for i in range(6):
        es = "closed" if i % 3 == 2 else "happy"
        fr.append((dict(eyestate=es, tail=[1, 2, 1, 2, 1, 2][i], mouth="smile", blush=True),
                   dict(dy=-1 if i % 2 else 0, sy=1.0), "hearts"))
    return fr, 150


def scroll():   # scrolling -> play with the yarn ball: alternate paws lift
                # (anticipation) then bat DOWN (strike). The ball reacts to the
                # strike frames at runtime (hop + knock + spin). 8-frame cycle:
                # strikes land on the "paw down" frames (1,3,5,7).
    fr = []
    paw  = [1, 0, 2, 0, 1, 0, 2, 0]      # L up, L strike, R up, R strike, ...
    tail = [1, 2, 1, 0, 1, 2, 1, 0]      # tail flicks with the play
    bob  = [-1, 1, -1, 1, -1, 1, -1, 1]  # tiny body bob: lift then push on each bat
    eyes = ["happy" if i % 2 else "open" for i in range(8)]  # squint on the strike
    for i in range(8):
        fr.append((dict(paw=paw[i], tail=tail[i], eyestate=eyes[i], mouth="smile",
                        body_dh=-1),
                   dict(dy=bob[i], dx=2, sy=1.0), None))   # lean toward the ball
    return fr, [85, 95, 85, 95, 85, 95, 85, 95]


def typing():   # tap on a keyboard, paws alternating, head down, keeps smiling
    fr = []
    for i in range(6):
        paw = 1 if i % 2 == 0 else 2   # alternate which paw is mid-tap
        fr.append((dict(paw=paw, tail=0, eyestate="open", mouth="smile", body_dh=-1),
                   dict(dy=0, sy=1.0), "keyboard"))
    return fr, 85


def meow():     # anticipation dip -> head up + wide mouth -> hold -> settle
    fr = [
        (dict(eyestate="happy", mouth="smile",   tail=1), dict(dy=1,  sy=0.98, sx=1.02), None),  # inhale dip
        (dict(eyestate="open",  mouth="open",    tail=3), dict(dy=-2, sy=1.06, sx=1.0 / 1.06), None),  # call up
        (dict(eyestate="happy", mouth="grimace", tail=3), dict(dy=-1, sy=1.02, sx=0.99), None),  # hold the meow
        (dict(eyestate="open",  mouth="open",    tail=1), dict(dy=0,  sy=1.0,  sx=1.0),  None),  # settle
    ]
    return fr, [120, 90, 200, 160]


def fall():      # airborne after a launch: braced, paws out, dizzy
    fr, sway = [], [-3, 3, -2, 2]
    for i in range(4):
        fr.append((dict(eyestate="dizzy", paw=3, mouth="open", tail=1),
                   dict(sx=1.0 / 1.12, sy=1.12, dy=-2, dx=sway[i]), None))
    return fr, 90


def confused():  # dizzy: spinning swirl eyes + head wobble + circling stars
    fr = []
    sway = [-2, -1, 1, 2, 1, -1]          # head lolls side to side
    droop = [0, 1, 1, 0, 1, 1]            # slight bob/sag
    for i in range(6):
        ear = -1 if i % 2 else 0           # ears flop down a touch
        fr.append((dict(eyestate="swirl", eye_phase=i, mouth="open",
                        ear=ear, tail=2, blush=True),
                   dict(dx=sway[i], dy=droop[i], sy=0.98, sx=1.02), "stars"))
    # hold the side extremes (slow-in/out) so the head lolls instead of buzzing
    return fr, [150, 90, 90, 150, 90, 110]


def angry():     # grumpy + red anger mark
    fr = []
    for i in range(4):
        m = "grimace" if i % 2 else "open"
        fr.append((dict(eyestate="dizzy", mouth=m, tail=2, ear=-1, blush=True),
                   dict(sx=1.02, sy=0.98, dx=(-1 if i % 2 else 1)), "anger"))
    return fr, 130


def attack():    # wind-up -> stretched strike smear -> contact -> recover
    fr = [
        (dict(eyestate="open",  mouth="open",  paw=0, tail=1), dict(sx=1.00, sy=1.00, dx=0),  None),     # ready
        (dict(eyestate="happy", mouth="open",  paw=1, tail=3), dict(sx=1.0 / 1.08, sy=1.08, dx=-3), None),  # wind-up (pull back, tail flick)
        (dict(eyestate="open",  mouth="open",  paw=2, tail=2), dict(sx=1.22, sy=0.86, dx=3),  "swipe"),  # strike smear (stretched)
        (dict(eyestate="happy", mouth="smile", paw=2, tail=2), dict(sx=1.04, sy=0.98, dx=2),  "swipe"),  # contact
        (dict(eyestate="open",  mouth="smile", paw=0, tail=1), dict(sx=1.00, sy=1.00, dx=0),  None),     # recover
    ]
    return fr, [120, 90, 50, 90, 150]   # snap through the strike, hold the ends


def hit():       # hard impact freeze -> fast recoil -> stagger -> slump -> dazed
    fr = [
        (dict(eyestate="dizzy", mouth="open",    tail=1, ear=-1),               dict(sx=1.10, sy=0.90, dx=4),        "stars"),  # impact (freeze)
        (dict(eyestate="swirl", eye_phase=0, mouth="open", tail=2, ear=-1),     dict(sx=0.96, sy=1.04, dx=-3),       "stars"),  # recoil back
        (dict(eyestate="swirl", eye_phase=2, mouth="grimace", tail=2, ear=-1),  dict(sx=1.12, sy=0.84, dy=3, dx=2),  "stars"),  # stagger
        (dict(eyestate="closed", mouth="open",   tail=0, ear=-1),               dict(sx=1.18, sy=0.78, dy=4),        None),     # slump
        (dict(eyestate="swirl", eye_phase=1, mouth="grimace", tail=0, ear=-1),  dict(sx=1.08, sy=0.88, dy=3),        None),     # dazed
    ]
    return fr, [170, 70, 110, 140, 200]   # hard freeze on impact, fast recoil out


def lie_down():  # relaxed lying pose (reference row 7, no zzz)
    fr = []
    for i in range(4):
        sy = 0.66 + (0.02 if i % 2 else 0.0)
        es = "happy" if i in (1, 2) else "closed"
        fr.append((dict(eyestate=es, tail=4, mouth="smile", body_dh=-2, blush=True),
                   dict(sx=1.22, sy=sy, dy=0), None))
    return fr, [360, 320, 340, 360]


def alert():     # answer is ready! anticipation crouch -> POP up (ears up, eyes
                 # wide, "!" pop) -> two attention shakes -> happy settle
    fr = [
        (dict(eyestate="open",  mouth="open",  ear=-1, tail=1, paw=0),
         dict(sx=1.12, sy=0.86, dy=2),                None),     # crouch (anticipation)
        (dict(eyestate="open",  mouth="open",  ear=2,  tail=3, paw=3),
         dict(sx=0.86, sy=1.20, dy=-7),               "alert"),  # POP up + "!"
        (dict(eyestate="open",  mouth="open",  ear=2,  tail=3, paw=3),
         dict(sx=0.92, sy=1.10, dy=-7, dx=-2),        "alert"),  # shake L
        (dict(eyestate="open",  mouth="open",  ear=2,  tail=3, paw=3),
         dict(sx=0.92, sy=1.10, dy=-7, dx=2),         "alert"),  # shake R
        (dict(eyestate="happy", mouth="smile", ear=1,  tail=1, paw=0),
         dict(sx=1.00, sy=1.00, dy=0),                "alert"),  # settle (! holds)
    ]
    return fr, [90, 80, 90, 90, 240]


def celebrate():  # tests/build pass or task done: happy double-bounce + confetti
    fr = [
        (dict(eyestate="happy", mouth="open",  ear=1, tail=3, paw=3),
         dict(sx=1.12, sy=0.86, dy=2),       None),        # crouch (anticipation)
        (dict(eyestate="happy", mouth="open",  ear=2, tail=3, paw=3),
         dict(sx=0.85, sy=1.22, dy=-12),     "confetti"),  # leap 1
        (dict(eyestate="happy", mouth="smile", ear=2, tail=3, paw=3),
         dict(sx=0.92, sy=1.10, dy=-6),      "confetti"),  # peak 1
        (dict(eyestate="happy", mouth="open",  ear=1, tail=3, paw=3),
         dict(sx=1.10, sy=0.88, dy=2),       "confetti"),  # land 1 (squash)
        (dict(eyestate="happy", mouth="open",  ear=2, tail=3, paw=3),
         dict(sx=0.88, sy=1.18, dy=-9),      "confetti"),  # leap 2
        (dict(eyestate="happy", mouth="smile", ear=1, tail=3, paw=0),
         dict(sx=1.06, sy=0.94, dy=1),       "confetti"),  # land 2
        (dict(eyestate="happy", mouth="smile", ear=1, tail=1, paw=0),
         dict(sx=1.00, sy=1.00, dy=0),       "confetti"),  # settle
    ]
    return fr, [90, 90, 90, 80, 90, 90, 220]


def worried():   # build/tests failed: flinch back, ears droop, sweat, hunch
    fr = [
        (dict(eyestate="open",   mouth="open",    ear=-1, tail=2, paw=0),
         dict(sx=1.06, sy=0.95, dx=-1),      "sweat"),     # flinch back
        (dict(eyestate="open",   mouth="grimace", ear=-1, tail=2, paw=1),
         dict(sx=1.00, sy=0.92, dy=2, dx=1), "sweat"),     # hunch / worry
        (dict(eyestate="closed", mouth="grimace", ear=-1, tail=0, paw=1),
         dict(sx=1.00, sy=0.90, dy=3, dx=-1),"sweat"),     # look down
        (dict(eyestate="open",   mouth="grimace", ear=-1, tail=0, paw=0),
         dict(sx=1.00, sy=0.93, dy=2, dx=1), "sweat"),     # tremble
        (dict(eyestate="open",   mouth="neutral", ear=0,  tail=0, paw=0),
         dict(sx=1.00, sy=1.00, dy=0),       None),        # recover
    ]
    return fr, [110, 150, 200, 120, 240]


def meeting():   # meeting reminder: cat RINGS its collar bell — fast wobble,
                 # ears up, waving paws, hops, ring arcs + notes overlay
    fr = []
    dx  = [-3, 3, -3, 3, -2, 2, -1, 1]
    dyb = [-3, 0, -3, 0, -2, 0, -1, 0]      # little hops on the shakes
    for i in range(8):
        fr.append((dict(eyestate="open", mouth="open", ear=2, tail=3,
                        paw=3 if i % 2 == 0 else 0),
                   dict(sx=1.0, sy=1.0, dx=dx[i], dy=dyb[i]), "bellring"))
    return fr, [80, 80, 80, 80, 90, 90, 100, 150]


def focus():     # break over -> back to work: sit up, ears perk, determined nod
    fr = [
        (dict(eyestate="open", mouth="smile", ear=2, tail=1, paw=0), dict(sx=1.00, sy=1.00, dy=0),  None),  # perk up
        (dict(eyestate="open", mouth="open",  ear=2, tail=3, paw=1), dict(sx=0.98, sy=1.03, dy=-2), None),  # ready (slight rise)
        (dict(eyestate="open", mouth="smile", ear=2, tail=3, paw=0), dict(sx=1.02, sy=0.97, dy=2),  None),  # determined nod
        (dict(eyestate="open", mouth="smile", ear=1, tail=1, paw=0), dict(sx=1.00, sy=1.00, dy=0),  None),  # settle focused
    ]
    return fr, [150, 170, 160, 220]


def yawn():      # sleepy yawn: inhale -> wide open + head back -> settle
    fr = [
        (dict(eyestate="open",   mouth="smile", tail=4, body_dh=-2), dict(dy=0,  sy=1.00, sx=1.00),       None),  # pre
        (dict(eyestate="closed", mouth="open",  tail=4, body_dh=-2), dict(dy=-2, sy=1.06, sx=1.0 / 1.06), None),  # opening
        (dict(eyestate="closed", mouth="open",  tail=4, body_dh=-2), dict(dy=-3, sy=1.10, sx=1.0 / 1.10), None),  # wide peak
        (dict(eyestate="happy",  mouth="smile", tail=4, body_dh=-2), dict(dy=0,  sy=1.00, sx=1.00),       None),  # settle
    ]
    return fr, [220, 160, 280, 240]


def emote():     # 6 expressions in one showcase row (reference row 8)
    base = dict(tail=1, blush=True)
    rows = [
        (dict(eyestate="happy",  mouth="smile",   **base), "emote_heart"),
        (dict(eyestate="open",   mouth="open",    **base), "emote_q"),
        (dict(eyestate="open",   mouth="open",    ear=1, **base), "emote_excl"),
        (dict(eyestate="happy",  mouth="smile",   **base), "emote_sparkle"),
        (dict(eyestate="closed", mouth="open",    **base), "emote_cry"),
        (dict(eyestate="dizzy",  mouth="grimace", ear=-1, **base), "emote_angry"),
    ]
    return [(pose, dict(sy=1.0), ov) for pose, ov in rows], 400


ANIMATIONS = [
    ("idle", idle), ("walk", walk), ("run", run), ("sit", sit),
    ("sleep", sleep), ("stretch", stretch), ("knead", knead), ("think", think),
    ("jump", jump), ("drag", drag), ("overheat", overheat),
    ("wiggle", wiggle), ("purr", purr), ("scroll", scroll), ("typing", typing),
    ("meow", meow), ("fall", fall), ("confused", confused), ("angry", angry),
    ("yawn", yawn), ("lie_down", lie_down), ("alert", alert),
    ("celebrate", celebrate), ("worried", worried),
    ("meeting", meeting), ("focus", focus),
]

# ---- standalone game-ready atlas (128x128 uniform grid, transparent) -----
ATLAS_CELL = 128
ATLAS = [
    ("idle", idle, 8), ("walk", walk, 8), ("run", run, 8), ("jump", jump, 6),
    ("fall", fall, 4), ("sleep", sleep, 8), ("typing", typing, 6), ("purr", purr, 6),
    ("drag", drag, 6), ("overheat", overheat, 8), ("think", think, 6),
    ("happy_jump", jump, 6), ("confused", confused, 6), ("angry", angry, 4),
    ("stretch", stretch, 8),
]
ATLAS_FPS = {"idle": 8, "walk": 12, "run": 16, "jump": 12, "fall": 12, "sleep": 4,
             "typing": 11, "purr": 6, "drag": 8, "overheat": 8, "think": 4,
             "happy_jump": 12, "confused": 8, "angry": 6, "stretch": 8}


def _fit(frames, n):
    """Resample a frame-spec list to exactly n frames."""
    L = len(frames)
    if L == n:
        return list(frames)
    if n == 1:
        return [frames[0]]
    return [frames[round(i * (L - 1) / (n - 1))] for i in range(n)]


def export_atlas():
    rows = [(name, _fit(fn()[0], count)) for name, fn, count in ATLAS]
    cols = max(len(fr) for _, fr in rows)
    sheet = Image.new("RGBA", (cols * ATLAS_CELL, len(rows) * ATLAS_CELL), T)
    anims = {}
    for r, (name, fr) in enumerate(rows):
        rects = []
        for col, spec in enumerate(fr):
            cell, eyes = render(spec, col, len(fr))
            # bake a forward pupil (the live app draws these at runtime, but a
            # standalone atlas needs them in the frames)
            dd = ImageDraw.Draw(cell)
            for e in eyes:
                if e["open"]:
                    ex, ey = int(round(e["x"])), int(round(e["y"]))
                    R(dd, ex - 1, ey - 1, ex, ey, EYE)   # dark pupil on the bright eye
            big = cell.resize((ATLAS_CELL, ATLAS_CELL), Image.NEAREST)
            sheet.paste(big, (col * ATLAS_CELL, r * ATLAS_CELL))
            rects.append({"x": col * ATLAS_CELL, "y": r * ATLAS_CELL, "w": ATLAS_CELL, "h": ATLAS_CELL})
        anims[name] = {"row": r, "frames": len(fr), "fps": ATLAS_FPS.get(name, 8), "rects": rects}
    sheet.save(os.path.join(OUT_DIR, "comnyang_atlas.png"))
    meta = {
        "image": "comnyang_atlas.png",
        "cell": {"w": ATLAS_CELL, "h": ATLAS_CELL},
        "grid": {"cols": cols, "rows": len(rows)},
        "transparent": True,
        "animations": anims,
    }
    with open(os.path.join(OUT_DIR, "comnyang_atlas.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    print(f"Wrote comnyang_atlas.png ({sheet.width}x{sheet.height}) + comnyang_atlas.json")
    print("Atlas rows:", ", ".join(f"{n}({c})" for n, _, c in ATLAS))


# ---- reference model sheet (matches the attached COMNYANG reference) ------
# Rows + frame counts follow the reference exactly: idle, walk, run, jump,
# attack/paw, hit, sit, lie down, emotes. 128px uniform cells, baked pupils.
REF_SHEET = [
    ("idle", idle, 6), ("walk", walk, 6), ("run", run, 6), ("jump", jump, 6),
    ("attack", attack, 5), ("hit", hit, 5), ("sit", sit, 3), ("lie_down", lie_down, 3),
    ("emote", emote, 6),
]
REF_FPS = {"idle": 6, "walk": 10, "run": 14, "jump": 12, "attack": 12,
           "hit": 8, "sit": 3, "lie_down": 3, "emote": 2}


def export_reference_sheet():
    rows = [(name, _fit(fn()[0], count)) for name, fn, count in REF_SHEET]
    cols = max(len(fr) for _, fr in rows)
    sheet = Image.new("RGBA", (cols * ATLAS_CELL, len(rows) * ATLAS_CELL), T)
    anims = {}
    for r, (name, fr) in enumerate(rows):
        rects = []
        for col, spec in enumerate(fr):
            cell, eyes = render(spec, col, len(fr))
            dd = ImageDraw.Draw(cell)
            for e in eyes:                     # bake a forward pupil
                if e["open"]:
                    ex, ey = int(round(e["x"])), int(round(e["y"]))
                    R(dd, ex - 1, ey - 1, ex, ey, EYE)
            big = cell.resize((ATLAS_CELL, ATLAS_CELL), Image.NEAREST)
            sheet.paste(big, (col * ATLAS_CELL, r * ATLAS_CELL))
            rects.append({"x": col * ATLAS_CELL, "y": r * ATLAS_CELL, "w": ATLAS_CELL, "h": ATLAS_CELL})
        anims[name] = {"row": r, "frames": len(fr), "fps": REF_FPS.get(name, 8), "rects": rects}
    sheet.save(os.path.join(OUT_DIR, "comnyang_sheet.png"))
    meta = {
        "image": "comnyang_sheet.png",
        "cell": {"w": ATLAS_CELL, "h": ATLAS_CELL},
        "grid": {"cols": cols, "rows": len(rows)},
        "transparent": True,
        "palette": ["FFF7F7", "DCDCDC", "F8B6C1", "FFD24D", "7EC8FF", "CBA6FF", "4B4BAB"],
        "animations": anims,
    }
    with open(os.path.join(OUT_DIR, "comnyang_sheet.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    print(f"Wrote comnyang_sheet.png ({sheet.width}x{sheet.height}) + comnyang_sheet.json")
    print("Sheet rows:", ", ".join(f"{n}({c})" for n, _, c in REF_SHEET))


# ---- dedicated curled sleeping pose (not a squashed standing cat) --------
def draw_sleep_pose(breathe=0, **_):
    """A fluffy curled-up ball: head tucked to the front, tail wrapped, ears on
    top, gentle closed eyes. `breathe` lifts the top 1px for the breath."""
    img = new_cell()
    d = ImageDraw.Draw(img)
    top = 34 - breathe
    # --- fluffy ball body (rounded mound on the ground) ---
    R(d, 28, top,     36, top,     BODY)
    R(d, 25, top + 1, 39, top + 1, BODY)
    R(d, 23, top + 2, 41, top + 2, BODY)
    R(d, 22, top + 3, 42, top + 3, BODY)
    R(d, 21, top + 4, 43, top + 4, BODY)
    R(d, 20, top + 5, 44, 49, BODY)        # main bulk
    R(d, 21, 50, 43, 50, BODY)
    R(d, 24, 51, 40, 51, BODY)
    # belly / lighter front + upper-left light
    R(d, 23, 44, 40, 49, BELLY)
    R(d, 24, top + 4, 38, top + 6, BELLY)
    # right-side shadow (light from upper-left)
    R(d, 41, top + 5, 44, 49, SHADOW)
    R(d, 40, 47, 43, 50, SHADOW)
    # --- ears on top ---
    def _ear(cx, t):
        P(d, cx, t, SHADOW); R(d, cx - 1, t + 1, cx + 1, t + 1, SHADOW)
        R(d, cx - 2, t + 2, cx + 2, t + 2, SHADOW); P(d, cx, t + 1, ACCENT)
    _ear(26, top - 2); _ear(38, top - 2)
    # --- tail wrapped around the front (grey, white tip) ---
    R(d, 23, 49, 39, 50, SHADOW); R(d, 37, 47, 39, 49, SHADOW); P(d, 38, 46, BODY)
    # --- face: gentle closed (peaceful upward-curve) eyes + nose ---
    for ex in (27, 37):
        ey = 43
        R(d, ex - 1, ey, ex + 1, ey, EYE)
        P(d, ex - 2, ey - 1, EYE); P(d, ex + 2, ey - 1, EYE)
    P(d, 31, 45, ACCENT); P(d, 32, 45, ACCENT)              # nose
    P(d, 24, 45, ACCENT); P(d, 40, 45, ACCENT)              # blush
    # --- tiny collar bell at the tuck (brand consistency) ---
    R(d, 30, 49, 33, 50, BELL); P(d, 31, 49, OUTLINE)
    return add_outline(img)


# ---- render -------------------------------------------------------------
def render(spec, i, n):
    pose_kw, tf, ov = spec
    if pose_kw.get("_pose") == "sleep":
        pose = draw_sleep_pose(breathe=pose_kw.get("breathe", 0))
    else:
        pose = draw_pose(**pose_kw)
    cell = compose(pose, **tf)
    cell = snap_palette(cell)          # keep the CAT strictly on-palette
    if ov:
        overlay(cell, ov, i, n)        # props (e.g. grey toilet-paper) on top
    # eye anchors after transform
    sx = tf.get("sx", 1.0); sy = tf.get("sy", 1.0)
    dx = tf.get("dx", 0); dy = tf.get("dy", 0)
    hdy = 0  # head_dy not used in transforms here
    eyes = []
    closed = pose_kw.get("eyestate", "open") != "open"
    for (ex, ey) in EYE_BASE:
        tx, ty = transform_point(ex, ey, sx, sy, dx, dy)
        eyes.append({"x": round(tx, 1), "y": round(ty, 1), "open": not closed})
    return cell, eyes


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    built = [(name, *fn()) for name, fn in ANIMATIONS]
    cols = max(len(f) for _, f, _ in built)
    rows = len(built)
    sheet = Image.new("RGBA", (cols * CELL, rows * CELL), T)

    anim_meta, frame_tags, frames_flat, gi = {}, [], [], 0
    for row, (name, frames, durs) in enumerate(built):
        if isinstance(durs, int):
            durs = [durs] * len(frames)
        n = len(frames)
        tag_from = gi
        entries = []
        for col, spec in enumerate(frames):
            cell, eyes = render(spec, col, n)
            sheet.paste(cell, (col * CELL, row * CELL))
            entry = {
                "index": gi,
                "rect": {"x": col * CELL, "y": row * CELL, "w": CELL, "h": CELL},
                "duration": durs[col],
                "eyes": eyes,
            }
            entries.append(entry); frames_flat.append(entry); gi += 1
        anim_meta[name] = {"frames": entries,
                           "loop": name not in ("jump", "stretch", "fall", "confused",
                                                "angry", "yawn", "lie_down", "alert",
                                                "celebrate", "worried", "focus", "meeting")}
        frame_tags.append({"name": name, "from": tag_from, "to": gi - 1})

    sheet.save(os.path.join(OUT_DIR, "pao.png"))

    # --- tray icon: a clean cat-face crop of idle frame 0, padded square ---
    head = sheet.crop((14, 0, 50, 36))          # head/face region of idle[0]
    bbox = head.getbbox() or (0, 0, head.width, head.height)
    head = head.crop(bbox)
    side = max(head.size) + 4                    # small transparent margin
    icon = Image.new("RGBA", (side, side), T)
    icon.paste(head, ((side - head.width) // 2, (side - head.height) // 2), head)
    icon.resize((32, 32), Image.NEAREST).save(os.path.join(OUT_DIR, "tray.png"))

    meta = {
        "name": "Pao",
        "image": "pao.png",
        "cell": {"w": CELL, "h": CELL},
        "sprite": {"w": 48, "h": 48},
        "renderScale": 3,
        "palette": ["#%02X%02X%02X" % c[:3] for c in PALETTE],
        "pupil": {"color": "#%02X%02X%02X" % EYE[:3], "radius": PUPIL_RADIUS, "maxOffset": PUPIL_MAX},
        "frameTags": frame_tags,
        "animations": anim_meta,
    }
    with open(os.path.join(OUT_DIR, "pao.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)

    print(f"Wrote pao.png ({sheet.width}x{sheet.height}) and pao.json")
    print("Animations:", ", ".join(f"{n}({len(f)})" for n, f, _ in built))

    export_atlas()   # also write the standalone 128x128 game-ready atlas
    export_reference_sheet()  # reference-matching model sheet (idle..emote)


if __name__ == "__main__":
    main()

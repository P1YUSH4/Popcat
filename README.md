# Pao — Desktop Pixel Companion

An original desktop companion inspired by the responsiveness and charm of
Comnyang, with entirely original artwork and implementation.

- **Stack:** TypeScript · Electron · Canvas API · `requestAnimationFrame`
- **Art:** 48×48 sprite in a 64×64 cell, 6-color palette, no anti-aliasing /
  gradients / blur, 4× nearest-neighbor scaling, transparent PNG sheet.
- **Character:** *Pao* — large head, small body, large eyes, tiny paws,
  expressive tail; readable silhouette at 48px.

## Quick start

```bash
npm install          # installs electron, typescript, esbuild (uiohook-napi optional)
npm run gen:sprites  # (optional) regenerate sprites — needs Python + Pillow
npm start            # build + launch the companion
```

The cat appears as a transparent, always-on-top overlay. It is click-through
everywhere except over the cat itself (so you can drag it).

## Public API

Exposed on `window.cat` in the renderer devtools:

```js
cat.startThinking();   // enter the thinking animation (looping bubble)
cat.finishThinking();  // happy jump, then back to idle
```

## Architecture

| Module | Responsibility |
|---|---|
| `SpriteRenderer` | Canvas draw, nearest-neighbor 4× scaling, runtime pupil tracking |
| `AnimationController` | Delta-time frame stepping from metadata; loop / one-shot |
| `PhysicsController` | Spring + acceleration + friction; organic, no-teleport motion |
| `InputController` | Global cursor (IPC) → canvas coords, cursor speed, keyboard energy |
| `StateMachine` | FSM: IDLE, LOOK_AROUND, WALK, RUN, HUNT, TYPE, THINK, JUMP, STRETCH, SLEEP, DRAG |
| `BehaviorController` | Transitions, cursor/keyboard reactions, random personality (15–45s) |
| `Cat` | Orchestrator + RAF loop; exposes the thinking API |

Main process (`src/main/main.ts`) owns the transparent overlay window, polls the
global cursor via `electron.screen` (no native deps), toggles click-through from
the cat hitbox, and — if `uiohook-napi` is installed — forwards global keystrokes.

## Ambient perception & mood (100% local, no screenshots)

Pao reads your **rhythm**, not your **screen**. There are no screenshots, no
pixel reads, no content capture — just cheap behavioural signals aggregated
locally into a small feature vector that drives a mood:

| Sense | Source |
|---|---|
| typing cadence / bursts | global keyboard hook (already used for reactions) |
| scroll & cursor energy | global hooks |
| idle / away / return | cursor + activity tracking |
| active **app title** (never content) | a long-lived PowerShell Win32 watcher (Windows; optional) |
| time of day / session length | local clock |

`Perception` builds the feature vector; `Affect` turns it into a continuous
**energy** level and a discrete **rhythm state** —
`AWAY · IDLE · FOCUSED · FLOW · SCATTERED · FATIGUED · WINDING_DOWN`. Pao then
*behaves* (it never advises): welcomes you back after you've been away, gets
restless when you window-hop, suggests a stretch deep in a flow streak, and
dozes off sooner when energy is low (late night / long marathon). The
classifier and energy model are pure functions with unit tests
(`tests/affect.test.ts`).

Inspect it live:

```bash
curl http://127.0.0.1:39127/state      # { rhythm, mood, energy, activeApp, ... }
```

…or `cat.affect()` in the renderer devtools.

## Play & personality (no AI)

| Feature | What it does |
|---|---|
| **Throw & bounce** | Fling Pao by releasing a drag with speed — it arcs under gravity, bounces off the screen edges (squash + thud), then shakes it off and sits. |
| **App-aware moods** | Pao's idle fidgets are flavoured by your active app category (editor → stretches, terminal → curious/alert, browser → watches along, media → relaxed, game → excited). Title-only, no content. |
| **Streaks & achievements** | A deterministic reward loop on the rhythm engine — first focus, flow, marathon, night-owl/early-bird, daily-return streaks (3/7/14/30). Unlocks pop a celebration + jingle; progress persists in `localStorage`. |
| **Coat colours** | Palette-swap the cat (Ginger, Charcoal, Russian Blue, Cream, Rose) — an exact recolour of the fur pixels, outline/eyes kept. Tray → *Coat colour*; persists across restarts. |

Drive them from the tray, devtools (`cat.setCoat("ginger")`, `cat.achievements()`),
or the control server:

```bash
curl "http://127.0.0.1:39127/coat?name=ginger"
curl  http://127.0.0.1:39127/throw      # demo toss
curl  http://127.0.0.1:39127/state      # includes { context, achievements } now
```

## Behaviors (exact Comnyang mapping)

| User event | Reaction | State → animation |
|---|---|---|
| Mouse moves | Eyes follow the cursor (pupils drawn at runtime) | — |
| Mouse moves **fast** | Hunts / chases the cursor | `HUNT` → run |
| **Pick up / drag** | Stretches like mochi | `DRAG` → drag |
| **Shake** while held | Wiggles (dizzy) | `SHAKE` → wiggle |
| **Pet** its head (hover slowly over it) | Purrs happily + hearts | `PET` → purr |
| **Type** | Kneads with tiny paws | `TYPE` → knead |
| **Type too fast** | Turns red + puffs steam | `OVERHEAT` → overheat |
| **Scroll** (mouse wheel) | Unspools a roll of paper | `PAPER` → paper |
| Idle 15–45s | Look around, wander, stretch, hop, doze | random |
| `cat.startThinking()` | Thinking bubble | `THINK` → think |
| `cat.finishThinking()` | Happy jump | `JUMP` → jump |

Reactive priority (highest first): scroll → fast-typing → typing → fast-cursor → pet.
Toggle the whole reactive set with `cat.setAutonomous(false)` (drag-only).

> Scroll and global-typing reactions rely on the optional `uiohook-napi` native
> module (it also provides the wheel hook). If it isn't installed, those two
> reactions are disabled; everything else still works.

## Sprites

`assets/sprites/pao.png` + `pao.json` are generated by
`tools/gen_companion.py` (Python + Pillow). Animation sets: idle(8), walk(8),
run(8), sit(4), sleep(4), stretch(6), knead(6), think(6), jump(8), drag(6),
overheat(6). Metadata includes per-frame eye anchors and open/closed flags so
the renderer can place tracking pupils even as the body squashes and stretches.

> Note: global keyboard detection uses the optional native module
> `uiohook-napi`. If it fails to install/compile, the app still runs; keyboard
> reactions are simply disabled. On macOS it also needs Accessibility
> permission.
